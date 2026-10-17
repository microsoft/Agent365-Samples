// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Graph-backed Planner tools. The A365 platform doesn't currently host
// `mcp_PlannerServer` in this tenant (POST returns 404 "Server does not
// exist"), so we call Microsoft Graph's /planner/* endpoints directly.
//
// AUTH: every Graph call here uses the standalone cos-graph-worker app
// (application permissions via client credentials — see graphAppToken.ts).
// The `PlannerToolOptions` shape is retained for API compatibility with
// client.ts but its `authorization` / `context` / `authHandlerName` fields
// are intentionally ignored — nothing on the blueprint / agent-instance
// identity needs `Tasks.ReadWrite.All`. Keeps consent minimal.
//
// Tools exposed to the LLM:
//   planner_list_tasks   — list tasks in a plan
//   planner_get_task     — read a single task's details
//   planner_create_task  — create a task in a bucket, optionally assigned
//
// Uses raw JSON Schema (not Zod) so we can explicitly set
// `additionalProperties: false` — required by Azure OpenAI's strict function
// schema validator on the /openai/deployments/... path.

import axios from 'axios';
import { tool } from '@openai/agents';
import { Authorization, TurnContext } from '@microsoft/agents-hosting';
import { getPlannerPlanId, getPlannerBucketId } from './plannerConfig';
import { acquireAppOnlyGraphToken } from './graphAppToken';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface PlannerToolOptions {
  // Kept for API compat with client.ts wiring; unused for auth now that
  // Graph calls go through the standalone worker.
  authorization: Authorization;
  context: TurnContext;
  authHandlerName: string;
}

// All Graph calls (LLM tools + deterministic helpers below) use the same
// cos-graph-worker credentials. This function is a thin shim so we don't
// have to rewrite every call site.
async function acquireGraphToken(_opts: PlannerToolOptions): Promise<string> {
  return acquireAppOnlyGraphToken();
}

function defaultPlanId(): Promise<string | undefined> {
  return getPlannerPlanId();
}

function defaultBucketId(): Promise<string | undefined> {
  return getPlannerBucketId();
}

function toolError(name: string, err: unknown): string {
  const e = err as any;
  const msg = e?.response?.data ?? e?.message ?? String(e);
  console.error(`[plannerTools] ${name} failed:`, msg);
  return JSON.stringify({ ok: false, tool: name, error: msg });
}

// ─── Plan boundary ─────────────────────────────────────────────────────────
// Every Planner call uses the worker's tenant-wide application permissions,
// so the configured leadership plan is the ONLY plan this agent reads or
// writes. A caller (or the model) can't widen that by supplying another
// plan, bucket, or task id.
export async function getAllowedPlanId(): Promise<string | undefined> {
  return defaultPlanId();
}

async function resolveAllowedPlan(
  requested?: string | null
): Promise<{ ok: true; planId: string } | { ok: false; error: string }> {
  const allowed = await getAllowedPlanId();
  if (!allowed) {
    return { ok: false, error: 'No Planner plan configured (PLANNER_PLAN_ID or LEADERSHIP_TEAM_ID auto-resolve)' };
  }
  if (requested && requested !== allowed) {
    return { ok: false, error: 'Only the configured leadership plan can be accessed.' };
  }
  return { ok: true, planId: allowed };
}

/** True when a task's planId is the configured leadership plan. */
export async function isTaskInAllowedPlan(taskPlanId: string | undefined | null): Promise<boolean> {
  const allowed = await getAllowedPlanId();
  return !!allowed && !!taskPlanId && taskPlanId === allowed;
}

async function resolveAllowedBucket(
  planId: string,
  requested: string | null | undefined,
  token: string
): Promise<{ ok: true; bucketId: string } | { ok: false; error: string }> {
  const fallback = await defaultBucketId();
  const bucketId = requested || fallback;
  if (!bucketId) return { ok: false, error: 'No bucketId (PLANNER_BUCKET_NEW or team auto-resolve)' };
  if (bucketId === fallback) return { ok: true, bucketId };
  // Any other bucket must belong to the allowed plan.
  try {
    const res = await axios.get(
      `${GRAPH_BASE}/planner/buckets/${encodeURIComponent(bucketId)}?$select=id,planId`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.data?.planId !== planId) return { ok: false, error: 'That bucket is not in the leadership plan.' };
    return { ok: true, bucketId };
  } catch {
    return { ok: false, error: 'Could not verify the bucket belongs to the leadership plan.' };
  }
}

