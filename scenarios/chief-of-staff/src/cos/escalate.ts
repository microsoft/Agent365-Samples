// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// FR-5 Escalate handler.
// Triggered by the in-process scheduler (CRON_ESCALATE, default every 4h) to
// scan for stalled/conflicting tasks and propose re-plan options to the leader.

import { TurnContext, TurnState } from '@microsoft/agents-hosting';
import type { Client } from '../client';
import { getPlannerPlanId } from '../graph/plannerConfig';

export async function runEscalate(
  _payload: unknown,
  _ctx: TurnContext,
  _state: TurnState,
  client: Client
): Promise<void> {
  console.log('[escalate] Trigger received.');

  const leaderAad =
    process.env.LEADER_AAD_ID?.trim() ||
    (await client.resolveUpnToAad(process.env.LEADER_UPN)) ||
    '<LEADER_AAD_ID missing>';

  const planId = (await getPlannerPlanId()) ?? '<PLANNER_PLAN_ID missing>';

  const prompt = `Run the Escalate scan.

Steps:
1. Use planner_list_tasks (plan ${planId}) to list all open tasks, then use planner_get_task on candidates. Identify:
   (a) any task past due by more than 48 hours with no recent update,
   (b) any two active tasks assigned to the same owner in the same time window (conflict).
2. For each detection, gather the task's history, previous nudges, and any comments.
3. Draft 2 re-plan options (e.g. push due date + reassign, or split into subtasks + prioritize).
4. Compose an approval request DM to the Leader (${leaderAad}) via mcp_TeamsServer. Include: the stalled item(s), context, and the 2 options with a clear "reply with the option number to approve, or 'reject' to park".
5. Do NOT apply changes to Planner yet — wait for a follow-up leader message (handled in the message pipeline).

Return a list of {taskId, reason, optionsProposed}.`;

  const result = await client.invokeAgentWithScope(prompt);
  console.log('[escalate] Result:\n', result);
}
