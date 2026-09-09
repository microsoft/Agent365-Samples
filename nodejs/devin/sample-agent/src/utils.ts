// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  CallerDetails,
  ExecutionType,
  InvokeAgentDetails,
  TenantDetails,
} from "@microsoft/agents-a365-observability";
import { TurnContext } from "@microsoft/agents-hosting";

// Helper functions to extract agent and tenant details from context
export function getAgentDetails(context: TurnContext): InvokeAgentDetails {
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
    conversationId: context.activity.conversation?.id,
    request: {
      content: context.activity.text || "Unknown text",
      executionType: ExecutionType.HumanToAgent,
      sessionId: context.activity.conversation?.id,
      sourceMetadata: { name: context.activity.channelId },
    },
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

export function getTenantDetails(context: TurnContext): TenantDetails {
  return { tenantId: getTenantId(context) };
}

export function getCallerDetails(context: TurnContext): CallerDetails {
  return {
    callerId: context.activity.from?.aadObjectId || context.activity.from?.id,
    callerUserId: context.activity.from?.id,
    callerName: context.activity.from?.name,
    tenantId: context.activity.from?.tenantId || getTenantId(context),
  };
}
