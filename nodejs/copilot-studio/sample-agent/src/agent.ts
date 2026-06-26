// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TurnState, AgentApplication, TurnContext, MemoryStorage } from '@microsoft/agents-hosting';
import { Activity, ActivityTypes } from '@microsoft/agents-activity';

// Notification Imports
import '@microsoft/agents-a365-notifications';
import { AgentNotificationActivity, NotificationType, createEmailResponseActivity } from '@microsoft/agents-a365-notifications';

// Observability Imports
import { BaggageBuilder } from '@microsoft/agents-a365-observability';
import { AgenticTokenCacheInstance, BaggageBuilderUtils } from '@microsoft/agents-a365-observability-hosting';
import { getObservabilityAuthenticationScope } from '@microsoft/agents-a365-runtime';

import { Client, getClient } from './client';

/**
 * MyAgent - Agent 365 sample that integrates with Microsoft Copilot Studio.
 *
 * This agent demonstrates how to:
 * - Receive notifications from Agent 365 (email, Teams, etc.)
 * - Forward messages to a Copilot Studio agent
 * - Return responses through the Agent 365 SDK
 * - Integrate with Agent 365 observability
 */
export class MyAgent extends AgentApplication<TurnState> {
  static authHandlerName: string = 'agentic';

  constructor() {
    super({
      storage: new MemoryStorage(),
      authorization: {
        agentic: { type: 'agentic'}
      }
    });

    // Route agent notifications (email, Teams, etc.)
    this.onAgentNotification("agents:*", async (context: TurnContext, state: TurnState, agentNotificationActivity: AgentNotificationActivity) => {
      await this.handleAgentNotificationActivity(context, state, agentNotificationActivity);
    });

    // Handle direct messages
    this.onActivity(ActivityTypes.Message, async (context: TurnContext, state: TurnState) => {
      await this.handleAgentMessageActivity(context, state);
    });

    // Handle install and uninstall events
    this.onActivity(ActivityTypes.InstallationUpdate, async (context: TurnContext, state: TurnState) => {
      await this.handleInstallationUpdateActivity(context, state);
    });
  }

  /**
   * Handles incoming user messages and sends responses via Copilot Studio.
   */
  async handleAgentMessageActivity(turnContext: TurnContext, state: TurnState): Promise<void> {
    const userMessage = turnContext.activity.text?.trim() || '';

    const from = turnContext.activity?.from;
    console.log(`Turn received from user — DisplayName: '${from?.name ?? "(unknown)"}', UserId: '${from?.id ?? "(unknown)"}', AadObjectId: '${from?.aadObjectId ?? "(none)"}'`);

    if (!userMessage) {
      await turnContext.sendActivity('Please send me a message and I\'ll forward it to Copilot Studio!');
      return;
    }

    await turnContext.sendActivity('Got it — working on it…');

    // Send typing indicator immediately (awaited so it arrives before the LLM call starts).
    await turnContext.sendActivity({ type: 'typing' } as Activity);

    // Background loop refreshes the "..." animation every ~4s (it times out after ~5s).
    // Only visible in 1:1 and small group chats.
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    const startTypingLoop = () => {
      typingInterval = setInterval(() => {
        turnContext.sendActivity({ type: 'typing' } as Activity).catch(() => {
          // Typing indicator failed — non-critical, continue
        });
      }, 4000);
    };
    const stopTypingLoop = () => { clearInterval(typingInterval); };

    startTypingLoop();

    const baggageScope = BaggageBuilderUtils.fromTurnContext(
      new BaggageBuilder(),
      turnContext
    ).sessionDescription('Copilot Studio integration session')
      .build();

    // Preload/refresh exporter token
    await this.preloadObservabilityToken(turnContext);

    try {
      await baggageScope.run(async () => {
        try {
          const client: Client = await getClient(this.authorization, MyAgent.authHandlerName, turnContext);
          const response = await client.invokeInferenceScope(userMessage);
          await turnContext.sendActivity(response);
        } catch (error) {
          console.error('Copilot Studio query error:', error);
          const err = error as any;
          await turnContext.sendActivity(`Error communicating with Copilot Studio: ${err.message || err}`);
        }
      });
    } finally {
      stopTypingLoop();
      baggageScope.dispose();
    }
  }

  /**
   * Preloads or refreshes the Observability token used by the Agent 365 Observability exporter.
   */
  private async preloadObservabilityToken(turnContext: TurnContext): Promise<void> {
    const agentId = turnContext?.activity?.recipient?.agenticAppId ?? '';
    const tenantId = turnContext?.activity?.recipient?.tenantId ?? '';

    await AgenticTokenCacheInstance.RefreshObservabilityToken(
      agentId,
      tenantId,
      turnContext,
      this.authorization,
      getObservabilityAuthenticationScope()
    );
  }

  /**
   * Routes agent notifications to the appropriate handler based on notification type.
   */
  async handleAgentNotificationActivity(
    context: TurnContext,
    state: TurnState,
    agentNotificationActivity: AgentNotificationActivity
  ): Promise<void> {
    switch (agentNotificationActivity.notificationType) {
      case NotificationType.EmailNotification:
        await this.handleEmailNotification(context, state, agentNotificationActivity);
        break;
      default:
        console.log(`Received notification of type: ${agentNotificationActivity.notificationType}`);
        await context.sendActivity(`Received notification of type: ${agentNotificationActivity.notificationType}`);
    }
  }

  /**
   * Handles email notifications by forwarding the email content to Copilot Studio
   * and returning the response via createEmailResponseActivity.
   */
  private async handleEmailNotification(
    context: TurnContext,
    state: TurnState,
    activity: AgentNotificationActivity
  ): Promise<void> {
    const emailNotification = activity.emailNotification;

    if (!emailNotification) {
      const errorResponse = createEmailResponseActivity('I could not find the email notification details.');
      await context.sendActivity(errorResponse);
      return;
    }

    // Preload observability token
    await this.preloadObservabilityToken(context);

    try {
      const client: Client = await getClient(this.authorization, MyAgent.authHandlerName, context);

      // Build a prompt with the email context
      const emailPrompt = `You have received an email from ${context.activity.from?.name || 'unknown sender'}. ` +
        `Email ID: '${emailNotification.id}', ` +
        `Conversation ID: '${emailNotification.conversationId}'. ` +
        `Please process this email and provide a helpful response.`;

      // Forward to Copilot Studio and get response
      const response = await client.invokeInferenceScope(emailPrompt);

      const emailResponseActivity = createEmailResponseActivity(
        response || 'I have processed your email but do not have a response at this time.'
      );
      await context.sendActivity(emailResponseActivity);
    } catch (error) {
      console.error('Email notification error:', error);
      const errorResponse = createEmailResponseActivity('Unable to process your email at this time.');
      await context.sendActivity(errorResponse);
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

// Export singleton instance for use by index.ts
export const agentApplication = new MyAgent();
