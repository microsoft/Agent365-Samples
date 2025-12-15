import { TurnState, AgentApplication, TurnContext, MemoryStorage } from '@microsoft/agents-hosting';
import { ActivityTypes } from '@microsoft/agents-activity';

// Notification Imports
import '@microsoft/agents-a365-notifications';
import { AgentNotificationActivity } from '@microsoft/agents-a365-notifications';
// Observability Imports
import {
  AgentDetails,
  TenantDetails,
} from '@microsoft/agents-a365-observability';
import { BaggageBuilder } from '@microsoft/agents-a365-observability';
import { Client, getClient } from './client';

export class A365Agent extends AgentApplication<TurnState> {
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
    });

    this.onActivity(ActivityTypes.Message, async (context: TurnContext, state: TurnState) => {
      await this.handleAgentMessageActivity(context, state);
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

    const agentDetails: AgentDetails = {
      agentId: 'typescript-compliance-agent',
      agentName: 'TypeScript Compliance Agent',
      conversationId: 'conv-12345',
    };

    const tenantDetails: TenantDetails = {
      tenantId: 'typescript-sample-tenant',
    };
    const baggageScope = new BaggageBuilder()
      .tenantId(tenantDetails.tenantId)
      .agentId(agentDetails.agentId)
      .agentName(agentDetails.agentName)
      .conversationId(agentDetails.conversationId)
      .correlationId(`corr-${Date.now()}`)
      .build();

    try {
      await baggageScope.run(async () => {
        try {
          const client: Client = await getClient(this.authorization, A365Agent.authHandlerName, turnContext);
          const response = await client.invokeInferenceScope(userMessage);
          await turnContext.sendActivity(response);
        } catch (error) {
          console.error('LLM query error:', error);
          const err = error as any;
          await turnContext.sendActivity(`Error: ${err.message || err}`);
        }
      });
    } finally {
      baggageScope.dispose();
    }
  }

  async handleAgentNotificationActivity(context: TurnContext, state: TurnState, agentNotificationActivity: AgentNotificationActivity) {
    context.sendActivity("Recieved an AgentNotification!");
    /* your logic here... */
  }
}

export const agentApplication = new A365Agent();
