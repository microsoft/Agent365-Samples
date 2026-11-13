// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Follow-up handler — DETERMINISTIC.
//
// Prior version delegated to gpt-4o with a natural-language prompt to filter
// Planner tasks, resolve names, and call send_followup_check_in_card. That
// path was non-deterministic: sometimes it worked, sometimes the LLM
// declared "no tasks qualified" even when at-risk tasks clearly existed.
//
// This version does all the work in TypeScript:
//   1. GET /planner/plans/{plan}/tasks           (app-only Graph)
//   2. Filter: percentComplete<100, not [DECISION], has assignee,
//              dueDateTime <= cutoff (24h ahead)
//   3. Skip tasks that already have an OPEN followup (avoid spam on 2-min cron).
//   4. GET /users/{aad}?$select=displayName       (app-only Graph)
//   5. Build FollowupCheckIn Adaptive Card in code, DM via
//      sendCardProactively.
//
// A separate stale-followup sweep (in scheduler.ts) picks up any followups
// the owner ignored for more than FOLLOWUP_ESCALATE_AFTER_HOURS and sends an
// escalation card to the leader.

import { graphHttp as axios } from '../graph/graphHttp';
import { providerError } from '../util/logger';
import { CloudAdapter, TurnContext, TurnState } from '@microsoft/agents-hosting';
import type { Client } from '../client';
import { acquireAppOnlyGraphToken } from '../graph/graphAppToken';
import {
  buildFollowupCheckInCard,
  FollowupCheckInArgs,
} from '../cards/followupCards';
import { getBotAppId, sendCardProactively } from '../cards/proactiveSend';
import { hasConversationRef } from '../state/conversationRefs';
import { createFollowup, deleteFollowup, listAll, markResolved } from '../state/followupStore';
import { getPlannerPlanId } from '../graph/plannerConfig';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Demo tenant runs in UTC, but the leader / owners are in India — compare
// due-dates in IST so a task due "tomorrow IST" isn't misjudged as either
// today or the day-after based on cron timing.
const DISPLAY_TZ = process.env.BRIEF_DISPLAY_TZ?.trim() || 'Asia/Kolkata';

function isoDateInTz(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const day = parts.find((p) => p.type === 'day')!.value;
  return `${y}-${m}-${day}`;
}

interface PlannerTask {
  id: string;
  title: string;
  percentComplete: number;
  dueDateTime?: string | null;
  assignments?: Record<string, unknown>;
}

