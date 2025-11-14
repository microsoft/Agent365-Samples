// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Perplexity } from "@perplexity-ai/perplexity_ai";
import {
  InferenceScope,
  AgentDetails,
  TenantDetails,
  InferenceDetails,
  InferenceOperationType,
} from "@microsoft/agents-a365-observability";

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

  constructor(apiKey: string, model: string = "sonar") {
    this.client = new Perplexity({ apiKey });
    this.model = model;
  }

  /**
   * Sends a user message to the Perplexity SDK and returns the AI's response.
   */
  async invokeAgent(userMessage: string): Promise<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: "system",
            content: "You are a helpful assistant. Keep answers concise.",
          },
          { role: "user", content: userMessage },
        ],
      });

      const completion = response as unknown as ChatCompletionResponse;
      const choice = completion?.choices?.[0];
      const rawContent = choice?.message?.content;

      if (typeof rawContent === "string") {
        return rawContent;
      }

      return JSON.stringify(rawContent ?? completion, null, 2);
    } catch (error) {
      console.error("Perplexity agent error:", error);
      const err = error as any;
      return `Error: ${err.message || err}`;
    }
  }

  /**
   * Wrapper for invokeAgent that adds tracing and span management using
   * Microsoft Agent 365 SDK (InferenceScope only).
   *
   * The outer InvokeAgentScope is created in agent.ts around the activity handler.
   */
  async invokeAgentWithScope(prompt: string): Promise<string> {
    const agentDetails: AgentDetails = {
      agentId: process.env.AGENT_ID || "perplexity-agent",
      agentName: process.env.AGENT_NAME || "Perplexity Agent",
    };

    const tenantDetails: TenantDetails = {
      tenantId: process.env.TENANT_ID || "perplexity-sample-tenant",
    };

    const inferenceDetails: InferenceDetails = {
      operationName: InferenceOperationType.CHAT,
      model: this.model,
      providerName: "perplexity",
    };

    const scope = InferenceScope.start(
      inferenceDetails,
      agentDetails,
      tenantDetails
    );

    // If observability isn't configured, just run the call
    if (!scope) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return await this.invokeAgent(prompt);
    }

    try {
      const result = await scope.withActiveSpanAsync(async () => {
        scope.recordInputMessages([prompt]);

        const response = await this.invokeAgent(prompt);

        scope.recordOutputMessages([response]);
        scope.recordResponseId(`resp-${Date.now()}`);
        scope.recordFinishReasons(["stop"]);

        return response;
      });

      return result;
    } catch (error) {
      scope.recordError(error as Error);
      throw error;
    } finally {
      scope.dispose();
    }
  }
}
