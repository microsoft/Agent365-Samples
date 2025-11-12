# Agent Code Walkthrough

Step-by-step walkthrough of the complete agent implementation in `src/agent.ts`.

## Overview

| Component | Purpose |
|-----------|---------|
| **OpenAI Agents SDK** | Core AI orchestration and native function calling |
| **Microsoft 365 Agents SDK** | Enterprise hosting and authentication integration |
| **Agent Notifications** | Handle @mentions from Outlook, Word, and Excel |
| **MCP Servers** | External tool access and integration |
| **Microsoft Agent 365 Observability** | Comprehensive tracing and monitoring |

## File Structure and Organization

```
sample-agent/
├── src/
│   ├── agent.ts               # Main agent implementation (~60 lines)
│   ├── client.ts              # OpenAI client wrapper with observability
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
import { Agent, run } from '@openai/agents';
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
- **@openai/agents**: OpenAI Agents SDK for native AI orchestration and function calling
- **@microsoft/agents-a365-tooling-extensions-openai**: MCP tool registration service for OpenAI agents
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

## Step 3: Agent Creation

The agent client wrapper is defined in `client.ts`:

```typescript
const agent = new Agent({
    // You can customize the agent configuration here if needed
    name: 'OpenAI Agent',
  });

export async function getClient(authorization: any, turnContext: TurnContext): Promise<Client> {
  try {
    await toolService.addToolServersToAgent(
      agent,
      process.env.AGENTIC_USER_ID || '',
      process.env.MCP_ENVIRONMENT_ID || "",
      authorization,
      turnContext,
      process.env.MCP_AUTH_TOKEN || "",
    );
  } catch (error) {
    console.warn('Failed to register MCP tool servers:', error);
  }

  return new OpenAIClient(agent);
}
```

**What it does**: Creates a client wrapper that adds MCP tools to the OpenAI agent.

**What happens**:
1. **Tool Registration**: Dynamically adds MCP servers from ToolingManifest.json
2. **Authorization Flow**: Passes authentication context for tool access
3. **Error Resilience**: Continues even if tool registration fails
4. **Returns Client**: Wraps the agent with lifecycle and observability

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
    model: this.agent.model,
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

MCP servers are registered in the `getClient` function:

```typescript
await toolService.addToolServersToAgent(
  agent,
  process.env.AGENTIC_USER_ID || '',
  process.env.MCP_ENVIRONMENT_ID || "",
  authorization,
  turnContext,
  process.env.MCP_AUTH_TOKEN || "",
);
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
2. **Register Tools**: Adds each tool server to the OpenAI agent
3. **Authentication**: Maintains authorization context for tool access
4. **Graceful Failure**: Logs warning but continues if tool registration fails

---

## Step 6: Message Processing

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
3. **Create Client**: Gets OpenAI client with MCP tools and authorization
4. **Invoke Agent**: Calls agent with observability tracking
5. **Send Response**: Returns AI-generated response to user
6. **Error Handling**: Catches problems and returns friendly error messages

---

## Step 7: Notification Handling

```typescript
async handleAgentNotificationActivity(context: TurnContext, state: TurnState, agentNotificationActivity: AgentNotificationActivity) {
  context.sendActivity("Recieved an AgentNotification!");
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

## Step 8: Cleanup and Resource Management

Server lifecycle management is handled in `client.ts`:

```typescript
async invokeAgent(prompt: string): Promise<string> {
  try {
    await this.connectToServers();

    const result = await run(this.agent, prompt);
    return result.finalOutput || "Sorry, I couldn't get a response from OpenAI :(";
  } catch (error) {
    console.error('OpenAI agent error:', error);
    const err = error as any;
    return `Error: ${err.message || err}`;
  } finally {
    await this.closeServers();
  }
}

private async connectToServers(): Promise<void> {
  if (this.agent.mcpServers && this.agent.mcpServers.length > 0) {
    for (const server of this.agent.mcpServers) {
      await server.connect();
    }
  }
}

private async closeServers(): Promise<void> {
  if (this.agent.mcpServers && this.agent.mcpServers.length > 0) {
    for (const server of this.agent.mcpServers) {
      await server.close();
    }
  }
}
```

**What it does**: Properly manages MCP server connections for each request.

**What happens**:
1. **Connect**: Opens connections to all MCP servers before agent invocation
2. **Execute**: Runs the OpenAI agent with the user's prompt
3. **Cleanup**: Closes all server connections in the finally block
4. **Error Handling**: Logs errors but ensures cleanup always happens

**Why it's important**: Prevents connection leaks and ensures efficient resource usage!

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

### 2. **Resource Management**
Proper lifecycle with try-finally:
```typescript
try {
  await this.connectToServers();
  return await run(this.agent, prompt);
} finally {
  await this.closeServers();
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

### 3. **Advanced Observability**
Customize telemetry tracking:
```typescript
scope?.recordCustomMetric('metric-name', value);
scope?.addTags({ key: 'value' });
```

---

## Performance Considerations

### 1. **Async Operations**
- All I/O operations are asynchronous
- Proper promise handling throughout
- Efficient resource management

### 2. **Memory Management**
- Server connections opened and closed per request
- In-memory storage for conversation state
- Proper cleanup in finally blocks

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
Check MCP server registration:
```typescript
console.log('MCP Servers:', agent.mcpServers?.length);
```

### 3. **Verify Authorization**
Check authorization configuration:
```typescript
console.log('Authorization:', this.authorization);
```

This architecture provides a solid foundation for building production-ready AI agents with OpenAI Agents SDK while maintaining flexibility for customization and extension.