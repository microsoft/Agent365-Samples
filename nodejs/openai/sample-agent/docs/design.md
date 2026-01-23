# OpenAI Sample Agent Design (Node.js/TypeScript)

## Overview

This sample demonstrates an agent built using the official OpenAI Agents SDK for Node.js. It showcases TypeScript patterns, MCP server integration, notification handling, and Microsoft Agent 365 observability.

## What This Sample Demonstrates

- OpenAI Agents SDK integration (`@openai/agents`)
- TypeScript with strict typing
- MCP server tool registration
- Agent 365 notification handling (Email, etc.)
- Observability with InferenceScope
- Token caching for authentication

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       index.ts                                   │
│  Express server + JWT middleware + /api/messages endpoint        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       agent.ts                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    MyAgent                                   ││
│  │  extends AgentApplication<TurnState>                         ││
│  │  ┌──────────────┐  ┌──────────────┐                         ││
│  │  │ Notifications│  │ Messages     │                         ││
│  │  │ Handler      │  │ Handler      │                         ││
│  │  └──────────────┘  └──────────────┘                         ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       client.ts                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              ObservabilityManager                            ││
│  │  configure() → withService() → withTokenResolver()           ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │           OpenAIAgentsTraceInstrumentor                      ││
│  │  Auto-instrumentation for OpenAI Agents SDK                  ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              OpenAIClient                                    ││
│  │  Agent + MCP Tools → invokeAgentWithScope()                  ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### src/index.ts
Application entry point:
- Environment configuration with dotenv
- Express server setup
- JWT authorization middleware
- POST /api/messages endpoint

### src/agent.ts
Agent application class:
- `MyAgent` extending `AgentApplication<TurnState>`
- Message activity handler
- Notification handlers (Email, etc.)
- Observability token preloading

### src/client.ts
LLM client and observability:
- `ObservabilityManager` configuration
- `OpenAIAgentsTraceInstrumentor` setup
- `getClient()` factory function
- `OpenAIClient` implementation with scopes

### src/token-cache.ts
Token caching utilities for observability.

## Message Flow

```
1. HTTP POST /api/messages
   │
2. Express middleware (JSON, JWT auth)
   │
3. CloudAdapter.process()
   │
4. MyAgent.handleAgentMessageActivity()
   │
5. BaggageBuilder context setup
   │  └── fromTurnContext() → sessionDescription() → correlationId()
   │
6. preloadObservabilityToken()
   │  └── AgenticTokenCacheInstance.RefreshObservabilityToken()
   │
7. baggageScope.run(async () => {
   │   ├── getClient() - Create agent with MCP tools
   │   └── client.invokeAgentWithScope(userMessage)
   │       ├── InferenceScope.start()
   │       ├── run(agent, prompt)
   │       ├── recordInputMessages(), recordOutputMessages()
   │       └── scope.dispose()
   │})
   │
8. turnContext.sendActivity(response)
```

## Observability Integration

### Manager Configuration
```typescript
export const a365Observability = ObservabilityManager.configure((builder: Builder) => {
  const exporterOptions = new Agent365ExporterOptions();
  exporterOptions.maxQueueSize = 10;

  builder
    .withService('TypeScript OpenAI Sample Agent', '1.0.0')
    .withExporterOptions(exporterOptions)
    .withTokenResolver((agentId, tenantId) =>
      AgenticTokenCacheInstance.getObservabilityToken(agentId, tenantId)
    );
});

// Enable instrumentation
const instrumentor = new OpenAIAgentsTraceInstrumentor({
  enabled: true,
  tracerName: 'openai-agent-auto-instrumentation',
});

a365Observability.start();
instrumentor.enable();
```

### InferenceScope Usage
```typescript
async invokeAgentWithScope(prompt: string): Promise<string> {
  const scope = InferenceScope.start(inferenceDetails, agentDetails, tenantDetails);
  try {
    await scope.withActiveSpanAsync(async () => {
      response = await this.invokeAgent(prompt);
      scope.recordInputMessages([prompt]);
      scope.recordOutputMessages([response]);
      scope.recordInputTokens(45);
      scope.recordOutputTokens(78);
      scope.recordFinishReasons(['stop']);
    });
  } finally {
    scope.dispose();
  }
  return response;
}
```

## Notification Handling

### Email Notifications
```typescript
async handleAgentNotificationActivity(context, state, notification) {
  switch (notification.notificationType) {
    case NotificationType.EmailNotification:
      await this.handleEmailNotification(context, state, notification);
      break;
    default:
      await context.sendActivity(`Received: ${notification.notificationType}`);
  }
}

private async handleEmailNotification(context, state, activity) {
  const client = await getClient(this.authorization, authHandlerName, context);

  // Retrieve email content
  const emailContent = await client.invokeAgentWithScope(
    `Retrieve email with id '${activity.emailNotification.id}'...`
  );

  // Process and respond
  const response = await client.invokeAgentWithScope(
    `Process this email: ${emailContent}`
  );

  const emailResponse = createEmailResponseActivity(response);
  await context.sendActivity(emailResponse);
}
```

## Configuration

### .env file
```bash
# Server
PORT=3978
NODE_ENV=development

# OpenAI
OPENAI_API_KEY=sk-...

# Authentication
BEARER_TOKEN=...
CLIENT_ID=...
TENANT_ID=...
CLIENT_SECRET=...

# Observability
Use_Custom_Resolver=false
```

## MCP Tool Integration

```typescript
const toolService = new McpToolRegistrationService();

export async function getClient(authorization, authHandlerName, turnContext) {
  const agent = new Agent({
    name: 'OpenAI Agent',
    instructions: `You are a helpful assistant...`,
  });

  try {
    await toolService.addToolServersToAgent(
      agent,
      authorization,
      authHandlerName,
      turnContext,
      process.env.BEARER_TOKEN || "",
    );
  } catch (error) {
    console.warn('Failed to register MCP tools:', error);
  }

  return new OpenAIClient(agent);
}
```

## Dependencies

```json
{
  "dependencies": {
    "@microsoft/agents-hosting": "^0.0.1",
    "@microsoft/agents-activity": "^0.0.1",
    "@microsoft/agents-a365-observability": "^0.0.1",
    "@microsoft/agents-a365-observability-hosting": "^0.0.1",
    "@microsoft/agents-a365-tooling-extensions-openai": "^0.0.1",
    "@microsoft/agents-a365-notifications": "^0.0.1",
    "@openai/agents": "^0.0.1",
    "express": "^4.18.0",
    "dotenv": "^16.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "ts-node": "^10.9.0"
  }
}
```

## Running the Agent

```bash
npm install
npm run build
npm start

# Development
npm run dev
```

## Extension Points

1. **Custom Tools**: Add to agent configuration
2. **MCP Servers**: Configure in tool manifest
3. **Notification Types**: Extend switch statement
4. **Token Resolvers**: Custom or built-in cache
5. **Baggage Attributes**: Add custom context
