// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { DefaultConversationState, TurnState } from "@microsoft/agents-hosting";

interface ConversationState extends DefaultConversationState {
  count: number;
}

export type ApplicationTurnState = TurnState<ConversationState>;
