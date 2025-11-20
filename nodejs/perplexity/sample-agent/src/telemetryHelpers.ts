// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { EnhancedAgentDetails } from "@microsoft/agents-a365-observability";
import { ClusterCategory } from "@microsoft/agents-a365-runtime";
import { TurnContext } from "@microsoft/agents-hosting";
import tokenCache from "./tokenCache.js";

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

// Configure observability with token resolver (like Python's token_resolver function)
export const tokenResolver = (
  agentId: string,
  tenantId: string
): string | null => {
  try {
    // Use cached agentic token from agent authentication with shared cache key method
    const cacheKey = createAgenticTokenCacheKey(agentId, tenantId);
    const cachedToken = tokenCache.get(cacheKey);

    if (cachedToken) {
      return cachedToken;
    } else {
      return null;
    }
  } catch (error) {
    return null;
  }
};

export const getClusterCategory = (): ClusterCategory => {
  const category = process.env.CLUSTER_CATEGORY;
  if (category) {
    return category as ClusterCategory;
  }
  return "prod" as ClusterCategory; // Safe fallback
};

export function createAgenticTokenCacheKey(
  agentId: string,
  tenantId?: string
): string {
  return tenantId
    ? `agentic-token-${agentId}-${tenantId}`
    : `agentic-token-${agentId}`;
}
