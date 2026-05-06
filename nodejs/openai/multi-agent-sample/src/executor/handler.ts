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
import { ExecutorOutput, AgentRequest } from '../shared/types';
import { searchContacts, createCampaign, createActivities } from '../shared/crm-tools';

export async function handleExecutorRequest(
  body: AgentRequest,
  headers: Record<string, string | string[] | undefined>
): Promise<ExecutorOutput> {
  return runWithExtractedTraceContext(headers, async () => {
    const mode = (body.payload as { mode?: string }).mode || 'draft';
    const callId = `executor-${mode}-${body.runId}`;

    const inferenceDetails: InferenceDetails = {
      operationName: InferenceOperationType.CHAT,
      model: 'stubbed-executor',
    };
    const agentDetails: AgentDetails = {
      agentId: 'executor-agent',
      agentName: 'Executor Agent',
      conversationId: body.runId,
    };
    const tenantDetails: TenantDetails = { tenantId: 'demo-tenant' };

    const scope = InferenceScope.start(inferenceDetails, agentDetails, tenantDetails);
    try {
      return await scope.withActiveSpanAsync(async () => {
        scope.recordAttributes({
          'a365.agent.role': 'executor',
          'a365.step': body.step,
          'a365.run_id': body.runId,
          'a365.agent.call_id': callId,
        });

        if (mode === 'draft') {
          // Draft mode: search contacts and create campaign
          const contacts = await searchContacts(body.runId, callId, 'Enterprise-EMEA');
          const campaign = await createCampaign(body.runId, callId, 'Q1 EMEA Outreach', contacts);

          const output: ExecutorOutput = { mode: 'draft', contacts, campaign };
          scope.recordInputMessages([JSON.stringify(body.payload)]);
          scope.recordOutputMessages([JSON.stringify({ contactCount: contacts.length, campaignId: campaign.id })]);
          scope.recordInputTokens(200);
          scope.recordOutputTokens(150);
          scope.recordFinishReasons(['stop']);

          console.log(`[Executor] Step ${body.step}: Draft — ${contacts.length} contacts, campaign "${campaign.id}"`);
          return output;
        } else {
          // Fix mode: create activities with the applied fixes
          const fixes = (body.payload as { fixes?: string[] }).fixes || [];
          const activities = await createActivities(body.runId, callId, fixes);

          const output: ExecutorOutput = { mode: 'fix', activities };
          scope.recordInputMessages([JSON.stringify(body.payload)]);
          scope.recordOutputMessages([JSON.stringify({ activitiesCreated: activities.length })]);
          scope.recordInputTokens(180);
          scope.recordOutputTokens(120);
          scope.recordFinishReasons(['stop']);

          console.log(`[Executor] Step ${body.step}: Fix — created ${activities.length} activities`);
          return output;
        }
      });
    } finally {
      scope.dispose();
    }
  });
}
