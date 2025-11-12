# Agent Code Walkthrough

Step-by-step walkthrough of the complete agent implementation in `src/agent.ts`.

## Overview

| Component | Purpose |
|-----------|---------|
| **Claude Agent SDK** | Core AI orchestration and agentic workflow management |
| **Microsoft 365 Agents SDK** | Enterprise hosting and authentication integration |
| **Agent Notifications** | Handle @mentions from Outlook, Word, and Excel |
| **MCP Servers** | External tool access and integration |
| **Microsoft Agent 365 Observability** | Comprehensive tracing and monitoring |

## File Structure and Organization

```
sample-agent/
├── src/
│   ├── agent.ts               # Main agent implementation (~60 lines)
│   ├── client.ts              # Claude client wrapper with observability
│   └── index.ts               # Express server entry point
├── ToolingManifest.json       # MCP tools definition
├── package.json               # Dependencies and scripts
└── .env                       # Configuration (not committed)
```

---

---

## Step 1: Dependency Imports

### agent.ts imports:
```typescript
import { TurnState, AgentApplication, TurnContext, MemoryStorage } from '@microsoft/agents-hosting';
import { ActivityTypes } from '@microsoft/agents-activity';

// Notification Imports
import '@microsoft/agents-a365-notifications';
import { AgentNotificationActivity } from '@microsoft/agents-a365-notifications';
```

### client.ts imports:
```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { TurnContext } from '@microsoft/agents-hosting';

import { McpToolRegistrationService } from '@microsoft/agents-a365-tooling-extensions-openai';

// Observability Imports
import {
  ObservabilityManager,
  InferenceScope,
  Builder,
  InferenceOperationType,
  AgentDetails,
  TenantDetails,
  InferenceDetails
} from '@microsoft/agents-a365-observability';
```

**What it does**: Brings in all the external libraries and tools the agent needs to work.

**Key Imports**:
- **@microsoft/agents-hosting**: Bot Framework integration for hosting and turn management
- **@microsoft/agents-activity**: Activity types for different message formats
- **@microsoft/agents-a365-notifications**: Handles @mentions from Outlook, Word, and Excel
- **@anthropic-ai/claude-agent-sdk**: Claude Agent SDK for agentic AI orchestration
- **@microsoft/agents-a365-tooling-extensions-openai**: MCP tool registration service (compatible with Claude)
- **@microsoft/agents-a365-observability**: Comprehensive telemetry, tracing, and monitoring infrastructure

---

## Step 2: Agent Initialization

```typescript
export class MyAgent extends AgentApplication<TurnState> {

  constructor() {
    super({
      startTypingTimer: true,
      storage: new MemoryStorage(),
      authorization: {
        agentic: {
          type: 'agentic',
        } // scopes set in the .env file...
      }
    });

    // Route agent notifications
    this.onAgentNotification("agents:*", async (context: TurnContext, state: TurnState, agentNotificationActivity: AgentNotificationActivity) => {
      await this.handleAgentNotificationActivity(context, state, agentNotificationActivity);
    });

    this.onActivity(ActivityTypes.Message, async (context: TurnContext, state: TurnState) => {
      await this.handleAgentMessageActivity(context, state);
    });
  }
}
```

**What it does**: Creates the main AI agent and sets up its basic behavior.

**What happens**:
1. **Extends AgentApplication**: Inherits Bot Framework hosting capabilities
2. **Typing Indicator**: Shows "typing..." while processing messages
3. **Memory Storage**: Uses in-memory conversation state storage
4. **Agentic Authorization**: Enterprise-grade authentication (scopes from .env)
5. **Event Routing**: Registers handlers for messages and notifications

---

## Step 3: Agent Configuration

The agent client wrapper is defined in `client.ts`:

