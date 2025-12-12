# Agent Code Walkthrough

Step-by-step walkthrough of the complete agent implementation in `python/google-adk/sample-agent`.

## Overview

| Component                    | Purpose                                           |
|------------------------------|---------------------------------------------------|
| **Google ADK**               | Core AI orchestration using Google's Gemini models |
| **Microsoft 365 Agents SDK** | Enterprise hosting and authentication integration |
| **MCP Servers**              | External tool access and integration              |
| **Microsoft Agent 365 SDK**  | Comprehensive tracing and monitoring              |

## File Structure and Organization

The code is organized into well-defined sections using XML tags for documentation automation and clear visual separators for developer readability.

Each section follows this pattern:

```python
# =============================================================================
# SECTION NAME
# =============================================================================
# <XmlTagName>
[actual code here]
# </XmlTagName>
```

---

## Step 1: Dependency Imports

```python
# Google ADK
from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions.in_memory_session_service import InMemorySessionService

# Microsoft Agents SDK
from microsoft_agents.hosting.core import Authorization, TurnContext

# MCP Tooling
from mcp_tool_registration_service import McpToolRegistrationService

# Observability Components
from microsoft_agents_a365.observability.core.middleware.baggage_builder import BaggageBuilder
```

**What it does**: Brings in all the external libraries and tools the agent needs to work.

**Key Imports**:
- **Google ADK**: Tools to talk to Google's Gemini AI models and manage conversations
- **Microsoft 365 Agents**: Enterprise security and hosting features
- **MCP Tooling**: Connects the agent to external tools and services via the Model Context Protocol
- **Observability**: Tracks what the agent is doing for monitoring and debugging

---

## Step 2: Agent Initialization

```python
def __init__(
    self,
    agent_name: str = "my_agent",
    model: str = "gemini-2.0-flash",
    description: str = "Agent to test Mcp tools.",
    instruction: str = "You are a helpful agent who can use tools...",
):
    """
    Initialize the Google ADK Agent Wrapper.

    Args:
        agent_name: Name of the agent
        model: Google ADK model to use
        description: Agent description
        instruction: Agent instruction/prompt
    """
    self.agent_name = agent_name
    self.model = model
    self.description = description
    self.instruction = instruction
    self.agent: Optional[Agent] = None

    # Create the agent using Google ADK
    self.agent = Agent(
        name=self.agent_name,
        model=self.model,
        description=self.description,
        instruction=self.instruction,
    )
```

**What it does**: Creates the main AI agent using Google's Gemini model and sets up its basic behavior.

**What happens**:
1. **Stores Configuration**: Saves the agent name, model, description, and instructions
2. **Creates AI Agent**: Builds a Google ADK Agent instance with the Gemini model
3. **Sets Instructions**: Defines how the agent should behave and respond

