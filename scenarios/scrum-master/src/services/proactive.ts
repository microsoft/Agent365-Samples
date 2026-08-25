// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Proactive-messaging helper.
 *
 * The Bot Framework proactive pattern: given a stored ConversationReference,
 * call `adapter.continueConversation(botAppId, ref, logic)` which reconstructs
 * a TurnContext bound to that conversation so we can `sendActivity` into it.
 */

import { ConversationReference } from '@microsoft/agents-activity';
import { CloudAdapter, TurnContext } from '@microsoft/agents-hosting';

import { agentApplication } from '../agent';
import { runWithObservabilityContext } from '../observability';

/**
 * Sends one activity (string or Activity) to a previously-known conversation.
 * Best-effort — swallow errors so a single missing user does not tank a fan-out.
 * The proactive turn is wrapped in `runWithObservabilityContext` so its spans
 * carry the same tenant+agent baggage as inbound /api/messages turns.
 */
export async function sendProactive(
    reference: Partial<ConversationReference>,
    logic: (context: TurnContext) => Promise<void>,
): Promise<{ ok: boolean; error?: string }> {
    const adapter = agentApplication.adapter as CloudAdapter;
    const authorization = (agentApplication as any).authorization;
    const botAppId = getBotAppId();
    try {
        await adapter.continueConversation(botAppId, reference as ConversationReference, async (context) => {
            await runWithObservabilityContext(context, authorization, async () => {
                await logic(context);
            });
        });
        return { ok: true };
    } catch (e) {
        const msg = (e as Error).message ?? String(e);
        console.warn(`[proactive] send failed: ${msg}`);
        return { ok: false, error: msg };
    }
}

export function getBotAppId(): string {
    const id = process.env.connections__service_connection__settings__clientId?.trim();
    if (!id) {
        throw new Error(
            'connections__service_connection__settings__clientId is required for proactive messaging. ' +
            'Set it in .env before running the agent — see .env.template.',
        );
    }
    return id;
}
