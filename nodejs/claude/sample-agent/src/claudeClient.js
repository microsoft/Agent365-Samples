import { InferenceScope, InvokeAgentScope, InferenceOperationType } from '@microsoft/agents-a365-observability';
import { query } from '@anthropic-ai/claude-agent-sdk';

export class ClaudeClient {

  constructor(agentOptions = {}) {
    this.agentOptions = agentOptions;
    this.configureAuthentication();
  }

  /**
   * Configures authentication for Claude API.
   * Requires API key authentication.
   */
  configureAuthentication() {
    // Check if API key is provided in environment
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Warning('ANTHROPIC_API_KEY environment variable is required. Get your API key from https://console.anthropic.com/');
    }
    
    // Ensure the API key is available in the environment for the Claude SDK
    this.agentOptions.env = {
      ...this.agentOptions.env,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
    };
  }

  /**
   * Sends a user message to the Claude Code SDK and returns the AI's response.
   * Handles streaming results and error reporting.
   *
   * @param {string} userMessage - The message or prompt to send to Claude.
   * @returns {Promise<string>} The response from Claude, or an error message if the query fails.
   */
  async invokeAgent(userMessage) {
    let claudeResponse = "";
    try {
      for await (const message of query({
        prompt: userMessage,
        options: this.agentOptions
      })) {
        if (message.type === 'result' && message.result) {
          claudeResponse = message.result;
          break;
        }
      }
      if (!claudeResponse) {
        return "Sorry, I couldn't get a response from Claude :(";
      }
      return claudeResponse;
    } catch (error) {
      console.error('Claude query error:', error);
      return `Error: ${error.message || error}`;
    }
  }

  /**
   * Wrapper for invokeAgent that adds tracing and span management using Agent365 SDK.
   * @param prompt - The prompt to send to Claude.
   */
  async invokeAgentWithScope(prompt) {
    const invokeAgentDetails = { agentId: process.env.AGENT_ID || 'sample-agent' };
    const invokeAgentScope = InvokeAgentScope.start(invokeAgentDetails);

    if (!invokeAgentScope) {
      // fallback: do the work without active parent span
      await new Promise((resolve) => setTimeout(resolve, 200));
      return await this.invokeAgent(prompt);
    }

    try {
      const inferenceDetails = {
    operationName: InferenceOperationType.CHAT,
    model: 'gpt-4',
    providerName: 'openai',
    inputTokens: 45,
    outputTokens: 78,
    responseId: `resp-${Date.now()}`,
    finishReasons: ['stop']
  };
      return await invokeAgentScope.withActiveSpanAsync(async () => {
        // Create the inference (child) scope while the invoke span is active
        const scope = InferenceScope.start(inferenceDetails);

        if (!scope) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return await this.invokeAgent(prompt);
        }

        try {
          // Activate the inference span for the inference work
          const result = await scope.withActiveSpanAsync(async () => {
            const response = await this.invokeAgent(prompt);
            scope.recordOutputMessages([{
              content: response,
              responseId: `resp-${Date.now()}`,
              finishReason: 'stop',
              inputTokens: 45,
              outputTokens: 78,
              totalTokens: 123,
            }]);
            return response;
          });
          return result;
        } catch (error) {
          scope.recordError(error);
          throw error;
        } finally {
          scope.dispose();
        }
      });
    } finally {
      invokeAgentScope.dispose();
    }
  }
}