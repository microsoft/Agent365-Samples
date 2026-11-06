// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// The conversation id recorded on a turn's spans (gen_ai.conversation.id). It is the activity's
// conversation id, except for email: every email in a thread arrives with a different activity
// conversation id, so email turns register the stable email thread id here and all spans of one
// thread are grouped as one conversation in Activity.
import type { TurnContext } from '@microsoft/agents-hosting';

const overrides = new WeakMap<object, string>();

export function setObservabilityConversationId(turnContext: TurnContext, conversationId: string | undefined): void {
  if (conversationId) overrides.set(turnContext, conversationId);
}

export function observabilityConversationId(turnContext: TurnContext): string | undefined {
  return overrides.get(turnContext) ?? turnContext.activity?.conversation?.id;
}

/** Session label for the baggage scope, so Activity shows which channel the run came from. */
export function observabilitySessionDescription(turnContext: TurnContext): string {
  const channel = turnContext.activity?.channelId;
  return channel ? `Employee Career Coach session (${channel})` : 'Employee Career Coach session';
}