// ─── Deterministic task creation (shared by the tool and meeting capture) ──
export interface CreatePlannerTaskInput {
  title: string;
  description?: string | null;
  planId?: string | null;
  bucketId?: string | null;
  assigneeAadIds?: string[] | null;
  dueDateTime?: string | null;
  priority?: number | null;
}

export type CreatePlannerTaskResult =
  | { ok: true; taskId: string; title: string; bucketId: string; assignees: string[]; descriptionSaved?: boolean }
  /** `taskId` is set when the task exists but a follow-up write failed. */
  | { ok: false; error: string; taskId?: string };

/**
 * Create one task in the configured leadership plan. When a description is
 * supplied and its write fails, returns ok:false WITH the new taskId so the
 * caller can record the task and retry only the description.
 */
export async function createPlannerTaskDirect(input: CreatePlannerTaskInput): Promise<CreatePlannerTaskResult> {
  try {
    if (!input.title?.trim()) return { ok: false, error: 'title is required' };
    const plan = await resolveAllowedPlan(input.planId);
    if (!plan.ok) return { ok: false, error: plan.error };
    const token = await acquireAppOnlyGraphToken();
    const bucket = await resolveAllowedBucket(plan.planId, input.bucketId, token);
    if (!bucket.ok) return { ok: false, error: bucket.error };

    const assignees =
      input.assigneeAadIds && input.assigneeAadIds.length > 0
        ? input.assigneeAadIds
        : ([process.env.LEADER_AAD_ID?.trim()].filter(Boolean) as string[]);
    const assignments: Record<string, unknown> = {};
    for (const aad of assignees) {
      assignments[aad] = { '@odata.type': '#microsoft.graph.plannerAssignment', orderHint: ' !' };
    }
    const body: Record<string, unknown> = { planId: plan.planId, bucketId: bucket.bucketId, title: input.title.trim() };
    if (Object.keys(assignments).length > 0) body.assignments = assignments;
    if (input.dueDateTime) body.dueDateTime = input.dueDateTime;
    if (typeof input.priority === 'number') body.priority = input.priority;

    const res = await axios.post(`${GRAPH_BASE}/planner/tasks`, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const taskId = String(res.data.id);
    const description = input.description?.trim();
    if (description) {
      const saved = await setPlannerTaskDescription(taskId, description, token);
      if (!saved.ok) {
        return { ok: false, taskId, error: `task created but its description could not be saved (${saved.error})` };
      }
    }
    return {
      ok: true,
      taskId,
      title: res.data.title,
      bucketId: res.data.bucketId,
      assignees,
      ...(description ? { descriptionSaved: true } : {}),
    };
  } catch (err) {
    const e = err as any;
    const msg = e?.response?.data ?? e?.message ?? String(e);
    return { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) };
  }
}

// ─── Tool argument types ───────────────────────────────────────────────────
interface ListTasksArgs {
  planId?: string | null;
}

interface GetTaskArgs {
  taskId: string;
}

type CreateTaskArgs = CreatePlannerTaskInput;

// ─── planner_list_tasks ────────────────────────────────────────────────────
function createListTasksTool(opts: PlannerToolOptions) {
  return tool({
    name: 'planner_list_tasks',
    description:
      'List open Planner tasks in the leadership plan. Returns id, title, bucketId, dueDateTime, percentComplete, and assignments.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        planId: {
          type: ['string', 'null'],
          description: 'Leave null. Only the configured leadership plan can be read.',
        },
      },
      required: ['planId'],
    } as any,
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs ?? {}) as ListTasksArgs;
      try {
        const plan = await resolveAllowedPlan(args.planId);
        if (!plan.ok) return toolError('planner_list_tasks', plan.error);
        const token = await acquireGraphToken(opts);
        const res = await axios.get(`${GRAPH_BASE}/planner/plans/${encodeURIComponent(plan.planId)}/tasks`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const tasks = (res.data.value ?? []).map((t: any) => ({
          id: t.id,
          title: t.title,
          bucketId: t.bucketId,
          dueDateTime: t.dueDateTime,
          percentComplete: t.percentComplete,
          assignments: Object.keys(t.assignments ?? {}),
          createdDateTime: t.createdDateTime,
        }));
        return JSON.stringify({ ok: true, count: tasks.length, tasks });
      } catch (err) {
        return toolError('planner_list_tasks', err);
      }
    },
  });
}

