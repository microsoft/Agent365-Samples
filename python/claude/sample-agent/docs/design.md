# Claude Sample Agent Design (Python)

## Overview

This sample demonstrates an agent built using Anthropic's Claude AI as the orchestrator. It showcases integration patterns for Claude with MCP tools and Microsoft Agent 365 observability.

## What This Sample Demonstrates

- Anthropic Claude SDK integration
- Claude-specific prompt engineering
- MCP server tool registration for Claude
- Microsoft Agent 365 observability
- Async message processing with Claude

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
│                    ClaudeAgentWithMCP                            │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Claude Client                             ││
│  │  AsyncAnthropic → messages.create() → Response               ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    MCP Tools                                 ││
│  │  Tool Registration → Claude Tool Use → Tool Execution        ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### agent.py
Main agent implementation:
- `ClaudeAgentWithMCP` class implementing `AgentInterface`
- Anthropic client configuration
- MCP tool integration for Claude
- Message processing with tool use

### agent_interface.py
Shared abstract base class.

### host_agent_server.py
Shared generic hosting infrastructure.

## Claude-Specific Patterns

### Tool Use with Claude
```python
async def process_user_message(self, message, auth, auth_handler_name, context):
    # Setup MCP tools
    tools = await self.setup_mcp_tools(auth, auth_handler_name, context)

    # Create message with tools
    response = await self.client.messages.create(
        model="claude-3-5-sonnet-20241022",
        max_tokens=1024,
        system=self.system_prompt,
        tools=tools,
        messages=[{"role": "user", "content": message}]
    )

    # Handle tool use if requested
    while response.stop_reason == "tool_use":
        tool_results = await self.execute_tools(response.content)
        response = await self.client.messages.create(
            model="claude-3-5-sonnet-20241022",
            max_tokens=1024,
            tools=tools,
            messages=[
                {"role": "user", "content": message},
                {"role": "assistant", "content": response.content},
                {"role": "user", "content": tool_results}
            ]
        )

    return self.extract_text_response(response)
```

## Configuration

### .env file
```bash
# Claude Configuration
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-3-5-sonnet-20241022

# Authentication
BEARER_TOKEN=...
AUTH_HANDLER_NAME=AGENTIC
CLIENT_ID=...
TENANT_ID=...

# Observability
OBSERVABILITY_SERVICE_NAME=claude-sample-agent
```

## Message Flow

```
1. HTTP POST /api/messages
2. GenericAgentHost routes to agent
3. Claude agent processes message
4. Tool use loop if tools requested
5. Final response returned
```

## Dependencies

```toml
[project]
dependencies = [
    "anthropic>=0.30.0",
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

1. **Custom Claude Tools**: Define tools in Claude's tool format
2. **MCP Servers**: Configure in tool manifest
3. **Model Selection**: Choose different Claude models
4. **System Prompts**: Customize agent behavior
