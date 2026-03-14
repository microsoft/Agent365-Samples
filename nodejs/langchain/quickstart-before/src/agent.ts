// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TurnState, AgentApplication, TurnContext } from '@microsoft/agents-hosting';
import { Activity, ActivityTypes } from '@microsoft/agents-activity';

import { Client, getClient } from './client';

class MyAgent extends AgentApplication<TurnState> {
  constructor() {
    super();

    this.onActivity(ActivityTypes.Message, async (context: TurnContext, state: TurnState) => {
      await this.handleAgentMessageActivity(context, state);
    });

    // Handle install and uninstall events
    this.onActivity(ActivityTypes.InstallationUpdate, async (context: TurnContext, state: TurnState) => {
      await this.handleInstallationUpdateActivity(context, state);
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

    // Multiple messages pattern: send an immediate acknowledgment before the LLM work begins.
    // Each sendActivity call produces a discrete Teams message.
    // NOTE: For Teams agentic identities, streaming is buffered into a single message by the SDK;
    //       use sendActivity for any messages that must arrive immediately.
    await turnContext.sendActivity('Got it — working on it…');

    // Typing indicator loop — refreshes the "..." animation every ~4s for long-running operations.
    // Typing indicators time out after ~5s and must be re-sent. Only visible in 1:1 and small group chats.
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    const startTypingLoop = () => {
      typingInterval = setInterval(async () => {
        await turnContext.sendActivity({ type: 'typing' } as Activity);
      }, 4000);
    };
    const stopTypingLoop = () => { clearInterval(typingInterval); };

    startTypingLoop();

    try {
      const client: Client = await getClient();
      const response = await client.invokeAgent(userMessage);
      await turnContext.sendActivity(response);
    } catch (error) {
      console.error('LLM query error:', error);
      const err = error as any;
      await turnContext.sendActivity(`Error: ${err.message || err}`);
    } finally {
      stopTypingLoop();
    }
  }

  /**
   * Handles agent installation and removal events.
   */
  async handleInstallationUpdateActivity(turnContext: TurnContext, state: TurnState): Promise<void> {
    if (turnContext.activity.action === 'add') {
      await turnContext.sendActivity('Thank you for hiring me! Looking forward to assisting you in your professional journey!');
    } else if (turnContext.activity.action === 'remove') {
      await turnContext.sendActivity('Thank you for your time, I enjoyed working with you.');
    }
  }
}

export const agentApplication = new MyAgent();