/** Fetch all tasks in the plan. */
async function fetchPlanTasks(token: string, planId: string): Promise<PlannerTask[]> {
  const res = await axios.get(`${GRAPH_BASE}/planner/plans/${planId}/tasks`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (res.data?.value ?? []) as PlannerTask[];
}

/** Resolve an AAD Object ID to a display name (app-only Graph). */
async function resolveDisplayName(token: string, aad: string): Promise<string | null> {
  try {
    const res = await axios.get(
      `${GRAPH_BASE}/users/${encodeURIComponent(aad)}?$select=displayName`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const name = (res.data?.displayName ?? '').toString().trim();
    return name || null;
  } catch (err) {
    console.warn(`[followup] resolveDisplayName failed for aad=${aad.slice(0, 8)}…:`, providerError(err));
    return null;
  }
}

/**
 * True if any recent followup for this task should suppress a new check-in
 * FOR THIS OWNER.
 *
 * Blocks in these cases:
 *   1. Still-open (pending/escalated) for the SAME owner  → always block
 *   2. A meeting was scheduled recently for the SAME owner → block for 24h
 *   3. Same owner responded recently                       → block for
 *      FOLLOWUP_COOLDOWN_HOURS (default 4)
 *
 * IMPORTANT: cooldowns are per-owner. If the task was reassigned (e.g.
 * Mario clicked "On track" and then the leader reassigned to Peyton),
 * the NEW owner deserves a fresh check-in — the old cooldown doesn't
 * apply to them. Co-assignees each have their own cooldown; check-ins for
 * people no longer assigned are cleaned up by resolveOrphanedFollowups.
 */
const FOLLOWUP_COOLDOWN_HOURS = Number(process.env.FOLLOWUP_COOLDOWN_HOURS ?? '4');
const MEETING_SCHEDULED_COOLDOWN_HOURS = 24;

/**
 * Resolve open check-ins for people who are no longer assigned to the task.
 * Co-owners who are still assigned keep their own check-ins.
 */
function resolveOrphanedFollowups(taskId: string, currentAssignees: Set<string>): void {
  for (const f of listAll()) {
    if (f.taskId !== taskId) continue;
    if (currentAssignees.has(f.ownerAad.toLowerCase())) continue;
    if (f.status === 'pending' || f.status === 'escalated') {
      markResolved(f.followupId, { meetingScheduledAt: undefined });
      console.log(
        `[followup] auto-resolving orphaned followup ${f.followupId.slice(0, 8)}… — owner ${f.ownerAad.slice(0, 8)}… is no longer assigned`
      );
    }
  }
}

function hasBlockingFollowupForTask(
  taskId: string,
  currentOwnerAad: string
): { blocked: true; reason: string } | { blocked: false } {
  const now = Date.now();
  const respondedCutoff = now - FOLLOWUP_COOLDOWN_HOURS * 60 * 60 * 1000;
  const meetingCutoff = now - MEETING_SCHEDULED_COOLDOWN_HOURS * 60 * 60 * 1000;
  const currentOwnerLc = currentOwnerAad.toLowerCase();

  // Cooldowns are per owner: each co-assignee has their own history.
  for (const f of listAll()) {
    if (f.taskId !== taskId) continue;
    if (f.ownerAad.toLowerCase() !== currentOwnerLc) continue;

    if (f.status === 'pending' || f.status === 'escalated') {
      return { blocked: true, reason: `open followup ${f.followupId.slice(0, 8)}…` };
    }
    if (f.meetingScheduledAt && f.meetingScheduledAt > meetingCutoff) {
      const ageMin = Math.round((now - f.meetingScheduledAt) / 60000);
      return { blocked: true, reason: `meeting scheduled ${ageMin} min ago (cooldown 24h)` };
    }
    if (f.respondedAt && f.respondedAt > respondedCutoff) {
      const ageMin = Math.round((now - f.respondedAt) / 60000);
      return {
        blocked: true,
        reason: `owner ${f.responseKind ?? 'responded'} ${ageMin} min ago (cooldown ${FOLLOWUP_COOLDOWN_HOURS}h)`,
      };
    }
    if (f.status === 'resolved' && f.sentAt > respondedCutoff) {
      const ageMin = Math.round((now - f.sentAt) / 60000);
      return { blocked: true, reason: `resolved followup sent ${ageMin} min ago (cooldown ${FOLLOWUP_COOLDOWN_HOURS}h)` };
    }
  }
  return { blocked: false };
}

export async function runFollowup(
  _payload: unknown,
  ctx: TurnContext,
  _state: TurnState,
  _client: Client
): Promise<void> {
  console.log('[followup] Trigger received.');

  const planId = await getPlannerPlanId();
  if (!planId) {
    console.warn('[followup] PLANNER_PLAN_ID not set (and team auto-resolve failed) — skipping.');
    return;
  }

  const now = new Date();
  const todayIso = isoDateInTz(now);
  const cutoffIso = isoDateInTz(new Date(now.getTime() + 24 * 60 * 60 * 1000));

  let tasks: PlannerTask[];
  try {
    const token = await acquireAppOnlyGraphToken();
    tasks = await fetchPlanTasks(token, planId);
  } catch (err) {
    console.error('[followup] fetchPlanTasks failed:', providerError(err));
    return;
  }

  console.log(
    `[followup] scanned ${tasks.length} task(s); today=${todayIso} cutoff=${cutoffIso}`
  );

  // Deterministic filter. Logs only reason codes and counts — task titles
  // (decisions, confidential work) never go to application logs.
  const droppedByReason: Record<string, number> = {};
  const drop = (reason: string) => {
    droppedByReason[reason] = (droppedByReason[reason] ?? 0) + 1;
    return false;
  };
  // Reconcile every open task's check-ins with its CURRENT assignees first —
  // including tasks that are unassigned or outside the reminder horizon, which
  // the filter below drops — so a removed owner is never escalated.
  for (const t of tasks) {
    if (!t || (t.percentComplete ?? 0) >= 100) continue;
    resolveOrphanedFollowups(t.id, new Set(Object.keys(t.assignments ?? {}).map((a) => a.toLowerCase())));
  }

  const atRisk = tasks.filter((t) => {
    if (!t) return false;
    if ((t.percentComplete ?? 0) >= 100) return drop('complete');
    if ((t.title ?? '').startsWith('[DECISION]')) return drop('decision');
    if (!t.dueDateTime) return drop('no-due-date');
    const dueIso = isoDateInTz(new Date(t.dueDateTime));
    if (dueIso > cutoffIso) return drop('due-after-cutoff');
    return true;
  });

  const droppedTotal = Object.values(droppedByReason).reduce((a, b) => a + b, 0);
  if (droppedTotal > 0) {
    console.log(
      `[followup] filtered out ${droppedTotal} task(s): ${Object.entries(droppedByReason)
        .map(([reason, n]) => `${reason}=${n}`)
        .join(' ')}`
    );
  }
  console.log(`[followup] ${atRisk.length} at-risk task(s) after filter.`);

  if (atRisk.length === 0) {
    console.log('[followup] Done. cardsSent=0 skipped=0 (nothing at-risk).');
    return;
  }

  const adapter = (ctx as any).adapter as CloudAdapter | undefined;
  const botAppId = getBotAppId();
  const token = await acquireAppOnlyGraphToken(); // reused for name lookups

  let cardsSent = 0;
  const skipped: string[] = [];
  // Log-safe task reference: an id prefix, never the title.
  const ref = (id: string) => `task=${id.slice(0, 8)}…`;
  const skip = (t: PlannerTask, reason: string) => {
    const line = `${ref(t.id)} ${reason}`;
    skipped.push(line);
    console.log(`[followup] skip: ${line}`);
  };

  for (const t of atRisk) {
    const assigneeAads = Object.keys(t.assignments ?? {});
    if (assigneeAads.length === 0) {
      skip(t, 'no-assignee');
      continue;
    }

    // Every current assignee gets their own check-in, cooldown, and delivery
    // result — one co-owner without a chat reference doesn't block the others.
    for (const ownerAad of assigneeAads) {
      const owner = `owner=${ownerAad.slice(0, 8)}…`;
      const block = hasBlockingFollowupForTask(t.id, ownerAad);
      if (block.blocked) {
        skip(t, `${owner} ${block.reason}`);
        continue;
      }

      const ownerName = await resolveDisplayName(token, ownerAad);
      if (!ownerName) {
        skip(t, `${owner} owner-name-unresolved`);
        continue;
      }
      if (!adapter || !hasConversationRef(ownerAad)) {
        skip(t, `${owner} no-conversation-ref (owner has not messaged the agent yet)`);
        continue;
      }

      const record = createFollowup({
        taskId: t.id,
        taskTitle: t.title,
        ownerAad,
        ownerName,
        dueDate: t.dueDateTime ?? undefined,
      });

      const cardArgs: FollowupCheckInArgs = {
        taskId: t.id,
        taskTitle: t.title,
        ownerAadObjectId: ownerAad,
        ownerName,
        dueDate: t.dueDateTime ?? null,
      };
      const card = buildFollowupCheckInCard(cardArgs, record.followupId);

      try {
        await sendCardProactively({ adapter, botAppId, recipientAad: ownerAad, card });
        cardsSent++;
        console.log(`[followup] ✔ sent check-in for ${ref(t.id)} to owner=${ownerAad.slice(0, 8)}…`);
      } catch (err) {
        // The owner never received this reminder: drop the record so the next
        // tick retries and the escalation sweep can't report it as ignored.
        deleteFollowup(record.followupId);
        skipped.push(`${ref(t.id)} ${owner} send failed`);
        console.error(`[followup] send failed for ${ref(t.id)} ${owner} — will retry next tick:`, providerError(err));
      }
    }
  }

  console.log(
    `[followup] Done. cardsSent=${cardsSent} skipped=${skipped.length}` +
      (skipped.length ? `\n  - ${skipped.join('\n  - ')}` : '')
  );
}
