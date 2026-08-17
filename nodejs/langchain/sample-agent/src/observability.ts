// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { TurnContext } from '@microsoft/agents-hosting';
import type { AgentDetails } from '@microsoft/opentelemetry';

/**
 * Builds the AgentDetails carried by every A365 scope in a turn.
 * Returns null when the turn has no runtime agent identity — the exporter cannot
 * authenticate spans emitted under a synthetic id, so the turn should run untraced.
 */
export function buildAgentDetails(turnContext: TurnContext): AgentDetails | null {
  const recipient = turnContext?.activity?.recipient as any;
  const agentId: string = recipient?.agenticAppId ?? '';
  if (!agentId) {
    return null;
  }

  return {
    agentId,
    agentName: process.env.agent365Observability__agentName || 'LangChainA365Agent',
    agentDescription: process.env.agent365Observability__agentDescription || '',
    agentAUID: recipient?.agenticUserId ?? '',
    agentEmail: recipient?.agenticUserId ?? '',
    // Blueprint id drives the MAC roll-up view; agentId drives the per-instance view.
    agentBlueprintId: recipient?.agenticAppBlueprintId || process.env.agent365Observability__agentBlueprintId || '',
    tenantId: recipient?.tenantId || process.env.agent365Observability__tenantId || '',
  };
}

/** Channel name for MAC Activity; notification turns override it since channelId is not msteams. */
export function resolveChannelName(turnContext: TurnContext, override?: string): string {
  return override || turnContext?.activity?.channelId || 'msteams';
}
