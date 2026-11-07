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
import { randomUUID } from 'node:crypto';
import {
  BaggageBuilder,
  ExecuteToolScope,
  InvokeAgentScope,
  type AgentDetails,
  type CallerDetails,
  type Channel,
  type Request,
  type ToolCallDetails,
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
 *
 * Pass `scopeOptions` to also open the `invoke_agent` root span for the run.
 */
export async function runWithObservabilityContext<T>(
  context: TurnContext,
  authorization: Authorization,
  work: () => Promise<T>,
  scopeOptions?: AgentRunScopeOptions
): Promise<T> {
  await ensureObservabilityToken(context, authorization);
  const scope = BaggageBuilderUtils.fromTurnContext(new BaggageBuilder(), context).build();
  try {
    return await scope.run(() =>
      scopeOptions ? runWithInvokeAgentScope(context, scopeOptions, work) : work()
    );
  } finally {
    scope.dispose();
  }
}

export interface AgentRunScopeOptions {
  /** Trigger text recorded as `gen_ai.input.messages` on the invoke_agent span. */
  input?: string;
  /** Groups every span emitted by one logical run. */
  sessionId?: string;
  /**
   * False for cron/poller-driven runs. Suppresses `user.id` so an autonomous
   * run never reports the cached inbound caller as the human who ran it.
   */
  humanInitiated?: boolean;
  peopleOpts?: PeopleToolOptions;
}

/**
 * Open the `invoke_agent` root span for one turn. MAC Activity groups a run by
 * this span; the `chat` and `execute_tool` spans raised inside `work` become
 * its children through the active OTel context.
 *
 * Runs untraced when the runtime agent identity can't be resolved — same guard
 * as `buildAgentDetails`, since a span the backend can't bind is dropped anyway.
 */
export async function runWithInvokeAgentScope<T>(
  context: TurnContext,
  options: AgentRunScopeOptions,
  work: () => Promise<T>
): Promise<T> {
  const agentDetails = buildAgentDetails(context);
  if (!agentDetails) {
    console.warn(
      '[observability] no runtime agent identity (recipient.agenticAppId) or tenant on this turn — running without an invoke_agent span.'
    );
    return work();
  }

  const request = buildRequest(context, { sessionId: options.sessionId });
  const userDetails = await resolveCaller(context, options);
  const callerDetails: CallerDetails | undefined = userDetails ? { userDetails } : undefined;

  const scope = InvokeAgentScope.start(request, {}, agentDetails, callerDetails);
  try {
    return await scope.withActiveSpanAsync(async () => {
      if (options.input) scope.recordInputMessages([options.input]);
      try {
        const result = await work();
        if (typeof result === 'string') scope.recordOutputMessages([result]);
        return result;
      } catch (err) {
        scope.recordError(err as Error);
        throw err;
      }
    });
  } finally {
    scope.dispose();
  }
}

/**
 * Open an `execute_tool` span around a single tool call. Without this the
 * `gen_ai.tool.*` attributes MAC needs for tool reporting are never emitted.
 */
export async function withToolScope<T>(
  context: TurnContext,
  details: ToolCallDetails,
  options: AgentRunScopeOptions,
  work: () => Promise<T>
): Promise<T> {
  const agentDetails = buildAgentDetails(context);
  if (!agentDetails) return work();

  const request = buildRequest(context, { sessionId: options.sessionId });
  const userDetails = await resolveCaller(context, options);
  const scope = ExecuteToolScope.start(
    request,
    { toolCallId: randomUUID(), ...details },
    agentDetails,
    userDetails
  );
  try {
    return await scope.withActiveSpanAsync(async () => {
      try {
        const result = await work();
        scope.recordResponse(typeof result === 'string' ? result : JSON.stringify(result ?? null));
        return result;
      } catch (err) {
        scope.recordError(err as Error);
        throw err;
      }
    });
  } finally {
    scope.dispose();
  }
}

interface InvokableTool {
  name?: string;
  invoke?: unknown;
}

/**
 * Return copies of the agent's function tools whose `invoke` is wrapped in an
 * `execute_tool` span. Non-invokable entries pass through untouched.
 */
export function instrumentTools<T extends InvokableTool>(
  tools: T[],
  context: TurnContext,
  options: AgentRunScopeOptions = {}
): T[] {
  return tools.map((toolDef) => {
    const original = toolDef.invoke;
    if (typeof original !== 'function') return toolDef;
    const invoke = (runContext: unknown, input: string, details?: unknown) =>
      withToolScope(
        context,
        { toolName: toolDef.name ?? 'tool', toolType: 'function', arguments: input },
        options,
        () => (original as Function).call(toolDef, runContext, input, details)
      );
    return { ...toolDef, invoke };
  });
}

/**
 * Patch `callTool` on each attached MCP server so WorkIQ tool calls emit
 * `execute_tool` spans too. The SDK dispatches these internally, so there is no
 * `invoke` to wrap — mutation in place is the only boundary available.
 */
export function instrumentMcpServers(
  servers: unknown[],
  context: TurnContext,
  options: AgentRunScopeOptions = {}
): void {
  for (const server of servers as any[]) {
    if (typeof server?.callTool !== 'function' || server.__a365ToolScope) continue;
    const original = server.callTool.bind(server);
    server.callTool = (toolName: string, args: Record<string, unknown> | null) =>
      withToolScope(
        context,
        {
          toolName,
          toolType: 'mcp',
          description: typeof server.name === 'string' ? server.name : undefined,
          arguments: args ?? undefined,
        },
        options,
        () => original(toolName, args)
      );
    server.__a365ToolScope = true;
  }
}

function resolveCaller(
  context: TurnContext,
  options: AgentRunScopeOptions
): Promise<UserDetails | undefined> {
  if (options.humanInitiated === false) return Promise.resolve(undefined);
  return buildUserDetails(context, options.peopleOpts);
}
