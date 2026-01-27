# Agent Framework Sample Agent Design (Python)

## Overview

This sample demonstrates a Python agent built using the Microsoft Agent Framework orchestrator. It follows the same patterns as the OpenAI sample but uses the Agent Framework for AI orchestration.

## What This Sample Demonstrates

- Microsoft Agent Framework integration in Python
- Generic host pattern for agent hosting
- MCP server tool registration
- Microsoft Agent 365 observability
- Async message processing

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  start_with_generic_host.py                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    GenericAgentHost                              │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Microsoft Agents SDK Components                 ││
│  │  MemoryStorage │ CloudAdapter │ AgentApplication            ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  AgentFrameworkAgent                             │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                Agent Framework Client                        ││
│  │  Agent Framework SDK → Process Message → Response            ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### agent.py
Main agent implementation using Agent Framework:
- Implements `AgentInterface`
- Configures Agent Framework client
- Integrates MCP tools
- Processes messages

### agent_interface.py
Shared abstract base class (same as OpenAI sample).

### host_agent_server.py
Shared generic hosting infrastructure.

## Configuration

### .env file
```bash
# Agent Framework Configuration
AGENT_FRAMEWORK_ENDPOINT=...
AGENT_FRAMEWORK_API_KEY=...

# Authentication
BEARER_TOKEN=...
AUTH_HANDLER_NAME=AGENTIC
CLIENT_ID=...
TENANT_ID=...

# Observability
OBSERVABILITY_SERVICE_NAME=agent-framework-sample
```

## Message Flow

```
1. HTTP POST /api/messages
2. GenericAgentHost routes to agent
3. Agent Framework agent processes message
4. MCP tools invoked as needed
5. Response returned to user
```

## Dependencies

```toml
[project]
dependencies = [
    "microsoft-agents-hosting-aiohttp>=0.0.1",
    "microsoft-agents-hosting-core>=0.0.1",
    "microsoft_agents_a365_observability_core>=0.0.1",
    "microsoft_agents_a365_tooling_core>=0.0.1",
    "python-dotenv>=1.0.0",
]
```

## Running the Agent

```bash
uv run python start_with_generic_host.py
```

## Extension Points

1. **Custom Tools**: Add Agent Framework native tools
2. **MCP Servers**: Configure in tool manifest
3. **Observability**: Use Agent Framework instrumentation extension