// ─── planner_get_task ──────────────────────────────────────────────────────
function createGetTaskTool(opts: PlannerToolOptions) {
  return tool({
    name: 'planner_get_task',
    description:
      'Read a single task from the leadership plan with all fields (title, description, dueDateTime, assignments, percentComplete, bucketId, priority).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: {
          type: 'string',
          description: 'Planner task id.',
        },
      },
      required: ['taskId'],
    } as any,
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs ?? {}) as GetTaskArgs;
      try {
        if (!args.taskId) return toolError('planner_get_task', 'taskId is required');
        const token = await acquireGraphToken(opts);
        const res = await axios.get(`${GRAPH_BASE}/planner/tasks/${encodeURIComponent(args.taskId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const t = res.data;
        // Never return tasks from other plans the worker app can technically read.
        if (!(await isTaskInAllowedPlan(t?.planId))) {
          return toolError('planner_get_task', 'That task is not in the leadership plan.');
        }
        let description: string | undefined;
        if (t.hasDescription) {
          try {
            const details = await axios.get(
              `${GRAPH_BASE}/planner/tasks/${encodeURIComponent(args.taskId)}/details?$select=description`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            description = details.data?.description || undefined;
          } catch (err) {
            console.warn('[plannerTools] planner_get_task could not read description:', (err as Error)?.message);
          }
        }
        return JSON.stringify({
          ok: true,
          task: {
            id: t.id,
            title: t.title,
            bucketId: t.bucketId,
            planId: t.planId,
            dueDateTime: t.dueDateTime,
            startDateTime: t.startDateTime,
            percentComplete: t.percentComplete,
            priority: t.priority,
            assignments: Object.keys(t.assignments ?? {}),
            createdDateTime: t.createdDateTime,
            hasDescription: !!t.hasDescription,
            description,
          },
        });
      } catch (err) {
        return toolError('planner_get_task', err);
      }
    },
  });
}

// ─── planner_create_task ───────────────────────────────────────────────────
function createCreateTaskTool(_opts: PlannerToolOptions) {
  return tool({
    name: 'planner_create_task',
    description:
      'Create a new task in the leadership plan, optionally with assignees, a due date, and a description. ' +
      'Each call creates a separate task. (Meeting capture does not use this tool; it writes tasks deterministically.)',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          description: 'Task title. Keep it short and action-oriented.',
        },
        description: {
          type: ['string', 'null'],
          description:
            'Decision context, rationale, or instructions. Stored in the Planner task details so it can be recalled later.',
        },
        planId: {
          type: ['string', 'null'],
          description: 'Leave null. Only the configured leadership plan can be written.',
        },
        bucketId: {
          type: ['string', 'null'],
          description: 'Bucket in the leadership plan. Defaults to the "New" bucket.',
        },
        assigneeAadIds: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description:
            'AAD Object IDs of users to assign. If null or empty, defaults to LEADER_AAD_ID.',
        },
        dueDateTime: {
          type: ['string', 'null'],
          description: 'Due date in ISO 8601 (e.g. 2026-07-15T00:00:00Z).',
        },
        priority: {
          type: ['integer', 'null'],
          description: '0=urgent, 3=important, 5=medium, 9=low. Defaults to 5.',
        },
      },
      required: ['title', 'description', 'planId', 'bucketId', 'assigneeAadIds', 'dueDateTime', 'priority'],
    } as any,
    execute: async (rawArgs: unknown) => {
      const args = (rawArgs ?? {}) as CreateTaskArgs;
      const r = await createPlannerTaskDirect(args);
      if (r.ok) return JSON.stringify(r);
      if (r.taskId) {
        // The task exists; only the description failed. Report it so the
        // model doesn't create the same task again.
        return JSON.stringify({
          ok: true,
          taskId: r.taskId,
          descriptionSaved: false,
          warning: 'The task was created, but its description could not be saved. Do not create it again.',
        });
      }
      return toolError('planner_create_task', r.error);
    },
  });
}

// ─── Public factory ────────────────────────────────────────────────────────
export function createPlannerTools(opts: PlannerToolOptions) {
  return [
    createListTasksTool(opts),
    createGetTaskTool(opts),
    createCreateTaskTool(opts),
  ];
}

// ─── Programmatic helper: acknowledge a Planner task ───────────────────────
// Called from actionRouter.ts when an owner clicks "Got it" on a task-
// assignment card. Marks the task as started so the acknowledgement is
// visible in Planner (progress dot moves from "Not started" to "In progress")
// without touching due date or assignments. Uses the standalone Graph worker
// app-permission token — no delegated auth needed.
// (acquireAppOnlyGraphToken is imported at the top of the file.)

/** Small ISO date offset a few seconds so the ETag stays stable if idempotent. */
export async function acknowledgePlannerTask(
  taskId: string,
  ackByName: string
): Promise<{ ok: true; percentComplete: number; startDateTime: string; alreadyStarted: boolean } | { ok: false; error: string }> {
  try {
    if (!taskId) return { ok: false, error: 'taskId is empty' };
    const token = await acquireAppOnlyGraphToken();

    // 1) GET the task to grab its ETag (required for PATCH's If-Match).
    const getRes = await axios.get(
      `${GRAPH_BASE}/planner/tasks/${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const etag = getRes.data['@odata.etag'];
    if (!etag) return { ok: false, error: 'Planner task response missing @odata.etag' };
    const currentPct = Number(getRes.data.percentComplete ?? 0);

    // If already in progress or complete, don't overwrite. Just report back.
    if (currentPct >= 50) {
      console.log(
        `[plannerTools] acknowledgePlannerTask task=${taskId.slice(0, 8)}… skipped (already ${currentPct}%)`
      );
      return {
        ok: true,
        percentComplete: currentPct,
        startDateTime: getRes.data.startDateTime,
        alreadyStarted: true,
      };
    }

    // 2) PATCH percentComplete=5 (visible "started" indicator) and set
    //    startDateTime=now if not already set.
    const newPct = currentPct > 0 ? currentPct : 5;
    const startIso = getRes.data.startDateTime ?? new Date().toISOString();
    await axios.patch(
      `${GRAPH_BASE}/planner/tasks/${encodeURIComponent(taskId)}`,
      { percentComplete: newPct, startDateTime: startIso },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'If-Match': etag,
        },
      }
    );
    console.log(
      `[plannerTools] acknowledgePlannerTask task=${taskId.slice(0, 8)}… pct=${newPct} startDate=${startIso.slice(0, 10)}`
    );
    return { ok: true, percentComplete: newPct, startDateTime: startIso, alreadyStarted: false };
  } catch (err) {
    const msg = (err as any)?.response?.data ?? (err as any)?.message ?? String(err);
    console.error(`[plannerTools] acknowledgePlannerTask failed for task=${taskId}:`, msg);
    return { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) };
  }
}

