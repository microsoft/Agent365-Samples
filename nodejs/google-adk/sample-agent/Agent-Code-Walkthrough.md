# Code Walkthrough: Google ADK Sample Agent

This document provides a detailed technical walkthrough of the Google ADK Sample Agent implementation, covering architecture, key components, and design decisions.

## 📁 File Structure Overview

```
sample-agent/
├── .vscode/
│   ├── extensions.json        # Recommended VS Code extensions
│   ├── launch.json            # Debug configurations
│   └── tasks.json             # Pre-launch tasks
├── env/
│   ├── .env.playground        # Playground-specific env vars
│   └── .env.playground.user   # User secrets (gitignored)
├── images/
│   └── .gitkeep               # Placeholder for future agent thumbnail assets
├── instrumentation.ts         # 🔵 OpenTelemetry setup (loaded first)
├── index.ts                   # 🔵 Express server entry point
├── hosting.ts                 # 🔵 AgentApplication + handlers
├── agent.ts                   # 🔵 Google ADK agent + InferenceScope
├── agentInterface.ts          # 🔵 Agent interface definition
├── mcpToolRegistrationService.ts # 🔵 MCP tool discovery + registration
├── .env.example               # ⚙️ Environment template
├── ToolingManifest.json       # 🔧 MCP tools definition
├── package.json               # 📦 Dependencies and scripts
├── tsconfig.json              # 🔧 TypeScript configuration
├── m365agents.yml             # 🔧 Agents Toolkit config
└── m365agents.playground.yml  # 🔧 Agents Playground config
```

## 🏗️ Architecture Overview

### Design Principles

1. **Google ADK Integration**: Uses Google's Agent Development Kit with Gemini models (Vertex AI or public API)
2. **Event-Driven**: Bot Framework activity handlers for messages, notifications, and install events
3. **Observability-First**: Microsoft OpenTelemetry Distro with `InferenceScope`, `BaggageBuilder`, and `AgenticTokenCacheInstance`
4. **MCP Tools**: Dynamic discovery and registration of MCP tool servers from the A365 gateway

### Request Flow

```
Teams Message → Express → authorizeJWT → CloudAdapter.process → AgentApplication.run
  → hosting.ts (baggage + observability token)
    → agent.ts (InferenceScope + Google ADK Runner)
      → mcpToolRegistrationService.ts (MCP tool discovery)
      → Gemini LLM (with MCP tools)
    → response → Teams
```

## 🔍 Core Components Deep Dive

### 1. instrumentation.ts — OpenTelemetry Setup

**Must be imported before all other modules** so the SDK can patch libraries (HTTP, Express).

- Loads `.env` via `configDotenv()` before `@microsoft/opentelemetry` reads `A365_OBSERVABILITY_LOG_LEVEL`
- Configures `useMicrosoftOpenTelemetry()` with `AgenticTokenCacheInstance` token resolver
- Enables console exporters in dev mode for local debugging
- Patches `Agent365Exporter.postWithRetries` to log HTTP response bodies (like the Python distro)

### 2. index.ts — Express Server

- Loads auth config via `loadAuthConfigFromEnv()` — always, not just in production
- Registers health endpoints (`/`, `/api/health`, `/robots933456.txt`) **before** JWT middleware
- `authorizeJWT(authConfig)` protects all routes after health endpoints
- Routes `POST /api/messages` through `CloudAdapter.process()` → `AgentApplication.run()`

### 3. hosting.ts — AgentApplication + Handlers

**MyAgent** extends `AgentApplication<TurnState>` and configures:

- `authorization: { agentic: { type: 'agentic' } }` — enables OBO token exchange
- `onActivity(ActivityTypes.Message, ...)` — message handling with baggage + typing loop
- `onAgentNotification("agents:*", ...)` — email, Word comment, lifecycle notifications
- `preloadObservabilityToken()` — refreshes exporter token via `AgenticTokenCacheInstance.refreshObservabilityToken()`
- `BaggageBuilderUtils.fromTurnContext()` — auto-populates tenant, agent, channel, conversation

### 4. agent.ts — Google ADK Agent

**GoogleADKAgent** implements the agent interface:

- **Personalized instructions**: Injects user display name per turn
- **MCP tool initialization**: Delegates to `McpToolRegistrationService` with 10s timeout
- **Google ADK Runner**: `runner.runEphemeral()` with `InMemorySessionService`
- **InferenceScope**: Wraps invocations with `recordInputMessages`, `recordOutputMessages`, `recordFinishReasons`
- **Baggage**: `BaggageBuilderUtils.fromTurnContext()` for auto-populated observability context

### 5. mcpToolRegistrationService.ts — MCP Tool Discovery

- Exchanges OBO token with MCP platform scope (`ea9ffc3e-.../.default`) via `ToolingConfiguration`
- Calls A365 gateway directly (bypasses SDK's `listToolServers` which has a response parsing bug)
- Handles both response shapes: raw array and `{ mcpServers: [...] }`
- Creates `MCPToolset` with `type: "StreamableHTTPConnectionParams"` + `header` auth

### 6. agentInterface.ts — Interface Contract

```typescript
export interface AgentInterface {
  invokeAgent(message, auth, authHandlerName, context): Promise<string>;
  invokeAgentWithScope(message, auth, authHandlerName, context): Promise<string>;
}
```

## 🔧 Observability

The sample uses the **Microsoft OpenTelemetry Distro** (`@microsoft/opentelemetry`) for end-to-end observability:

- **Token resolver**: `AgenticTokenCacheInstance.getObservabilityToken()` — built-in singleton
- **Token refresh**: `AgenticTokenCacheInstance.refreshObservabilityToken()` on each turn
- **Baggage**: `BaggageBuilderUtils.fromTurnContext()` auto-populates all identity fields
- **InferenceScope**: Wraps LLM calls with input/output messages and finish reasons
- **A365 Exporter**: Sends spans to the A365 backend (flashpoint, sentinel, esp sinks)
- **Console exporters**: Enabled in dev mode for local debugging
- **A365_OBSERVABILITY_LOG_LEVEL**: Set to `info|warn|error` for exporter diagnostics

## 🔐 Authentication

| Mode | Config | Description |
|------|--------|-------------|
| **Teams/dev tunnel** | `AUTH_HANDLER_NAME=AGENTIC` + service connection env vars | JWT validation + OBO token exchange |
| **Playground** | Via Agents Toolkit extension | Uses `env/.env.playground` values |
| **Bare local LLM** | No MCP token / no agentic handler | Runs without MCP tools |

## 📦 MCP Tools

The `ToolingManifest.json` defines available MCP servers. At runtime:

1. Agent discovers servers from the A365 gateway (`/agents/v2/{agenticAppId}/mcpServers`)
2. Creates `MCPToolset` instances with `StreamableHTTPConnectionParams` transport
3. Merges MCP tools with the Google ADK `Agent` tools array
4. Gemini can call tools like `SendEmailWithAttachments` via function calling

## 🔔 Notifications

| Type | Handler | Description |
|------|---------|-------------|
| `EmailNotification` | `handleEmailNotification` | Processes email content, responds via `createEmailResponseActivity()` |
| `WpxComment` | `handleWpxCommentNotification` | Retrieves Word doc content, processes comment |
| `AgentLifecycleNotification` | Log only | No reply needed |
