// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  InferenceScope,
  InferenceDetails,
  InferenceOperationType,
  AgentDetails,
  TenantDetails,
  runWithExtractedTraceContext,
} from '@microsoft/agents-a365-observability';
import { STUBBED_PLAN } from '../shared/stubbed-responses';
import { AgentRequest, PlanOutput } from '../shared/types';

export async function handlePlannerRequest(
  body: AgentRequest,
  headers: Record<string, string | string[] | undefined>
): Promise<PlanOutput> {
  return runWithExtractedTraceContext(headers, async () => {
    const inferenceDetails: InferenceDetails = {
      operationName: InferenceOperationType.CHAT,
      model: 'stubbed-planner',
    };
    const agentDetails: AgentDetails = {
      agentId: 'planner-agent',
      agentName: 'Planner Agent',
      conversationId: body.runId,
    };
    const tenantDetails: TenantDetails = { tenantId: 'demo-tenant' };

    const scope = InferenceScope.start(inferenceDetails, agentDetails, tenantDetails);
    try {
      return await scope.withActiveSpanAsync(async () => {
        scope.recordAttributes({
          'a365.agent.role': 'planner',
          'a365.step': body.step,
          'a365.run_id': body.runId,
          'a365.agent.call_id': `planner-${body.runId}`,
        });

        // Simulate LLM thinking time
        await new Promise((r) => setTimeout(r, 200));

        const plan = STUBBED_PLAN;
        scope.recordInputMessages([JSON.stringify(body.payload)]);
        scope.recordOutputMessages([JSON.stringify(plan)]);
        scope.recordInputTokens(120);
        scope.recordOutputTokens(85);
        scope.recordFinishReasons(['stop']);

        console.log(`[Planner] Step ${body.step}: Generated campaign plan for "${plan.targetSegment}"`);
        return plan;
      });
    } finally {
      scope.dispose();
    }
  });
}