```typescript
// Claude agent configuration
const agentConfig = {
  model: 'claude-3-5-sonnet' as const,
  cwd: process.cwd(),
  maxTurns: 50,
  mcpServers: {} as Record<string, any>
};

export async function getClient(authorization: any, turnContext: TurnContext): Promise<Client> {
  try {
    // Get MCP servers configuration
    const mcpServers = await toolService.getMcpServersConfig(
      process.env.AGENTIC_USER_ID || '',
      process.env.MCP_ENVIRONMENT_ID || "",
      authorization,
      turnContext,
      process.env.MCP_AUTH_TOKEN || "",
    );

    // Update agent config with MCP servers
    agentConfig.mcpServers = mcpServers || {};
  } catch (error) {
    console.warn('Failed to retrieve MCP tool servers config:', error);
  }

  return new ClaudeClient(agentConfig);
}
```

**What it does**: Creates a client wrapper that configures Claude with MCP tools.

**What happens**:
1. **Claude Configuration**: Sets model, working directory, and turn limits
2. **MCP Server Discovery**: Retrieves MCP servers from ToolingManifest.json
3. **Authorization Flow**: Passes authentication context for tool access
4. **Error Resilience**: Continues even if tool registration fails
5. **Returns Client**: Wraps the configuration with lifecycle and observability

**Environment Variables**:
- `AGENTIC_USER_ID`: User identifier for the agent
- `MCP_ENVIRONMENT_ID`: Environment where MCP servers are provisioned
- `MCP_AUTH_TOKEN`: Bearer token for MCP server authentication

---

## Step 4: Observability Configuration

Observability is configured at the module level in `client.ts`:

```typescript
const sdk = ObservabilityManager.configure(
  (builder: Builder) =>
    builder
      .withService('TypeScript Sample Agent', '1.0.0')
);

sdk.start();
```

And applied per-invocation:

```typescript
async invokeAgentWithScope(prompt: string) {
  const inferenceDetails: InferenceDetails = {
    operationName: InferenceOperationType.CHAT,
    model: this.config.model,
  };

  const agentDetails: AgentDetails = {
    agentId: 'typescript-compliance-agent',
    agentName: 'TypeScript Compliance Agent',
    conversationId: 'conv-12345',
  };

  const tenantDetails: TenantDetails = {
    tenantId: 'typescript-sample-tenant',
  };

  const scope = InferenceScope.start(inferenceDetails, agentDetails, tenantDetails);

  const response = await this.invokeAgent(prompt);

  // Record the inference response with token usage
  scope?.recordOutputMessages([response]);
  scope?.recordInputMessages([prompt]);
  scope?.recordResponseId(`resp-${Date.now()}`);
  scope?.recordInputTokens(45);
  scope?.recordOutputTokens(78);
  scope?.recordFinishReasons(['stop']);

  return response;
}
```

**What it does**: Turns on detailed logging and monitoring so you can see what your agent is doing.

**What happens**:
1. **SDK Configuration**: Sets up observability with service name and version
2. **Inference Scope**: Creates telemetry context for each agent invocation
3. **Recording Metrics**: Captures input/output messages, tokens, and response IDs
4. **Multi-tenant Context**: Associates operations with agent, tenant, and conversation

**Why it's useful**: Like having a detailed diary of everything your agent does - great for troubleshooting!

---

## Step 5: MCP Server Setup

MCP servers are configured in the `getClient` function:

```typescript
// Get MCP servers configuration
const mcpServers = await toolService.getMcpServersConfig(
  process.env.AGENTIC_USER_ID || '',
  process.env.MCP_ENVIRONMENT_ID || "",
  authorization,
  turnContext,
  process.env.MCP_AUTH_TOKEN || "",
);

// Update agent config with MCP servers
agentConfig.mcpServers = mcpServers || {};
```

**What it does**: Connects your agent to external tools (like mail, calendar, notifications) that it can use to help users.

**Environment Variables**:
- `AGENTIC_USER_ID`: Identifier for the agent instance
- `MCP_ENVIRONMENT_ID`: Environment ID for MCP server provisioning
- `MCP_AUTH_TOKEN`: Bearer token for MCP authentication

**Authentication Modes**:
- **Agentic Authentication**: Enterprise-grade security with Azure AD (for production)
- **Bearer Token Authentication**: Simple token-based security (for development and testing)

