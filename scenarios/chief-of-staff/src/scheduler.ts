// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// In-process scheduler. Replaces the Power Automate mail-bus with:
//   - cron (npm) for Brief / Follow-up / Escalate (scheduled)
//   - polling loops for Capture (new transcripts) and Task Complete (Planner)
//
// Design constraints:
//   - Agentic auth needs a real TurnContext to exchange tokens. We cache the
//     first inbound conversation reference and use adapter.continueConversation
//     to reconstitute a valid context for every scheduled fire.
//   - Handlers use mcp_TeamsServer to DM the leader / owners, so
//     ctx.sendActivity is never called from cron paths. The context is only
//     needed for auth.
//
// Everything is optional — set SCHEDULER_ENABLED=false to disable it entirely.

import { CronJob } from 'cron';
import {
  Authorization,
  CloudAdapter,
  TurnContext,
  TurnState,
} from '@microsoft/agents-hosting';
import type { Activity, ConversationReference } from '@microsoft/agents-activity';

import { getClient, Client } from './client';
import { runBrief } from './cos/brief';
import { runFollowup } from './cos/followup';
import { runEscalate } from './cos/escalate';
import { runCapture } from './cos/capture';
import { runTaskComplete } from './cos/taskComplete';
import { pollForNewTranscripts } from './graph/transcriptPoller';
import { pollForCompletedTasks } from './graph/plannerPoller';
import { findStaleForEscalation, markEscalated, markResolved } from './state/followupStore';
import { sendEscalationCardDirect } from './cards/followupCards';
import { getPlannerTaskDetails } from './graph/plannerTools';

// ─── Config (env-driven) ───────────────────────────────────────────────────
const SCHEDULER_ENABLED = process.env.SCHEDULER_ENABLED !== 'false';
const BRIEF_CRON = process.env.CRON_BRIEF ?? '0 8 * * 1-5'; // 8 AM weekdays
const FOLLOWUP_CRON = process.env.CRON_FOLLOWUP ?? '0 * * * *'; // top of every hour
const ESCALATE_CRON = process.env.CRON_ESCALATE ?? '0 */4 * * *'; // every 4h
// IANA time zone for the CRON_* patterns above (e.g. 'America/Los_Angeles',
// 'Asia/Kolkata', 'UTC'). If blank/unset, cron patterns are interpreted in
// the SERVER's local time — which differs between local dev and Azure App
// Service (UTC).
const CRON_TIMEZONE = process.env.CRON_TIMEZONE?.trim() || undefined;
// POLL_MEETINGS_MS: cadence for the meeting-capture orchestrator (both
// discovery + retry sweep). 60s default — cheap since each tick is one
// calendarView call + at most a few per-meeting transcript/insights lookups.
// Legacy POLL_TRANSCRIPTS_MS is still honoured for back-compat.
const POLL_MEETINGS_MS = Number(
  process.env.POLL_MEETINGS_MS ?? process.env.POLL_TRANSCRIPTS_MS ?? '60000'
);
const POLL_TASKS_MS = Number(process.env.POLL_TASKS_MS ?? '300000'); // 5 min
const FOLLOWUP_ESCALATE_AFTER_HOURS = Number(process.env.FOLLOWUP_ESCALATE_AFTER_HOURS ?? '3');
const LEADER_UPN = process.env.LEADER_UPN ?? '';

// ─── State ─────────────────────────────────────────────────────────────────
let cachedRef: Partial<ConversationReference> | null = null;
let started = false;
const scheduledTasks: CronJob[] = [];
const intervalIds: NodeJS.Timeout[] = [];

/**
 * Called from agent.ts on every inbound user turn so we can reproduce a valid
 * TurnContext later for scheduled work.
 *
 * Uses the SDK-provided activity.getConversationReference() helper so all
 * fields (channelId, serviceUrl, conversation, agent, user, locale) are set
 * exactly the way continueConversation() expects.
 */
export function cacheConversationReference(activity: Activity): void {
  if (cachedRef) return;
  const a = activity as any;
  cachedRef =
    (typeof a.getConversationReference === 'function'
      ? a.getConversationReference()
      : {
          activityId: a.id,
          channelId: a.channelId,
          conversation: a.conversation,
          agent: a.recipient,
          user: a.from,
          serviceUrl: a.serviceUrl,
          locale: a.locale,
        }) as Partial<ConversationReference>;
  console.log(
    `[scheduler] cached conversation reference — cron/pollers can now fire (tenant=${
      (cachedRef as any).conversation?.tenantId ?? '?'
    })`
  );
}

export function hasCachedReference(): boolean {
  return cachedRef !== null;
}

interface SchedulerDeps {
  adapter: CloudAdapter;
  authorization: Authorization;
  authHandlerName: string;
}

/**
 * Start the scheduler. Called once from agent.ts after AgentApplication is
 * constructed. Idempotent — safe to call multiple times.
 */
