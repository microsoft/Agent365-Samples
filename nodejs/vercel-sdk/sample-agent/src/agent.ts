// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TurnState, AgentApplication, TurnContext, MemoryStorage } from '@microsoft/agents-hosting';
import { Activity, ActivityTypes } from '@microsoft/agents-activity';

// Notification Imports
import '@microsoft/agents-a365-notifications';
import { AgentNotificationActivity, NotificationType, createEmailResponseActivity } from '@microsoft/agents-a365-notifications';

import { Client, getClient } from './client';

export class A365Agent extends AgentApplication<TurnState> {
  agentName = "A365 Agent";
  static authHandlerName: string = 'agentic';

  constructor() {
    super({
      storage: new MemoryStorage(),
      authorization: {
        agentic: {
          type: 'agentic',
        } // scopes set in the .env file...
      }
    });

    // Route agent notifications
    this.onAgentNotification("agents:*", async (context: TurnContext, state: TurnState, agentNotificationActivity: AgentNotificationActivity) => {
      await this.handleAgentNotificationActivity(context, state, agentNotificationActivity);
    }, 1, [A365Agent.authHandlerName]);

    this.onActivity(ActivityTypes.Message, async (context: TurnContext, state: TurnState) => {
      await this.handleAgentMessageActivity(context, state);
    }, [A365Agent.authHandlerName]);

    // Handle agent install / uninstall events (agentInstanceCreated / InstallationUpdate)
    this.onActivity(ActivityTypes.InstallationUpdate, async (context: TurnContext, state: TurnState) => {
      await this.handleInstallationUpdateActivity(context, state);
    });
  }

    /**
   * Handles incoming user messages and sends responses.
   */
  async handleAgentMessageActivity(turnContext: TurnContext, state: TurnState): Promise<void> {
    const userMessage = turnContext.activity.text?.trim() || '';

    const from = turnContext.activity?.from;
    console.log(`Turn received from user — DisplayName: '${from?.name ?? "(unknown)"}', UserId: '${from?.id ?? "(unknown)"}', AadObjectId: '${from?.aadObjectId ?? "(none)"}'`);
    const displayName = from?.name ?? 'unknown';

    if (!userMessage) {
      await turnContext.sendActivity('Please send me a message and I\'ll help you!');
      return;
    }

    // Multiple messages pattern: send an immediate acknowledgment before the LLM work begins.
    // Each sendActivity call produces a discrete Teams message.
    // NOTE: For Teams agentic identities, streaming is buffered into a single message by the SDK;
    //       use sendActivity for any messages that must arrive immediately.
    await turnContext.sendActivity('Got it — working on it…');

    // Send typing indicator immediately (awaited so it arrives before the LLM call starts).
    await turnContext.sendActivity({ type: 'typing' } as Activity);

    // Background loop refreshes the "..." animation every ~4s (it times out after ~5s).
    // Only visible in 1:1 and small group chats.
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    const startTypingLoop = () => {
      typingInterval = setInterval(async () => {
        await turnContext.sendActivity({ type: 'typing' } as Activity);
      }, 4000);
    };
    const stopTypingLoop = () => { clearInterval(typingInterval); };

    startTypingLoop();

    try {
      const client: Client = await getClient(displayName);
      const response = await client.invokeAgentWithScope(userMessage);
      await turnContext.sendActivity(response);
    } catch (error) {
      console.error('LLM query error:', error);
      const err = error as any;
      await turnContext.sendActivity(`Error: ${err.message || err}`);
    } finally {
      stopTypingLoop();
    }
  }

  async handleAgentNotificationActivity(context: TurnContext, state: TurnState, agentNotificationActivity: AgentNotificationActivity) {
    switch (agentNotificationActivity.notificationType) {
      case NotificationType.EmailNotification:
        await this.handleEmailNotification(context, state, agentNotificationActivity);
        break;
      default:
        await context.sendActivity(`Received notification of type: ${agentNotificationActivity.notificationType}`);
    }
  }

  private async handleEmailNotification(context: TurnContext, state: TurnState, activity: AgentNotificationActivity): Promise<void> {
    const emailNotification = activity.emailNotification;

    if (!emailNotification) {
      const errorResponse = createEmailResponseActivity('I could not find the email notification details.');
      await context.sendActivity(errorResponse);
      return;
    }

    try {
      const client: Client = await getClient();

      // First, retrieve the email content
      const emailContent = await client.invokeAgentWithScope(
        `You have a new email from ${context.activity.from?.name} with id '${emailNotification.id}', ` +
        `ConversationId '${emailNotification.conversationId}'. Please retrieve this message and return it in text format.`
      );

      // Then process the email
      const response = await client.invokeAgentWithScope(
        `You have received the following email. Please follow any instructions in it. ${emailContent}`
      );

      const emailResponseActivity = createEmailResponseActivity(response || 'I have processed your email but do not have a response at this time.');
      await context.sendActivity(emailResponseActivity);
    } catch (error) {
      console.error('Email notification error:', error);
      const errorResponse = createEmailResponseActivity('Unable to process your email at this time.');
      await context.sendActivity(errorResponse);
    }
  }
  /**
   * Handles agent install and uninstall events (agentInstanceCreated / InstallationUpdate).
   * Sends a welcome message on install and a farewell on uninstall.
   */
  async handleInstallationUpdateActivity(context: TurnContext, state: TurnState): Promise<void> {
    const from = context.activity?.from;
    console.log(`InstallationUpdate received — Action: '${context.activity.action ?? "(none)"}', DisplayName: '${from?.name ?? "(unknown)"}', UserId: '${from?.id ?? "(unknown)"}'`);

    if (context.activity.action === 'add') {
      await context.sendActivity('Thank you for hiring me! Looking forward to assisting you in your professional journey!');
    } else if (context.activity.action === 'remove') {
      await context.sendActivity('Thank you for your time, I enjoyed working with you.');
    }
  }
}

export const agentApplication = new A365Agent();
