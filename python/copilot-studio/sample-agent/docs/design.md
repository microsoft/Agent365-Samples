# Copilot Studio Sample Agent — Design Document

## Overview

This sample demonstrates how to bridge a **Microsoft Copilot Studio** low-code agent into the **Microsoft Agent 365** managed environment. It acts as a thin proxy: every user message arriving through Agent 365 channels (Teams, email, etc.) is forwarded to a published Copilot Studio agent, and the response is relayed back to the user.

The integration gives low-code agents access to enterprise features they cannot reach on their own — Microsoft 365 notifications, OpenTelemetry observability, agentic authentication with Entra ID, and the full Agent 365 lifecycle.

## What This Sample Demonstrates

- Copilot Studio integration with Agent 365
- Agentic authentication with Power Platform audience (`https://api.powerplatform.com/.default`)
- Email notification handling via `AgentNotification`
- Microsoft Agent 365 observability with `AgenticTokenCache`
- Multiple-message and typing-indicator patterns for Teams

## Architecture

```
┌────────────┐     ┌──────────────────────────────────────────────┐     ┌──────────────────┐
│  Teams /   │     │            This Sample                       │     │  Copilot Studio  │
│  Email /   │     │                                              │     │  (Low-code Agent) │
│  Channels  │     │  main.py                                     │     │                  │
│            │ ──▶ │    └─ CopilotStudioAgentHost                 │     │                  │
│            │     │         ├─ AgentApplication (M365 Agents SDK)│     │                  │
│            │     │         ├─ AgentNotification (email handler) │     │                  │
│            │     │         ├─ Observability (AgenticTokenCache) │     │                  │
│            │     │         └─ on_message / on_notification      │     │                  │
│            │     │              │                                │     │                  │
│            │     │              ▼                                │     │                  │
│            │     │  agent.py                                    │     │                  │
│            │     │    └─ MyAgent                                │     │                  │
│            │     │         ├─ process_user_message()            │     │                  │
│            │     │         └─ handle_agent_notification_activity│     │                  │
│            │     │              │                                │     │                  │
│            │     │              ▼                                │     │                  │
│            │     │  client.py                                   │     │                  │
│            │     │    ├─ get_client() ─ token exchange (OBO)    │     │                  │
│            │     │    └─ McsClient                              │     │                  │
│            │     │         ├─ invoke_agent()                    │ ──▶ │  CopilotClient   │
│            │     │         └─ invoke_inference_scope()          │     │  (Direct Line)   │
│            │     │              (InferenceScope telemetry)       │     │                  │
│            │ ◀── │                                              │ ◀── │                  │
└────────────┘     └──────────────────────────────────────────────┘     └──────────────────┘
```

## Key Components

### main.py

Server entry point and hosting logic:
- Bootstraps observability via `use_microsoft_opentelemetry()` with `AgenticTokenCache`
- Creates `CopilotStudioAgentHost` which wires `AgentApplication`, `CloudAdapter`, `Authorization`, and `AgentNotification`
- Registers `on_message` and `on_notification` handlers
- Manages JWT middleware with health-endpoint bypass
- Runs a typing indicator loop via `asyncio.create_task`

### agent.py

Agent logic:
- `MyAgent` class with `process_user_message()` and `handle_agent_notification_activity()`
- Delegates to `McsClient` via the `get_client()` factory
- Routes notifications by `NotificationTypes` (currently handles `EMAIL_NOTIFICATION`)
- Builds context-rich prompts from email metadata

### client.py

Copilot Studio client wrapper:
- `McsClient` wraps `CopilotClient` with conversation management and observability
- `invoke_agent()` starts a conversation (if needed) and sends a user activity
- `invoke_inference_scope()` wraps `invoke_agent()` in an `InferenceScope` span
- `get_client()` factory acquires an OBO token for `https://api.powerplatform.com/.default`

## Copilot Studio–Specific Patterns

### CopilotClient & ConnectionSettings

```python
from microsoft_agents.copilotstudio.client import CopilotClient, ConnectionSettings

settings_dict = ConnectionSettings.populate_from_environment()
settings = ConnectionSettings(**settings_dict)
copilot_client = CopilotClient(settings, token)
```

`ConnectionSettings` reads `DIRECT_CONNECT_URL` or `ENVIRONMENT_ID` + `AGENT_IDENTIFIER` from the environment.

### Token Exchange for Power Platform Audience

Copilot Studio requires an OBO token scoped to the Power Platform API:

```python
token_result = await authorization.exchange_token(
    turn_context,
    scopes=["https://api.powerplatform.com/.default"],
    auth_handler_id=auth_handler_name,  # "AGENTIC"
)
```

