// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// FR-7 Task Complete handler.
// Triggered by a `[COS-TASK-COMPLETE]` email from Power Automate when a Planner
// task in the tracked plan is marked complete.
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
import { findOpenFollowupsForTask, markResolved } from '../state/followupStore';

export interface TaskCompletePayload {
  taskId?: string;
  planId?: string;
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
    console.warn(`[taskComplete] resolveDisplayName failed for aad=${aad}:`, (err as Error)?.message);
    return null;
  }
}

export async function runTaskComplete(
  payload: TaskCompletePayload,
  _ctx: TurnContext,
  _state: TurnState,
  client: Client
): Promise<void> {
  console.log('[taskComplete] Trigger received.', payload);

  if (!payload.taskId) {
    console.warn('[taskComplete] Missing taskId in payload — skipping.');
    return;
  }

  // 1) Load task details (title + assignees).
  const details = await getPlannerTaskDetails(payload.taskId);
  if (!details.ok) {
    console.warn(`[taskComplete] getPlannerTaskDetails failed: ${details.error}`);
    return;
  }
  const title = details.title ?? '(untitled task)';
  const assignees = details.assigneeAads ?? [];
  console.log(
    `[taskComplete] task="${title}" percentComplete=${details.percentComplete} assignees=${assignees.length}`
  );

  // Only act on actual completions. Power Automate can fire twice; ignore
  // anything that isn't 100% (belt & suspenders — Graph should reflect it
  // by the time we receive the mail).
  if ((details.percentComplete ?? 0) < 100) {
    console.log(
      `[taskComplete] task not 100% complete (percent=${details.percentComplete}) — skipping DMs.`
    );
    return;
  }

  // Clear any outstanding follow-ups for this task so the escalation sweep
  // doesn't fire an "Escalation — no reply" card AFTER we've already
  // confirmed completion. Cheap, in-memory — safe to call every time.
  const openFollowups = findOpenFollowupsForTask(payload.taskId);
  if (openFollowups.length > 0) {
    for (const f of openFollowups) markResolved(f.followupId);
    console.log(
      `[taskComplete] resolved ${openFollowups.length} open follow-up(s) for task ${payload.taskId} (was ${openFollowups
        .map((f) => f.status)
        .join(', ')}).`
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

  // 2) DM every assignee.
  for (const aad of assignees) {
    const ownerMsg =
      `✅ Thanks — **"${cleanTitle}"** is marked complete in Planner.` +
      (isBlocker ? `\n\nThat one was flagged as a blocker — great to see it resolved.` : '');
    const r = await sendPlainDmToUser(opts, aad, ownerMsg);
    if (!r.ok) {
      console.warn(`[taskComplete] owner DM failed for ${aad}: ${r.error}`);
    }
  }

  // 3) DM the leader.
  const leaderAad =
    process.env.LEADER_AAD_ID?.trim() ||
    (await client.resolveUpnToAad(process.env.LEADER_UPN)) ||
    '';

  if (!leaderAad) {
    console.warn('[taskComplete] LEADER_AAD_ID / LEADER_UPN not configured — skipping leader DM.');
    return;
  }

  const ownerNames =
    assignees.length === 0
      ? 'Someone'
      : assignees.map((a) => nameByAad.get(a) ?? a.slice(0, 8)).join(', ');

  const leaderMsg = isBlocker
    ? `✅ **Blocker resolved** — ${ownerNames} completed **"${cleanTitle}"**.`
    : `✅ ${ownerNames} completed **"${cleanTitle}"**.`;

  const r = await sendPlainDmToUser(opts, leaderAad, leaderMsg);
  if (!r.ok) {
    console.warn(`[taskComplete] leader DM failed: ${r.error}`);
  } else {
    console.log(`[taskComplete] leader DM'd (${leaderAad.slice(0, 8)}…).`);
  }
}

