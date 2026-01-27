# Python Design Guidelines

## Overview

This document describes the design patterns and conventions for Python sample agents in the Agent365-Samples repository. All Python samples use async/await patterns and follow a modular architecture with clear separation of concerns.

## Supported Orchestrators

| Orchestrator | Description | Sample Location |
|--------------|-------------|-----------------|
| Agent Framework | Microsoft's agent orchestration framework | [agent-framework/sample-agent](../agent-framework/sample-agent/) |
| Claude | Anthropic's Claude AI | [claude/sample-agent](../claude/sample-agent/) |
| CrewAI | Multi-agent orchestration framework | [crewai/sample_agent](../crewai/sample_agent/) |
| Google ADK | Google's Agent Development Kit | [google-adk/sample-agent](../google-adk/sample-agent/) |
| OpenAI | OpenAI Agents SDK | [openai/sample-agent](../openai/sample-agent/) |

## Project Structure

```
sample-agent/
├── agent.py                  # Main agent implementation
├── agent_interface.py        # Abstract base class for agents
├── host_agent_server.py      # Generic hosting server
├── start_with_generic_host.py # Entry point
├── local_authentication_options.py # Auth configuration
├── token_cache.py            # Token caching utilities
├── pyproject.toml           # Project configuration
├── ToolingManifest.json     # MCP tool manifest
├── .env                     # Environment variables
└── README.md                # Documentation
```

## Core Patterns

### 1. Agent Interface (Abstract Base Class)

All agents must implement the `AgentInterface`:

```python
from abc import ABC, abstractmethod
from microsoft_agents.hosting.core import Authorization, TurnContext

class AgentInterface(ABC):
    """Abstract base class that any hosted agent must inherit from."""

    @abstractmethod
    async def initialize(self) -> None:
        """Initialize the agent and any required resources."""
        pass

    @abstractmethod
    async def process_user_message(
        self, message: str, auth: Authorization,
        auth_handler_name: str, context: TurnContext
    ) -> str:
        """Process a user message and return a response."""
        pass

    @abstractmethod
    async def cleanup(self) -> None:
        """Clean up any resources used by the agent."""
        pass
```

### 2. Agent Implementation

Example agent implementation:

```python
class OpenAIAgentWithMCP(AgentInterface):
    """OpenAI Agent integrated with MCP servers"""

    def __init__(self, openai_api_key: str | None = None):
        self.openai_api_key = openai_api_key or os.getenv("OPENAI_API_KEY")

        # Initialize observability
        self._setup_observability()

        # Initialize LLM client
        endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
        if endpoint:
            self.openai_client = AsyncAzureOpenAI(...)
        else:
            self.openai_client = AsyncOpenAI(api_key=self.openai_api_key)

        # Create agent with model and instructions
        self.agent = Agent(
            name="MCP Agent",
            model=self.model,
            instructions="...",
            mcp_servers=self.mcp_servers,
        )

    async def initialize(self) -> None:
        """Initialize the agent and MCP server connections"""
        self._initialize_services()

    async def process_user_message(
        self, message: str, auth: Authorization,
        auth_handler_name: str, context: TurnContext
    ) -> str:
        """Process user message using the OpenAI Agents SDK"""
        await self.setup_mcp_servers(auth, auth_handler_name, context)
        result = await Runner.run(starting_agent=self.agent, input=message)
        return str(result.final_output)

    async def cleanup(self) -> None:
        """Clean up agent resources"""
        if hasattr(self, "openai_client"):
            await self.openai_client.close()
```

### 3. Generic Host Server

The generic host provides reusable hosting infrastructure:

```python
class GenericAgentHost:
    """Generic host that can host any agent implementing AgentInterface"""

    def __init__(self, agent_class: type[AgentInterface], *agent_args, **agent_kwargs):
        # Validate agent implements interface
        if not check_agent_inheritance(agent_class):
            raise TypeError(f"Agent must inherit from AgentInterface")

        # Microsoft Agents SDK components
        self.storage = MemoryStorage()
        self.connection_manager = MsalConnectionManager(**agents_sdk_config)
        self.adapter = CloudAdapter(connection_manager=self.connection_manager)
        self.authorization = Authorization(self.storage, self.connection_manager)

        self.agent_app = AgentApplication[TurnState](
            storage=self.storage,
            adapter=self.adapter,
            authorization=self.authorization,
        )

        self._setup_handlers()

    def _setup_handlers(self):
        """Setup message handlers"""
        @self.agent_app.activity("message", **handler_config)
        async def on_message(context: TurnContext, _: TurnState):
            with BaggageBuilder().tenant_id(tenant_id).agent_id(agent_id).build():
                response = await self.agent_instance.process_user_message(
                    user_message, self.agent_app.auth,
                    self.auth_handler_name, context
                )
                await context.send_activity(response)
```

### 4. Observability Configuration

```python
def _setup_observability(self):
    """Configure Microsoft Agent 365 observability"""
    # Step 1: Configure with service information
    status = configure(
        service_name=os.getenv("OBSERVABILITY_SERVICE_NAME", "sample-agent"),
        service_namespace=os.getenv("OBSERVABILITY_SERVICE_NAMESPACE", "agent365"),
        token_resolver=self.token_resolver,
    )

    # Step 2: Enable framework-specific instrumentation
    OpenAIAgentsTraceInstrumentor().instrument()

def token_resolver(self, agent_id: str, tenant_id: str) -> str | None:
    """Token resolver for Agent 365 Observability exporter"""
    cached_token = get_cached_agentic_token(tenant_id, agent_id)
    return cached_token
```