// ─── Programmatic helper: extend a Planner task's due date ─────────────────
// Called from actionRouter.ts when the leader clicks "Approve extension" on
// an extension-request card. PATCHes ONLY the dueDateTime on the existing
// task (no duplicate task creation). Uses ETag If-Match to be safe against
// concurrent edits.
export async function updatePlannerTaskDueDate(
  taskId: string,
  newDueIso: string
): Promise<{ ok: true; previousDue?: string; newDue: string } | { ok: false; error: string }> {
  try {
    if (!taskId) return { ok: false, error: 'taskId is empty' };
    if (!newDueIso) return { ok: false, error: 'newDueIso is empty' };

    // Normalize input: accept "YYYY-MM-DD" or full ISO. Planner needs full ISO.
    let dueIso = newDueIso.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(dueIso)) dueIso = `${dueIso}T00:00:00Z`;
    if (Number.isNaN(new Date(dueIso).getTime())) {
      return { ok: false, error: `newDueIso is not a valid ISO date: ${newDueIso}` };
    }

    const token = await acquireAppOnlyGraphToken();

    // GET for ETag.
    const getRes = await axios.get(
      `${GRAPH_BASE}/planner/tasks/${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const etag = getRes.data['@odata.etag'];
    if (!etag) return { ok: false, error: 'Planner task response missing @odata.etag' };
    const previousDue: string | undefined = getRes.data.dueDateTime;

    // PATCH only the dueDateTime.
    await axios.patch(
      `${GRAPH_BASE}/planner/tasks/${encodeURIComponent(taskId)}`,
      { dueDateTime: dueIso },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'If-Match': etag,
        },
      }
    );
    console.log(
      `[plannerTools] updatePlannerTaskDueDate task=${taskId.slice(0, 8)}… previousDue=${previousDue ?? '∅'} newDue=${dueIso}`
    );
    return { ok: true, previousDue, newDue: dueIso };
  } catch (err) {
    const msg = (err as any)?.response?.data ?? (err as any)?.message ?? String(err);
    console.error(`[plannerTools] updatePlannerTaskDueDate failed for task=${taskId}:`, msg);
    return { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) };
  }
}

// ─── Programmatic helper: rename a Planner task ───────────────────────────
// Called from actionRouter.ts book_meeting handler to prepend "[BLOCKER] "
// to the task title so the brief's Risks section surfaces it and the
// taskComplete handler DMs the leader when it's closed. Idempotent — if
// the prefix is already present, we skip the PATCH.
export async function updatePlannerTaskTitle(
  taskId: string,
  newTitle: string
): Promise<{ ok: true; previousTitle?: string; newTitle: string; skipped?: boolean } | { ok: false; error: string }> {
  try {
    if (!taskId) return { ok: false, error: 'taskId is empty' };
    if (!newTitle || !newTitle.trim()) return { ok: false, error: 'newTitle is empty' };

    const token = await acquireAppOnlyGraphToken();

    // GET for ETag + current title (avoid PATCH if already correct).
    const getRes = await axios.get(
      `${GRAPH_BASE}/planner/tasks/${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const etag = getRes.data['@odata.etag'];
    if (!etag) return { ok: false, error: 'Planner task response missing @odata.etag' };
    const previousTitle: string | undefined = getRes.data.title;
    if (previousTitle && previousTitle.trim() === newTitle.trim()) {
      return { ok: true, previousTitle, newTitle, skipped: true };
    }

    await axios.patch(
      `${GRAPH_BASE}/planner/tasks/${encodeURIComponent(taskId)}`,
      { title: newTitle },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'If-Match': etag,
        },
      }
    );
    console.log(
      `[plannerTools] updatePlannerTaskTitle task=${taskId.slice(0, 8)}… title updated`
    );
    return { ok: true, previousTitle, newTitle };
  } catch (err) {
    const msg = (err as any)?.response?.data ?? (err as any)?.message ?? String(err);
    console.error(`[plannerTools] updatePlannerTaskTitle failed for task=${taskId}:`, msg);
    return { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) };
  }
}

