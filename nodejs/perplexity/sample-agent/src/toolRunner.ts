// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TurnContext } from "@microsoft/agents-hosting";
import {
  AgentDetails,
  ExecuteToolScope,
  TenantDetails,
  type ToolCallDetails,
} from "@microsoft/agents-a365-observability";
import {
  extractAgentDetailsFromTurnContext,
  extractTenantDetailsFromTurnContext,
} from "./telemetryHelpers.js";

/**
 * ToolRunner handles the execution of tools with proper telemetry.
 */
export class ToolRunner {
  /**
   * Performs a tool call with telemetry tracking.
   * @param turnContext The context of the current turn.
   * @param invokeScope The scope for invoking the agent.
   * @returns The result of the tool call.
   */
  async runToolFlow(turnContext: TurnContext): Promise<void> {
    const streamingResponse = (turnContext as any).streamingResponse;

    // Show progress indicator (streaming or normal)
    if (streamingResponse) {
      streamingResponse.queueInformativeUpdate("Now performing a tool call...");
    } else {
      await turnContext.sendActivity("Now performing a tool call...");
    }

    const agentDetails = extractAgentDetailsFromTurnContext(
      turnContext
    ) as AgentDetails;
    const tenantDetails = extractTenantDetailsFromTurnContext(
      turnContext
    ) as TenantDetails;

    const toolDetails: ToolCallDetails = {
      toolName: "send-email-demo",
      toolCallId: `tool-${Date.now()}`,
      description: "Demo tool that pretends to send an email",
      arguments: JSON.stringify({
        recipient: "user@example.com",
        subject: "Hello",
        body: "Test email from demo tool",
      }),
      toolType: "function",
    };

    const toolScope = ExecuteToolScope.start(
      toolDetails,
      agentDetails,
      tenantDetails
    );

    try {
      const response = await (toolScope
        ? toolScope.withActiveSpanAsync(() => this.runDemoToolWork(toolScope))
        : this.runDemoToolWork());

      toolScope?.recordResponse(response);

      if (streamingResponse) {
        streamingResponse.queueTextChunk(`Tool Response: ${response}`);
        await streamingResponse.endStream();
      } else {
        await turnContext.sendActivity(`Tool Response: ${response}`);
      }
    } catch (error) {
      toolScope?.recordError(error as Error);
      const err = error as any;
      const errorMessage = `Tool error: ${err.message || err}`;

      if (streamingResponse) {
        streamingResponse.queueTextChunk(errorMessage);
        await streamingResponse.endStream();
      } else {
        await turnContext.sendActivity(errorMessage);
      }

      throw error;
    } finally {
      toolScope?.dispose();
    }
  }

  /**
   * Runs the demo tool work simulating an email send.
   * @param toolScope The scope for executing the tool.
   * @returns The result of the tool execution.
   */
  private async runDemoToolWork(toolScope?: ExecuteToolScope): Promise<string> {
    // Simulate tool latency
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const response = "Email sent successfully to user@example.com";

    toolScope?.recordResponse?.(response);
    return response;
  }
}