### 5. MCP Server Setup

```python
async def setup_mcp_servers(self, auth: Authorization, auth_handler_name: str,
                            context: TurnContext):
    """Set up MCP server connections"""
    # Priority 1: Bearer token from config (development)
    if self.auth_options.bearer_token:
        self.agent = await self.tool_service.add_tool_servers_to_agent(
            agent=self.agent,
            auth=auth,
            auth_handler_name=auth_handler_name,
            context=context,
            auth_token=self.auth_options.bearer_token,
        )
    # Priority 2: Auth handler (production)
    elif auth_handler_name:
        self.agent = await self.tool_service.add_tool_servers_to_agent(
            agent=self.agent,
            auth=auth,
            auth_handler_name=auth_handler_name,
            context=context,
        )
    # Priority 3: No auth - bare LLM mode
    else:
        logger.warning("No auth configured - running without MCP tools")
```

### 6. Authentication Options

```python
class LocalAuthenticationOptions:
    """Authentication options loaded from environment"""

    bearer_token: str | None = None
    auth_handler_name: str | None = None

    @classmethod
    def from_environment(cls) -> "LocalAuthenticationOptions":
        return cls(
            bearer_token=os.getenv("BEARER_TOKEN"),
            auth_handler_name=os.getenv("AUTH_HANDLER_NAME"),
        )
```

### 7. Token Caching

```python
# Global token cache
_agentic_token_cache: dict[str, str] = {}

def cache_agentic_token(tenant_id: str, agent_id: str, token: str) -> None:
    """Cache an agentic token for later use"""
    cache_key = f"{tenant_id}:{agent_id}"
    _agentic_token_cache[cache_key] = token

def get_cached_agentic_token(tenant_id: str, agent_id: str) -> str | None:
    """Retrieve a cached agentic token"""
    cache_key = f"{tenant_id}:{agent_id}"
    return _agentic_token_cache.get(cache_key)
```

## Key Python Packages

| Package | Purpose |
|---------|---------|
| `microsoft-agents-hosting-aiohttp` | aiohttp-based hosting |
| `microsoft-agents-hosting-core` | Core hosting abstractions |
| `microsoft_agents_a365.observability` | Agent 365 tracing |
| `microsoft_agents_a365.tooling` | MCP tool integration |
| `openai` / `agents` | OpenAI SDK |
| `anthropic` | Anthropic Claude SDK |
| `pydantic` | Data validation |
| `python-dotenv` | Environment configuration |
| `aiohttp` | Async HTTP server |

## Configuration

**pyproject.toml structure:**
```toml
[project]
name = "sample-agent"
version = "0.1.0"
requires-python = ">=3.11"

dependencies = [
    "microsoft-agents-hosting-aiohttp>=0.0.1",
    "microsoft-agents-hosting-core>=0.0.1",
    "microsoft_agents_a365_observability_core>=0.0.1",
    "microsoft_agents_a365_tooling_core>=0.0.1",
    "openai>=1.0.0",
    "python-dotenv>=1.0.0",
]

[tool.uv]
dev-dependencies = [
    "pytest>=8.0.0",
]
```

**.env configuration:**
```bash
# LLM Configuration
OPENAI_API_KEY=sk-...
AZURE_OPENAI_ENDPOINT=https://...
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_DEPLOYMENT=gpt-4o

# Authentication
BEARER_TOKEN=...
AUTH_HANDLER_NAME=AGENTIC
CLIENT_ID=...
TENANT_ID=...
CLIENT_SECRET=...

# Observability
OBSERVABILITY_SERVICE_NAME=sample-agent
OBSERVABILITY_SERVICE_NAMESPACE=agent365-samples
```

## Async Patterns

All I/O operations use async/await:

```python
async def process_user_message(self, message: str, ...) -> str:
    # Async MCP setup
    await self.setup_mcp_servers(auth, auth_handler_name, context)

    # Async LLM invocation
    result = await Runner.run(starting_agent=self.agent, input=message)

    return str(result.final_output)
```

## Error Handling

```python
@staticmethod
def should_skip_tooling_on_errors() -> bool:
    """Check if graceful fallback is enabled"""
    environment = os.getenv("ENVIRONMENT", "Production")
    skip_tooling = os.getenv("SKIP_TOOLING_ON_ERRORS", "").lower()
    return environment.lower() == "development" and skip_tooling == "true"

try:
    await self.setup_mcp_servers(...)
except Exception as e:
    if self.should_skip_tooling_on_errors():
        logger.warning(f"Falling back to bare LLM mode: {e}")
    else:
        raise
```

## Running the Agent

```bash
# Using UV (recommended)
uv run python start_with_generic_host.py

# Using pip
pip install -e .
python start_with_generic_host.py
```

## Sample Agents

- [Agent Framework Sample Design](../agent-framework/sample-agent/docs/design.md)
- [Claude Sample Design](../claude/sample-agent/docs/design.md)
- [CrewAI Sample Design](../crewai/sample_agent/docs/design.md)
- [Google ADK Sample Design](../google-adk/sample-agent/docs/design.md)
- [OpenAI Sample Design](../openai/sample-agent/docs/design.md)
