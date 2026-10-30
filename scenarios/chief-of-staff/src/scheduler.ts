// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// In-process scheduler. Replaces the Power Automate mail-bus with:
//   - cron (npm) for Brief / Follow-up (scheduled). Escalation is the
//     deterministic stale-follow-up sweep that runs after each follow-up tick.
//   - polling loops for Capture (new transcripts) and Task Complete (Planner)
//
// Design constraints:
//   - Agentic auth needs a real TurnContext to exchange tokens. We cache a
//     conversation reference (persisted to disk) and use
//     adapter.continueConversation to reconstitute a valid context for every
//     scheduled fire. After a restart the persisted reference — or the
//     leader's persisted personal chat — is restored at boot, so scheduled
//     work resumes without waiting for a new inbound message.
//   - Handlers DM people through Bot Framework proactive sends, so
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
import { runWithObservabilityContext } from './observability';
import { providerError } from './util/logger';
import { runBrief } from './cos/brief';
import { runFollowup } from './cos/followup';
import { runCapture } from './cos/capture';
import { runTaskComplete } from './cos/taskComplete';
import { pollForNewTranscripts } from './graph/transcriptPoller';
import { acknowledgeCompletion, pollForCompletedTasks } from './graph/plannerPoller';
import {
  cancelOutstandingRequestsForTask,
  findStaleForEscalation,
  getFollowup,
  markEscalated,
  markResolved,
} from './state/followupStore';
import { markCaptureComplete, markCaptureProcessingFailed } from './state/pendingCaptureStore';
import { lookupConversationRef } from './state/conversationRefs';
import { PersistentMap } from './state/persistentMap';
import { sendEscalationCardDirect } from './cards/followupCards';
import { retryPendingLeaderDeliveries } from './cards/actionRouter';
import { getPlannerTaskDetails } from './graph/plannerTools';

// ─── Config (env-driven) ───────────────────────────────────────────────────
const SCHEDULER_ENABLED = process.env.SCHEDULER_ENABLED !== 'false';
const BRIEF_CRON = process.env.CRON_BRIEF ?? '0 8 * * 1-5'; // 8 AM weekdays
const FOLLOWUP_CRON = process.env.CRON_FOLLOWUP ?? '0 * * * *'; // top of every hour
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
// Persisted so a restart (App Service recycle, deploy, crash) can resume
// scheduled work immediately instead of waiting for a new inbound message.
const schedulerRefStore = new PersistentMap<Partial<ConversationReference>>({
  file: 'scheduler-ref.json',
});
const SCHEDULER_REF_KEY = 'bootstrap';
let cachedRef: Partial<ConversationReference> | null = schedulerRefStore.get(SCHEDULER_REF_KEY) ?? null;
let started = false;
const scheduledTasks: CronJob[] = [];
const intervalIds: NodeJS.Timeout[] = [];

/**
 * Called from agent.ts on every inbound user turn so we can reproduce a valid
 * TurnContext later for scheduled work. The first reference is persisted.
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
  schedulerRefStore.set(SCHEDULER_REF_KEY, cachedRef);
  console.log(
    `[scheduler] cached conversation reference — cron/pollers can now fire (tenant=${String(
      (cachedRef as any).conversation?.tenantId ?? '?'
    ).slice(0, 8)}…)`
  );
}

/**
 * Boot-time recovery: if no scheduler reference was persisted (e.g. a
 * deployment from before persistence existed), seed it from the configured
 * leader's persisted personal chat. Only a genuinely uninitialized deployment
 * still needs a first inbound message.
 */
