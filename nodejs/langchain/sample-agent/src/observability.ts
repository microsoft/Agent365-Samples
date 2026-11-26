// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { TurnContext } from '@microsoft/agents-hosting';
import type { AgentDetails } from '@microsoft/opentelemetry';

/**
 * Builds the AgentDetails carried by every A365 scope in a turn.
 * Returns null when the runtime agent id or tenant is missing — the
 * OBS token resolver rejects spans whose identity doesn't match its configuration.
 */
export function buildAgentDetails(turnContext: TurnContext): AgentDetails | null {
  const recipient = turnContext?.activity?.recipient as any;
  const agentId: string = recipient?.agenticAppId || process.env.AGENT365_OBS_AGENT_ID || '';
  const tenantId: string = recipient?.tenantId
    || turnContext?.activity?.conversation?.tenantId
    || process.env.AGENT365_OBS_TENANT_ID
    || process.env.agent365Observability__tenantId || '';
  if (!agentId || !tenantId) {
    return null;
  }

  return {
    agentId,
    agentName: process.env.agent365Observability__agentName || 'LangChainA365Agent',
    agentDescription: process.env.agent365Observability__agentDescription || '',
    agentAUID: recipient?.agenticUserId ?? '',
    agentEmail: typeof recipient?.id === 'string' && /^[^@\s]+@[^@\s]+$/.test(recipient.id)
      ? recipient.id : '',
    // Blueprint id drives the MAC roll-up view; agentId drives the per-instance view.
    agentBlueprintId: recipient?.agenticAppBlueprintId || process.env.agent365Observability__agentBlueprintId || '',
    tenantId,
  };
}

/** Channel name for MAC Activity; notification turns override it since channelId is not msteams. */
export function resolveChannelName(turnContext: TurnContext, override?: string): string {
  return override || turnContext?.activity?.channelId || 'msteams';
}