The auth handler is configured via environment variables:

```
AUTH_HANDLER_NAME=AGENTIC
AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__SETTINGS__TYPE=AgenticUserAuthorization
AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__SETTINGS__ALT_BLUEPRINT_NAME=SERVICE_CONNECTION
AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__SETTINGS__SCOPES=https://graph.microsoft.com/.default
```

> **Important:** `AUTH_HANDLER_NAME` must be uppercase `AGENTIC` to match the key in `AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__...`. Python dict lookup is case-sensitive.

## Observability

### AgenticTokenCache Pattern

The sample uses the recommended `AgenticTokenCache` pattern from the [Microsoft OpenTelemetry Distro docs](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/microsoft-opentelemetry?tabs=python):

1. **Sync resolver** (`_sync_token_resolver`) — called by the OpenTelemetry batch exporter thread. Returns a cached token.
2. **Async refresh** (`_setup_observability_token`) — called on each incoming turn. Uses `AgenticTokenCache.register_observability()` to acquire/refresh the token via OBO auth from the `TurnContext`.
3. **`use_microsoft_opentelemetry()`** — bootstraps the distro with `enable_a365=True` and the sync resolver.

No static `A365_AGENT_APP_INSTANCE_ID` / `A365_AGENTIC_USER_ID` environment variables are needed — tokens are acquired at runtime from the incoming activity.

### BaggageBuilder

Every handler wraps its work in a `BaggageBuilder` context that propagates `tenant_id` and `agent_id` through all downstream spans:

```python
with BaggageBuilder().tenant_id(tenant_id).agent_id(agent_id).build():
    # all spans inside carry tenant + agent context
```

Values are read from `context.activity.recipient` at runtime, with env var fallbacks for Playground.

### InferenceScope

`McsClient.invoke_inference_scope()` creates an `InferenceScope` span that records:
- `InferenceCallDetails` (operation type, model name, provider)
- Input / output messages
- Finish reasons
- Errors (if any)

## Message Flow

### Direct Message (Teams / Chat)

```
1. HTTP POST /api/messages
2. CopilotStudioAgentHost validates agent, sets up observability context
3. Immediate ack: "Got it — working on it…" + typing indicator
4. MyAgent.process_user_message() called
5. get_client() acquires OBO token → creates McsClient
6. McsClient.invoke_inference_scope() opens InferenceScope span
7. CopilotClient sends message to Copilot Studio API
8. Response recorded in span, sent back to user
```

### Email Notification

```
1. Agent 365 delivers email notification to on_notification
2. MyAgent routes to _handle_email_notification()
3. Context-rich prompt built from email metadata
4. Prompt forwarded to Copilot Studio via McsClient
5. Response wrapped in EmailResponse activity and sent back
```

## Configuration

| Section | Variables |
|---|---|
| Copilot Studio | `DIRECT_CONNECT_URL` or `ENVIRONMENT_ID` + `AGENT_IDENTIFIER` |
| Service Connection | `CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID/CLIENTSECRET/TENANTID` |
| Authentication | `AUTH_HANDLER_NAME`, `AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__*` |
| Observability | `ENABLE_OBSERVABILITY`, `ENABLE_A365_OBSERVABILITY_EXPORTER` |
| Server | `PORT` |

See `.env.template` for the full list with descriptions.

## Dependencies

```toml
[project]
dependencies = [
    "microsoft-agents-hosting-aiohttp",
    "microsoft-agents-hosting-core",
    "microsoft-agents-authentication-msal",
    "microsoft-agents-activity",
    "microsoft-agents-copilotstudio-client",
    "microsoft-agents-a365-notifications",
    "microsoft-agents-a365-runtime >= 0.1.0",
    "microsoft-opentelemetry >= 0.1.0a3",
    "python-dotenv",
    "aiohttp",
]
```

## Running the Agent

```bash
# Setup
a365 setup all --agent-name "<your-agent-name>" --aiteammate

# Run locally
python main.py

# Publish
a365 publish --agent-name "<your-agent-name>" --aiteammate
```

## Extension Points

1. **Additional notification types** — Add handlers for `TEAMS_NOTIFICATION`, `WPX_COMMENT`, etc.
2. **Multi-turn conversations** — Store `conversation_id` in `TurnState` or external storage
3. **MCP tools** — Add MCP tool servers alongside the Copilot Studio proxy for hybrid patterns
4. **Multiple Copilot Studio agents** — Route messages to different agents based on intent
5. **Custom telemetry** — Add custom spans or register additional exporters