export function startScheduler(deps: SchedulerDeps): void {
  if (started) return;
  if (!SCHEDULER_ENABLED) {
    console.log('[scheduler] disabled via SCHEDULER_ENABLED=false');
    return;
  }
  started = true;

  console.log(
    `[scheduler] starting — brief="${BRIEF_CRON}" followup="${FOLLOWUP_CRON}" ` +
      `escalate="${ESCALATE_CRON}" tz=${CRON_TIMEZONE ?? 'server-local'} ` +
      `meetingPoll=${POLL_MEETINGS_MS / 1000}s tasksPoll=${POLL_TASKS_MS / 1000}s`
  );

  // ── Cron: Brief ──
  // Gated behind BRIEF_ENABLED so the leader can silence the morning brief
  // without commenting out the cron. Set BRIEF_ENABLED=true in .env to
  // re-enable. Defaults to disabled.
  const briefEnabled = (process.env.BRIEF_ENABLED ?? 'false').toLowerCase() === 'true';
  if (briefEnabled) {
    scheduledTasks.push(
      CronJob.from({
        cronTime: BRIEF_CRON,
        start: true,
        timeZone: CRON_TIMEZONE,
        onTick: () =>
          fireInAuthedContext(deps, 'brief', async (ctx, state, client) => {
            await runBrief({}, ctx, state, client);
          }),
        errorHandler: (err) => console.error('[scheduler] brief cron error:', err),
      })
    );
  } else {
    console.log('[scheduler] brief cron DISABLED (set BRIEF_ENABLED=true in .env to re-enable).');
  }

  // ── Cron: Follow-up ──
  scheduledTasks.push(
    CronJob.from({
      cronTime: FOLLOWUP_CRON,
      start: true,
      timeZone: CRON_TIMEZONE,
      onTick: () =>
        fireInAuthedContext(deps, 'followup', async (ctx, state, client) => {
          await runFollowup({}, ctx, state, client);
          await sweepStaleFollowupsAndEscalate(deps, ctx, client);
        }),
      errorHandler: (err) => console.error('[scheduler] followup cron error:', err),
    })
  );

  // ── Cron: Escalate ──
  scheduledTasks.push(
    CronJob.from({
      cronTime: ESCALATE_CRON,
      start: true,
      timeZone: CRON_TIMEZONE,
      onTick: () =>
        fireInAuthedContext(deps, 'escalate', async (ctx, state, client) => {
          await runEscalate({}, ctx, state, client);
        }),
      errorHandler: (err) => console.error('[scheduler] escalate cron error:', err),
    })
  );

  // ── Poll: meeting-capture orchestrator (calendar-driven, per-meeting) ──
  // Guard against overlap: a full scan can take longer than POLL_MEETINGS_MS
  // when many meetings are pending (each meeting = 1-2 Graph calls). If two
  // scans run concurrently they'll both see the same "ready" capture and
  // fire runCapture twice → duplicate Planner tasks. Skip the tick if the
  // previous scan hasn't finished yet.
  let meetingPollInFlight = false;
  intervalIds.push(
    setInterval(async () => {
      if (meetingPollInFlight) {
        console.log('[scheduler] meeting-poll skipped — previous scan still in flight');
        return;
      }
      meetingPollInFlight = true;
      try {
        await fireInAuthedContext(deps, 'meeting-poll', async (ctx, state, client) => {
          const ready = await pollForNewTranscripts({
            authorization: deps.authorization,
            context: ctx,
            authHandlerName: deps.authHandlerName,
          });
          for (const t of ready) {
            try {
              await runCapture(
                {
                  meetingId: t.meetingId,
                  transcriptId: t.transcriptId,
                  organizerId: t.organizerId,
                  chatId: t.chatId,
                  subject: t.subject,
                  transcriptContent: t.transcriptContent,
                  actionItems: t.actionItems,
                  meetingNotes: t.meetingNotes,
                },
                ctx,
                state,
                client
              );
            } catch (err) {
              console.error(`[scheduler] runCapture(${t.transcriptId}) failed:`, err);
            }
          }
        });
      } finally {
        meetingPollInFlight = false;
      }
    }, POLL_MEETINGS_MS)
  );

  // ── Poll: completed Planner tasks → runTaskComplete ──
  intervalIds.push(
    setInterval(async () => {
      await fireInAuthedContext(deps, 'planner-poll', async (ctx, state, client) => {
        const done = await pollForCompletedTasks({
          authorization: deps.authorization,
          context: ctx,
          authHandlerName: deps.authHandlerName,
        });
        for (const t of done) {
          try {
            await runTaskComplete(
              { taskId: t.taskId, planId: t.planId },
              ctx,
              state,
              client
            );
          } catch (err) {
            console.error(`[scheduler] runTaskComplete(${t.taskId}) failed:`, err);
          }
        }
      });
    }, POLL_TASKS_MS)
  );
}

export function stopScheduler(): void {
  for (const t of scheduledTasks) t.stop();
  for (const id of intervalIds) clearInterval(id);
  scheduledTasks.length = 0;
  intervalIds.length = 0;
  started = false;
}

