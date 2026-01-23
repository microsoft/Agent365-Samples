// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Activity, ActivityTypes } from '@microsoft/agents-activity';
import { CopilotStudioClient, loadCopilotStudioConnectionSettingsFromEnv } from '@microsoft/agents-copilotstudio-client';
import { Authorization, TurnContext } from '@microsoft/agents-hosting';

// Observability Imports
import {
  ObservabilityManager,
  InferenceScope,
  Builder,
  InferenceOperationType,
  AgentDetails,
  TenantDetails,
  InferenceDetails,
  Agent365ExporterOptions,
} from '@microsoft/agents-a365-observability';
import { AgenticTokenCacheInstance } from '@microsoft/agents-a365-observability-hosting';

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
 * Configure Agent 365 Observability for telemetry export.
 */
export const a365Observability = ObservabilityManager.configure((builder: Builder) => {
  const exporterOptions = new Agent365ExporterOptions();
  exporterOptions.maxQueueSize = 10;

  builder
    .withService('Copilot Studio Sample Agent', '1.0.0')
    .withExporterOptions(exporterOptions);

  if (process.env.Use_Custom_Resolver === 'true') {
    // Custom token resolver would be configured here if needed
    builder.withTokenResolver((agentId: string, tenantId: string) =>
      AgenticTokenCacheInstance.getObservabilityToken(agentId, tenantId)
    );
  } else {
    builder.withTokenResolver((agentId: string, tenantId: string) =>
      AgenticTokenCacheInstance.getObservabilityToken(agentId, tenantId)
    );
  }
});

// Start observability collection
a365Observability.start();

/**
 * Microsoft Copilot Studio (MCS) client wrapper for {@link CopilotStudioClient} that adds observability spans.
 *
 * The "Mcs" prefix stands for "Microsoft Copilot Studio" and indicates that this client is specific
 * to Copilot Studio agents, extending the base CopilotStudioClient with observability instrumentation.
 */
class McsClient implements Client {
  private client: CopilotStudioClient;
  private conversationId: string = '';

  constructor(client: CopilotStudioClient) {
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
    const inferenceDetails: InferenceDetails = {
      operationName: InferenceOperationType.CHAT,
      model: 'copilot-studio-agent',
    };

    const agentDetails: AgentDetails = {
      agentId: 'copilot-studio-sample-agent',
      agentName: 'Copilot Studio Sample Agent',
      conversationId: this.conversationId || `conv-${Date.now()}`,
    };

    const tenantDetails: TenantDetails = {
      tenantId: process.env.tenantId || 'unknown-tenant',
    };

    let response = '';
    const scope = InferenceScope.start(inferenceDetails, agentDetails, tenantDetails);

    try {
      await scope.withActiveSpanAsync(async () => {
        response = await this.invokeAgent(prompt);

        // Record the inference telemetry
        scope.recordInputMessages([prompt]);
        scope.recordOutputMessages([response]);
        scope.recordResponseId(`resp-${Date.now()}`);
        scope.recordFinishReasons(['stop']);
      });
    } catch (error) {
      scope.recordError(error as Error);
      throw error;
    } finally {
      scope.dispose();
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

  return new McsClient(copilotClient);
}
