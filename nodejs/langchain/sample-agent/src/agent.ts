// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TurnState, AgentApplication, TurnContext, MemoryStorage } from '@microsoft/agents-hosting';
import { Activity, ActivityTypes } from '@microsoft/agents-activity';

// Notification Imports
import '@microsoft/agents-a365-notifications';
import { AgentNotificationActivity, NotificationType, createEmailResponseActivity } from '@microsoft/agents-a365-notifications';
// Observability Imports
import { BaggageBuilder, AgenticTokenCacheInstance, BaggageBuilderUtils, InvokeAgentScope } from '@microsoft/opentelemetry';
import type { A365Request, CallerDetails, InvokeAgentScopeDetails } from '@microsoft/opentelemetry';
import { getObservabilityAuthenticationScope } from '@microsoft/agents-a365-runtime';
import tokenCache, { createAgenticTokenCacheKey } from './token-cache';
import { buildAgentDetails, resolveChannelName } from './observability';
import { Client, getClient } from './client';

const EMAIL_CHANNEL_NAME = 'outlook';

export class A365Agent extends AgentApplication<TurnState> {
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
    });

    this.onActivity(ActivityTypes.Message, async (context: TurnContext, state: TurnState) => {
      await this.handleAgentMessageActivity(context, state);
    });

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
    // This is the id MAC/Defender reporting groups on — not the blueprint id stamped into .env.
    console.log(`Runtime agent identity for this turn — agenticAppId: '${(turnContext.activity?.recipient as any)?.agenticAppId ?? "(none)"}'`);
    const displayName = from?.name ?? 'unknown';

    if (!userMessage) {
      await turnContext.sendActivity('Please send me a message and I\'ll help you!');
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

    try {
      await this.runTraced(turnContext, userMessage, async (scope) => {
        scope?.recordInputMessages([userMessage]);
        const client: Client = await getClient(this.authorization, A365Agent.authHandlerName, turnContext, displayName);
        const response = await client.invokeInferenceScope(userMessage);
        scope?.recordOutputMessages([response]);
        await turnContext.sendActivity(response);
      });
    } catch (error) {
      console.error('LLM query error:', error);
      const err = error as any;
      await turnContext.sendActivity(`Error: ${err.message || err}`);
    } finally {
      stopTypingLoop();
    }
  }

  /**
   * Runs `work` under the full A365 trace context: refreshed exporter token, turn baggage,
   * and a root `invoke_agent` scope. Every path that calls the LLM must go through this,
   * otherwise its spans have no identity group and are dropped before export.
   */
  private async runTraced<T>(
    turnContext: TurnContext,
    inputText: string,
    work: (scope: InvokeAgentScope | null) => Promise<T>,
    channelName?: string
  ): Promise<T> {
    await this.preloadObservabilityToken(turnContext);

    const baggageScope = BaggageBuilderUtils.fromTurnContext(
      new BaggageBuilder(),
      turnContext as any
    ).sessionDescription('Initial onboarding session')
      .channelName(resolveChannelName(turnContext, channelName))
      .build();

    try {
      return await baggageScope.run(async () => {
        const scope = this.startInvokeAgentScope(turnContext, inputText, channelName);
        try {
          return scope ? await scope.withActiveSpanAsync(() => work(scope)) : await work(null);
        } catch (error) {
          scope?.recordError(error as Error);
          throw error;
        } finally {
          scope?.dispose();
        }
      });
    } finally {
      baggageScope.dispose();
    }
  }

  /**
   * Opens the root `invoke_agent` scope for the turn.
   * Returns null when the turn carries no real agent identity — a synthetic id would
   * produce spans the exporter cannot authenticate, so the turn runs untraced instead.
   */
  private startInvokeAgentScope(turnContext: TurnContext, userMessage: string, channelName?: string): InvokeAgentScope | null {
    const agentDetails = buildAgentDetails(turnContext);
    if (!agentDetails) {
      return null;
    }

    const request: A365Request = {
      content: userMessage,
      conversationId: turnContext.activity?.conversation?.id,
      channel: { name: resolveChannelName(turnContext, channelName) },
    };

    const from = turnContext.activity?.from;
    const callerDetails: CallerDetails = {
      userDetails: {
        userId: from?.aadObjectId || from?.id || '',
        userName: from?.name || '',
        tenantId: agentDetails.tenantId,
      },
    };

    const scopeDetails: InvokeAgentScopeDetails = {
      endpoint: {
        host: process.env.WEBSITE_HOSTNAME || 'localhost',
        port: Number(process.env.PORT) || 3978,
      },
    };

    return InvokeAgentScope.start(request, scopeDetails, agentDetails, callerDetails);
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
      console.log(`Preloaded Observability token for agentId=${agentId}, tenantId=${tenantId} token=${aauToken?.token?.substring(0, 10)}...`);
      const cacheKey = createAgenticTokenCacheKey(agentId, tenantId);
      tokenCache.set(cacheKey, aauToken?.token || '');
    } else {
      await AgenticTokenCacheInstance.refreshObservabilityToken(
        agentId,
        tenantId,
        turnContext as any,
        this.authorization as any
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

    const retrievePrompt =
      `You have a new email from ${context.activity.from?.name} with id '${emailNotification.id}', ` +
      `ConversationId '${emailNotification.conversationId}'. Please retrieve this message and return it in text format.`;

    try {
      await this.runTraced(context, retrievePrompt, async (scope) => {
        scope?.recordInputMessages([retrievePrompt]);
        const client: Client = await getClient(this.authorization, A365Agent.authHandlerName, context);

        // First, retrieve the email content
        const emailContent = await client.invokeInferenceScope(retrievePrompt, EMAIL_CHANNEL_NAME);

        // Then process the email
        const response = await client.invokeInferenceScope(
          `You have received the following email. Please follow any instructions in it. ${emailContent}`,
          EMAIL_CHANNEL_NAME
        );

        const finalResponse = response || 'I have processed your email but do not have a response at this time.';
        scope?.recordOutputMessages([finalResponse]);
        await context.sendActivity(createEmailResponseActivity(finalResponse));
      }, EMAIL_CHANNEL_NAME);
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
