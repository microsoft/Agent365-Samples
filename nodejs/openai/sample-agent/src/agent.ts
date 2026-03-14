// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// IMPORTANT: Load environment variables FIRST before any other imports
// This ensures NODE_ENV and other config is available when AgentApplication initializes
import { configDotenv } from 'dotenv';
configDotenv();

import { TurnState, AgentApplication, TurnContext, MemoryStorage } from '@microsoft/agents-hosting';
import { Activity, ActivityTypes } from '@microsoft/agents-activity';
import { BaggageBuilder } from '@microsoft/agents-a365-observability';
import {AgenticTokenCacheInstance, BaggageBuilderUtils} from '@microsoft/agents-a365-observability-hosting'
import { getObservabilityAuthenticationScope } from '@microsoft/agents-a365-runtime';

// Notification Imports
import '@microsoft/agents-a365-notifications';
import { AgentNotificationActivity, NotificationType, createEmailResponseActivity } from '@microsoft/agents-a365-notifications';

import { Client, getClient } from './client';
import tokenCache, { createAgenticTokenCacheKey } from './token-cache';

export class MyAgent extends AgentApplication<TurnState> {
  static authHandlerName: string = 'agentic';

  constructor() {
    super({
      startTypingTimer: true,
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
    }, 1, [MyAgent.authHandlerName]);

    this.onActivity(ActivityTypes.Message, async (context: TurnContext, state: TurnState) => {
      await this.handleAgentMessageActivity(context, state);
    }, [MyAgent.authHandlerName]);

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

    // Populate baggage consistently from TurnContext using hosting utilities
    const baggageScope = BaggageBuilderUtils.fromTurnContext(
      new BaggageBuilder(),
      turnContext
    ).sessionDescription('Initial onboarding session')
      .correlationId("7ff6dca0-917c-4bb0-b31a-794e533d8aad")
      .build();

    // Preloads or refreshes the Observability token used by the Agent 365 Observability exporter.
      await this.preloadObservabilityToken(turnContext);

    try {
      await baggageScope.run(async () => {
        const client: Client = await getClient(this.authorization, MyAgent.authHandlerName, turnContext, displayName);
        const response = await client.invokeAgentWithScope(userMessage);
        // Message 2: the LLM response
        await turnContext.sendActivity(response);
      });
    } catch (error) {
      console.error('LLM query error:', error);
      const err = error as any;
      await turnContext.sendActivity(`Error: ${err.message || err}`);
    } finally {
      stopTypingLoop();
      baggageScope.dispose();
    }
  }

  /**
   * Preloads or refreshes the Observability token used by the Agent 365 Observability exporter.
   *
   * Behavior:
   * - If the environment variable `Use_Custom_Resolver` is set to `true`, this method exchanges an
   *   AAU token using the agent's authorization and stores it in the local `tokenCache`, keyed by
   *   `agentId`/`tenantId` via `createAgenticTokenCacheKey`.
   * - Otherwise, it refreshes the built-in `AgenticTokenCacheInstance` by invoking
   *   `RefreshObservabilityToken`, which is used by the default token resolver configured in the client.
   *
   * Notes:
   * - Token acquisition failures are non-fatal for this sample and should not block the user flow.
   * - `agentId` and `tenantId` are derived from the current `TurnContext` activity recipient.
   * - Uses `getObservabilityAuthenticationScope()` to obtain the exporter auth scopes.
   *
   * @param turnContext The current turn context containing activity and identity metadata.
   */
  private async preloadObservabilityToken(turnContext: TurnContext): Promise<void> {
    const agentId = turnContext?.activity?.recipient?.agenticAppId ?? '';
    const tenantId = turnContext?.activity?.recipient?.tenantId ?? '';

    // Set Use_Custom_Resolver === 'true' to use a custom token resolver and a custom token cache (see token-cache.ts).
    // Otherwise: use the default AgenticTokenCache via RefreshObservabilityToken.
    if (process.env.Use_Custom_Resolver === 'true') {
      const aauToken = await this.authorization.exchangeToken(turnContext, 'agentic', {
        scopes: getObservabilityAuthenticationScope()
      });

      console.log(`Preloaded Observability token for agentId=${agentId}, tenantId=${tenantId} token=${aauToken?.token?.substring(0, 10)}...`);
      const cacheKey = createAgenticTokenCacheKey(agentId, tenantId);
      tokenCache.set(cacheKey, aauToken?.token || '');
    } else {
      // Preload/refresh the observability token into the built-in AgenticTokenCache.
      // We don't immediately need the token here, and if acquisition fails we continue (non-fatal for this demo sample).
      await AgenticTokenCacheInstance.RefreshObservabilityToken(
        agentId,
        tenantId,
        turnContext,
        this.authorization,
        getObservabilityAuthenticationScope()
      );
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
      const client: Client = await getClient(this.authorization, MyAgent.authHandlerName, context);

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

export const agentApplication = new MyAgent();
