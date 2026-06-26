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
import { ReviewOutput, AgentRequest } from '../shared/types';
import { STUBBED_BLOCK_REVIEW, STUBBED_APPROVE_REVIEW } from '../shared/stubbed-responses';

export async function handleReviewerRequest(
  body: AgentRequest,
  headers: Record<string, string | string[] | undefined>
): Promise<ReviewOutput> {
  return runWithExtractedTraceContext(headers, async () => {
    const reviewRound = (body.payload as { reviewRound?: number }).reviewRound || 1;
    const callId = `reviewer-round${reviewRound}-${body.runId}`;

    const inferenceDetails: InferenceDetails = {
      operationName: InferenceOperationType.CHAT,
      model: 'stubbed-reviewer',
    };
    const agentDetails: AgentDetails = {
      agentId: 'reviewer-agent',
      agentName: 'Reviewer Agent',
      conversationId: body.runId,
    };
    const tenantDetails: TenantDetails = { tenantId: 'demo-tenant' };

    const scope = InferenceScope.start(inferenceDetails, agentDetails, tenantDetails);
    try {
      return await scope.withActiveSpanAsync(async () => {
        // Deterministic: round 1 blocks, round 2 approves
        const review = reviewRound === 1 ? STUBBED_BLOCK_REVIEW : STUBBED_APPROVE_REVIEW;

        scope.recordAttributes({
          'a365.agent.role': 'reviewer',
          'a365.step': body.step,
          'a365.run_id': body.runId,
          'a365.agent.call_id': callId,
          'a365.review.status': review.status,
          'a365.review.reason': review.reason,
        });

        // Simulate review thinking time
        await new Promise((r) => setTimeout(r, 150));

        scope.recordInputMessages([JSON.stringify(body.payload)]);
        scope.recordOutputMessages([JSON.stringify(review)]);
        scope.recordInputTokens(250);
        scope.recordOutputTokens(90);
        scope.recordFinishReasons(['stop']);

        console.log(`[Reviewer] Step ${body.step}: Round ${reviewRound} — ${review.status.toUpperCase()}`);
        return review;
      });
    } finally {
      scope.dispose();
    }
  });
}
