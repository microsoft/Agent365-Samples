// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Shared A365 observability context helpers.
//
// The backend enforces a three-way binding before a span becomes eligible for
// MAC Activity:
//
//   token principal == /agents/{agentId} == gen_ai.agent.id
//
// The runtime agent identity is `activity.recipient.agenticAppId`. The
// blueprint id belongs in `agentBlueprintId` as metadata only — spans tagged
// with the blueprint id land in a second identity group and are dropped by the
// exporter ("N spans skipped"), so export succeeds while Activity stays empty.

import type { Authorization, TurnContext } from '@microsoft/agents-hosting';
import {
  BaggageBuilder,
  type AgentDetails,
  type Channel,
  type Request,
  type UserDetails,
} from '@microsoft/agents-a365-observability';
import {
  AgenticTokenCacheInstance,
  BaggageBuilderUtils,
} from '@microsoft/agents-a365-observability-hosting';

import { resolveAadToUpn, type PeopleToolOptions } from './graph/peopleTools';

// Observability API resource. Same across every A365 tenant.
const OBSERVABILITY_SCOPE = 'api://9b975845-388f-4429-889e-eab1ef63949c/.default';

interface AgenticRecipient {
  id?: string;
  name?: string;
  tenantId?: string;
  agenticUserId?: string;
  agenticAppId?: string;
  agenticAppBlueprintId?: string;
}

function recipientOf(context: TurnContext | undefined): AgenticRecipient {
  return ((context?.activity?.recipient as AgenticRecipient | undefined) ?? {});
}

/**
 * Runtime agent identity (the agentic instance). This — not the blueprint id —
 * is what belongs in `gen_ai.agent.id` and in the export route.
 *
 * The legacy `agent_id` / `agent365Observability__agentId` vars hold the
 * BLUEPRINT id in this deployment, so they are deliberately not consulted here.
 */
export function getAgentId(context: TurnContext | undefined): string | undefined {
  return (
    recipientOf(context).agenticAppId?.trim() ||
    process.env.agent365Observability__agentInstanceId?.trim() ||
    undefined
  );
}

export function getAgentBlueprintId(context?: TurnContext): string | undefined {
  return (
    recipientOf(context).agenticAppBlueprintId?.trim() ||
    process.env.agent365Observability__agentBlueprintId?.trim() ||
    process.env.agent365Observability__agentId?.trim() ||
    process.env.agent_id?.trim() ||
    undefined
  );
}

export function getTenantId(context?: TurnContext): string | undefined {
  const activity = context?.activity as any;
  return (
    activity?.recipient?.tenantId?.trim() ||
    activity?.conversation?.tenantId?.trim() ||
    process.env.agent365Observability__tenantId?.trim() ||
    process.env.connections__service_connection__settings__tenantId?.trim() ||
    undefined
  );
}

/**
 * Returns undefined when the runtime agent identity or tenant can't be
 * resolved. Callers should skip the span entirely rather than emit one the
 * backend cannot bind.
 */
export function buildAgentDetails(context: TurnContext): AgentDetails | undefined {
  const agentId = getAgentId(context);
  const tenantId = getTenantId(context);
  if (!agentId || !tenantId) return undefined;

  const recipient = recipientOf(context);
  return {
    agentId,
    agentName: process.env.agent365Observability__agentName?.trim() || 'Chief of Staff',
    agentDescription: process.env.agent365Observability__agentDescription?.trim(),
    tenantId,
    agentBlueprintId: getAgentBlueprintId(context),
    agentAUID: recipient.agenticUserId,
    agentEmail: recipient.id,
  };
}

export function buildRequest(
  context: TurnContext,
  overrides: { conversationId?: string; sessionId?: string } = {}
): Request {
  const activity = context?.activity as any;
  const channelId: string = activity?.channelId ?? 'msteams';
  const channel: Channel = { id: channelId, name: channelId };
  return {
    channel,
    conversationId:
      overrides.conversationId ?? activity?.conversation?.id ?? `cos-run-${Date.now()}`,
    sessionId: overrides.sessionId,
  };
}

/**
 * Human caller identity for HumanToAgent reporting. Returns undefined for
 * autonomous runs so the agent's own identity is never reported as the caller.
 *
 * `userEmail` maps to the `user.email` span attribute — the M365 admin center
 * reads this for the MAC Activity "User principal name" column. A365-native
 * activities carry the UPN in `from.agenticUserId`; Teams channel activities
 * carry only `aadObjectId`, so when `peopleOpts` is supplied we resolve the
 * UPN via Graph (`resolveAadToUpn` caches after first lookup per user).
 *
 * Note: even with a real UPN, the admin center will still display a hashed
 * value if the tenant's "Conceal user, group, and site names in all reports"
 * setting is enabled. That's a tenant policy, not fixable in code.
 */
export async function buildUserDetails(
  context: TurnContext,
  peopleOpts?: PeopleToolOptions
): Promise<UserDetails | undefined> {
  const from = context?.activity?.from as any;
  const userId: string | undefined = from?.aadObjectId?.trim() || undefined;
  if (!userId) return undefined;
  let userEmail: string | undefined =
    from?.agenticUserId?.trim() || from?.userPrincipalName?.trim() || undefined;
  if (!userEmail && peopleOpts) {
    try {
      const resolved = await resolveAadToUpn(userId, peopleOpts);
      if (resolved) userEmail = resolved;
    } catch (err) {
      console.warn(
        `[observability] UPN resolve failed for aad=${userId.slice(0, 8)}…: ${(err as Error)?.message ?? err}`
      );
    }
  }
  return { userId, userEmail, userName: from?.name, tenantId: getTenantId(context) };
}

/**
 * Warm the exporter's token cache for this turn.
 *
 * The exporter partitions spans by (agentId, tenantId), and blueprint-tagged
 * spans and instance-tagged spans land in different groups — so both identities
 * need a cached token or one group exports unauthenticated.
 */
export async function ensureObservabilityToken(
  context: TurnContext,
  authorization: Authorization
): Promise<void> {
  const tenantId = getTenantId(context);
  if (!tenantId) return;

  const identities = Array.from(
    new Set(
      [getAgentId(context), getAgentBlueprintId(context)].filter(
        (id): id is string => !!id
      )
    )
  );

  for (const agentId of identities) {
    try {
      await AgenticTokenCacheInstance.RefreshObservabilityToken(
        agentId,
        tenantId,
        context,
        authorization,
        [OBSERVABILITY_SCOPE]
      );
    } catch (err) {
      console.warn(
        `[observability] token refresh failed for agentId=${agentId.slice(0, 8)}… — spans for this turn may be dropped: ${(err as Error)?.message ?? err}`
      );
    }
  }
}

/**
 * Wrap proactive / scheduled work so it carries the same tenant+agent baggage
 * the hosting middleware applies to inbound `/api/messages` turns. Without
 * this, spans from continueConversation and cron paths have no identity and
 * the exporter discards them.
 */
export async function runWithObservabilityContext<T>(
  context: TurnContext,
  authorization: Authorization,
  work: () => Promise<T>
): Promise<T> {
  await ensureObservabilityToken(context, authorization);
  const scope = BaggageBuilderUtils.fromTurnContext(new BaggageBuilder(), context).build();
  try {
    return await scope.run(work);
  } finally {
    scope.dispose();
  }
}
