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

import axios from 'axios';
import { CloudAdapter, TurnContext, TurnState } from '@microsoft/agents-hosting';
import type { Client } from '../client';
import { acquireAppOnlyGraphToken } from '../graph/graphAppToken';
import {
  buildFollowupCheckInCard,
  FollowupCheckInArgs,
} from '../cards/followupCards';
import { getBotAppId, sendCardProactively } from '../cards/proactiveSend';
import { hasConversationRef } from '../state/conversationRefs';
import { createFollowup, listAll, markResolved } from '../state/followupStore';
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
    console.warn(`[followup] resolveDisplayName failed for aad=${aad}:`, (err as Error)?.message);
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
 * Alex clicked "On track" and then the leader reassigned to Adele),
 * the NEW owner deserves a fresh check-in — the old cooldown doesn't
 * apply to them.
 *
 * As a side-effect, if there's a pending/escalated followup for a
 * DIFFERENT owner, we mark it resolved (cleanup) since that owner is no
 * longer responsible.
 */
const FOLLOWUP_COOLDOWN_HOURS = Number(process.env.FOLLOWUP_COOLDOWN_HOURS ?? '4');
const MEETING_SCHEDULED_COOLDOWN_HOURS = 24;

function hasBlockingFollowupForTask(
  taskId: string,
  currentOwnerAad: string
): { blocked: true; reason: string } | { blocked: false } {
  const now = Date.now();
  const respondedCutoff = now - FOLLOWUP_COOLDOWN_HOURS * 60 * 60 * 1000;
  const meetingCutoff = now - MEETING_SCHEDULED_COOLDOWN_HOURS * 60 * 60 * 1000;
  const currentOwnerLc = currentOwnerAad.toLowerCase();

  for (const f of listAll()) {
    if (f.taskId !== taskId) continue;
    const sameOwner = f.ownerAad.toLowerCase() === currentOwnerLc;

    // Task was reassigned since this followup was created — clean up any
    // orphaned pending/escalated cards for the OLD owner and continue.
    if (!sameOwner && (f.status === 'pending' || f.status === 'escalated')) {
      markResolved(f.followupId, { meetingScheduledAt: undefined });
      console.log(
        `[followup] auto-resolving orphaned followup ${f.followupId.slice(0, 8)}… — task reassigned from ${f.ownerAad.slice(0, 8)}… to ${currentOwnerAad.slice(0, 8)}…`
      );
      continue;
    }
    if (!sameOwner) continue;

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
    console.error('[followup] fetchPlanTasks failed:', (err as Error)?.message ?? err);
    return;
  }

  console.log(
    `[followup] scanned ${tasks.length} task(s); today=${todayIso} cutoff=${cutoffIso}`
  );

  // Deterministic filter — log each rejection so it's obvious WHY a task
  // didn't get a check-in.
  const dropped: string[] = [];
  const atRisk = tasks.filter((t) => {
    if (!t) return false;
    const title = t.title ?? '(untitled)';
    if ((t.percentComplete ?? 0) >= 100) {
      dropped.push(`"${title}" — 100% complete`);
      return false;
    }
    if ((t.title ?? '').startsWith('[DECISION]')) {
      dropped.push(`"${title}" — [DECISION] prefix`);
      return false;
    }
    if (!t.dueDateTime) {
      dropped.push(`"${title}" — no due date`);
      return false;
    }
    const dueIso = isoDateInTz(new Date(t.dueDateTime));
    if (dueIso > cutoffIso) {
      dropped.push(`"${title}" — due ${dueIso} > cutoff ${cutoffIso}`);
      return false;
    }
    return true;
  });

  if (dropped.length > 0) {
    console.log(`[followup] filtered out ${dropped.length} task(s):`);
    for (const line of dropped) console.log(`  · ${line}`);
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

  for (const t of atRisk) {
    const assigneeAads = Object.keys(t.assignments ?? {});
    if (assigneeAads.length === 0) {
      const line = `"${t.title}" no assignee`;
      skipped.push(line);
      console.log(`[followup] skip: ${line}`);
      continue;
    }
    const ownerAad = assigneeAads[0];
    const block = hasBlockingFollowupForTask(t.id, ownerAad);
    if (block.blocked) {
      const line = `"${t.title}" ${block.reason}`;
      skipped.push(line);
      console.log(`[followup] skip: ${line}`);
      continue;
    }

    const ownerName = await resolveDisplayName(token, ownerAad);
    if (!ownerName) {
      const line = `"${t.title}" could not resolve name for aad=${ownerAad}`;
      skipped.push(line);
      console.log(`[followup] skip: ${line}`);
      continue;
    }
    if (!adapter || !hasConversationRef(ownerAad)) {
      const line = `"${t.title}" ${ownerName} hasn't DM'd the agent yet (no ConversationReference)`;
      skipped.push(line);
      console.log(`[followup] skip: ${line}`);
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
      console.log(
        `[followup] ✔ sent check-in to ${ownerName} (${ownerAad}) for "${t.title}" (due ${t.dueDateTime?.slice(0, 10)})`
      );
    } catch (err) {
      skipped.push(`"${t.title}" send failed: ${(err as Error)?.message}`);
      console.error(`[followup] send failed for "${t.title}":`, (err as Error)?.message);
    }
  }

  console.log(
    `[followup] Done. cardsSent=${cardsSent} skipped=${skipped.length}` +
      (skipped.length ? `\n  - ${skipped.join('\n  - ')}` : '')
  );
}