**What happens**:
1. **Read Manifest**: Loads ToolingManifest.json to discover available MCP servers
2. **Configure Tools**: Retrieves MCP server configuration for Claude
3. **Authentication**: Maintains authorization context for tool access
4. **Graceful Failure**: Logs warning but continues if tool configuration fails

---

## Step 6: Message Processing with Claude

```typescript
async invokeAgent(prompt: string): Promise<string> {
  try {
    const result = query({
      prompt,
      options: {
        model: this.config.model,
        cwd: this.config.cwd,
        maxTurns: this.config.maxTurns,
        mcpServers: this.config.mcpServers
      }
    });

    let finalResponse = '';

    // Process streaming messages
    for await (const message of result) {
      if (message.type === 'result') {
        // Get the final output from the result message
        const resultContent = message.content;
        if (resultContent && resultContent.length > 0) {
          for (const content of resultContent) {
            if (content.type === 'text') {
              finalResponse += content.text;
            }
          }
        }
      } else if (message.type === 'assistant') {
        // Get assistant message content
        const assistantContent = message.content;
        if (assistantContent && assistantContent.length > 0) {
          for (const content of assistantContent) {
            if (content.type === 'text') {
              finalResponse += content.text;
            }
          }
        }
      }
    }

    return finalResponse || "Sorry, I couldn't get a response from Claude :(";
  } catch (error) {
    console.error('Claude agent error:', error);
    const err = error as any;
    return `Error: ${err.message || err}`;
  }
}
```

**What it does**: Invokes Claude Agent SDK and processes streaming responses.

**What happens**:
1. **Query Invocation**: Calls `query()` with prompt and configuration
2. **Streaming Processing**: Iterates through streaming messages asynchronously
3. **Message Handling**: Extracts text content from assistant and result messages
4. **Response Aggregation**: Combines text chunks into final response
5. **Error Handling**: Catches problems and returns friendly error messages

**Why streaming matters**: Claude Agent SDK returns messages as they arrive, allowing for real-time processing!

---

## Step 7: Main Message Handler

```typescript
async handleAgentMessageActivity(turnContext: TurnContext, state: TurnState): Promise<void> {
  const userMessage = turnContext.activity.text?.trim() || '';

  if (!userMessage) {
    await turnContext.sendActivity('Please send me a message and I\'ll help you!');
    return;
  }

  try {
    const client: Client = await getClient(this.authorization, turnContext);
    const response = await client.invokeAgentWithScope(userMessage);
    await turnContext.sendActivity(response);
  } catch (error) {
    console.error('LLM query error:', error);
    const err = error as any;
    await turnContext.sendActivity(`Error: ${err.message || err}`);
  }
}
```

**What it does**: Handles regular chat messages from users.

**What happens**:
1. **Extract Message**: Gets the user's text from the activity
2. **Validate Input**: Checks for non-empty message
3. **Create Client**: Gets Claude client with MCP tools and authorization
4. **Invoke Agent**: Calls agent with observability tracking
5. **Send Response**: Returns AI-generated response to user
6. **Error Handling**: Catches problems and returns friendly error messages

---

## Step 8: Notification Handling

```typescript
async handleAgentNotificationActivity(context: TurnContext, state: TurnState, agentNotificationActivity: AgentNotificationActivity) {
  context.sendActivity("Received an AgentNotification!");
  /* your logic here... */
}
```

**What it does**: Handles notifications from Microsoft 365 apps like Outlook and Word.

**What happens**:
- **Event Recognition**: Receives agent notification activities
- **Acknowledgment**: Sends a simple acknowledgment message
- **Extensibility**: Placeholder for custom notification logic

**To extend this handler, you would**:
1. Check `agentNotificationActivity.notificationType` (e.g., EmailNotification, WpxComment)
2. Extract notification-specific data from the activity
3. Create a client and invoke the agent with notification context
4. Return an appropriate response

---

## Step 9: Main Entry Point

