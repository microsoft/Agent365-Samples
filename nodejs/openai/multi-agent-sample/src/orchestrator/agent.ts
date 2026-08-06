// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { configDotenv } from 'dotenv';
configDotenv();

import { TurnState, AgentApplication, TurnContext, MemoryStorage } from '@microsoft/agents-hosting';
import { ActivityTypes } from '@microsoft/agents-activity';
import { BaggageBuilder } from '@microsoft/agents-a365-observability';
import { AgenticTokenCacheInstance, BaggageBuilderUtils } from '@microsoft/agents-a365-observability-hosting';
import { getObservabilityAuthenticationScope } from '@microsoft/agents-a365-runtime';
import { runSalesCampaignPipeline } from './state-machine';

export class OrchestratorAgent extends AgentApplication<TurnState> {
  static authHandlerName: string = 'agentic';

  constructor() {
    super({
      startTypingTimer: true,
      storage: new MemoryStorage(),
      authorization: {
        agentic: {
          type: 'agentic',
        },
      },
    });

    this.onActivity(ActivityTypes.Message, async (context: TurnContext, _state: TurnState) => {
      await this.handleMessage(context);
    }, [OrchestratorAgent.authHandlerName]);
  }

  private async handleMessage(turnContext: TurnContext): Promise<void> {
    const userMessage = turnContext.activity.text?.trim() || '';

    if (!userMessage) {
      await turnContext.sendActivity('Send me a campaign brief and I\'ll orchestrate the sales team agents.');
      return;
    }

    // Build baggage from TurnContext (extracts real tenant/agent/caller IDs in production)
    const baggageScope = BaggageBuilderUtils.fromTurnContext(
      new BaggageBuilder(),
      turnContext
    ).sessionDescription('Multi-agent sales campaign pipeline')
      .correlationId(`corr-${Date.now()}`)
      .build();

    // Preload observability token for A365 exporter
    await this.preloadObservabilityToken(turnContext);

    try {
      const response = await baggageScope.run(async () => {
        return runSalesCampaignPipeline(userMessage, turnContext);
      });
      await turnContext.sendActivity(response);
    } catch (error) {
      console.error('[Orchestrator] Pipeline error:', error);
      await turnContext.sendActivity(`Pipeline failed: ${(error as Error).message}`);
    } finally {
      baggageScope.dispose();
    }
  }

  /**
   * Preloads or refreshes the observability token used by the A365 exporter.
   * Non-fatal: if token acquisition fails, the pipeline still runs (console exporter fallback).
   */
  private async preloadObservabilityToken(turnContext: TurnContext): Promise<void> {
    const agentId = turnContext?.activity?.recipient?.agenticAppId ?? '';
    const tenantId = turnContext?.activity?.recipient?.tenantId ?? '';

    try {
      await AgenticTokenCacheInstance.RefreshObservabilityToken(
        agentId,
        tenantId,
        turnContext,
        this.authorization,
        getObservabilityAuthenticationScope()
      );
    } catch (error) {
      console.debug('[Orchestrator] Observability token preload skipped:', (error as Error).message);
    }
  }
}

export const agentApplication = new OrchestratorAgent();
