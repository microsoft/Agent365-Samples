# Semantic Kernel Sample Agent Design (Node.js/TypeScript)

## Overview

This sample demonstrates an agent built using Semantic Kernel patterns in Node.js/TypeScript. It implements the same architecture as the [C#/.NET Semantic Kernel sample](../../../dotnet/semantic-kernel/sample-agent/) — using OpenAI Chat Completions with function calling in a loop to mirror the `ChatCompletionAgent` with `FunctionChoiceBehavior.Auto`.

## What This Sample Demonstrates

- Semantic Kernel-style function calling loop with OpenAI Chat Completions
- Plugin system (terms and conditions accept/reject)
- MCP server tool registration via `@openai/agents`
- Azure OpenAI and standard OpenAI support
- Agent 365 notification handling (Email)
- Observability with InferenceScope and baggage propagation
- Token caching for authentication
- TypeScript with strict typing

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
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      ││
│  │  │ Notifications│  │ Messages     │  │ Installation │      ││
│  │  │ Handler      │  │ Handler      │  │ Handler      │      ││
│  │  └──────────────┘  └──────────────┘  └──────────────┘      ││
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
│  │           SemanticKernelClient                               ││
│  │  OpenAI Chat Completions + Function Calling Loop             ││
│  │  ┌──────────────┐  ┌──────────────┐                         ││
│  │  │ Local Plugins│  │ MCP Tools    │                         ││
│  │  │ (T&C)        │  │ (@openai/    │                         ││
│  │  │              │  │  agents)     │                         ││
│  │  └──────────────┘  └──────────────┘                         ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### src/index.ts
Application entry point:
- Environment configuration with dotenv (loaded before all other imports)
- Express server setup with JSON middleware
- JWT authorization middleware (disabled in development)
- `POST /api/messages` endpoint
- `GET /api/health` health check endpoint

### src/agent.ts
Agent application class:
- `MyAgent` extending `AgentApplication<TurnState>`
- Message activity handler with typing indicators
- Notification handlers (Email)
- Installation update handler (hire/fire)
- Observability token preloading
- Terms and conditions state management

### src/client.ts
Semantic Kernel-style agent and observability:
- `ObservabilityManager` configuration with Agent 365 exporter
- `getClient()` factory — creates agent with plugins and MCP tools
- `SemanticKernelClient` — function calling loop implementation
- `InferenceScope` wrapping for observability

### src/plugins.ts
Local Semantic Kernel plugins:
- `termsAndConditionsAcceptedPlugin` — allows rejecting T&C
- `termsAndConditionsNotAcceptedPlugin` — allows accepting T&C or blocking actions

### src/openai-config.ts
OpenAI/Azure OpenAI configuration:
- `isAzureOpenAI()` — detects Azure OpenAI from environment
- `createOpenAIClient()` — creates the appropriate OpenAI client
- `configureOpenAIAgentClient()` — configures `@openai/agents` for Azure

### src/token-cache.ts
Token caching utilities:
- In-memory token cache
- Custom token resolver for observability

## Message Flow

```
1. HTTP POST /api/messages
   │
2. Express middleware (JSON, JWT auth)
   │
3. CloudAdapter.process()
   │
4. MyAgent.handleAgentMessageActivity()
   │  ├── Log user identity from Activity.From
   │  ├── Send "Got it — working on it…" ack
   │  └── Start typing indicator loop
   │
5. BaggageBuilder context setup
   │  └── fromTurnContext() → sessionDescription()
   │
6. preloadObservabilityToken()
   │
7. baggageScope.run(async () => {
   │   ├── getClient() — Create client with plugins + MCP tools
   │   └── client.invokeAgentWithScope(userMessage)
   │       ├── InferenceScope.start()
   │       ├── invokeAgent() — function calling loop:
   │       │   ├── MCP tools → @openai/agents run()
   │       │   └── Local plugins → manual tool call loop
   │       ├── recordInputMessages(), recordOutputMessages()
   │       └── scope.dispose()
   │})
   │
8. outputResponse() → turnContext.sendActivity(response)
```

## Function Calling Loop (Semantic Kernel Pattern)

The `SemanticKernelClient.invokeAgent()` method implements the equivalent of C#'s
`ChatCompletionAgent` with `FunctionChoiceBehavior.Auto`:

```typescript
// 1. If MCP agent exists, run through @openai/agents first
if (mcpAgent && mcpAgent.mcpServers.length > 0) {
  const mcpResult = await run(mcpAgent, prompt);
  currentPrompt = mcpResult.finalOutput;
}

// 2. Manual function-calling loop for local plugins
for (let i = 0; i < maxIterations; i++) {
  const completion = await openai.chat.completions.create({
    model, messages: chatHistory, tools: pluginTools, tool_choice: 'auto'
  });

  if (!message.tool_calls) break;  // Final answer

  for (const toolCall of message.tool_calls) {
    const result = await executePluginTool(toolCall.function.name, args);
    chatHistory.push({ role: 'tool', tool_call_id, content: result });
  }
}
```

## Notification Handling

### Email Notifications
```typescript
async handleEmailNotification(context, state, activity) {
  const client = await getClient(authorization, authHandlerName, context);

  // Retrieve email content
  const emailContent = await client.invokeAgentWithScope(
    `Retrieve email with id '${activity.emailNotification.id}'...`
  );

  // Process and respond
  const response = await client.invokeAgentWithScope(
    `Process this email: ${emailContent.content}`
  );

  const emailResponse = createEmailResponseActivity(response.content);
  await context.sendActivity(emailResponse);
}
```

## Comparison with C#/.NET Sample

| C#/.NET Component | Node.js/TypeScript Equivalent |
|---|---|
| `Program.cs` | `src/index.ts` |
| `Agents/MyAgent.cs` | `src/agent.ts` |
| `Agents/Agent365Agent.cs` | `src/client.ts` (SemanticKernelClient) |
| `Agents/Agent365AgentResponse.cs` | `SemanticKernelAgentResponse` interface |
| `Plugins/*.cs` | `src/plugins.ts` |
| `telemetry/AgentMetrics.cs` | `ObservabilityManager` + `InferenceScope` |
| `telemetry/A365OtelWrapper.cs` | `BaggageBuilderUtils` + token preloading |
| `Kernel` + `ChatCompletionAgent` | `OpenAI Chat Completions` + function calling loop |
| `KernelFunction` attributes | Plugin objects with `name`, `description`, `execute` |
| `FunctionChoiceBehavior.Auto` | `tool_choice: 'auto'` in chat completions |
| `appsettings.json` | `.env` / `.env.template` |
