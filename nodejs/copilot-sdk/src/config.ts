// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { AgentDetails } from '@microsoft/opentelemetry';

export const SDK_VERSION = '1.0.14';
export const RUNTIME_VERSION = '1.0.85';

export interface LiveIdentity {
  tenantId: string;
  agentId: string;
  blueprintClientId: string;
  clientSecret: string;
}

export interface SampleConfig {
  observability: boolean;
  exportToA365: boolean;
  agent: AgentDetails;
  identity?: LiveIdentity;
  model: string;
  timeoutMs: number;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`);
  return value === 'true';
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value || value.includes('<<')) throw new Error(`${name} is required for live A365 export`);
  return value;
}

function guid(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a GUID`);
  }
  return value.toLowerCase();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SampleConfig {
  const observability = flag(env, 'ENABLE_A365_OBSERVABILITY', true);
  const exportToA365 = flag(env, 'ENABLE_A365_OBSERVABILITY_EXPORTER', false);
  if (exportToA365 && !observability) {
    throw new Error('Live export requires ENABLE_A365_OBSERVABILITY=true');
  }
  const timeoutMs = Number(env.COPILOT_TIMEOUT_MS ?? '120000');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
    throw new Error('COPILOT_TIMEOUT_MS must be an integer between 1000 and 600000');
  }
  const identity: LiveIdentity | undefined = exportToA365 ? {
    tenantId: guid(env, 'AGENT365_TENANT_ID'),
    agentId: guid(env, 'AGENT365_AGENT_ID'),
    blueprintClientId: guid(env, 'AGENT365_BLUEPRINT_CLIENT_ID'),
    clientSecret: required(env, 'AGENT365_CLIENT_SECRET'),
  } : undefined;
  if (identity && identity.agentId === identity.blueprintClientId) {
    throw new Error('AGENT365_AGENT_ID must be the agent identity client ID, not the blueprint');
  }
  return {
    observability,
    exportToA365,
    ...(identity ? { identity } : {}),
    agent: {
      agentId: identity?.agentId ?? 'local-copilot-sdk',
      tenantId: identity?.tenantId ?? 'local-only',
      ...(identity ? { agentBlueprintId: identity.blueprintClientId } : {}),
      agentName: env.AGENT365_AGENT_NAME?.trim() || 'copilot-sdk-standalone',
      providerName: 'github.copilot',
      agentVersion: '0.1.0',
    },
    model: env.COPILOT_MODEL?.trim() || 'gpt-5-mini',
    timeoutMs,
  };
}

// The Copilot subprocess must not inherit the blueprint credential or exporter settings.
export function runtimeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(AGENT365_|A365_|ENABLE_A365_|OTEL_|AZURE_|APPLICATIONINSIGHTS_)/i.test(key)));
}
