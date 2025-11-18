import { createAgent, ReactAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";

// Tooling Imports
import { McpToolRegistrationService } from '@microsoft/agents-a365-tooling-extensions-langchain';
import { Authorization, TurnContext } from '@microsoft/agents-hosting';

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
      .withService('TypeScript Sample Agent', '1.0.0')
);

sdk.start();

const toolService = new McpToolRegistrationService();

const agentName = "LangChain A365 Agent";
const agent = createAgent({
  model: new ChatOpenAI({ temperature: 0 }),
  name: agentName,
});

/**
 * Creates and configures a LangChain client with Agent 365 MCP tools.
 *
 * This factory function initializes a LangChain React agent with access to
 * Microsoft 365 tools through MCP (Model Context Protocol) servers. It handles
 * tool discovery, authentication, and agent configuration.
 *
 * @param authorization - Agent 365 authorization context for token acquisition
 * @param turnContext - Bot Framework turn context for the current conversation
 * @returns Promise<Client> - Configured LangChain client ready for agent interactions
 *
 * @example
 * ```typescript
 * const client = await getClient(authorization, turnContext);
 * const response = await client.invokeAgent("Send an email to john@example.com");
 * ```
 */
export async function getClient(authorization: Authorization, authHandlerName: string, turnContext: TurnContext): Promise<Client> {
  // Get Mcp Tools
  let agentWithMcpTools = undefined;
  try {
    agentWithMcpTools = await toolService.addToolServersToAgent(
      agent,
      authHandlerName,
      turnContext,
      process.env.BEARER_TOKEN || "",
    );
  } catch (error) {
    console.error('Error adding MCP tool servers:', error);
  }

  return new LangChainClient(agentWithMcpTools || agent);
}

/**
 * LangChainClient provides an interface to interact with LangChain agents.
 * It creates a React agent with tools and exposes an invokeAgent method.
 */
class LangChainClient implements Client {
  private agent: ReactAgent;

  constructor(agent: ReactAgent) {
    this.agent = agent;
  }

  /**
   * Sends a user message to the LangChain agent and returns the AI's response.
   * Handles streaming results and error reporting.
   *
   * @param {string} userMessage - The message or prompt to send to the agent.
   * @returns {Promise<string>} The response from the agent, or an error message if the query fails.
   */
  async invokeAgent(userMessage: string): Promise<string> {
    const result = await this.agent.invoke({
      messages: [
        {
          role: "user",
          content: userMessage,
        },
      ],
    });

    let agentMessage: any = '';

    // Extract the content from the LangChain response
    if (result.messages && result.messages.length > 0) {
      const lastMessage = result.messages[result.messages.length - 1];
      agentMessage = lastMessage.content || "No content in response";
    }

    // Fallback if result is already a string
    if (typeof result === 'string') {
      agentMessage = result;
    }

    if (!agentMessage) {
      return "Sorry, I couldn't get a response from the agent :(";
    }

    return agentMessage;
  }

  async invokeAgentWithScope(prompt: string) {
    const inferenceDetails: InferenceDetails = {
      operationName: InferenceOperationType.CHAT,
      model: "gpt-4o-mini",
    };

    const agentDetails: AgentDetails = {
      agentId: 'typescript-compliance-agent',
      agentName: 'TypeScript Compliance Agent',
      conversationId: 'conv-12345',
    };

    const tenantDetails: TenantDetails = {
      tenantId: 'typescript-sample-tenant',
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
