// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  InvokeAgentScope,
  InvokeAgentDetails,
  TenantDetails,
  AgentDetails,
  ExecutionType,
  injectTraceContext,
} from '@microsoft/agents-a365-observability';

const PORTS: Record<string, number> = {
  planner: Number(process.env.PLANNER_PORT) || 4001,
  executor: Number(process.env.EXECUTOR_PORT) || 4002,
  reviewer: Number(process.env.REVIEWER_PORT) || 4003,
};

const TENANT: TenantDetails = { tenantId: 'demo-tenant' };

const CALLER_AGENT: AgentDetails = {
  agentId: 'orchestrator',
  agentName: 'Sales Campaign Orchestrator',
};

/**
 * Calls a sub-agent service over HTTP with full A365 telemetry.
 * Creates an InvokeAgentScope (Agent2Agent) child span and propagates W3C trace context.
 */
export async function callAgent(
  agentRole: string,
  runId: string,
  step: number,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const port = PORTS[agentRole];
  const host = process.env.AGENT_HOST || 'localhost';
  const url = `http://${host}:${port}/api/run`;
  const callId = `${agentRole}-${step}-${runId}`;

  const invokeDetails: InvokeAgentDetails = {
    agentId: `${agentRole}-agent`,
    agentName: `${agentRole.charAt(0).toUpperCase() + agentRole.slice(1)} Agent`,
    endpoint: { host, port },
    request: {
      content: JSON.stringify(payload),
      executionType: ExecutionType.Agent2Agent,
    },
  };

  const scope = InvokeAgentScope.start(invokeDetails, TENANT, CALLER_AGENT);
  try {
    return await scope.withActiveSpanAsync(async () => {
      scope.recordAttributes({
        'a365.agent.role': agentRole,
        'a365.agent.call_id': callId,
        'a365.step': step,
        'a365.run_id': runId,
      });

      // Inject W3C trace context into outgoing headers
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      injectTraceContext(headers);

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ runId, step, payload }),
      });

      if (!response.ok) {
        throw new Error(`Agent ${agentRole} returned HTTP ${response.status}: ${await response.text()}`);
      }

      const json = await response.json() as { result: Record<string, unknown> };
      scope.recordInputMessages([JSON.stringify(payload)]);
      scope.recordOutputMessages([JSON.stringify(json.result)]);

      return json.result;
    });
  } catch (error) {
    scope.recordError(error as Error);
    throw error;
  } finally {
    scope.dispose();
  }
}
