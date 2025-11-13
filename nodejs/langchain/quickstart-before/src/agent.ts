// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TurnState, AgentApplication, TurnContext } from '@microsoft/agents-hosting';
import { ActivityTypes } from '@microsoft/agents-activity';

import { Client, getClient } from './client';

class MyAgent extends AgentApplication<TurnState> {
  constructor() {
    super();

    this.onActivity(ActivityTypes.Message, async (context: TurnContext, state: TurnState) => {
      await this.handleAgentMessageActivity(context, state);
    });
  }

  /**
   * Handles incoming user messages and sends responses.
   */
  async handleAgentMessageActivity(turnContext: TurnContext, state: TurnState): Promise<void> {
    const userMessage = turnContext.activity.text?.trim() || '';

    if (!userMessage) {
      await turnContext.sendActivity('Please send me a message and I\'ll help you!');
      return;
    }

    try {
      const client: Client = await getClient();
      const response = await client.invokeAgent(userMessage);
      await turnContext.sendActivity(response);
    } catch (error) {
      console.error('LLM query error:', error);
      const err = error as any;
      await turnContext.sendActivity(`Error: ${err.message || err}`);
    }
  }
}

export const agentApplication = new MyAgent();