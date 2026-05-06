# Claude Sample Agent Design (Node.js/TypeScript)

## Overview

This sample demonstrates an agent built using Anthropic's Claude AI as the orchestrator in a Node.js/TypeScript environment. It showcases Claude-specific patterns for tool use and integration with Microsoft Agent 365.

## What This Sample Demonstrates

- Anthropic Claude Agent SDK integration (`@anthropic-ai/claude-agent-sdk`)
- Auto-instrumentation via `@microsoft/opentelemetry` distro
- Explicit `InferenceScope` for LLM call tracing (required due to Claude SDK subprocess model)
- MCP server tool registration via `@microsoft/agents-a365-tooling-extensions-claude`
- TypeScript type safety

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       index.ts                                   │
│  import './otel'  ← must be first, patches HTTP at load time     │
│  Express server + /api/messages endpoint                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       otel.ts                                    │
│  useMicrosoftOpenTelemetry() — auto-instruments HTTP, Express    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                       agent.ts                                   │
│  MyAgent extends AgentApplication<TurnState>                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       client.ts                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              ClaudeClient                                    ││
│  │  InferenceScope → query() → Claude CLI subprocess            ││
│  │                   [api.anthropic.com call happens here]       ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### src/otel.ts
Initialises the `@microsoft/opentelemetry` distro. Must be imported first in `index.ts` so auto-instrumentation patches are applied before any HTTP modules load:

```typescript
import { useMicrosoftOpenTelemetry, shutdownMicrosoftOpenTelemetry } from '@microsoft/opentelemetry';

useMicrosoftOpenTelemetry();
```

### src/index.ts
Application entry point. Imports `./otel` before all other modules, then starts the Express server.

### src/agent.ts
Agent application routing messages to the Claude client. Handles `message` and `installationUpdate` activities.

### src/client.ts
Claude-specific client implementation:
- Uses `query()` from `@anthropic-ai/claude-agent-sdk` — the SDK spawns the Claude CLI as a subprocess to handle inference
- Wraps `query()` in `InferenceScope` to produce a span covering the LLM call (required because the actual HTTPS call to `api.anthropic.com` happens in the subprocess, invisible to HTTP auto-instrumentation)
- MCP tools are registered via `McpToolRegistrationService.addToolServersToAgent()` before each query

## Claude Agent SDK — Subprocess Model

The `@anthropic-ai/claude-agent-sdk` executes inference by spawning `dist/cli.js` as a child process. The `api.anthropic.com` HTTPS call happens inside that subprocess — it is invisible to the parent process's HTTP auto-instrumentation.

This is why `InferenceScope` is added explicitly in `invokeAgentWithScope`:

```typescript
// InferenceScope is added explicitly because the Claude Agent SDK spawns a child process
// to execute inference — the actual HTTPS call to api.anthropic.com happens in that subprocess,
// not in this process. HTTP auto-instrumentation cannot cross process boundaries, so without
// this scope there would be no span covering the LLM call and no gen_ai.* attributes in traces.
const scope = InferenceScope.start(
  {},
  { operationName: InferenceOperationType.CHAT, model: 'claude', providerName: 'anthropic' },
  { agentId: 'claude-sample-agent', tenantId: this.tenantId }
);
try {
  return await scope.withActiveSpanAsync(() => this.invokeAgent(prompt));
} catch (error) {
  scope.recordError(error as Error);
  throw error;
} finally {
  scope.dispose();
}
```

## Observability

Observability has two layers:

### 1. Auto-instrumentation (`otel.ts`)
`useMicrosoftOpenTelemetry()` instruments the following automatically — no custom code required:

| Span | What it captures |
|---|---|
| `POST /api/messages` | Inbound request — method, path, status code (Express) |
| `POST login.microsoftonline.com` | MSAL token acquisition (HttpClient) |
| `POST smba.trafficmanager.net` | Outbound Teams messages (HttpClient) |

### 2. Explicit `InferenceScope` (`client.ts`)
Because the Claude Agent SDK uses a subprocess, the LLM call is not auto-instrumented. `InferenceScope` manually brackets the `query()` call to produce a `gen_ai.*` span with model, provider, and agent identity attributes.

### Service Name
Set `OTEL_SERVICE_NAME` in `.env` to give your service a meaningful name in traces. Defaults to the package name if not set.

## MCP Tool Registration

MCP tools are injected into the `Options` object before each `query()` call:

```typescript
await toolService.addToolServersToAgent(
  requestConfig,       // Options object passed to query()
  authorization,       // Auth handler
  authHandlerName,
  turnContext,
  process.env.BEARER_TOKEN || "",
);
```

`McpToolRegistrationService` from `@microsoft/agents-a365-tooling-extensions-claude` handles fetching and formatting tools for the Claude Agent SDK format.

## Configuration

### .env file
```bash
# Anthropic
ANTHROPIC_API_KEY=

# MCP Tooling
BEARER_TOKEN=                         # Development bearer token

# OpenTelemetry
OTEL_SERVICE_NAME=Claude Sample Agent # Service name in traces
OTEL_EXPORTER_OTLP_ENDPOINT=          # OTLP collector (leave empty for console)
ENABLE_A365_OBSERVABILITY_EXPORTER=   # Set to 'false' for console-only

# Environment
NODE_ENV=development                   # 'production' for Teams (enables JWT validation)

# Service Connection (auth)
connections__service_connection__settings__clientId=
connections__service_connection__settings__clientSecret=
connections__service_connection__settings__tenantId=
```

## Message Flow

```
1. import './otel'  [patches HTTP instrumentation at startup]
   │
2. HTTP POST /api/messages  [auto-instrumented by Express]
   │
3. MyAgent.handleAgentMessageActivity()
   │  └── getClient() — registers MCP tools into Options
   │
4. ClaudeClient.invokeAgentWithScope()
   │  └── InferenceScope.start()  [explicit — subprocess boundary]
   │      └── query()  [spawns Claude CLI subprocess]
   │              └── api.anthropic.com  [in subprocess]
   │
5. Send response via sendActivity()  [auto-instrumented outbound HTTP]
```

## Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.1.1",
    "@microsoft/agents-a365-notifications": "1.0.0",
    "@microsoft/agents-a365-tooling": "1.0.0",
    "@microsoft/agents-a365-tooling-extensions-claude": "1.0.0",
    "@microsoft/agents-activity": "^1.2.2",
    "@microsoft/agents-hosting": "^1.2.2",
    "@microsoft/opentelemetry": "1.0.1",
    "express": "^5.1.0"
  }
}
```

## Extension Points

1. **Model Selection**: Set `model` in `Options` passed to `query()`
2. **System Prompt**: Modify `agentConfig.systemPrompt` in `client.ts`
3. **Max Turns**: Adjust `maxTurns` in `agentConfig`
4. **Additional MCP Servers**: Configure in the tool manifest; automatic registration via `addToolServersToAgent`