// ─── Programmatic helper: write a Planner task description ────────────────
// Planner stores the description on the separate /details resource, which
// needs its own ETag. Called right after task creation so decision context
// from a captured meeting survives in Planner (the source of truth).
export async function setPlannerTaskDescription(
  taskId: string,
  description: string,
  token?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const bearer = token ?? (await acquireAppOnlyGraphToken());
    const url = `${GRAPH_BASE}/planner/tasks/${encodeURIComponent(taskId)}/details`;
    // Details are created asynchronously after the task; retry briefly.
    let etag: string | undefined;
    for (let attempt = 0; attempt < 3 && !etag; attempt++) {
      try {
        const getRes = await axios.get(url, { headers: { Authorization: `Bearer ${bearer}` } });
        etag = getRes.data?.['@odata.etag'];
      } catch (err) {
        if ((err as any)?.response?.status !== 404 || attempt === 2) throw err;
      }
      if (!etag) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    if (!etag) return { ok: false, error: 'Planner task details response missing @odata.etag' };
    await axios.patch(
      url,
      { description, previewType: 'description' },
      {
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
          'If-Match': etag,
        },
      }
    );
    return { ok: true };
  } catch (err) {
    const msg = (err as any)?.response?.data ?? (err as any)?.message ?? String(err);
    return { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) };
  }
}

// ─── Programmatic helper: get full Planner task details ────────────────────
// Used by runTaskComplete to fetch title + assignees for the completion DMs.
export async function getPlannerTaskDetails(
  taskId: string
): Promise<
  | { ok: true; title: string; assigneeAads: string[]; percentComplete: number; planId: string }
  | { ok: false; error: string; notFound: boolean }
