// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { query, Options } from "@anthropic-ai/claude-agent-sdk";

export interface Client {
  invokeAgent(prompt: string, options?: Options): Promise<string>;
}

const defaultOptions: Options = {
  model: "claude-sonnet-4-5-20250929",
  permissionMode: "default",
  includePartialMessages: false,
  maxTurns: 15,
  continue: true,
};

class ClaudeAgentSDKClient implements Client {
  async invokeAgent(prompt: string, options?: Options): Promise<string> {
    let response = "";

    const result = query({
      prompt,
      options: { ...defaultOptions, ...options },
    });

    for await (const message of result) {
      console.log("Claude Agent SDK message:", message);
      if (message.type === "result" && message.subtype === "success") {
        response += message.result;
      } else if (
        message.type === "result" &&
        message.subtype === "error_during_execution"
      ) {
        throw new Error(`Claude Agent SDK error: ${message.type} `);
      }
    }

    return response;
  }
}

export default ClaudeAgentSDKClient;