function restoreSchedulerReference(): void {
  if (cachedRef) {
    console.log('[scheduler] restored persisted conversation reference — scheduled work resumes immediately.');
    return;
  }
  const leaderRef = lookupConversationRef(process.env.LEADER_AAD_ID?.trim());
  if (leaderRef) {
    cachedRef = leaderRef;
    schedulerRefStore.set(SCHEDULER_REF_KEY, leaderRef);
    console.log("[scheduler] seeded conversation reference from the leader's persisted personal chat.");
    return;
  }
  console.log(
    '[scheduler] no conversation reference yet — scheduled work starts after the first message to the agent.'
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
  restoreSchedulerReference();

  console.log(
    `[scheduler] starting — brief="${BRIEF_CRON}" followup="${FOLLOWUP_CRON}" ` +
      `tz=${CRON_TIMEZONE ?? 'server-local'} ` +
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
        errorHandler: (err) => console.error('[scheduler] brief cron error:', providerError(err)),
      })
    );
  } else {
    console.log('[scheduler] brief cron DISABLED (set BRIEF_ENABLED=true in .env to re-enable).');
  }

  // ── Cron: Follow-up (+ deterministic stale-follow-up escalation sweep) ──
  // Guard against overlap: with a short CRON_FOLLOWUP (e.g. every minute) a
  // slow run can still be in flight at the next tick. Two concurrent runs can
  // both pass the per-task duplicate check and create two check-ins for the
  // same task (and later a false no-reply escalation). Skip the tick instead.
  scheduledTasks.push(
    CronJob.from({
      cronTime: FOLLOWUP_CRON,
      start: true,
      timeZone: CRON_TIMEZONE,
      onTick: singleFlight('follow-up', () =>
        fireInAuthedContext(deps, 'followup', async (ctx, state, client) => {
          await runFollowup({}, ctx, state, client);
          await retryUndeliveredLeaderRequests(deps, ctx);
          await sweepStaleFollowupsAndEscalate(deps, ctx, client);
        })
      ),
      errorHandler: (err) => console.error('[scheduler] followup cron error:', providerError(err)),
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
                  eventId: t.eventId,
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
              // Acknowledge only after processing succeeded.
              markCaptureComplete(t.eventId);
            } catch (err) {
              const next = markCaptureProcessingFailed(t.eventId);
              console.error(
                `[scheduler] runCapture(${t.transcriptId.slice(0, 8)}…) failed — ${
                  next === 'retry' ? 'kept READY for retry' : 'giving up after repeated failures'
                }:`,
                providerError(err)
              );
            }
          }
        });
      } finally {
        meetingPollInFlight = false;
      }
    }, POLL_MEETINGS_MS)
  );

  // ── Poll: completed Planner tasks → runTaskComplete ──
  // Guarded like the meeting poll: a slow DM send must not let the next tick
  // re-read the same pending completion (with its old recipient list) and
  // notify the same people again.
  let plannerPollInFlight = false;
  intervalIds.push(
    setInterval(async () => {
      if (plannerPollInFlight) {
        console.log('[scheduler] planner-poll skipped — previous run still delivering');
        return;
      }
      plannerPollInFlight = true;
      try {
        await fireInAuthedContext(deps, 'planner-poll', async (ctx, state, client) => {
          const done = await pollForCompletedTasks({
            authorization: deps.authorization,
            context: ctx,
            authHandlerName: deps.authHandlerName,
          });
          for (const t of done) {
            try {
              const outcome = await runTaskComplete(
                { taskId: t.taskId, planId: t.planId, alreadyDelivered: t.alreadyDelivered },
                ctx,
                state,
                client
              );
              acknowledgeCompletion(t.taskId, outcome);
            } catch (err) {
              acknowledgeCompletion(t.taskId, { complete: false, delivered: [] });
              console.error(`[scheduler] runTaskComplete(${t.taskId.slice(0, 8)}…) failed — will retry:`, providerError(err));
            }
          }
        });
      } finally {
        plannerPollInFlight = false;
      }
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

// ─── Undelivered owner requests (extension / blocker) ─────────────────────
/** Retry owner requests whose leader card failed to send. Runs on every
 *  follow-up cron fire, before the stale sweep. */
async function retryUndeliveredLeaderRequests(deps: SchedulerDeps, ctx: TurnContext): Promise<void> {
  const opts = { authorization: deps.authorization, context: ctx, authHandlerName: deps.authHandlerName };
  try {
    const { resolveUpnToAad } = await import('./graph/peopleTools');
    const leaderAad = process.env.LEADER_AAD_ID?.trim() || (await resolveUpnToAad(LEADER_UPN, opts));
    if (!leaderAad) {
      console.warn('[scheduler] leader-delivery retry skipped — leader identity could not be resolved.');
      return;
    }
    await retryPendingLeaderDeliveries(opts, leaderAad);
  } catch (err) {
    console.error('[scheduler] leader-delivery retry failed:', providerError(err));
  }
}

// ─── Stale follow-up escalation sweep ─────────────────────────────────────
/**
 * Direct-code (no LLM) escalation of any followup older than
 * FOLLOWUP_ESCALATE_AFTER_HOURS that hasn't been responded to. Runs after
 * every follow-up cron fire.
 */
export async function sweepStaleFollowupsAndEscalate(
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
    console.error('[scheduler] escalation aborted — could not resolve LEADER_UPN:', providerError(err));
    return;
  }
  if (!leaderAad) {
    console.warn('[scheduler] escalation aborted — LEADER_UPN did not resolve to an AAD.');
    return;
  }

  console.log(`[scheduler] escalating ${stale.length} stale followup(s) to the leader`);
  for (const f of stale) {
    // Belt-and-suspenders: re-check the Planner task before escalating. If
    // the owner already marked it complete (and the taskComplete flow hasn't
    // fired yet, or the store was wiped by a restart), silently resolve the
    // followup instead of DMing the leader with a stale "no reply" card.
    try {
      const details = await getPlannerTaskDetails(f.taskId);
      // Planner confirmed the task was deleted: close every outstanding
      // request for it and never send a no-reply escalation.
      if (!details.ok && details.notFound) {
        const closed = cancelOutstandingRequestsForTask(f.taskId);
        console.log(
          `[scheduler] skip escalation for task=${f.taskId.slice(0, 8)}… — task no longer exists (closed ${closed} request(s)).`
        );
        continue;
      }
      if (details.ok && (details.percentComplete ?? 0) >= 100) {
        markResolved(f.followupId);
        console.log(
          `[scheduler] skip escalation for task=${f.taskId.slice(0, 8)}… — task is 100% complete (auto-resolved followup ${f.followupId.slice(0, 8)}…).`
        );
        continue;
      }
      // The recorded owner was unassigned since the check-in: they aren't
      // the one ignoring it, so don't escalate them.
      if (details.ok && !details.assigneeAads.some((a) => a.toLowerCase() === f.ownerAad.toLowerCase())) {
        markResolved(f.followupId);
        console.log(
          `[scheduler] skip escalation for task=${f.taskId.slice(0, 8)}… — owner is no longer assigned (auto-resolved followup ${f.followupId.slice(0, 8)}…).`
        );
        continue;
      }
    } catch (err) {
      console.warn(
        `[scheduler] pre-escalation Planner check failed for task=${f.taskId.slice(0, 8)}… — will escalate anyway:`,
        providerError(err)
      );
    }

    // Selection was before several awaits. An owner may have responded
    // meanwhile; never send a stale "no reply" card or reopen that response.
    if (getFollowup(f.followupId)?.status !== 'pending') continue;
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

/**
 * Wrap a scheduled job so a tick that fires while the previous run is still
 * in flight is skipped instead of running concurrently.
 */
export function singleFlight(name: string, job: () => Promise<unknown>): () => Promise<void> {
  let inFlight = false;
  return async () => {
    if (inFlight) {
      console.log(`[scheduler] ${name} skipped — previous run still in flight`);
      return;
    }
    inFlight = true;
    try {
      await job();
    } finally {
      inFlight = false;
    }
  };
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
    await (deps.adapter as any).continueConversation(botAppId, cachedRef, async (ctx: TurnContext) => {
      // Cron/poller turns never pass through the adapter's BaggageMiddleware,
      // and the token cached on the last inbound turn may have expired hours
      // ago — re-establish both or the batch is dropped.
      await runWithObservabilityContext(
        ctx,
        deps.authorization,
        async () => {
          const state = {} as TurnState;
          const client = await getClient(
            deps.authorization,
            deps.authHandlerName,
            ctx,
            'CoS Scheduler',
            { humanInitiated: false }
          );
          await work(ctx, state, client);
        },
        { input: `scheduled run: ${name}`, humanInitiated: false }
      );
    });
  } catch (err) {
    console.error(`[scheduler] ${name} error:`, providerError(err));
  }
}
