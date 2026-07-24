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

/**
 * Sends one activity (string or Activity) to a previously-known conversation.
 * Best-effort — swallow errors so a single missing user does not tank a fan-out.
 */
export async function sendProactive(
    reference: Partial<ConversationReference>,
    logic: (context: TurnContext) => Promise<void>,
): Promise<{ ok: boolean; error?: string }> {
    const adapter = agentApplication.adapter as CloudAdapter;
    const botAppId = getBotAppId();
    try {
        // Cast: stored references always come from `activity.getConversationReference()`
        // which returns a fully-populated ConversationReference, but our storage layer
        // deserializes as `Partial<>`. Adapter throws at runtime on truly-incomplete refs.
        await adapter.continueConversation(botAppId, reference as ConversationReference, async (context) => {
            await logic(context);
        });
        return { ok: true };
    } catch (e) {
        const msg = (e as Error).message ?? String(e);
        console.warn(`[proactive] send failed: ${msg}`);
        return { ok: false, error: msg };
    }
}

export function getBotAppId(): string {
    return (
        process.env.connections__service_connection__settings__clientId ??
        ''
    );
}
