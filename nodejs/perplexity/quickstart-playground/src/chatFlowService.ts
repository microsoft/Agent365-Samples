// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TurnContext, TurnState } from "@microsoft/agents-hosting";
import type { InvokeAgentScope } from "@microsoft/agents-a365-observability";
import { PerplexityClient } from "./perplexityClient.js";
import { ToolRunner } from "./toolRunner.js";

/**
 * ChatFlowService manages the chat and tool invocation flow.
 */
export class ChatFlowService {
  constructor(private readonly getPerplexityClient: () => PerplexityClient) {}

  /**
   * Runs the main chat and tool flow.
   * @param turnContext The context of the current turn.
   * @param _state The state of the current turn.
   * @param userMessage The user's message.
   * @param invokeScope The scope for invoking the agent.
   */
  async runChatFlow(
    turnContext: TurnContext,
    _state: TurnState,
    userMessage: string,
    invokeScope: InvokeAgentScope | undefined
  ): Promise<void> {
    const streamingResponse = (turnContext as any).streamingResponse;
    const perplexityClient = this.getPerplexityClient();

    try {
      invokeScope?.recordInputMessages([userMessage]);

      if (streamingResponse) {
        streamingResponse.queueInformativeUpdate(
          "I'm working on your request..."
        );
      }

      invokeScope?.recordOutputMessages([
        "Message path: PerplexityInvocationStarted",
      ]);

      const response = await perplexityClient.invokeAgentWithScope(userMessage);

      invokeScope?.recordOutputMessages([
        "Message path: PerplexityInvocationSucceeded",
      ]);

      if (streamingResponse) {
        streamingResponse.queueTextChunk(response);
        await streamingResponse.endStream();
      } else {
        await turnContext.sendActivity(response);
      }

      invokeScope?.recordOutputMessages([
        "Message path: ChatOnly_CompletedSuccessfully",
      ]);
    } catch (error) {
      const err = error as any;
      const errorMessage = `Error: ${err.message || err}`;

      invokeScope?.recordError(error as Error);
      invokeScope?.recordOutputMessages([
        "Message path: ChatOnly_Error",
        errorMessage,
      ]);

      if (streamingResponse) {
        streamingResponse.queueTextChunk(errorMessage);
        await streamingResponse.endStream();
      } else {
        await turnContext.sendActivity(errorMessage);
      }
    }
  }
}
