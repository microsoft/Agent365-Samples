# Google ADK Sample Agent Design (Python)

## Overview

This sample demonstrates an agent built using Google's Agent Development Kit (ADK). It showcases integration with Google's Gemini models and tools within the Microsoft Agent 365 ecosystem.

## What This Sample Demonstrates

- Google ADK integration with Agent 365
- Google Gemini model configuration (public API and Vertex AI)
- MCP tool integration with Google ADK
- Microsoft Agent 365 observability via Microsoft OpenTelemetry Distro
- Async message processing with typing indicators

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         main.py                                  │
│  (Observability config + server startup)                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    MyAgent (hosting.py)                           │
│  (AgentApplication — message routing, auth, notifications)       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    GoogleADKAgent (agent.py)                      │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Google ADK Agent                           ││
│  │  Agent → Runner → Gemini Model → Response                     ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    MCP Tools                                 ││
│  │  McpToolRegistrationService → McpToolset → Tool Execution     ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### main.py
Entry point and server startup:
- Configures observability via `use_microsoft_opentelemetry()`
- Builds JWT auth middleware for production
- Starts aiohttp server on configured port

### hosting.py
Agent hosting framework:
- `MyAgent(AgentApplication)` — handles message routing, auth, notifications
- Message handler with typing indicators and immediate acknowledgments
- Email and Word comment notification handlers
- Agent lifecycle event handling

### agent.py
Core agent implementation:
- Google ADK Agent with Gemini model
- MCP tool initialization with bearer token validation and timeout
- Observability baggage injection (`agentic_app_id`, not `agentic_user_id`)
- Per-turn instruction personalization with user display name

### mcp_tool_registration_service.py
MCP tool integration:
- Discovers MCP servers via `McpToolServerConfigurationService`
- Creates `McpToolset` with `StreamableHTTPConnectionParams` for each server
- Returns new Agent instance with tools attached

## Google ADK-Specific Patterns

### Agent Setup
```python
from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions.in_memory_session_service import InMemorySessionService

class GoogleADKAgent:
    def __init__(self):
        self.agent = Agent(
            name="my_agent",
            model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
            description="Agent to test Mcp tools.",
            instruction="You are a helpful AI assistant...",
        )

    async def invoke_agent(self, message, auth, auth_handler_name, context):
        # Initialize agent with MCP tools (with 10s timeout)
        agent = await self._initialize_agent(auth, auth_handler_name, context)

        # Create runner and process message
        runner = Runner(
            app_name="agents",
            agent=agent,
            session_service=InMemorySessionService(),
        )
        result = await runner.run_debug(user_messages=[message])

        # Extract text responses from event stream
        responses = []
        for event in result:
            for part in event.content.parts:
                if hasattr(part, 'text') and part.text:
                    responses.append(part.text)

        return responses[-1] if responses else "No response."
```

## Configuration

### .env file
```bash
# Google Gemini Configuration
GOOGLE_GENAI_USE_VERTEXAI=FALSE          # TRUE for Vertex AI, FALSE for public API
GEMINI_MODEL=gemini-2.5-flash
GOOGLE_API_KEY=...                        # When VERTEXAI=FALSE
GOOGLE_CLOUD_PROJECT=...                  # When VERTEXAI=TRUE
GOOGLE_CLOUD_LOCATION=us-central1         # When VERTEXAI=TRUE
GOOGLE_APPLICATION_CREDENTIALS=...        # When VERTEXAI=TRUE

# Authentication
AUTH_HANDLER_NAME=AGENTIC                 # Empty for local dev / Playground
BEARER_TOKEN=...                          # For local MCP tool access

# Agent Identity (fallbacks — delivered per-message in production)
AGENTIC_APP_ID=...
AGENTIC_USER_ID=...
AGENTIC_TENANT_ID=...
A365_AGENT_APP_INSTANCE_ID=...            # Same as AGENTIC_APP_ID
A365_AGENTIC_USER_ID=...                  # Same as AGENTIC_USER_ID

# Service Connection
CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID=...
CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTSECRET=...
CONNECTIONS__SERVICE_CONNECTION__SETTINGS__TENANTID=...

# Observability
ENABLE_OBSERVABILITY=true
ENABLE_A365_OBSERVABILITY_EXPORTER=true   # false for local dev
OBSERVABILITY_SERVICE_NAME=GoogleADKSampleAgent
```

## Message Flow

```
1. HTTP POST /api/messages → aiohttp server (main.py)
2. JWT validation (production) or anonymous claims (local dev)
3. MyAgent routes to message_handler (hosting.py)
4. Immediate ack: "Got it — working on it…" + typing indicator loop
5. GoogleADKAgent.invoke_agent_with_scope() — sets observability baggage
6. _initialize_agent() — MCP tool registration with 10s timeout
7. Runner.run_debug() — Gemini processes message with tools
8. Response sent back to user; typing loop cancelled; MCP connections cleaned up
```

## Dependencies

```toml
[project]
dependencies = [
    "google-adk>=1.32.0,<2",
    "microsoft-agents-hosting-aiohttp",
    "microsoft-agents-hosting-core",
    "microsoft-agents-authentication-msal",
    "microsoft-agents-activity",
    "microsoft_agents_a365_tooling >= 1.0.0",
    "microsoft_agents_a365_observability_core >= 1.0.0",
    "microsoft_agents_a365_notifications >= 1.0.0",
    "microsoft-opentelemetry >= 1.2.0",
    "python-dotenv>=1.0.0",
    "aiohttp>=3.9.0",
]
```

## Running the Agent

```bash
# Local dev
python main.py

# With Agents Playground
agentsplayground -e "http://localhost:3978/api/messages" -c "emulator"
```

## Extension Points

1. **Model Selection**: Change `GEMINI_MODEL` env var (e.g., `gemini-2.5-pro`)
2. **MCP Tools**: Configure in `ToolingManifest.json`
3. **System Instructions**: Customize `_INSTRUCTION_TEMPLATE` in `agent.py`
4. **Notifications**: Add handlers in `hosting.py` for new notification types
5. **Vertex AI**: Set `GOOGLE_GENAI_USE_VERTEXAI=TRUE` for production GCP deployment
