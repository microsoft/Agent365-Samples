// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Activity, ActivityTypes } from '@microsoft/agents-activity';
import { CopilotStudioClient, loadCopilotStudioConnectionSettingsFromEnv } from '@microsoft/agents-copilotstudio-client';
import { Authorization, TurnContext } from '@microsoft/agents-hosting';

// Observability Imports
import {
  InferenceScope,
  InferenceOperationType,
  AgentDetails,
  InferenceDetails,
  BaggageBuilder,
  TenantDetails,
} from '@microsoft/agents-a365-observability';

/**
 * Client interface for interacting with Copilot Studio agents.
 */
export interface Client {
  /**
   * Sends a message to the Copilot Studio agent and returns the response.
   * @param message - The message to send to the agent.
   * @returns The agent's response text.
   */
  invokeAgent(message: string): Promise<string>;

  /**
   * Sends a message wrapped in an observability inference scope.
   * @param prompt - The prompt to send to the agent.
   * @returns The agent's response text.
   */
  invokeInferenceScope(prompt: string): Promise<string>;
}

/**
 * Microsoft Copilot Studio (MCS) client wrapper for {@link CopilotStudioClient} that adds observability spans.
 *
 * The "Mcs" prefix stands for "Microsoft Copilot Studio" and indicates that this client is specific
 * to Copilot Studio agents, extending the base CopilotStudioClient with observability instrumentation.
 */
class McsClient implements Client {
  private client: CopilotStudioClient;
  private conversationId: string = '';

  constructor(client: CopilotStudioClient, private readonly turnContext: TurnContext) {
    this.client = client;
  }

  /**
   * Sends a message to the Copilot Studio agent and collects the response.
   * Uses sendActivityStreaming to handle responses from the agent.
   *
   * @param message - The message to send to the agent.
   * @returns The concatenated text responses from the agent.
   */
  async invokeAgent(message: string): Promise<string> {
    const responses: string[] = [];

    try {
      // If no conversation started yet, start one
      if (!this.conversationId) {
        for await (const activity of this.client.startConversationStreaming()) {
          if (activity.conversation?.id) {
            this.conversationId = activity.conversation.id;
          }
          if (activity.type === ActivityTypes.Message && activity.text) {
            responses.push(activity.text);
          }
        }
      }

      // Create user activity
      const userActivity = Activity.fromObject({
        type: ActivityTypes.Message,
        text: message,
        conversation: { id: this.conversationId }
      });

      // Send message and collect responses
      for await (const activity of this.client.sendActivityStreaming(userActivity, this.conversationId)) {
        if (activity.type === ActivityTypes.Message && activity.text) {
          responses.push(activity.text);
        }
      }

      return responses.join('\n') || 'No response from Copilot Studio agent.';
    } catch (error) {
      console.error('Error sending message to Copilot Studio:', error);
      throw error;
    }
  }

  /**
   * Sends a message wrapped in an observability inference scope.
   * Records telemetry data for the interaction.
   *
   * @param prompt - The prompt to send to the agent.
   * @returns The agent's response text.
   */
  async invokeInferenceScope(prompt: string): Promise<string> {
    const activity = this.turnContext.activity;
    const inferenceDetails: InferenceDetails = {
      operationName: InferenceOperationType.CHAT,
      model: 'copilot-studio-agent',
    };

    const agentDetails: AgentDetails = {
      agentId: activity.recipient?.agenticAppId
        || process.env.AGENT365_OBS_AGENT_ID || '',
      agentName: 'Copilot Studio Sample Agent',
      conversationId: activity.conversation?.id || this.conversationId,
      agentBlueprintId: activity.recipient?.agenticAppBlueprintId,
      agentAUID: activity.recipient?.aadObjectId,
    };
    const tenantDetails: TenantDetails = {
      tenantId: activity.recipient?.tenantId
        || activity.getAgenticTenantId()
        || activity.conversation?.tenantId
        || process.env.AGENT365_OBS_TENANT_ID || '',
    };

    const baggageScope = new BaggageBuilder()
      .agentId(agentDetails.agentId)
      .agentName(agentDetails.agentName)
      .agentAuid(agentDetails.agentAUID)
      .agentBlueprintId(agentDetails.agentBlueprintId)
      .tenantId(tenantDetails.tenantId)
      .correlationId(activity.id || `corr-${Date.now()}`)
      .callerId(activity.from?.aadObjectId || activity.from?.id)
      .callerName(activity.from?.name)
      .conversationId(activity.conversation?.id)
      .conversationItemLink(activity.serviceUrl)
      .sourceMetadataName(activity.channelId)
      .build();

    let response = '';
    try {
      await baggageScope.run(async () => {
        const scope = InferenceScope.start(
          inferenceDetails,
          agentDetails,
          tenantDetails,
          agentDetails.conversationId,
        );
        try {
          await scope.withActiveSpanAsync(async () => {
            response = await this.invokeAgent(prompt);
            scope.recordInputMessages([prompt]);
            scope.recordOutputMessages([response]);
            scope.recordResponseId(`resp-${Date.now()}`);
            scope.recordFinishReasons(['stop']);
          });
        } catch (error) {
          scope.recordError(error instanceof Error ? error : new Error(String(error)));
          throw error;
        } finally {
          scope.dispose();
        }
      });
    } finally {
      baggageScope.dispose();
    }

    return response;
  }
}

/**
 * Factory function to create a configured Copilot Studio client.
 * Acquires an OBO token and initializes the client with observability.
 *
 * @param authorization - Agent 365 authorization context for token acquisition.
 * @param authHandlerName - The name of the auth handler to use (typically 'agentic').
 * @param turnContext - Bot Framework turn context for the current conversation.
 * @returns A configured Client instance ready for agent interactions.
 *
 * @example
 * ```typescript
 * const client = await getClient(authorization, 'agentic', turnContext);
 * const response = await client.invokeInferenceScope("What's the weather?");
 * ```
 */
export async function getClient(
  authorization: Authorization,
  authHandlerName: string,
  turnContext: TurnContext
): Promise<Client> {
  // Load Copilot Studio connection settings from environment
  const settings = loadCopilotStudioConnectionSettingsFromEnv();

  // Acquire token for Copilot Studio API
  const tokenResult = await authorization.exchangeToken(turnContext, authHandlerName, {
    scopes: ['https://api.powerplatform.com/.default']
  });

  if (!tokenResult?.token) {
    throw new Error('Failed to acquire token for Copilot Studio. User may need to sign in.');
  }

  // Create the Copilot Studio client with the token
  const copilotClient = new CopilotStudioClient(settings, tokenResult.token);

  return new McsClient(copilotClient, turnContext);
}
