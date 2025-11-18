// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { TurnContext, Authorization } from '@microsoft/agents-hosting';

import { McpToolRegistrationService } from '@microsoft/agents-a365-tooling-extensions-claude';

// Observability Imports
import {
  ObservabilityManager,
  InferenceScope,
  Builder,
  InferenceOperationType,
  AgentDetails,
  TenantDetails,
  InferenceDetails
} from '@microsoft/agents-a365-observability';

export interface Client {
  invokeAgentWithScope(prompt: string): Promise<string>;
}

const sdk = ObservabilityManager.configure(
  (builder: Builder) =>
    builder
      .withService('TypeScript Claude Sample Agent', '1.0.0')
);

sdk.start();

const toolService = new McpToolRegistrationService();

// Claude agent configuration
const agentConfig = {
  maxTurns: 10,
  mcpServers: {} as Record<string, any>
};


export async function getClient(authorization: Authorization, authHandlerName: string, turnContext: TurnContext): Promise<Client> {
  try {
    await toolService.addToolServersToAgent(
      agentConfig,
      authorization,
      authHandlerName,
      turnContext,
      process.env.BEARER_TOKEN || "",
    );
  } catch (error) {
    console.warn('Failed to register MCP tool servers:', error);
  }

  return new ClaudeClient(agentConfig);
}

/**
 * ClaudeClient provides an interface to interact with the Claude Agent SDK.
 * It maintains agentConfig as an instance field and exposes an invokeAgent method.
 */
class ClaudeClient implements Client {
  config: typeof agentConfig;

  constructor(config: typeof agentConfig) {
    this.config = config;
  }

  /**
   * Sends a user message to the Claude Agent SDK and returns the AI's response.
   * Handles streaming results and error reporting.
   *
   * @param {string} userMessage - The message or prompt to send to Claude.
   * @returns {Promise<string>} The response from Claude, or an error message if the query fails.
   */
  async invokeAgent(prompt: string): Promise<string> {
    try {
      const result = query({
        prompt,
        options: {
          maxTurns: this.config.maxTurns,
          mcpServers: this.config.mcpServers
        }
      });

      let finalResponse = '';

      // Process streaming messages
      for await (const message of result) {
        if (message.type === 'result') {
          // Get the final output from the result message
          const resultContent = message.content;
          if (resultContent && resultContent.length > 0) {
            for (const content of resultContent) {
              if (content.type === 'text') {
                finalResponse += content.text;
              }
            }
          }
        } else if (message.type === 'assistant') {
          // Get assistant message content
          const assistantContent = message.content;
          if (assistantContent && assistantContent.length > 0) {
            for (const content of assistantContent) {
              if (content.type === 'text') {
                finalResponse += content.text;
              }
            }
          }
        }
      }

      return finalResponse || "Sorry, I couldn't get a response from Claude :(";
    } catch (error) {
      console.error('Claude agent error:', error);
      const err = error as any;
      return `Error: ${err.message || err}`;
    }
  }

  async invokeAgentWithScope(prompt: string) {
    const inferenceDetails: InferenceDetails = {
      operationName: InferenceOperationType.CHAT,
      model: this.config.model,
    };

    const agentDetails: AgentDetails = {
      agentId: 'claude-travel-agent',
      agentName: 'Claude Travel Agent',
      conversationId: 'conv-12345',
    };

    const tenantDetails: TenantDetails = {
      tenantId: 'claude-sample-tenant',
    };

    const scope = InferenceScope.start(inferenceDetails, agentDetails, tenantDetails);

    const response = await this.invokeAgent(prompt);

    // Record the inference response with token usage
    scope?.recordOutputMessages([response]);
    scope?.recordInputMessages([prompt]);
    scope?.recordResponseId(`resp-${Date.now()}`);
    scope?.recordInputTokens(45);
    scope?.recordOutputTokens(78);
    scope?.recordFinishReasons(['stop']);

    return response;
  }
}
