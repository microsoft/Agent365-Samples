import { ActivityTypes } from '@microsoft/agents-activity'
import { AgentApplicationBuilder, MemoryStorage } from '@microsoft/agents-hosting'

import '@microsoft/agents-a365-notifications'
import { ClaudeAgent } from './claudeAgent.js'

const storage = new MemoryStorage();

export const simpleClaudeAgent = new AgentApplicationBuilder()
  .withAuthorization({
    agentic: { } // We have the type and scopes set in the .env file
  })
  .withStorage(storage)
  .build();

// Create Claude Agent
// Pass the authorization from the agent application
const claudeAgent = new ClaudeAgent(simpleClaudeAgent.authorization);

// Register notification handler
// simpleClaudeAgent.onAgentNotification("*", claudeAgent.handleAgentNotificationActivity.bind(claudeAgent));
simpleClaudeAgent.onAgenticEmailNotification(claudeAgent.emailNotificationHandler.bind(claudeAgent));

simpleClaudeAgent.onAgenticWordNotification(claudeAgent.wordNotificationHandler.bind(claudeAgent));

// Welcome message when user joins
simpleClaudeAgent.onConversationUpdate('membersAdded', async (context, state) => {
  const welcomeMessage = `
🤖 **Simple Claude Agent** is ready!

This agent demonstrates MCP tooling integration and notification routing.

**Features:**
- Handles email notifications and @-mentions from Word and Excel using notification routing
- Integrates with Microsoft 365 via MCP Tooling

**Try these commands:**
  - Ask the agent to use MCP tools from tool servers
  - Send mock custom activities (email, mentions)
  `
  await context.sendActivity(welcomeMessage)
})

// Handle user messages
simpleClaudeAgent.onActivity(ActivityTypes.Message, claudeAgent.handleAgentMessageActivity.bind(claudeAgent));

// Handle installation updates
simpleClaudeAgent.onActivity(ActivityTypes.InstallationUpdate, claudeAgent.handleInstallationUpdateActivity.bind(claudeAgent))