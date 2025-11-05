# Simple Claude Agent

An integration of **Claude Code SDK** with **Microsoft 365 Agents SDK** and **Agent 365 SDK** for conversational AI experiences.

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Anthropic API key from [https://console.anthropic.com/](https://console.anthropic.com/)

### Setup

1. **Install Dependencies**

   ```bash
   cd nodejs/claude/sample-agent
   npm install
   ```

2. **Configure Claude API Key**

   ```bash
   # 1. Get your API key from https://console.anthropic.com/
   # 2. Set your Anthropic API key in .env file
   ANTHROPIC_API_KEY=your_anthropic_api_key_here
   ```

3. **Configure Environment** (optional)

   ```bash
   cp env.TEMPLATE .env
   # Edit .env if needed for Azure Bot Service deployment or MCP Tooling
   # the .env is already configured for connecting to the Mock MCP Server.
   ```

4. **Start the Agent**

   ```bash
   npm run dev
   ```

5. **Test with Playground**
   ```bash
   npm run test-tool
   ```

## 💡 How It Works

This agent demonstrates the simplest possible integration between:

- **Claude Code SDK**: Provides AI capabilities with tool access
- **Microsoft 365 Agents SDK**: Handles conversational interface and enterprise features
- **Agents 365 SDK**: Handles MCP tooling and Agent Notification set up

### Key Features

- ✨ **Direct Claude Integration**: Uses `query()` API for natural conversations
- 🔧 **Tool Access**: Claude can use Read, Write, WebSearch, Bash, and Grep tools
- 🎴 **Adaptive Card Responses**: Beautiful, interactive card-based responses
- 💬 **Streaming Progress**: Real-time processing indicators
- 🏢 **Enterprise Features**: Sensitivity labels and compliance features

## 📝 Usage Examples

Just chat naturally with the agent:

```
"Use MailTools to send an email."
"Query my calendar with CalendarTools."
"Summarize a web page using NLWeb."
"Search SharePoint files with SharePointTools."
"Access my OneDrive files using OneDriveMCPServer."
```

## 🏗️ Architecture

```
User Input → M365 Agent → Claude Code SDK → AI Response → User
```

### Core Components

1. `src/index.js`: Server startup and configuration
2. `src/agent.js`: Main agent orchestration and turn handling
3. `src/claudeAgent.js`: Claude agent wrapper and higher-level logic
4. `src/claudeClient.js`: Claude SDK client
5. `src/adaptiveCards.js`: Adaptive card utilities for rich responses
6. `src/telemetry.js`: Application telemetry and tracing helpers
7. `src/evals/`: Evaluation scripts and result viewers (benchmarks and test harness)

### Simple Integration Pattern

```javascript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: userMessage,
  options: {
    allowedTools: ["Read", "Write", "WebSearch"],
    maxTurns: 3,
  },
})) {
  if (message.type === "result") {
    // Create adaptive card response
    const responseCard = createClaudeResponseCard(message.result, userMessage);
    const cardAttachment = MessageFactory.attachment({
      contentType: "application/vnd.microsoft.card.adaptive",
      content: responseCard,
    });
    await context.sendActivity(cardAttachment);
  }
}
```

## 🎴 Adaptive Card Features

The agent displays Claude responses in interactive adaptive cards featuring:

- **Rich Formatting**: Markdown rendering with styling
- **User Context**: Shows the original query for reference
- **Timestamps**: Generated response time for tracking
- **Interactive Actions**: Follow-up buttons and error recovery
- **Error Handling**: error cards with troubleshooting steps

### Card Types

1. **Response Cards**: Main Claude responses with formatted text
2. **Error Cards**: Friendly error handling with action buttons
3. **Thinking Cards**: Processing indicators (optional)

## 🔧 Customization

### Agent Notification Handling

You can handle agent notifications (such as email, mentions, etc.) using the `OnAgentNotification` method from the Agent 365 SDK. This allows your agent to respond to custom activities and notifications.

#### Example: Registering a Notification Handler

```javascript
import "@microsoft/agents-a365-notifications";
import { ClaudeAgent } from "./claudeAgent.js";

const claudeAgent = new ClaudeAgent(simpleClaudeAgent.authorization);

// Route all notifications (any channel)
simpleClaudeAgent.onAgentNotification(
  "*",
  claudeAgent.handleAgentNotificationActivity.bind(claudeAgent)
);
```

**Note:**

- The first argument to `onAgentNotification` can be a specific `channelId` (such as `'email'`, `'mention'`, etc.) to route only those notifications, or use `'*'` to route all notifications regardless of channel.

This enables flexible notification routing for your agent, allowing you to handle all notifications or only those from specific channels as needed.

### Add More Tools

Tools can be added directly to the `options` passed to the query, or dynamically registered using Agent 365 SDK's `McpToolRegistrationService.addMcpToolServers()` method.

#### Example: Registering MCP Tool Servers

```javascript
import { McpToolRegistrationService } from "@microsoft/agents-a365-tooling-extensions-claude";

const toolServerService = new McpToolRegistrationService();
const agentOptions = {
  allowedTools: ["Read", "Write", "WebSearch", "Bash", "Grep"],
  // ...other options
};

await toolServerService.addMcpToolServers(
  agentOptions,
  process.env.AGENTIC_USER_ID || "", // Only required outside development mode
  process.env.MCP_ENVIRONMENT_ID || "", // Only required outside development mode
  app.authorizaiton,
  turnContext,
  process.env.MCP_AUTH_TOKEN || "" // Only required if your mcp server requires this
);
```

This will register all MCP tool servers found in your ToolingManifest.json and make them available to the agent at runtime.

Depending on your environment, tool servers may also be discovered dynamically from a tooling gateway (such as via the Agent 365 SDK) instead of or in addition to ToolingManifest.json. This enables flexible and environment-specific tool server registration for your agent.

**Note:** The `allowedTools` and `mcpServers` properties in your agent options will be automatically modified by appending the tools found in the tool servers specified. This enables dynamic tool access for Claude and the agent, based on the current MCP tool server configuration.

**Note:** This sample uses the agentic authorization flow if MCP_AUTH_TOKEN is not provided. To run agentic auth you must provide values that match your Azure app registrations and tenant:

- `AGENT_APPLICATION_ID` — agent application (client) id
- `AGENT_CLIENT_SECRET` (optional) — if not using managed identity, provide the agent application client secret securely
- `AGENT_ID` — agent identity client id
- `USER_PRINCIPAL_NAME` — the agent's username (UPN)
- `AGENTIC_USER_ID` — agentic user id (used by some tooling flows)
- `MANAGED_IDENTITY_TOKEN` (optional, dev) — pre-acquired managed identity token used as a client_assertion fallback for local development

### Custom System Prompt

```javascript
appendSystemPrompt: "You are a specialized assistant for...";
```

### Conversation Memory

The agent maintains conversation context automatically through the M365 SDK.

## 🚢 Deployment

### Local Development

```bash
npm start  # Runs on localhost:3978
```

### Azure Bot Service

1. Create Azure Bot Service
2. Set environment variables in `.env`
3. Deploy to Azure App Service
4. Configure messaging endpoint

## ⚙️ Configuration

### Environment Variables

- `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`: Azure Bot Service credentials
- `ANTHROPIC_API_KEY`: Anthropic API key for Claude authentication (required)
- `NODE_ENV`: Environment (development/production)
- `PORT`: Server port (default: 3978)

### Claude Authentication

- Obtain an API key from [Anthropic Console](https://console.anthropic.com/)
- Set `ANTHROPIC_API_KEY` in your `.env` file
- Suitable for all deployment scenarios

## 🤝 Contributing

This is a minimal example. Extend it by [WIP]

## 📚 Learn More

- [Claude Agent SDK Documentation](https://docs.anthropic.com/claude-agent-sdk)
- [Microsoft 365 Agents SDK](https://github.com/microsoft/agents)
- [Agent Playground Tool](https://www.npmjs.com/package/@microsoft/m365agentsplayground)
