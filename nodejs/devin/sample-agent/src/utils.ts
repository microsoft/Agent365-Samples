// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  AgentDetails,
  InvokeAgentScopeDetails,
  Request,
  UserDetails,
} from "@microsoft/agents-a365-observability";
import { TurnContext } from "@microsoft/agents-hosting";

// Helper functions to extract agent and tenant details from context
export function getAgentDetails(context: TurnContext): AgentDetails {
  // Extract agent ID from activity recipient - use agenticAppId (camelCase, not underscore)
  const agentId =
    context.activity.recipient?.agenticAppId ||
    process.env.AGENT365_OBS_AGENT_ID ||
    "";

  console.log(
    `🎯 Agent ID: ${agentId} (from ${
      context.activity.recipient?.agenticAppId
        ? "activity.recipient.agenticAppId"
        : "environment/fallback"
    })`
  );

  return {
    agentId: agentId,
    tenantId: getTenantId(context),
    agentName:
      context.activity.recipient?.name ||
      process.env.AGENT_NAME ||
      "Devin Agent Sample",
    agentBlueprintId: context.activity.recipient?.agenticAppBlueprintId,
    agentAUID: context.activity.recipient?.aadObjectId,
  };
}

function getTenantId(context: TurnContext): string {
  // First try to extract tenant ID from activity recipient - use tenantId (camelCase)
  const tenantId =
    context.activity.recipient?.tenantId ||
    context.activity.getAgenticTenantId() ||
    context.activity.conversation?.tenantId ||
    process.env.AGENT365_OBS_TENANT_ID ||
    "";

  console.log(
    `🏢 Tenant ID: ${tenantId} (from ${
      context.activity.recipient?.tenantId
        ? "activity.recipient.tenantId"
        : "environment/fallback"
    })`
  );

  return tenantId;
}

export function getRequest(context: TurnContext): Request {
  return {
    content: context.activity.text || "Unknown text",
    conversationId: context.activity.conversation?.id,
    sessionId: context.activity.conversation?.id,
    channel: { name: context.activity.channelId },
  };
}

export function getInvokeAgentScopeDetails(context: TurnContext): InvokeAgentScopeDetails {
  const serviceUrl = context.activity.serviceUrl;
  if (!serviceUrl) {
    return {};
  }
  const endpoint = new URL(serviceUrl);
  return {
    endpoint: {
      host: endpoint.hostname,
      port: Number(endpoint.port) || 443,
      protocol: endpoint.protocol.replace(":", ""),
    },
  };
}

export function getUserDetails(context: TurnContext): UserDetails {
  return {
    userId: context.activity.from?.aadObjectId || context.activity.from?.id,
    userName: context.activity.from?.name,
    tenantId: context.activity.from?.tenantId || getTenantId(context),
  };
}
