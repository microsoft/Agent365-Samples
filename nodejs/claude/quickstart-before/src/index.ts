// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import "dotenv/config";
import { startServer } from "@microsoft/agents-hosting-express";
import {
  TurnState,
  MemoryStorage,
  TurnContext,
  AgentApplication,
} from "@microsoft/agents-hosting";
import { ActivityTypes } from "@microsoft/agents-activity";
import ClaudeAgentSDKClient from "./client.js";

// Create custom conversation state properties.  This is
// used to store customer properties in conversation state.
interface ConversationState {
  count: number;
}
type ApplicationTurnState = TurnState<ConversationState>;

// Register IStorage.  For development, MemoryStorage is suitable.
// For production Agents, persisted storage should be used so
// that state survives Agent restarts, and operates correctly
// in a cluster of Agent instances.
const storage = new MemoryStorage();

const agentApp = new AgentApplication<ApplicationTurnState>({
  storage,
});

// Initialize Claude Agent SDK client
const claudeClient = new ClaudeAgentSDKClient();

// Display a welcome message when members are added
agentApp.onConversationUpdate(
  "membersAdded",
  async (context: TurnContext, state: ApplicationTurnState) => {
    await context.sendActivity("Hello and Welcome!");
  }
);

// Listen for ANY message to be received. MUST BE AFTER ANY OTHER MESSAGE HANDLERS
agentApp.onActivity(
  ActivityTypes.Message,
  async (context: TurnContext, state: ApplicationTurnState) => {
    // Increment count state
    let count = state.conversation.count ?? 0;
    state.conversation.count = ++count;

    // Use Claude Agent SDK to respond
    await respondWithClaudeAgentSDK(context, context.activity.text || "");
  }
);

async function respondWithClaudeAgentSDK(
  context: TurnContext,
  userMessage: string
): Promise<void> {
  try {
    // Invoke the Claude agent with the user's message
    const response = await claudeClient.invokeAgent(userMessage, {
      systemPrompt: `You are a helpful assistant. Respond to the user message below.
      Keep the response concise and to the point When asked about a task, first check if it can be achieved using ANY of your tools before denying the request.`,
      allowedTools: ["WebSearch", "WebFetch"],
    });

    // Send the response back to the user
    await context.sendActivity(response);
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Unknown error occurred during Claude invocation";
    await context.sendActivity(
      `Sorry, I encountered an error: ${errorMessage}`
    );
  }
}

startServer(agentApp);
