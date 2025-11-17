import { DefaultConversationState, TurnState } from "@microsoft/agents-hosting";

interface ConversationState extends DefaultConversationState {
  count: number;
}

export type ApplicationTurnState = TurnState<ConversationState>;
