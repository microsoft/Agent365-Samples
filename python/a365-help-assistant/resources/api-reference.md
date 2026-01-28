# Microsoft Agent 365 SDK - API Reference

## Overview

The Microsoft Agent 365 SDK provides a comprehensive set of APIs for building intelligent agents that integrate with Microsoft 365 services.

## Core APIs

### AgentInterface

Abstract base class that all agents must inherit from.

```python
from abc import ABC, abstractmethod
from microsoft_agents.hosting.core import Authorization, TurnContext

class AgentInterface(ABC):
    @abstractmethod
    async def initialize(self) -> None:
        """Initialize the agent and any required resources."""
        pass

    @abstractmethod
    async def process_user_message(
        self, message: str, auth: Authorization, auth_handler_name: str, context: TurnContext
    ) -> str:
        """Process a user message and return a response."""
        pass

    @abstractmethod
    async def cleanup(self) -> None:
        """Clean up any resources used by the agent."""
        pass
```

### TurnContext

Represents the context for a single turn of conversation.

**Properties:**
- `activity`: The incoming activity (message, event, etc.)
- `send_activity(message)`: Send a response to the user
- `activity.text`: The text content of the user's message
- `activity.recipient.tenant_id`: The tenant ID of the recipient
- `activity.recipient.agentic_app_id`: The agent's application ID

### Authorization

Handles authentication and token management.

**Methods:**
- `get_token(context, auth_handler_name)`: Get an access token
- `exchange_token(context, scopes, auth_handler_id)`: Exchange token for different scopes

## MCP Tooling APIs

### McpToolServerConfigurationService

Manages MCP server configurations.

```python
from microsoft_agents_a365.tooling.services.mcp_tool_server_configuration_service import (
    McpToolServerConfigurationService,
)

config_service = McpToolServerConfigurationService()
```

### McpToolRegistrationService

Registers MCP tools with agents.

```python
from microsoft_agents_a365.tooling.extensions.openai import mcp_tool_registration_service

tool_service = mcp_tool_registration_service.McpToolRegistrationService()

# Add tools to agent
agent = await tool_service.add_tool_servers_to_agent(
    agent=agent,
    auth=auth,
    auth_handler_name=auth_handler_name,
    context=context,
    auth_token=bearer_token,  # Optional
)
```

## Observability APIs

### configure

Configure Agent 365 observability.

```python
from microsoft_agents_a365.observability.core.config import configure

status = configure(
    service_name="my-agent",
    service_namespace="my-namespace",
    token_resolver=my_token_resolver,
)
```

**Parameters:**
- `service_name` (str): Name of the service for telemetry
- `service_namespace` (str): Namespace for grouping services
- `token_resolver` (Callable): Function to resolve authentication tokens

### OpenAIAgentsTraceInstrumentor

Instruments OpenAI Agents for automatic tracing.

```python
from microsoft_agents_a365.observability.extensions.openai import OpenAIAgentsTraceInstrumentor

OpenAIAgentsTraceInstrumentor().instrument()
```

### BaggageBuilder

Builds baggage context for distributed tracing.

```python
from microsoft_agents_a365.observability.core.middleware.baggage_builder import BaggageBuilder

with BaggageBuilder().tenant_id(tenant_id).agent_id(agent_id).build():
    # Code with trace context
    pass
```

## OpenAI Agents SDK Integration

### Agent

Create an agent with the OpenAI Agents SDK.

```python
from agents import Agent, OpenAIChatCompletionsModel
from agents.model_settings import ModelSettings

model = OpenAIChatCompletionsModel(
    model="gpt-4o-mini",
    openai_client=openai_client,
)

agent = Agent(
    name="MyAgent",
    model=model,
    model_settings=ModelSettings(temperature=0.7),
    instructions="Your agent instructions here",
    tools=[...],  # Optional tools
    mcp_servers=[...],  # Optional MCP servers
)
```

### Runner

Run agent conversations.

```python
from agents import Runner

result = await Runner.run(
    starting_agent=agent,
    input=user_message,
    context=context,
)

response = result.final_output
```

### function_tool Decorator

Create custom tools for agents.

```python
from agents import function_tool

@function_tool
def my_tool(param1: str, param2: int) -> str:
    """
    Tool description for the agent.
    
    Args:
        param1: Description of param1
        param2: Description of param2
        
    Returns:
        Description of return value
    """
    return f"Result: {param1}, {param2}"
```

## Hosting APIs

### GenericAgentHost

Hosts agents with Microsoft Agents SDK infrastructure.

```python
from host_agent_server import GenericAgentHost, create_and_run_host

# Simple usage
create_and_run_host(MyAgent)

# Advanced usage
host = GenericAgentHost(MyAgent, api_key="...")
auth_config = host.create_auth_configuration()
host.start_server(auth_config)
```

### AgentApplication

Microsoft Agents SDK application wrapper.

```python
from microsoft_agents.hosting.core import AgentApplication, TurnState

agent_app = AgentApplication[TurnState](
    storage=storage,
    adapter=adapter,
    authorization=authorization,
    **config,
)

# Register handlers
@agent_app.activity("message")
async def on_message(context: TurnContext, state: TurnState):
    await context.send_activity("Hello!")
```

## Error Handling

### Common Exceptions

- `ValueError`: Configuration or parameter errors
- `ConnectionError`: Network or service connectivity issues
- `AuthenticationError`: Authentication failures

### Best Practices

```python
try:
    result = await agent.process_user_message(message, auth, handler, context)
except ValueError as e:
    logger.error(f"Configuration error: {e}")
except Exception as e:
    logger.error(f"Unexpected error: {e}")
    return "Sorry, an error occurred."
```

## Additional Resources

- [OpenAI Agents SDK Documentation](https://openai.github.io/openai-agents-python/)
- [Microsoft Agents SDK Documentation](https://learn.microsoft.com/en-us/python/api/?view=m365-agents-sdk)
- [Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
