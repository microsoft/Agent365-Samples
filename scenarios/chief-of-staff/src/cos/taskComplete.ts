// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// FR-7 Task Complete handler.
// Triggered by the Planner completion poller when a task in the tracked plan
// transitions to 100% complete. Returns a per-recipient delivery outcome so
// the poller retries only the notifications that failed.
//
// Deterministic implementation — no LLM in the loop:
//   1. Read the task from Graph (title + assignees).
//   2. DM every assignee: "✅ Thanks — <title> is marked complete."
//   3. DM the leader:     "✅ <owners> completed <title>."
//   4. If the title is prefixed [BLOCKER] / [RISK], call it out.

import axios from 'axios';
import { TurnContext, TurnState } from '@microsoft/agents-hosting';
import type { Client } from '../client';
import { acquireAppOnlyGraphToken } from '../graph/graphAppToken';
import { getPlannerTaskDetails } from '../graph/plannerTools';
import { sendPlainDmToUser } from '../cards/followupCards';
import { cancelOutstandingRequestsForTask } from '../state/followupStore';
import { providerError } from '../util/logger';

export interface TaskCompletePayload {
  taskId?: string;
  planId?: string;
  /** Recipients (AAD ids) notified on an earlier attempt — not messaged again. */
  alreadyDelivered?: string[];
}

/**
 * Outcome of a completion run. `complete` is true when every recipient has
 * been notified (or the task no longer needs notifications); otherwise the
 * poller keeps the transition and retries the remaining recipients.
 */
export interface TaskCompleteOutcome {
  complete: boolean;
  delivered: string[];
}

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

async function resolveDisplayName(token: string, aad: string): Promise<string | null> {
  try {
    const res = await axios.get(
      `${GRAPH_BASE}/users/${encodeURIComponent(aad)}?$select=displayName`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const name = (res.data?.displayName ?? '').toString().trim();
    return name || null;
  } catch (err) {
    console.warn(`[taskComplete] resolveDisplayName failed for aad=${aad.slice(0, 8)}…:`, providerError(err));
    return null;
  }
}

export async function runTaskComplete(
  payload: TaskCompletePayload,
  _ctx: TurnContext,
  _state: TurnState,
  client: Client
): Promise<TaskCompleteOutcome> {
  console.log('[taskComplete] Trigger received.', { taskId: payload.taskId?.slice(0, 8) });
  const alreadyDelivered = new Set((payload.alreadyDelivered ?? []).map((a) => a.toLowerCase()));
  const delivered: string[] = [];

  if (!payload.taskId) {
    console.warn('[taskComplete] Missing taskId in payload — skipping.');
    return { complete: true, delivered };
  }

  // 1) Load task details (title + assignees). A failure is retried later.
  const details = await getPlannerTaskDetails(payload.taskId);
  if (!details.ok) {
    console.warn(`[taskComplete] getPlannerTaskDetails failed (will retry): ${details.error}`);
    return { complete: false, delivered };
  }
  const title = details.title ?? '(untitled task)';
  const assignees = details.assigneeAads ?? [];
  console.log(
    `[taskComplete] task=${payload.taskId.slice(0, 8)}… percentComplete=${details.percentComplete} assignees=${assignees.length}`
  );

  // Only act on actual completions; a reopened task needs no notification.
  if ((details.percentComplete ?? 0) < 100) {
    console.log(
      `[taskComplete] task not 100% complete (percent=${details.percentComplete}) — skipping DMs.`
    );
    return { complete: true, delivered };
  }

  // Clear everything outstanding for this task: open check-ins (so the
  // escalation sweep doesn't fire after completion) AND owner requests still
  // waiting for delivery or a leader decision (so no obsolete extension or
  // blocker card reaches the leader). Cheap, in-memory — safe every time.
  const cancelled = cancelOutstandingRequestsForTask(payload.taskId);
  if (cancelled > 0) {
    console.log(
      `[taskComplete] cancelled ${cancelled} outstanding follow-up/request record(s) for task=${payload.taskId.slice(0, 8)}…`
    );
  }

  const isBlocker = title.startsWith('[BLOCKER]') || title.startsWith('[RISK]');
  const cleanTitle = title.replace(/^\[(BLOCKER|RISK)\]\s*/i, '').trim() || title;

  // Resolve display names in parallel.
  const token = await acquireAppOnlyGraphToken();
  const nameByAad = new Map<string, string>();
  await Promise.all(
    assignees.map(async (aad) => {
      const n = await resolveDisplayName(token, aad);
      nameByAad.set(aad, n ?? aad.slice(0, 8));
    })
  );

  const opts = client.getPeopleOpts();
  let allDelivered = true;

  // 2) DM every assignee not already notified.
  for (const aad of assignees) {
    if (alreadyDelivered.has(aad.toLowerCase())) continue;
    const ownerMsg =
      `✅ Thanks — **"${cleanTitle}"** is marked complete in Planner.` +
      (isBlocker ? `\n\nThat one was flagged as a blocker — great to see it resolved.` : '');
    const r = await sendPlainDmToUser(opts, aad, ownerMsg);
    if (r.ok) {
      delivered.push(aad);
    } else {
      allDelivered = false;
      console.warn(`[taskComplete] owner DM failed for ${aad.slice(0, 8)}… (will retry): ${r.error}`);
    }
  }

  // 3) DM the leader. Only an unconfigured leader skips this step; a
  // configured leader that can't be resolved right now (e.g. a transient
  // Graph failure) keeps the event pending so the next poll retries.
  const leaderConfigured = !!(process.env.LEADER_AAD_ID?.trim() || process.env.LEADER_UPN?.trim());
  if (!leaderConfigured) {
    console.warn('[taskComplete] LEADER_AAD_ID / LEADER_UPN not configured — skipping leader DM.');
    return { complete: allDelivered, delivered };
  }
  let leaderAad = process.env.LEADER_AAD_ID?.trim() || '';
  if (!leaderAad) {
    try {
      leaderAad = (await client.resolveUpnToAad(process.env.LEADER_UPN)) || '';
    } catch (err) {
      console.warn('[taskComplete] LEADER_UPN lookup threw:', providerError(err));
    }
  }
  if (!leaderAad) {
    console.warn('[taskComplete] LEADER_UPN could not be resolved right now — leader DM will be retried.');
    return { complete: false, delivered };
  }
  if (alreadyDelivered.has(leaderAad.toLowerCase())) {
    return { complete: allDelivered, delivered };
  }

  const ownerNames =
    assignees.length === 0
      ? 'Someone'
      : assignees.map((a) => nameByAad.get(a) ?? a.slice(0, 8)).join(', ');

  const leaderMsg = isBlocker
    ? `✅ **Blocker resolved** — ${ownerNames} completed **"${cleanTitle}"**.`
    : `✅ ${ownerNames} completed **"${cleanTitle}"**.`;

  const r = await sendPlainDmToUser(opts, leaderAad, leaderMsg);
  if (r.ok) {
    delivered.push(leaderAad);
    console.log(`[taskComplete] leader DM'd (${leaderAad.slice(0, 8)}…).`);
  } else {
    allDelivered = false;
    console.warn(`[taskComplete] leader DM failed (will retry): ${r.error}`);
  }
  return { complete: allDelivered, delivered };
}
