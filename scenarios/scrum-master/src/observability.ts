// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Shared A365 observability helpers. The exporter binds a span to MAC Activity
// only when the three IDs match:
//
//   token principal == /agents/{agentId} == gen_ai.agent.id
//
// Runtime agent identity is `activity.recipient.agenticAppId` — NOT the
// blueprint id. Blueprint id belongs in `agentBlueprintId` as metadata only;
// spans tagged with the blueprint id land in a second identity group that the
// exporter silently skips, which leaves M365 admin center Activity empty even
// though `agent365-export succeeded` batches fire.
//
// Adapted from the Chief-of-Staff scenario (PR #333) so both samples share the
// same wiring conventions.

import { AsyncLocalStorage } from 'node:async_hooks';

import type { Authorization, TurnContext } from '@microsoft/agents-hosting';
import {
    BaggageBuilder,
    ExecuteToolScope,
    InvokeAgentScope,
    type AgentDetails,
    type CallerDetails,
    type Channel,
    type InvokeAgentScopeDetails,
    type Request,
    type ToolCallDetails,
    type UserDetails,
} from '@microsoft/agents-a365-observability';
import {
    AgenticTokenCacheInstance,
    BaggageBuilderUtils,
} from '@microsoft/agents-a365-observability-hosting';

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

/** Runtime agent identity (agentic instance) — this belongs in `gen_ai.agent.id`. */
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

/** Returns undefined when identity can't be resolved so callers can skip the span. */
export function buildAgentDetails(context: TurnContext): AgentDetails | undefined {
    const agentId = getAgentId(context);
    const tenantId = getTenantId(context);
    if (!agentId || !tenantId) return undefined;
    const recipient = recipientOf(context);
    return {
        agentId,
        agentName: process.env.agent365Observability__agentName?.trim() || 'Scrum Master',
        agentDescription:
            process.env.agent365Observability__agentDescription?.trim() ||
            'Scrum Master autopilot',
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
            overrides.conversationId ?? activity?.conversation?.id ?? `sma-run-${Date.now()}`,
        sessionId: overrides.sessionId,
    };
}

/**
 * Warm the exporter's token cache for BOTH blueprint and agentic-instance
 * identities. The exporter partitions spans by (agentId, tenantId); a group
 * without a cached token is silently dropped.
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
 * inbound `/api/messages` turns get from the hosting middleware. Without this,
 * spans emitted from `continueConversation` and cron handlers have no identity
 * and the exporter discards them.
 */
export async function runWithObservabilityContext<T>(
    context: TurnContext,
    authorization: Authorization,
    work: () => Promise<T>
): Promise<T> {
    await ensureObservabilityToken(context, authorization);
    return runWithTurnBaggage(context, work);
}

/**
 * The turn currently being handled. Deep helpers (LLM function-tools) have no
 * TurnContext parameter, so they read identity from here instead of taking one.
 */
const currentTurn = new AsyncLocalStorage<TurnContext>();

export function getCurrentTurnContext(): TurnContext | undefined {
    return currentTurn.getStore();
}

/**
 * Build the A365 baggage scope and publish the turn so every span created by
 * `work` — including ones started deeper in the call tree — lands in the same
 * (agentId, tenantId) identity group the exporter partitions on.
 *
 * Callers are responsible for warming the observability token first.
 */
export async function runWithTurnBaggage<T>(
    context: TurnContext,
    work: () => Promise<T>,
    sessionDescription?: string
): Promise<T> {
    let builder = BaggageBuilderUtils.fromTurnContext(new BaggageBuilder(), context);
    if (sessionDescription) builder = builder.sessionDescription(sessionDescription);
    const scope = builder.build();
    try {
        return await scope.run(() => currentTurn.run(context, work));
    } finally {
        scope.dispose();
    }
}

export function buildUserDetails(context: TurnContext): UserDetails {
    const from = context?.activity?.from as { id?: string; name?: string; aadObjectId?: string } | undefined;
    return {
        userId: from?.aadObjectId ?? from?.id ?? '',
        userName: from?.name ?? '',
        // `from.id` is an MRI in 1:1 Teams chats; only notification/email turns carry a UPN.
        userEmail: from?.id?.includes('@') ? from.id : '',
    } as UserDetails;
}

export function buildCallerDetails(context: TurnContext): CallerDetails {
    return { userDetails: buildUserDetails(context) } as CallerDetails;
}

/**
 * Emit the `invoke_agent` parent span MAC Activity anchors the agent-turn view
 * on. Falls through to plain execution when identity can't be resolved, so we
 * never publish orphan spans the exporter would drop anyway.
 */
export async function withInvokeAgentScope<T>(
    context: TurnContext | undefined,
    input: string,
    work: () => Promise<T>,
    toOutput: (result: T) => string[] = (result) => [String(result ?? '')]
): Promise<T> {
    const agentDetails = context ? buildAgentDetails(context) : undefined;
    if (!context || !agentDetails) return work();

    const scopeDetails = {
        endpoint: { host: process.env.WEBSITE_HOSTNAME ?? 'localhost', port: Number(process.env.PORT) || 3978 },
    } as InvokeAgentScopeDetails;

    const scope = InvokeAgentScope.start(
        buildRequest(context),
        scopeDetails,
        agentDetails,
        buildCallerDetails(context)
    );
    try {
        return await scope.withActiveSpanAsync(async () => {
            scope.recordInputMessages([input]);
            try {
                const result = await work();
                scope.recordOutputMessages(toOutput(result));
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
 * Emit an `execute_tool` span around an LLM function-tool. Reads the turn from
 * AsyncLocalStorage so tool definitions stay context-free.
 */
export async function withExecuteToolScope<T>(
    toolName: string,
    args: unknown,
    work: () => Promise<T>
): Promise<T> {
    const context = getCurrentTurnContext();
    const agentDetails = context ? buildAgentDetails(context) : undefined;
    if (!context || !agentDetails) return work();

    const toolDetails = {
        toolName,
        toolType: 'function',
        toolCallId: `${toolName}-${Date.now()}`,
        arguments: JSON.stringify(args ?? {}),
    } as ToolCallDetails;

    const scope = ExecuteToolScope.start(
        buildRequest(context),
        toolDetails,
        agentDetails,
        buildUserDetails(context)
    );
    try {
        return await scope.withActiveSpanAsync(async () => {
            try {
                const result = await work();
                scope.recordResponse(JSON.stringify(result ?? null));
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
