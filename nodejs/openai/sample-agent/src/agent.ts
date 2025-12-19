// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TurnState, AgentApplication, TurnContext, MemoryStorage } from '@microsoft/agents-hosting';
import { ActivityTypes } from '@microsoft/agents-activity';
import { BaggageBuilder } from '@microsoft/agents-a365-observability';
import {AgenticTokenCacheInstance, BaggageBuilderUtils} from '@microsoft/agents-a365-observability-hosting'
import { getObservabilityAuthenticationScope } from '@microsoft/agents-a365-runtime';

// Notification Imports
import '@microsoft/agents-a365-notifications';
import { AgentNotificationActivity } from '@microsoft/agents-a365-notifications';

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
        const client: Client = await getClient(this.authorization, MyAgent.authHandlerName, turnContext);
        const response = await client.invokeAgentWithScope(userMessage);
        await turnContext.sendActivity(response);
      });
    } catch (error) {
      console.error('LLM query error:', error);
      const err = error as any;
      await turnContext.sendActivity(`Error: ${err.message || err}`);
    } finally {
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
    context.sendActivity("Received an AgentNotification!");
    /* your logic here... */
  }
}

export const agentApplication = new MyAgent();