> {
  try {
    if (!taskId) return { ok: false, error: 'taskId is empty', notFound: false };
    const token = await acquireAppOnlyGraphToken();
    const res = await axios.get(
      `${GRAPH_BASE}/planner/tasks/${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const title = String(res.data?.title ?? '').trim();
    const assignments = (res.data?.assignments ?? {}) as Record<string, unknown>;
    const assigneeAads = Object.keys(assignments);
    const pct = Number(res.data?.percentComplete ?? 0);
    return { ok: true, title, assigneeAads, percentComplete: pct, planId: String(res.data?.planId ?? '') };
  } catch (err) {
    const msg = (err as any)?.response?.data ?? (err as any)?.message ?? String(err);
    // Only a 404 proves the task is gone; throttling, 5xx, and transport
    // errors are indeterminate.
    const notFound = (err as any)?.response?.status === 404;
    console.error(`[plannerTools] getPlannerTaskDetails failed for task=${taskId.slice(0, 8)}… (status=${(err as any)?.response?.status ?? 'n/a'}):`, msg);
    return { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg), notFound };
  }
}

// ─── Programmatic helper: mark a Planner task 100% complete ───────────────
// Called from actionRouter.ts when the owner tells the agent the task is
// done (e.g. "complete" / "done" / "finished"). Idempotent — if the task is
// already at 100%, we skip the PATCH.
export async function completePlannerTask(
  taskId: string
): Promise<
  | { ok: true; title?: string; previousPercent: number; alreadyComplete: boolean }
  | { ok: false; error: string }
> {
  try {
    if (!taskId) return { ok: false, error: 'taskId is empty' };
    const token = await acquireAppOnlyGraphToken();

    // GET for ETag + current percentComplete (avoid PATCH if already 100).
    const getRes = await axios.get(
      `${GRAPH_BASE}/planner/tasks/${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const etag = getRes.data['@odata.etag'];
    if (!etag) return { ok: false, error: 'Planner task response missing @odata.etag' };
    const title: string | undefined = getRes.data?.title;
    const previousPercent = Number(getRes.data?.percentComplete ?? 0);
    if (previousPercent >= 100) {
      return { ok: true, title, previousPercent, alreadyComplete: true };
    }

    await axios.patch(
      `${GRAPH_BASE}/planner/tasks/${encodeURIComponent(taskId)}`,
      { percentComplete: 100 },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'If-Match': etag,
        },
      }
    );
    console.log(
      `[plannerTools] completePlannerTask task=${taskId.slice(0, 8)}… ${previousPercent}% → 100%`
    );
    return { ok: true, title, previousPercent, alreadyComplete: false };
  } catch (err) {
    const msg = (err as any)?.response?.data ?? (err as any)?.message ?? String(err);
    console.error(`[plannerTools] completePlannerTask failed for task=${taskId}:`, msg);
    return { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) };
  }
}

// ─── Programmatic helper: fuzzy-find an OPEN Planner task by title ────────
// Used by actionRouter when the owner tells the agent (in chat) that a task
// is done and includes the task title. Returns a single unambiguous match,
// or reports 'ambiguous' / 'not_found' / 'none_assigned' so the caller can
// prompt for clarification instead of silently guessing.
//
// Matching rules (all case-insensitive, ignoring [BLOCKER]/[RISK]/[DECISION]/
// [COMPLETED] prefixes):
//   1. Exact match — LOSSLESS: only case, whitespace, and the prefix above are
//      ignored; punctuation and non-ASCII letters must match ("C#" ≠ "C++").
//      Only this tier may be acted on without confirmation.
//   2. Query is a substring of title → keep as candidate.
//   3. Every word in query appears in title → keep as candidate (word-set).
// If we end up with exactly one candidate → return it. If assigneeAad is
// provided, we prefer tasks assigned to that user; if there's a unique
// match among their tasks we use that even when other candidates exist.
export async function findOpenTaskByTitle(
  titleHint: string,
  opts?: { assigneeAad?: string; planId?: string; onlyAssignedTo?: string }
): Promise<
  | { ok: true; taskId: string; title: string; percentComplete: number; matchType: 'exact' | 'substring' | 'wordset' }
  | { ok: false; reason: 'not_found' | 'ambiguous' | 'no_plan_id' | 'graph_error'; candidates?: Array<{ taskId: string; title: string }>; error?: string }
