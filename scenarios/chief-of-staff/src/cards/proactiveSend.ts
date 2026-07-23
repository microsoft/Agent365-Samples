// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Proactive Adaptive Card sender.
//
// Uses the Bot Framework proactive-messaging pattern:
//   adapter.continueConversation(botAppId, ref, async (ctx) => {
//     await ctx.sendActivity({ attachments: [ { contentType: '…adaptive', content: card } ] });
//   });
//
// This is the ONLY reliable way for an agent to DM a Teams user with an
// Adaptive Card. The Graph alternative (`POST /chats/{id}/messages`) needs
// `Teamwork.Migrate.All` under application-permission tokens — which is a
// gated import-only role, not something a normal agent app can hold.
//
// A ConversationReference for the recipient must be stored (see
// `conversationRefs.ts`). This means the recipient must have DM'd the agent
// at least once. For the leader that's guaranteed (they're the primary user).
// For followup owners or escalation targets, they need to have talked to the
// agent at least once — otherwise this call throws with a clear message and
// the LLM can fall back to plain-text DM via `mcp_TeamsServer`.

import type { Activity, ConversationReference } from '@microsoft/agents-activity';
import type { CloudAdapter, TurnContext } from '@microsoft/agents-hosting';
import { lookupConversationRef } from '../state/conversationRefs';

const ADAPTIVE_CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';

export interface SendProactiveCardArgs {
  adapter: CloudAdapter;
  botAppId: string;
  recipientAad: string;
  card: object;
}

/**
 * Send an Adaptive Card to a user we've previously seen.
 *
 * Throws with a descriptive message when we don't yet have a
 * ConversationReference for the recipient — the caller should either fall
 * back to a plain-text DM path (mcp_TeamsServer) or surface the error to the
 * leader.
 */
export async function sendCardProactively(
  args: SendProactiveCardArgs
): Promise<{ conversationId: string | undefined }> {
  const { adapter, botAppId, recipientAad, card } = args;

  const ref = lookupConversationRef(recipientAad);
  if (!ref) {
    throw new Error(
      `No cached ConversationReference for aad=${recipientAad}. ` +
        `The recipient must DM the agent at least once before we can proactively send them a card.`
    );
  }

  if (!botAppId) {
    throw new Error(
      'botAppId is empty. Set agent_id (or connections__service_connection__settings__clientId) in .env.'
    );
  }

  let conversationId: string | undefined;
  await (adapter as any).continueConversation(
    botAppId,
    ref as ConversationReference,
    async (ctx: TurnContext) => {
      conversationId = ctx.activity?.conversation?.id;
      await ctx.sendActivity({
        type: 'message',
        attachments: [
          {
            contentType: ADAPTIVE_CARD_CONTENT_TYPE,
            content: card,
          },
        ],
      } as Partial<Activity> as Activity);
    }
  );

  return { conversationId };
}

/** Resolve the botAppId the platform expects for outbound activities. */
export function getBotAppId(): string {
  return (
    process.env.agent_id?.trim() ||
    process.env.connections__service_connection__settings__clientId?.trim() ||
    ''
  );
}
