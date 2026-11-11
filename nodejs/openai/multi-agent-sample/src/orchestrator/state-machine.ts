// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  InvokeAgentScope,
  InvokeAgentDetails,
  TenantDetails,
  ExecutionType,
} from '@microsoft/agents-a365-observability';
import { TurnContext } from '@microsoft/agents-hosting';
import { PipelineState, PlanOutput, ExecutorOutput, ReviewOutput } from '../shared/types';
import { callAgent } from './agent-client';

/**
 * Runs the 5-step sales campaign pipeline:
 *   1. Planner → plan + constraints
 *   2. Executor (draft) → searchContacts + createCampaign
 *   3. Reviewer → BLOCK (forced)
 *   4. Executor (fix) → createActivities
 *   5. Reviewer → APPROVE
 *
 * Creates a root InvokeAgentScope span that parents all agent call spans.
 */
export async function runSalesCampaignPipeline(userRequest: string, turnContext?: TurnContext): Promise<string> {
  const runId = `run-${Date.now()}`;
  const state: PipelineState = {
    runId,
    scenario: 'sequential_sales_campaign',
    teamId: 'sales-team-alpha',
    userRequest,
    step: 0,
  };

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Orchestrator] Starting pipeline ${runId}`);
  console.log(`[Orchestrator] User request: "${userRequest}"`);
  console.log(`${'='.repeat(60)}\n`);

  // Extract real tenant/agent IDs from TurnContext when deployed in Teams
  const tenantId = turnContext?.activity?.recipient?.tenantId ?? 'demo-tenant';
  const agentId = turnContext?.activity?.recipient?.agenticAppId
    ?? turnContext?.activity?.recipient?.id
    ?? 'orchestrator';

  const tenant: TenantDetails = { tenantId };

  const rootDetails: InvokeAgentDetails = {
    agentId,
    agentName: 'Sales Campaign Orchestrator',
    request: {
      content: userRequest,
      executionType: ExecutionType.HumanToAgent,
    },
  };

  const scope = InvokeAgentScope.start(rootDetails, tenant);
  let finalResponse = '';

  try {
    await scope.withActiveSpanAsync(async () => {
      /* scope.recordAttributes({
        'a365.run_id': runId,
        'a365.scenario': 'sequential_sales_campaign',
        'a365.team_id': 'sales-team-alpha',
        'a365.user_request': userRequest.substring(0, 200),
      });*/

      // Step 1: Planner
      console.log('[Orchestrator] Step 1/5: Calling Planner...');
      state.step = 1;
      state.plan = await callAgent('planner', runId, 1, { request: userRequest }) as unknown as PlanOutput;

      // Step 2: Executor (draft)
      console.log('[Orchestrator] Step 2/5: Calling Executor (draft)...');
      state.step = 2;
      state.draftArtifacts = await callAgent('executor', runId, 2, {
        mode: 'draft',
        plan: state.plan,
      }) as unknown as ExecutorOutput;

      // Step 3: Reviewer (will BLOCK)
      console.log('[Orchestrator] Step 3/5: Calling Reviewer (round 1)...');
      state.step = 3;
      state.reviewResult = await callAgent('reviewer', runId, 3, {
        artifacts: state.draftArtifacts,
        reviewRound: 1,
      }) as unknown as ReviewOutput;

      // Step 4: Executor (fix)
      console.log('[Orchestrator] Step 4/5: Calling Executor (fix)...');
      state.step = 4;
      state.fixArtifacts = await callAgent('executor', runId, 4, {
        mode: 'fix',
        fixes: state.reviewResult.fixes,
      }) as unknown as ExecutorOutput;

      // Step 5: Reviewer (will APPROVE)
      console.log('[Orchestrator] Step 5/5: Calling Reviewer (round 2)...');
      state.step = 5;
      state.finalReview = await callAgent('reviewer', runId, 5, {
        artifacts: state.fixArtifacts,
        reviewRound: 2,
      }) as unknown as ReviewOutput;

      scope.recordInputMessages([userRequest]);
      scope.recordOutputMessages([JSON.stringify(state)]);

      finalResponse = formatFinalResponse(state);
      console.log(`\n${'='.repeat(60)}`);
      console.log(`[Orchestrator] Pipeline ${runId} complete!`);
      console.log(`${'='.repeat(60)}\n`);
    });
  } catch (error) {
    scope.recordError(error as Error);
    throw error;
  } finally {
    scope.dispose();
  }

  return finalResponse;
}

function formatFinalResponse(state: PipelineState): string {
  return [
    `**Sales Campaign Pipeline Complete** (Run: \`${state.runId}\`)`,
    ``,
    `**Step 1 — Plan:** Target "${state.plan?.targetSegment}" via ${state.plan?.channels?.join(', ')}`,
    `**Step 2 — Draft:** Found ${state.draftArtifacts?.contacts?.length} contacts, created campaign \`${state.draftArtifacts?.campaign?.id}\``,
    `**Step 3 — Review 1:** ${state.reviewResult?.status?.toUpperCase()} — ${state.reviewResult?.reason}`,
    `**Step 4 — Fix:** Created ${state.fixArtifacts?.activities?.length} activities with GDPR-compliant opt-out`,
    `**Step 5 — Review 2:** ${state.finalReview?.status?.toUpperCase()} — ${state.finalReview?.reason}`,
  ].join('\n');
}