> {
  const planId = opts?.planId ?? (await defaultPlanId());
  if (!planId) return { ok: false, reason: 'no_plan_id' };
  if (!titleHint?.trim()) return { ok: false, reason: 'not_found' };

  const stripPrefix = (s: string) => s.replace(/^\s*\[(blocker|risk|decision|completed)\]\s*/i, '');
  // Lossless key for the exact tier: case + whitespace only.
  const exactKey = (s: string) => stripPrefix(s.normalize('NFC')).toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  // Lossy key for suggestions (substring / word-set) that always need confirmation.
  const normalize = (s: string) =>
    stripPrefix(s.normalize('NFC'))
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const queryExact = exactKey(titleHint);
  const queryNorm = normalize(titleHint);
  if (!queryNorm) return { ok: false, reason: 'not_found' };
  // Keep every identifying token (Q2, v1, 12…). Only drop filler words that
  // never distinguish one task from another.
  const FILLER = new Set(['a', 'an', 'the', 'to', 'for', 'of', 'and', 'on', 'in']);
  const queryWords = queryNorm.split(' ').filter((w) => w && !FILLER.has(w));
  const restrictTo = opts?.onlyAssignedTo?.toLowerCase();

  try {
    const token = await acquireAppOnlyGraphToken();
    const res = await axios.get(
      `${GRAPH_BASE}/planner/plans/${encodeURIComponent(planId)}/tasks?$select=id,title,percentComplete,assignments&$top=200`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const tasks = ((res.data?.value ?? []) as Array<{
      id: string;
      title: string;
      percentComplete: number;
      assignments?: Record<string, unknown>;
    }>).filter((t) => (t?.percentComplete ?? 0) < 100)
      .filter(
        (t) =>
          !restrictTo ||
          Object.keys(t.assignments ?? {}).some((aad) => aad.toLowerCase() === restrictTo)
      );

    if (tasks.length === 0) return { ok: false, reason: 'not_found' };

    type Candidate = { taskId: string; title: string; percentComplete: number; matchType: 'exact' | 'substring' | 'wordset'; assignedToUser: boolean };
    const candidates: Candidate[] = [];

    for (const t of tasks) {
      const titleNorm = normalize(t.title ?? '');
      if (!titleNorm) continue;
      const titleTokens = new Set(titleNorm.split(' '));
      const assignedToUser =
        !!opts?.assigneeAad && !!t.assignments && Object.keys(t.assignments).some((aad) => aad.toLowerCase() === opts.assigneeAad!.toLowerCase());

      let matchType: Candidate['matchType'] | null = null;
      if (exactKey(t.title ?? '') === queryExact) matchType = 'exact';
      // Equal only after dropping punctuation (e.g. "C#" vs "C++") is a
      // suggestion, never an automatic match.
      else if (titleNorm === queryNorm) matchType = 'substring';
      else if (` ${titleNorm} `.includes(` ${queryNorm} `) || ` ${queryNorm} `.includes(` ${titleNorm} `)) matchType = 'substring';
      else if (queryWords.length > 0 && queryWords.every((w) => titleTokens.has(w))) matchType = 'wordset';

      if (matchType) {
        candidates.push({ taskId: t.id, title: t.title, percentComplete: t.percentComplete, matchType, assignedToUser });
      }
    }

    if (candidates.length === 0) return { ok: false, reason: 'not_found' };

    // Prefer exact matches; among ties prefer tasks assigned to the caller.
    const rank = (c: Candidate) =>
      (c.matchType === 'exact' ? 0 : c.matchType === 'substring' ? 1 : 2) * 10 + (c.assignedToUser ? 0 : 1);
    candidates.sort((a, b) => rank(a) - rank(b));

    const bestRank = rank(candidates[0]);
    const topTier = candidates.filter((c) => rank(c) === bestRank);
    if (topTier.length === 1) {
      const c = topTier[0];
      return { ok: true, taskId: c.taskId, title: c.title, percentComplete: c.percentComplete, matchType: c.matchType };
    }

    // Multiple candidates at the same rank → ambiguous.
    return {
      ok: false,
      reason: 'ambiguous',
      candidates: topTier.slice(0, 5).map((c) => ({ taskId: c.taskId, title: c.title })),
    };
  } catch (err) {
    const msg = (err as any)?.response?.data ?? (err as any)?.message ?? String(err);
    console.error(`[plannerTools] findOpenTaskByTitle failed (hint chars=${titleHint.length}):`, msg);
    return { ok: false, reason: 'graph_error', error: typeof msg === 'string' ? msg : JSON.stringify(msg) };
  }
}