// ─── Stale follow-up escalation sweep ─────────────────────────────────────
/**
 * Direct-code (no LLM) escalation of any followup older than
 * FOLLOWUP_ESCALATE_AFTER_HOURS that hasn't been responded to. Runs after
 * every follow-up cron fire.
 */
async function sweepStaleFollowupsAndEscalate(
  deps: SchedulerDeps,
  ctx: TurnContext,
  _client: Client
): Promise<void> {
  const stale = findStaleForEscalation(FOLLOWUP_ESCALATE_AFTER_HOURS);
  if (stale.length === 0) return;
  if (!LEADER_UPN) {
    console.warn(`[scheduler] ${stale.length} stale followup(s) but LEADER_UPN is not set — cannot escalate.`);
    return;
  }
  // Lazy-resolve LEADER_UPN → AAD via the same graph helper the tools use.
  const { resolveUpnToAad } = await import('./graph/peopleTools');
  let leaderAad: string | undefined;
  try {
    const resolved = await resolveUpnToAad(LEADER_UPN, {
      authorization: deps.authorization,
      context: ctx,
      authHandlerName: deps.authHandlerName,
    });
    leaderAad = resolved ?? undefined;
  } catch (err) {
    console.error('[scheduler] escalation aborted — could not resolve LEADER_UPN:', err);
    return;
  }
  if (!leaderAad) {
    console.warn('[scheduler] escalation aborted — LEADER_UPN did not resolve to an AAD.');
    return;
  }

  console.log(`[scheduler] escalating ${stale.length} stale followup(s) to leader ${LEADER_UPN}`);
  for (const f of stale) {
    // Belt-and-suspenders: re-check the Planner task before escalating. If
    // the owner already marked it complete (and the taskComplete flow hasn't
    // fired yet, or the store was wiped by a restart), silently resolve the
    // followup instead of DMing the leader with a stale "no reply" card.
    try {
      const details = await getPlannerTaskDetails(f.taskId);
      if (details.ok && (details.percentComplete ?? 0) >= 100) {
        markResolved(f.followupId);
        console.log(
          `[scheduler] skip escalation for "${f.taskTitle}" — task is 100% complete (auto-resolved followup ${f.followupId.slice(0, 8)}…).`
        );
        continue;
      }
    } catch (err) {
      console.warn(
        `[scheduler] pre-escalation Planner check failed for ${f.taskId} — will escalate anyway:`,
        (err as Error)?.message ?? err
      );
    }

    const hours = (Date.now() - f.sentAt) / (60 * 60 * 1000);
    const res = await sendEscalationCardDirect(
      { authorization: deps.authorization, context: ctx, authHandlerName: deps.authHandlerName },
      {
        leaderAadObjectId: leaderAad,
        followupId: f.followupId,
        taskId: f.taskId,
        taskTitle: f.taskTitle,
        ownerName: f.ownerName,
        hoursSinceReminder: hours,
        dueDate: f.dueDate ?? null,
      }
    );
    if (res.ok) markEscalated(f.followupId);
  }
}

// ─── Internal ──────────────────────────────────────────────────────────────
/**
 * Reconstitute a valid TurnContext via adapter.continueConversation, build a
 * Client, and hand both to the caller. Skips + warns if we haven't seen a
 * first inbound turn yet (needed to bootstrap agentic auth).
 */
async function fireInAuthedContext(
  deps: SchedulerDeps,
  name: string,
  work: (ctx: TurnContext, state: TurnState, client: Client) => Promise<void>
): Promise<void> {
  if (!cachedRef) {
    console.warn(
      `[scheduler] ${name} skipped — no cached conversation reference yet. ` +
        `Send any Teams message to the agent once, then cron/pollers will fire.`
    );
    return;
  }
  try {
    console.log(`[scheduler] firing ${name}`);
    // continueConversation signature is (botAppIdOrIdentity, reference, logic).
    // The blueprint app id is what claims the identity for proactive turns.
    const botAppId =
      process.env.agent_id?.trim() ||
      process.env.connections__service_connection__settings__clientId?.trim() ||
      '';
    if (!botAppId) {
      // Without a bot app id continueConversation() would throw a cryptic
      // MSAL/OBO error deep in the SDK. Fail fast with a clear log line so
      // misconfiguration is obvious.
      console.warn(
        `[scheduler] ${name} skipped — botAppId is empty (set agent_id or connections__service_connection__settings__clientId in .env).`
      );
      return;
    }
    await (deps.adapter as any).continueConversation(botAppId, cachedRef, async (ctx: TurnContext) => {
      const state = {} as TurnState;
      const client = await getClient(
        deps.authorization,
        deps.authHandlerName,
        ctx,
        'CoS Scheduler'
      );
      await work(ctx, state, client);
    });
  } catch (err) {
    console.error(`[scheduler] ${name} error:`, err);
  }
}
