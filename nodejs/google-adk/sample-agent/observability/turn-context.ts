// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// A365 Observability — best-effort instrumentation (verify against official sample)
import type { TurnContext } from '@microsoft/agents-hosting';
import type { A365Request, AgentDetails, UserDetails, BaggageBuilderUtils } from '@microsoft/opentelemetry';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TurnTelemetry {
  request: A365Request & { sessionId: string; conversationId: string };
  agentDetails: AgentDetails;
  userDetails: UserDetails;
}

// Normalize the optional tenant getter in agents-hosting to the distro's structural contract.
export function toObservabilityContext(context: TurnContext): Parameters<typeof BaggageBuilderUtils.fromTurnContext>[1] {
  const { activity } = context;
  return {
    activity: {
      ...activity,
      isAgenticRequest: () => activity.isAgenticRequest(),
      getAgenticInstanceId: () => activity.getAgenticInstanceId(),
      getAgenticTenantId: () => activity.getAgenticTenantId() ?? '',
      getAgenticUser: () => activity.getAgenticUser() ?? '',
    },
    turnState: context.turnState,
  };
}

export function getTurnTelemetry(context: TurnContext, agentName: string): TurnTelemetry | undefined {
  if (process.env.ENABLE_OBSERVABILITY === 'false') return undefined;
  const { recipient, conversation, from, channelId } = context.activity;
  const agentId = recipient?.agenticAppId ?? '';
  const tenantId = recipient?.tenantId ?? conversation?.tenantId ?? '';
  const blueprintId = recipient?.agenticAppBlueprintId ?? process.env.agent365Observability__agentBlueprintId;
  if (!GUID.test(agentId) || !GUID.test(tenantId) ||
      agentId.toLowerCase() === blueprintId?.toLowerCase()) {
    console.warn('[A365 Observability] Skipping semantic spans: a runtime agent identity and tenant are required (not the blueprint).');
    return undefined;
  }
  const conversationId = conversation?.id ?? context.activity.id;
  if (!conversationId) {
    console.warn('[A365 Observability] Skipping semantic spans: a conversation or activity ID is required.');
    return undefined;
  }

  return {
    request: {
      conversationId,
      sessionId: conversationId,
      channel: { name: channelId || 'web' },
    },
    agentDetails: {
      agentId,
      tenantId,
      agentName,
      agentBlueprintId: blueprintId,
      agentAUID: recipient?.aadObjectId,
    },
    userDetails: {
      userId: from?.aadObjectId,
      userName: from?.name,
    },
  };
}
