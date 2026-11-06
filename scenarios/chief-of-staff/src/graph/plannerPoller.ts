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

import { graphHttp as axios } from './graphHttp';
import { Authorization, TurnContext } from '@microsoft/agents-hosting';
import { acquireGraphToken } from './peopleTools';
import { PersistentMap } from '../state/persistentMap';
import { getPlannerPlanId } from './plannerConfig';
import { providerError } from '../util/logger';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface CompletedTask {
  taskId: string;
  planId: string;
  /** Recipients (AAD ids) already notified on an earlier attempt. */
  alreadyDelivered: string[];
}

// taskId → last-known percentComplete (persisted between restarts)
const lastProgress = new PersistentMap<number>({
  file: 'planner-progress.json',
  // No TTL — task IDs are stable; entries are 8 bytes each.
});

// Completion transitions that still need their notifications delivered.
// Kept separate from the progress baseline so a failed delivery is retried
// on the next poll instead of being lost once the baseline reads 100%.
interface PendingCompletion {
  planId: string;
  detectedAt: number;
  attempts: number;
  delivered: string[];
}
const pendingCompletions = new PersistentMap<PendingCompletion>({
  file: 'planner-completions-pending.json',
});
const MAX_COMPLETION_ATTEMPTS = Number(process.env.TASK_COMPLETE_MAX_ATTEMPTS ?? '12');

/**
 * Record the outcome of a completion run. Fully delivered (or no longer
 * applicable) transitions are removed; partial deliveries keep the
 * recipients already notified so they aren't messaged twice on retry.
 */
export function acknowledgeCompletion(
  taskId: string,
  outcome: { complete: boolean; delivered: string[] }
): void {
  const entry = pendingCompletions.get(taskId);
  if (!entry) return;
  if (outcome.complete) {
    pendingCompletions.delete(taskId);
    return;
  }
  entry.attempts += 1;
  entry.delivered = Array.from(new Set([...entry.delivered, ...outcome.delivered]));
  if (entry.attempts >= MAX_COMPLETION_ATTEMPTS) {
    console.warn(
      `[plannerPoller] giving up on completion notifications for task ${taskId.slice(0, 8)} after ${entry.attempts} attempt(s).`
    );
    pendingCompletions.delete(taskId);
    return;
  }
  pendingCompletions.set(taskId, entry);
}

function pendingAsCompletedTasks(): CompletedTask[] {
  return Array.from(pendingCompletions.entries()).map(([taskId, p]) => ({
    taskId,
    planId: p.planId,
    alreadyDelivered: p.delivered,
  }));
}

// If we hydrated a baseline from disk, treat the first poll as a normal
// comparison (transitions that happened during downtime WILL fire). Only
// a truly cold start (empty file) needs the seed-and-suppress dance.
// When the baseline was first seeded. A task first seen AFTER seeding that is
// already 100% was created after the agent started watching and completed
// before its first poll (e.g. a captured task completed by chat within one
// POLL_TASKS_MS) — that is a real completion and must notify. Tasks that
// already existed at seed time stay suppressed.
const pollerMeta = new PersistentMap<number>({ file: 'planner-poller-meta.json' });
// Begin watching immediately, not only after the first successful poll.
// Pre-existing completed tasks remain suppressed; tasks created while the
// initial Graph request is failing still generate completion notifications.
const watchingSince = pollerMeta.get('seededAt') ?? Date.now();

// Seeded before (even for a plan that was empty then) → compare normally.
let firstPollDone = lastProgress.size > 0 || pollerMeta.get('seededAt') !== undefined;
if (firstPollDone) {
  console.log(
    `[plannerPoller] hydrated baseline of ${lastProgress.size} task(s) from disk — completions during downtime will fire on next poll.`
  );
}

if (firstPollDone && pollerMeta.get('seededAt') === undefined) {
  // Baseline hydrated from an older version without this marker.
  pollerMeta.set('seededAt', Date.now());
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
  if (!planId) return pendingAsCompletedTasks();

  try {
    const token = await acquireGraphToken(opts);
    const res = await axios.get(
      `${GRAPH_BASE}/planner/plans/${planId}/tasks?$select=id,planId,percentComplete,createdDateTime&$top=200`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const completedNow: string[] = [];
    for (const t of res.data?.value ?? []) {
      const prev = lastProgress.get(t.id);
      const curr = typeof t.percentComplete === 'number' ? t.percentComplete : 0;
      // Fire on a witnessed transition to 100, or on a task created after the
      // baseline was seeded that is already complete when first seen.
      const seededAt = pollerMeta.get('seededAt') ?? watchingSince;
      const created = t.createdDateTime ? Date.parse(t.createdDateTime) : NaN;
      const newSinceSeed =
        prev === undefined && seededAt !== undefined && Number.isFinite(created) && created >= seededAt;
      if (curr === 100 && ((firstPollDone && prev !== undefined && prev < 100) || newSinceSeed)) {
        completedNow.push(t.id);
        if (!pendingCompletions.has(t.id)) {
          pendingCompletions.set(t.id, { planId: t.planId, detectedAt: Date.now(), attempts: 0, delivered: [] });
        }
      }
      lastProgress.set(t.id, curr);
    }

    if (completedNow.length > 0) {
      console.log(
        `[plannerPoller] detected ${completedNow.length} newly-completed task(s): ${completedNow
          .map((id) => id.slice(0, 8))
          .join(', ')}`
      );
    }
    if (!firstPollDone) {
      firstPollDone = true;
      pollerMeta.set('seededAt', watchingSince);
      console.log(
        `[plannerPoller] baseline seeded with ${lastProgress.size} tasks — future completions will fire runTaskComplete.`
      );
    }
    // New transitions plus any earlier ones whose notifications haven't
    // been fully delivered yet.
    return pendingAsCompletedTasks();
  } catch (err) {
    const e = err as any;
    console.warn('[plannerPoller] failed:', providerError(err));
    // Still retry undelivered notifications from earlier polls.
    return pendingAsCompletedTasks();
  }
}
