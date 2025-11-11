import { createAgent, ReactAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";

export interface Client {
  invokeAgent(prompt: string): Promise<string>;
}

/**
 * Creates and configures a LangChain client with Agent365 MCP tools.
 *
 * This factory function initializes a LangChain React agent with access to
 * Microsoft 365 tools through MCP (Model Context Protocol) servers. It handles
 * tool discovery, authentication, and agent configuration.
 *
 * @returns Promise<Client> - Configured LangChain client ready for agent interactions
 *
 * @example
 * ```typescript
 * const client = await getClient(authorization, turnContext);
 * const response = await client.invokeAgent("Send an email to john@example.com");
 * ```
 */
export async function getClient(): Promise<Client> {
  // Create the model
  const model = new ChatOpenAI({
    model: "gpt-4o-mini",
  });

  // Create the agent
  const agent = createAgent({
    model: model,
    tools: [],
    name: 'LangChain Agent',
  });

  return new LangChainClient(agent);
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

    let agentMessage = '';

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
}
