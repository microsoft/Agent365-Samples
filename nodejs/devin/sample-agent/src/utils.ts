// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  AgentDetails,
  TenantDetails,
} from "@microsoft/agents-a365-observability";
import { TurnContext } from "@microsoft/agents-hosting";

// Helper functions to extract agent and tenant details from context
export function getAgentDetails(context: TurnContext): AgentDetails {
  // Extract agent ID from activity recipient - use agenticAppId (camelCase, not underscore)
  const agentId =
    (context.activity.recipient as any)?.agenticAppId ||
    process.env.AGENT_ID ||
    "devin-agent";

  console.log(
    `🎯 Agent ID: ${agentId} (from ${
      (context.activity.recipient as any)?.agenticAppId
        ? "activity.recipient.agenticAppId"
        : "environment/fallback"
    })`
  );

  return {
    agentId: agentId,
    agentName:
      (context.activity.recipient as any)?.name ||
      process.env.AGENT_NAME ||
      "Devin Agent Sample",
  };
}

export function getTenantDetails(context: TurnContext): TenantDetails {
  // First try to extract tenant ID from activity recipient - use tenantId (camelCase)
  const tenantId =
    (context.activity.recipient as any)?.tenantId ||
    process.env.connections__serviceConnection__settings__tenantId ||
    "sample-tenant";

  console.log(
    `🏢 Tenant ID: ${tenantId} (from ${
      (context.activity.recipient as any)?.tenantId
        ? "activity.recipient.tenantId"
        : "environment/fallback"
    })`
  );

  return { tenantId: tenantId };
}
