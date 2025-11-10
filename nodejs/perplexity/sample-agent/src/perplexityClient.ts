import { Perplexity } from '@perplexity-ai/perplexity_ai';
import { InferenceScope, InvokeAgentScope, InvokeAgentDetails, AgentDetails, TenantDetails } from '@microsoft/agents-a365-observability';

// Minimal interface based on observed SDK response shape
interface ChatMessage {
  role: string;
  content: unknown;
}

interface ChatChoice {
  index?: number;
  message?: ChatMessage;
  finish_reason?: string;
}

interface ChatCompletionResponse {
  id?: string;
  created?: number;
  model?: string;
  choices?: ChatChoice[];
  [key: string]: unknown;
}

/**
 * PerplexityClient provides an interface to interact with the Perplexity SDK.
 * It maintains a Perplexity client instance and exposes an invokeAgent method.
 */
export class PerplexityClient {
  private client: Perplexity;
  private model: string;

  constructor(apiKey: string, model: string = 'sonar') {
    this.client = new Perplexity({ apiKey });
    this.model = model;
  }

  /**
   * Sends a user message to the Perplexity SDK and returns the AI's response.
   * 
   * @param {string} userMessage - The message or prompt to send to Perplexity.
   * @returns {Promise<string>} The response from Perplexity, or an error message if the query fails.
   */
  async invokeAgent(userMessage: string): Promise<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a helpful assistant. Keep answers concise.' },
          { role: 'user', content: userMessage }
        ]
      });

      const completion = response as unknown as ChatCompletionResponse;
      const choice = completion?.choices?.[0];
      const rawContent = choice?.message?.content;
      
      if (typeof rawContent === 'string') {
        return rawContent;
      }
      
      return JSON.stringify(rawContent ?? completion, null, 2);
    } catch (error) {
      console.error('Perplexity agent error:', error);
      const err = error as any;
      return `Error: ${err.message || err}`;
    }
  }

  /**
   * Wrapper for invokeAgent that adds tracing and span management using Agent365 SDK.
   */
  async invokeAgentWithScope(prompt: string): Promise<string> {
    const invokeAgentDetails: InvokeAgentDetails = { 
      agentId: process.env.AGENT_ID || 'perplexity-agent' 
    };
    
    const agentDetails: AgentDetails = {
      agentId: 'perplexity-agent',
      agentName: 'Perplexity Agent',
    };

    const tenantDetails: TenantDetails = {
      tenantId: 'perplexity-sample-tenant',
    };
    
    const invokeAgentScope = InvokeAgentScope.start(invokeAgentDetails, agentDetails, tenantDetails);

    if (!invokeAgentScope) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return await this.invokeAgent(prompt);
    }

    try {
      return await invokeAgentScope.withActiveSpanAsync(async () => {
        const scope = InferenceScope.start({
          modelName: this.model,
          provider: 'perplexity',
          modelVersion: '1.0',
          temperature: 0.7,
          maxTokens: 500,
          topP: 0.9,
          prompt: prompt,
        }, agentDetails, tenantDetails);

        if (!scope) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return await this.invokeAgent(prompt);
        }

        try {
          const result = await scope.withActiveSpanAsync(async () => {
            const response = await this.invokeAgent(prompt);

            scope.recordResponse({
              content: response,
              responseId: `resp-${Date.now()}`,
              finishReason: 'stop',
              inputTokens: 0,  // Perplexity doesn't expose token counts
              outputTokens: 0,
            });

            return response;
          });

          return result;
        } catch (error) {
          scope.recordError(error as Error);
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
