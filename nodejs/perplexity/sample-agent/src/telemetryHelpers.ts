// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { EnhancedAgentDetails } from "@microsoft/agents-a365-observability";
import { TurnContext } from "@microsoft/agents-hosting";

/**
 * This function extracts agent details from the TurnContext.
 * @param context The TurnContext from which to extract agent details.
 * @returns An object containing enhanced agent details.
 */
export function extractAgentDetailsFromTurnContext(
  context: TurnContext
): EnhancedAgentDetails {
  const recipient: any = context.activity.recipient || {};
  const agentId =
    recipient.agenticAppId || process.env.AGENT_ID || "sample-agent";

  return {
    agentId,
    agentName: recipient.name || process.env.AGENT_NAME || "Basic Agent Sample",
    agentAUID: recipient.agenticUserId,
    agentUPN: recipient.id,
    conversationId: context.activity.conversation?.id,
  } as EnhancedAgentDetails;
}

/**
 * This function extracts tenant details from the TurnContext.
 * @param context The TurnContext from which to extract tenant details.
 * @returns An object containing tenant details.
 */
export function extractTenantDetailsFromTurnContext(context: TurnContext): {
  tenantId: string;
} {
  const recipient: any = context.activity.recipient || {};
  const tenantId =
    recipient.tenantId ||
    process.env.connections__serviceConnection__settings__tenantId ||
    "sample-tenant";

  return { tenantId };
}
