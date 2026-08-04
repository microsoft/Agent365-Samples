// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// IMPORTANT: Load environment variables FIRST before any other imports
// This ensures NODE_ENV and other config is available when AgentApplication initializes
import { configDotenv } from 'dotenv';
configDotenv();

import { TurnState, AgentApplication, TurnContext, MemoryStorage } from '@microsoft/agents-hosting';
import { Activity, ActivityTypes } from '@microsoft/agents-activity';
import { BaggageBuilder } from '@microsoft/agents-a365-observability';
import { AgenticTokenCacheInstance, BaggageBuilderUtils } from '@microsoft/agents-a365-observability-hosting';
import { getObservabilityAuthenticationScope } from '@microsoft/agents-a365-runtime';

// Notification Imports
import '@microsoft/agents-a365-notifications';
import { AgentNotificationActivity, NotificationType, createEmailResponseActivity } from '@microsoft/agents-a365-notifications';

import { Client, SemanticKernelAgentResponse, getClient } from './client';
import tokenCache, { createAgenticTokenCacheKey } from './token-cache';

// Terms and conditions state — mirrors the C# static property pattern
let termsAndConditionsAccepted = true; // Disabled for development purpose

export function isTermsAndConditionsAccepted(): boolean {
  return termsAndConditionsAccepted;
}

export function setTermsAndConditionsAccepted(value: boolean): void {
  termsAndConditionsAccepted = value;
}

export class MyAgent extends AgentApplication<TurnState> {
  static authHandlerName: string = 'agentic';

  constructor() {
    super({
      storage: new MemoryStorage(),
      authorization: {
        agentic: {
          type: 'agentic',
        } // scopes set in the .env file
      }
    });

    // Route agent notifications
    this.onAgentNotification('agents:*', async (context: TurnContext, state: TurnState, agentNotificationActivity: AgentNotificationActivity) => {
      await this.handleAgentNotificationActivity(context, state, agentNotificationActivity);
    }, 1, [MyAgent.authHandlerName]);

    // Route messages
    this.onActivity(ActivityTypes.Message, async (context: TurnContext, state: TurnState) => {
      await this.handleAgentMessageActivity(context, state);
    }, [MyAgent.authHandlerName]);

    // Handle agent install / uninstall events
    this.onActivity(ActivityTypes.InstallationUpdate, async (context: TurnContext, state: TurnState) => {
      await this.handleInstallationUpdateActivity(context, state);
    });
  }

  /**
   * Handles incoming user messages using Semantic Kernel-style agent invocation.
   */
  async handleAgentMessageActivity(turnContext: TurnContext, state: TurnState): Promise<void> {
    const userMessage = turnContext.activity.text?.trim() || '';

    // Log user identity from Activity.From
    const from = turnContext.activity?.from;
    console.log(`Turn received from user — DisplayName: '${from?.name ?? '(unknown)'}', UserId: '${from?.id ?? '(unknown)'}', AadObjectId: '${from?.aadObjectId ?? '(none)'}'`);
    const displayName = from?.name ?? 'unknown';

    if (!userMessage) {
      await turnContext.sendActivity('Please send me a message and I\'ll help you!');
      return;
    }

    // Send immediate acknowledgment before LLM work begins
    await turnContext.sendActivity('Got it — working on it…');

    // Send typing indicator
    await turnContext.sendActivity({ type: 'typing' } as Activity);

    // Background loop refreshes the "..." animation every ~4s
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

    // Populate baggage from TurnContext for observability
    const baggageScope = BaggageBuilderUtils.fromTurnContext(
      new BaggageBuilder(),
      turnContext
    ).sessionDescription('Semantic Kernel agent session')
      .build();

    // Preload observability token
    await this.preloadObservabilityToken(turnContext);

    try {
      await baggageScope.run(async () => {
        const client: Client = await getClient(
          this.authorization,
          MyAgent.authHandlerName,
          turnContext,
          displayName
        );

        const response: SemanticKernelAgentResponse = await client.invokeAgentWithScope(userMessage);
        await this.outputResponse(turnContext, response);
      });
    } catch (error) {
      console.error('Semantic Kernel agent error:', error);
      await turnContext.sendActivity('Sorry, something went wrong. Please try again.');
    } finally {
      stopTypingLoop();
      baggageScope.dispose();
    }
  }

  /**
   * Sends the agent response back to the user.
   */
  private async outputResponse(turnContext: TurnContext, response: SemanticKernelAgentResponse | null): Promise<void> {
    if (!response) {
      await turnContext.sendActivity('Sorry, I couldn\'t get an answer at the moment.');
      return;
    }

    switch (response.contentType) {
      case 'text':
        await turnContext.sendActivity(response.content);
        break;
      default:
        break;
    }
  }

  /**
   * Preloads or refreshes the Observability token used by the Agent 365 Observability exporter.
   */
  private async preloadObservabilityToken(turnContext: TurnContext): Promise<void> {
    const agentId = turnContext?.activity?.recipient?.agenticAppId ?? '';
    const tenantId = turnContext?.activity?.recipient?.tenantId ?? '';

    if (process.env.Use_Custom_Resolver === 'true') {
      const aauToken = await this.authorization.exchangeToken(turnContext, 'agentic', {
        scopes: getObservabilityAuthenticationScope()
      });

      console.log(`Preloaded Observability token for agentId=${agentId}, tenantId=${tenantId}`);
      const cacheKey = createAgenticTokenCacheKey(agentId, tenantId);
      tokenCache.set(cacheKey, aauToken?.token || '');
    } else {
      await AgenticTokenCacheInstance.RefreshObservabilityToken(
        agentId,
        tenantId,
        turnContext,
        this.authorization,
        getObservabilityAuthenticationScope()
      );
    }
  }

  /**
   * Handles agent notification activities (email, Word comments, etc.).
   */
  async handleAgentNotificationActivity(context: TurnContext, state: TurnState, agentNotificationActivity: AgentNotificationActivity): Promise<void> {
    switch (agentNotificationActivity.notificationType) {
      case NotificationType.EmailNotification:
        await this.handleEmailNotification(context, state, agentNotificationActivity);
        break;
      default:
        await context.sendActivity(`Received notification of type: ${agentNotificationActivity.notificationType}`);
    }
  }

  /**
   * Handles email notification activities — retrieves email content and processes it.
   */
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
        `You have received the following email. Please follow any instructions in it. ${emailContent.content}`
      );

      const emailResponseActivity = createEmailResponseActivity(
        response?.content || 'I have processed your email but do not have a response at this time.'
      );
      await context.sendActivity(emailResponseActivity);
    } catch (error) {
      console.error('Email notification error:', error);
      const errorResponse = createEmailResponseActivity('Unable to process your email at this time.');
      await context.sendActivity(errorResponse);
    }
  }

  /**
   * Handles agent install and uninstall events.
   */
  async handleInstallationUpdateActivity(context: TurnContext, state: TurnState): Promise<void> {
    const from = context.activity?.from;
    console.log(`InstallationUpdate received — Action: '${context.activity.action ?? '(none)'}', DisplayName: '${from?.name ?? '(unknown)'}', UserId: '${from?.id ?? '(unknown)'}'`);

    if (context.activity.action === 'add') {
      setTermsAndConditionsAccepted(true);
      await context.sendActivity('Thank you for hiring me! Looking forward to assisting you in your professional journey!');
    } else if (context.activity.action === 'remove') {
      setTermsAndConditionsAccepted(false);
      await context.sendActivity('Thank you for your time, I enjoyed working with you.');
    }
  }
}

export const agentApplication = new MyAgent();
