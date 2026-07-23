// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Planner completion poller. Every N minutes lists tasks in the configured
// plan and detects any that just transitioned from percentComplete < 100 →
// percentComplete === 100 since the last poll. Emits {taskId, planId} per
// transition for the scheduler to fire runTaskComplete.
//
// Uses the same Graph scopes as the planner_* tools (Tasks / Planner via
// User.Read.All etc.). No new consent needed.
//
// Persistence: the last-known percentComplete map is backed by
// PersistentMap. Without persistence, every restart re-seeds the baseline
// from the current plan snapshot — which silently swallows any completion
// that happened while the process was down. With persistence, we compare
// each new poll against the LAST-KNOWN state from disk, so any transition
// (even one that happened during downtime) fires runTaskComplete.

import axios from 'axios';
import { Authorization, TurnContext } from '@microsoft/agents-hosting';
import { acquireGraphToken } from './peopleTools';
import { PersistentMap } from '../state/persistentMap';
import { getPlannerPlanId } from './plannerConfig';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface CompletedTask {
  taskId: string;
  planId: string;
}

// taskId → last-known percentComplete (persisted between restarts)
const lastProgress = new PersistentMap<number>({
  file: 'planner-progress.json',
  // No TTL — task IDs are stable; entries are 8 bytes each.
});

// If we hydrated a baseline from disk, treat the first poll as a normal
// comparison (transitions that happened during downtime WILL fire). Only
// a truly cold start (empty file) needs the seed-and-suppress dance.
let firstPollDone = lastProgress.size > 0;
if (firstPollDone) {
  console.log(
    `[plannerPoller] hydrated baseline of ${lastProgress.size} task(s) from disk — completions during downtime will fire on next poll.`
  );
}

/**
 * Poll Planner for tasks that just became 100% complete. Empty on failure.
 * First poll after boot only seeds the baseline — no completions reported
 * (otherwise every already-done task would fire on first tick).
 */
export async function pollForCompletedTasks(opts: {
  authorization: Authorization;
  context: TurnContext;
  authHandlerName: string;
}): Promise<CompletedTask[]> {
  const planId = await getPlannerPlanId();
  if (!planId) return [];

  try {
    const token = await acquireGraphToken(opts);
    const res = await axios.get(
      `${GRAPH_BASE}/planner/plans/${planId}/tasks?$select=id,planId,percentComplete&$top=200`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const completedNow: CompletedTask[] = [];
    for (const t of res.data?.value ?? []) {
      const prev = lastProgress.get(t.id);
      const curr = typeof t.percentComplete === 'number' ? t.percentComplete : 0;
      // Only fire on transition to 100 that we actually witnessed happening.
      if (firstPollDone && prev !== undefined && prev < 100 && curr === 100) {
        completedNow.push({ taskId: t.id, planId: t.planId });
      }
      lastProgress.set(t.id, curr);
    }

    if (completedNow.length > 0) {
      console.log(
        `[plannerPoller] detected ${completedNow.length} newly-completed task(s): ${completedNow
          .map((t) => t.taskId.slice(0, 8))
          .join(', ')}`
      );
    }
    if (!firstPollDone) {
      firstPollDone = true;
      console.log(
        `[plannerPoller] baseline seeded with ${lastProgress.size} tasks — future completions will fire runTaskComplete.`
      );
    }
    return completedNow;
  } catch (err) {
    const e = err as any;
    console.warn('[plannerPoller] failed:', e?.response?.data ?? e?.message ?? String(e));
    return [];
  }
}
