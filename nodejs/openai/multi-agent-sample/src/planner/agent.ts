// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { configDotenv } from 'dotenv';
configDotenv();

import { TurnState, AgentApplication, TurnContext, MemoryStorage } from '@microsoft/agents-hosting';
import { ActivityTypes } from '@microsoft/agents-activity';
import { BaggageBuilder } from '@microsoft/agents-a365-observability';
import { BaggageBuilderUtils } from '@microsoft/agents-a365-observability-hosting';
import { handlePlannerRequest } from './handler';

export class PlannerAgent extends AgentApplication<TurnState> {
  static authHandlerName = 'agentic';

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
    }, [PlannerAgent.authHandlerName]);
  }

  private async handleMessage(turnContext: TurnContext): Promise<void> {
    const userMessage = turnContext.activity.text?.trim() || '';

    if (!userMessage) {
      await turnContext.sendActivity('Send me a campaign brief and I\'ll create a plan.');
      return;
    }

    const baggageScope = BaggageBuilderUtils.fromTurnContext(
      new BaggageBuilder(),
      turnContext
    ).sessionDescription('Planner agent')
      .correlationId(`corr-${Date.now()}`)
      .build();

    try {
      const result = await baggageScope.run(async () => {
        return handlePlannerRequest(
          { runId: `run-${Date.now()}`, step: 1, payload: { request: userMessage } },
          {}
        );
      });
      await turnContext.sendActivity(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error('[Planner] Error:', error);
      await turnContext.sendActivity(`Error: ${(error as Error).message}`);
    } finally {
      baggageScope.dispose();
    }
  }
}

export const agentApplication = new PlannerAgent();
