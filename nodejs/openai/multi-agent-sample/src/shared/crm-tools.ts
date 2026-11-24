// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  ExecuteToolScope,
  ToolCallDetails,
  AgentDetails,
  TenantDetails,
} from '@microsoft/agents-a365-observability';
import { CrmContact, CrmCampaign, CrmActivity } from './types';
import { STUBBED_CONTACTS, STUBBED_CAMPAIGN, STUBBED_ACTIVITIES } from './stubbed-responses';

const EXECUTOR_AGENT: AgentDetails = {
  agentId: 'executor-agent',
  agentName: 'Executor Agent',
};
const TENANT: TenantDetails = { tenantId: 'demo-tenant' };

async function executeWithToolScope<T>(
  toolName: string,
  target: string,
  runId: string,
  agentCallId: string,
  fn: () => Promise<T>
): Promise<T> {
  const toolDetails: ToolCallDetails = {
    toolName,
    toolCallId: `${toolName}-${Date.now()}`,
    description: `CRM operation: ${toolName}`,
    toolType: 'mock-crm',
  };

  const scope = ExecuteToolScope.start(toolDetails, EXECUTOR_AGENT, TENANT, runId);
  try {
    return await scope.withActiveSpanAsync(async () => {
      scope.recordAttributes({
        'a365.tool.name': toolName,
        'a365.tool.target': target,
        'a365.tool.success': true,
        'a365.run_id': runId,
        'a365.agent.call_id': agentCallId,
      });

      const result = await fn();
      scope.recordResponse(JSON.stringify(result));
      return result;
    });
  } catch (error) {
    scope.recordAttributes({ 'a365.tool.success': false });
    scope.recordError(error as Error);
    throw error;
  } finally {
    scope.dispose();
  }
}

export async function searchContacts(
  runId: string,
  agentCallId: string,
  _segment: string
): Promise<CrmContact[]> {
  return executeWithToolScope(
    'crm.searchContacts',
    'mock-crm',
    runId,
    agentCallId,
    async () => {
      await new Promise((r) => setTimeout(r, 100));
      return STUBBED_CONTACTS;
    }
  );
}

export async function createCampaign(
  runId: string,
  agentCallId: string,
  _name: string,
  contacts: CrmContact[]
): Promise<CrmCampaign> {
  return executeWithToolScope(
    'crm.createCampaign',
    'mock-crm',
    runId,
    agentCallId,
    async () => {
      await new Promise((r) => setTimeout(r, 150));
      return { ...STUBBED_CAMPAIGN, targetCount: contacts.length };
    }
  );
}

export async function createActivities(
  runId: string,
  agentCallId: string,
  _fixes: string[]
): Promise<CrmActivity[]> {
  return executeWithToolScope(
    'crm.createActivities',
    'mock-crm',
    runId,
    agentCallId,
    async () => {
      await new Promise((r) => setTimeout(r, 120));
      return STUBBED_ACTIVITIES;
    }
  );
}