**Settings**:
- Uses "gemini-2.0-flash" model by default (Google's fast Gemini model)
- Configurable agent name and instructions
- No explicit temperature/creativity settings (uses Google ADK defaults)

---

## Step 3: Observability Configuration

Observability for Google ADK is configured in the hosting layer (`main.py`) rather than in the agent class itself:

```python
# In main.py
from microsoft_agents_a365.observability.core.config import configure

if __name__ == "__main__":
    configure(
        service_name="GoogleADKSampleAgent",
        service_namespace="GoogleADKTesting",
    )
```

**What it does**: Configures Microsoft Agent 365 observability for tracking and monitoring.

**What happens**:
1. Sets up distributed tracing across your agent's operations
2. Enables telemetry export to Azure Monitor or other backends
3. Automatically tracks agent invocations, tool calls, and errors

**In the agent code**, observability context is passed via `BaggageBuilder`:

```python
with BaggageBuilder().tenant_id(tenant_id).agent_id(agent_id).build():
    return await self.invoke_agent(...)
```

**Why it's useful**: Provides visibility into agent behavior, performance metrics, and helps troubleshoot issues in production!

---

## Step 4: MCP Server Setup

```python
async def _initialize_agent(self, auth, auth_handler_name, turn_context):
    """Initialize the agent with MCP tools and authentication."""
    try:
        # Add MCP tools to the agent
        tool_service = McpToolRegistrationService()
        return await tool_service.add_tool_servers_to_agent(
            agent=self.agent,
            agentic_app_id=os.getenv("AGENTIC_APP_ID", "agent123"),
            auth=auth,
            context=turn_context,
            auth_token=os.getenv("BEARER_TOKEN", ""),
        )
    except Exception as e:
        print(f"Error during agent initialization: {e}")
```

**What it does**: Connects your agent to external tools via MCP (Model Context Protocol) servers.

**What happens**:
1. **Load MCP Tools**: Connects to configured MCP servers (like Mail, OneDrive, etc.)
2. **Enhance Agent**: Adds the MCP tools to the Google ADK agent so it can use them

**Key Components**:
- `McpToolRegistrationService`: Manages MCP server connections and tool registration
- `add_tool_servers_to_agent`: Dynamically adds external tools to the agent

**Authentication**:
- Uses Microsoft 365 authentication for secure access to enterprise tools
- Supports bearer token authentication for MCP server access

**Environment Variables**:
- `AGENTIC_APP_ID`: Your Agent 365 application ID
- `BEARER_TOKEN`: Authentication token for MCP servers

---

## Step 5: Message Processing

```python
async def invoke_agent(
    self,
    message: str,
    auth: Authorization,
    auth_handler_name: str,
    context: TurnContext
) -> str:
    """Invoke the agent with a user message."""
    # Initialize agent with MCP tools
    agent = await self._initialize_agent(auth, auth_handler_name, context)

    # Create the Google ADK runner
    runner = Runner(
        app_name="agents",
        agent=agent,
        session_service=InMemorySessionService(),
    )

    # Run the agent and collect responses
    responses = []
    result = await runner.run_debug(user_messages=[message])

    # Extract text responses from events
    for event in result:
        if hasattr(event, 'content') and event.content:
            if hasattr(event.content, 'parts'):
                for part in event.content.parts:
                    if hasattr(part, 'text') and part.text:
                        responses.append(part.text)

    # Cleanup
    await self._cleanup_agent(agent)

    return responses[-1] if responses else "I couldn't get a response."
```

**What it does**: Processes user messages using Google ADK and returns the agent's response.

**What happens**:
1. **Initialize**: Sets up agent with authentication and MCP tools
2. **Create Runner**: Builds a Google ADK Runner to execute the agent
3. **Run Agent**: Sends the message through the agent for processing
4. **Extract Response**: Collects text responses from the event stream
5. **Cleanup**: Closes MCP tool connections after processing

**With Observability Scope**:
```python
async def invoke_agent_with_scope(self, message: str, auth, auth_handler_name, context):
    tenant_id = context.activity.recipient.tenant_id
    agent_id = context.activity.recipient.agentic_user_id
    with BaggageBuilder().tenant_id(tenant_id).agent_id(agent_id).build():
        return await self.invoke_agent(message, auth, auth_handler_name, context)
```

**Why it's important**: This is the core conversation handler - it orchestrates the entire agent invocation flow!

---

## Step 6: Cleanup and Resource Management

```python
async def _cleanup_agent(self, agent: Agent):
    """Clean up agent resources."""
    if agent and hasattr(agent, 'tools'):
        for tool in agent.tools:
            if hasattr(tool, "close"):
                await tool.close()
```

**What it does**: Properly closes MCP tool connections when the agent is done processing.

**What happens**:
- Iterates through all tools attached to the agent
- Calls the `close()` method on each tool that supports it
- Ensures MCP server connections are properly terminated

**Why it's important**:
- Prevents connection leaks and resource exhaustion
- Ensures clean shutdown of external service connections
- Avoids async cleanup errors during application shutdown

**Note**: This is called automatically after each message is processed, not just at application shutdown!

---

## Step 7: Hosting and Entry Point

The Google ADK agent is hosted using the Microsoft 365 Agents SDK hosting framework:

```python
# hosting.py
class MyAgent(AgentApplication):
    def __init__(self, agent: AgentInterface):
        # Initialize Agent365 hosting
        agents_sdk_config = load_configuration_from_env(os.environ)
        connection_manager = MsalConnectionManager(**agents_sdk_config)
        storage = MemoryStorage()

        super().__init__(
            options=ApplicationOptions(
                storage=storage,
                adapter=CloudAdapter(connection_manager=connection_manager),
            ),
            connection_manager=connection_manager,
            authorization=Authorization(storage, connection_manager, **agents_sdk_config),
            **agents_sdk_config,
        )

        self.agent = agent
        self._setup_handlers()

    def _setup_handlers(self):
        @self.activity("message", auth_handlers=self.auth_handlers, rank=2)
        async def message_handler(context: TurnContext, _: TurnState):
            response = await self.agent.invoke_agent_with_scope(
                message=context.activity.text,
                auth=self.auth,
                auth_handler_name="AGENTIC",
                context=context
            )
            await context.send_activity(Activity(type=ActivityTypes.message, text=response))
```

```python
# main.py
if __name__ == "__main__":
    configure(
        service_name="GoogleADKSampleAgent",
        service_namespace="GoogleADKTesting",
    )

    google_adk_agent = GoogleADKAgent()
    app = MyAgent(agent=google_adk_agent)

    run_http_app(app=app, host="0.0.0.0", port=3978)
```

**What it does**: Hosts the Google ADK agent as an HTTP service with Microsoft 365 Agents SDK.

**What happens**:
1. **Configure Observability**: Sets up distributed tracing and monitoring
2. **Create Agent**: Instantiates the GoogleADKAgent wrapper
3. **Create Host**: Wraps the agent in the Agent365 hosting framework
4. **Start Server**: Runs an HTTP server that handles incoming messages

**Key Features**:
- Enterprise authentication and authorization
- Message routing and activity handling
- Notification support (email, Word comments, etc.)
- Automatic cleanup and resource management

**Why it's useful**: Provides production-ready hosting with enterprise features like auth, logging, and scalability!