The main entry point is in `index.ts`:

```typescript
import { configDotenv } from 'dotenv';
configDotenv();

import { AuthConfiguration, authorizeJWT, CloudAdapter, Request } from '@microsoft/agents-hosting';
import express, { Response } from 'express'
import { agentApplication } from './agent';

const authConfig: AuthConfiguration = {};

const server = express()
server.use(express.json())
server.use(authorizeJWT(authConfig))

server.post('/api/messages', (req: Request, res: Response) => {
  const adapter = agentApplication.adapter as CloudAdapter;
  adapter.process(req, res, async (context) => {
    await agentApplication.run(context)
  })
})

const port = process.env.PORT || 3978
server.listen(port, async () => {
  console.log(`\nServer listening to port ${port} for appId ${authConfig.clientId} debug ${process.env.DEBUG}`)
})
```

**What it does**: Starts the HTTP server and sets up Bot Framework integration.

**What happens**:
1. **Load Environment**: Reads .env file before importing other modules
2. **Create Express Server**: Sets up HTTP server with JSON parsing
3. **JWT Authorization**: Adds authentication middleware
4. **Bot Framework Endpoint**: Creates /api/messages endpoint for Bot Framework
5. **Start Server**: Listens on configured port (default 3978)

**Why it's useful**: This is the entry point that makes your agent accessible via HTTP!

---

## Design Patterns and Best Practices

### 1. **Factory Pattern**
Clean client creation through factory function:
```typescript
const client = await getClient(authorization, turnContext);
```

### 2. **Streaming Processing**
Asynchronous iteration over Claude SDK messages:
```typescript
for await (const message of result) {
  // Process streaming messages
}
```

### 3. **Event-Driven Architecture**
Bot Framework event routing:
```typescript
this.onActivity(ActivityTypes.Message, async (context, state) => {
  await this.handleAgentMessageActivity(context, state);
});

this.onAgentNotification("agents:*", async (context, state, activity) => {
  await this.handleAgentNotificationActivity(context, state, activity);
});
```

---

## Extension Points

### 1. **Adding New Capabilities**
Extend notification handling for specific types:
```typescript
async handleAgentNotificationActivity(context, state, activity) {
  switch (activity.notificationType) {
    case NotificationTypes.EMAIL_NOTIFICATION:
      // Handle email
      break;
    case NotificationTypes.WPX_COMMENT:
      // Handle Word comment
      break;
  }
}
```

### 2. **Adding MCP Servers**
Add new MCP servers in ToolingManifest.json:
```json
{
  "mcpServerName": "mcp_Server"
}
```

### 3. **Advanced Claude Configuration**
Customize Claude Agent SDK options:
```typescript
const result = query({
  prompt,
  options: {
    model: 'claude-3-5-sonnet',
    maxTurns: 100,
    permissionMode: 'plan',
    systemPrompt: 'Custom instructions...'
  }
});
```

---

## Performance Considerations

### 1. **Async Operations**
- All I/O operations are asynchronous
- Proper promise handling throughout
- Streaming message processing

### 2. **Memory Management**
- In-memory storage for conversation state
- Efficient streaming message handling
- Proper cleanup and error handling

### 3. **Error Recovery**
- Graceful degradation on tool failures
- User-friendly error messages
- Comprehensive error logging

---

## Debugging Guide

### 1. **Enable Debug Logging**
Set DEBUG environment variable:
```bash
DEBUG=*
```

### 2. **Test MCP Connection**
Check MCP server configuration:
```typescript
console.log('MCP Servers:', agentConfig.mcpServers);
```

### 3. **Verify Authorization**
Check authorization configuration:
```typescript
console.log('Authorization:', this.authorization);
```

### 4. **Monitor Streaming Messages**
Log incoming messages from Claude:
```typescript
for await (const message of result) {
  console.log('Message type:', message.type);
  console.log('Message content:', message.content);
}
```

This architecture provides a solid foundation for building production-ready AI agents with Claude Agent SDK while maintaining flexibility for customization and extension.
