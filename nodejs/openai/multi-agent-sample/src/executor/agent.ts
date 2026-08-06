// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { configDotenv } from 'dotenv';
configDotenv();

import { TurnState, AgentApplication, TurnContext, MemoryStorage } from '@microsoft/agents-hosting';
import { ActivityTypes } from '@microsoft/agents-activity';
import { BaggageBuilder } from '@microsoft/agents-a365-observability';
import { BaggageBuilderUtils } from '@microsoft/agents-a365-observability-hosting';
import { handleExecutorRequest } from './handler';

export class ExecutorAgent extends AgentApplication<TurnState> {
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
    }, [ExecutorAgent.authHandlerName]);
  }

  private async handleMessage(turnContext: TurnContext): Promise<void> {
    const userMessage = turnContext.activity.text?.trim() || '';

    if (!userMessage) {
      await turnContext.sendActivity('Send me a campaign plan and I\'ll execute it.');
      return;
    }

    const baggageScope = BaggageBuilderUtils.fromTurnContext(
      new BaggageBuilder(),
      turnContext
    ).sessionDescription('Executor agent')
      .correlationId(`corr-${Date.now()}`)
      .build();

    try {
      const result = await baggageScope.run(async () => {
        return handleExecutorRequest(
          { runId: `run-${Date.now()}`, step: 2, payload: { mode: 'draft', request: userMessage } },
          {}
        );
      });
      await turnContext.sendActivity(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error('[Executor] Error:', error);
      await turnContext.sendActivity(`Error: ${(error as Error).message}`);
    } finally {
      baggageScope.dispose();
    }
  }
}

export const agentApplication = new ExecutorAgent();
