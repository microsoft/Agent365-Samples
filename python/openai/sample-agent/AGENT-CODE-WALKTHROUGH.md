# Agent Code Walkthrough

Step-by-step walkthrough of the complete agent implementation in `python/openai/sample-agent`.

## Overview

| Component                    | Purpose                                           |
|------------------------------|---------------------------------------------------|
| **OpenAI Agents SDK**        | Core AI orchestration and conversation management |
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
# OpenAI Agents SDK
from agents import Agent, OpenAIChatCompletionsModel, Runner
from agents.model_settings import ModelSettings

# Microsoft Agents SDK
from local_authentication_options import LocalAuthenticationOptions
from openai import AsyncOpenAI
from microsoft_agents.hosting.core import Authorization, TurnContext

# MCP Tooling
from microsoft_agents_a365.tooling.services.mcp_tool_server_configuration_service import (
    McpToolServerConfigurationService,
)
from microsoft_agents_a365.tooling.extensions.openai import mcp_tool_registration_service

# Observability Components (updated paths)
from microsoft_agents_a365.observability.core.config import configure
from microsoft_agents_a365.observability.extensions.openai import OpenAIAgentsTraceInstrumentor

from opentelemetry import trace
```

**What it does**: Brings in all the external libraries and tools the agent needs to work.

**Key Imports**:
- **OpenAI**: Tools to talk to AI models and manage conversations
- **Microsoft 365 Agents**: Enterprise security and hosting features
- **MCP Tooling**: Connects the agent to external tools and services
- **Observability**: Tracks what the agent is doing for monitoring and debugging

---

## Step 2: Agent Initialization

```python
def __init__(self, openai_api_key: str | None = None):
        # Resolve API credentials (plain OpenAI or Azure)
        self.openai_api_key = openai_api_key or os.getenv("OPENAI_API_KEY")
        azure_endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
        azure_api_key = os.getenv("AZURE_OPENAI_API_KEY")
    
        if not self.openai_api_key and (not azure_endpoint or not azure_api_key):
            raise ValueError("OpenAI API key OR Azure OpenAI credentials (endpoint + key) are required")
    
        # Initialize observability pipeline
        self._setup_observability()
    
        # Select client (Azure preferred if both sets provided)
        if azure_endpoint and azure_api_key:
            self.openai_client = AsyncAzureOpenAI(
                azure_endpoint=azure_endpoint,
                api_key=azure_api_key,
                api_version="2025-01-01-preview",
            )
        else:
            self.openai_client = AsyncOpenAI(api_key=self.openai_api_key)
    
        # Model + settings
        self.model = OpenAIChatCompletionsModel(
            model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            openai_client=self.openai_client,
        )

        # Configure model settings (optional parameters)
        self.model_settings = ModelSettings(temperature=0.7)

        # Initialize MCP servers
        self.mcp_servers = []

        # Create the agent
        self.agent = Agent(
            name="MCP Agent",
            model=self.model,
            model_settings=self.model_settings,
            instructions="""
You are a helpful AI assistant with access to external tools through MCP servers.
When a user asks for any action, use the appropriate tools to provide accurate and helpful responses.
Always be friendly and explain your reasoning when using tools.
            """,
            mcp_servers=self.mcp_servers,
        )

        # Initialize the runner
        self.runner = Runner()

        # Setup OpenAI Agents instrumentation (handled in _setup_observability)
        # Instrumentation is automatically configured during observability setup
        pass
```

**What it does**: Creates the main AI agent and sets up its basic behavior.

**What happens**:
1. **Gets API Key**: Takes the OpenAI key to access the AI model
2. **Sets up Monitoring**: Turns on tracking so we can see what the agent does
3. **Creates AI Client**: Makes a connection to OpenAI's servers
4. **Builds the Agent**: Creates the actual AI assistant with instructions
5. **Creates Runner**: Makes the engine that will handle conversations

**Settings**:
- Uses "gpt-4o-mini" model by default
- Sets creativity level to 0.7 (balanced responses)

---

## Step 3: Observability Configuration

```python
def token_resolver(self, agent_id: str, tenant_id: str) -> str | None:
    """
    Resolve an agentic bearer token for secure Agent 365 Observability exporter calls.

    Tokens are cached in the generic host (see host_agent_server.py) when:
        exaau_token = agent_app.auth.exchange_token(...)
        cache_agentic_token(tenant_id, agent_id, exaau_token.token)

    Returns:
        str | None: Returns cached token or None (exporter will skip authenticated export).
    """
    try:
        logger.info(f"Token resolver called for agent_id={agent_id}, tenant_id={tenant_id}")
        cached_token = get_cached_agentic_token(tenant_id, agent_id)
        if cached_token:
            return cached_token
        logger.warning("No cached agentic token found; exporter may skip secure send.")
        return None
    except Exception as e:
        logger.error(f"Token resolver error for agent {agent_id}/{tenant_id}: {e}")
        return None

def _setup_observability(self):
        """
        Configure Microsoft Agent 365 observability (simplified pattern)

        This follows the same pattern as the reference examples:
        - semantic_kernel: configure() + SemanticKernelInstrumentor().instrument()
        - openai_agents: configure() + OpenAIAgentsTraceInstrumentor().instrument()
        - token_resolver for secure exporter usage
        - cluster_category selection (prod/preprod)
        """
        try:
            # Step 1: Configure Agent 365 Observability with service information
            status = configure(
                service_name=os.getenv("OBSERVABILITY_SERVICE_NAME", "openai-sample-agent"),
                service_namespace=os.getenv("OBSERVABILITY_SERVICE_NAMESPACE", "agent365-samples"),
                token_resolver=self.token_resolver,
                cluster_category=os.getenv("CLUSTER_CATEGORY", "prod"),
            )

            if not status:
                logger.warning("⚠️ Agent 365 Observability configuration failed")
                return

            logger.info("✅ Agent 365 Observability configured successfully")

            # Step 2: Enable OpenAI Agents instrumentation
            self._enable_openai_agents_instrumentation()

        except Exception as e:
            logger.error(f"❌ Error setting up observability: {e}")

    def _enable_openai_agents_instrumentation(self):
        """Enable OpenAI Agents instrumentation for automatic tracing"""
        try:
            # Initialize Agent 365 Observability Wrapper for OpenAI Agents SDK
            OpenAIAgentsTraceInstrumentor().instrument()
            logger.info("✅ OpenAI Agents instrumentation enabled")
        except Exception as e:
            logger.warning(f"⚠️ Could not enable OpenAI Agents instrumentation: {e}")
```

**What it does**: Turns on detailed logging and monitoring so you can see what your agent is doing.

**What happens**:
1. Sets up tracking with a service name (like giving your agent an ID badge)
2. Automatically records all AI conversations and tool usage
3. Helps you debug problems and understand performance

**Environment Variables**:
- `OBSERVABILITY_SERVICE_NAME`: What to call your agent in logs (default: "openai-sample-agent")
- `OBSERVABILITY_SERVICE_NAMESPACE`: Which group it belongs to (default: "agent365-samples")

**Why it's useful**: Like having a detailed diary of everything your agent does - great for troubleshooting!

---

## Step 4: MCP Server Setup

```python
def _initialize_services(self):
        """
        Initialize MCP services and authentication options.

        Returns:
            Tuple of (tool_service, auth_options)
        """
        # Create configuration service and tool service with dependency injection
        self.config_service = McpToolServerConfigurationService()
        self.tool_service = mcp_tool_registration_service.McpToolRegistrationService()

        # Create authentication options from environment
        self.auth_options = LocalAuthenticationOptions.from_environment()

        # return tool_service, auth_options

    async def setup_mcp_servers(self, auth: Authorization, auth_handler_name: str, context: TurnContext):
        """Set up MCP server connections"""
        try:

            use_agentic_auth = os.getenv("USE_AGENTIC_AUTH", "false").lower() == "true"
            if use_agentic_auth:
                self.agent = await self.tool_service.add_tool_servers_to_agent(
                    agent=self.agent,
                    auth=auth,
                    auth_handler_name=auth_handler_name,
                    context=context,
                )
            else:
                self.agent = await self.tool_service.add_tool_servers_to_agent(
                    agent=self.agent,
                    auth=auth,
                    auth_handler_name=auth_handler_name,
                    context=context,
                    auth_token=self.auth_options.bearer_token,
                )

        except Exception as e:
            logger.error(f"Error setting up MCP servers: {e}")

    async def initialize(self):
        """Initialize the agent and MCP server connections"""
        logger.info("Initializing OpenAI Agent with MCP servers...")

        try:
            # The runner doesn't need explicit initialization
            logger.info("Agent and MCP servers initialized successfully")
            self._initialize_services()

        except Exception as e:
            logger.error(f"Failed to initialize agent: {e}")
            raise
```

**What it does**: Connects your agent to external tools (like mail, calendar) that it can use to help users.

The agent supports multiple authentication modes and extensive configuration options:

**Environment Variables**:
- `OPENAI_API_KEY`: Your OpenAI key to access AI models
- `OPENAI_MODEL`: Which AI model to use (defaults to "gpt-4o-mini")
- `OBSERVABILITY_SERVICE_NAME`: Name for tracking and logs
- `OBSERVABILITY_SERVICE_NAMESPACE`: Group name for organization
- `AGENT_ID`: Unique identifier for this agent instance
- `USE_AGENTIC_AUTH`: Choose between enterprise security (true) or simple tokens (false)

**Authentication Modes**:
- **Agentic Authentication**: Enterprise-grade security with Azure AD (for production)
- **Bearer Token Authentication**: Simple token-based security (for development and testing)

**What happens**:
1. Creates services to find and manage external tools
2. Sets up security and authentication
3. Finds available tools and connects them to the agent

---

## Step 5: Message Processing

```python
async def process_user_message(
        self, message: str, auth: Authorization, auth_handler_name: str, context: TurnContext
    ) -> str:
        """Process user message using the OpenAI Agents SDK"""
        try:
            # Setup MCP servers
            await self.setup_mcp_servers(auth, auth_handler_name, context)

            # Run the agent with the user message
            result = await self.runner.run(starting_agent=self.agent, input=message)

            # Extract the response from the result
            if result and hasattr(result, "final_output") and result.final_output:
                return str(result.final_output)
            else:
                return "I couldn't process your request at this time."

        except Exception as e:
            logger.error(f"Error processing message: {e}")
            return f"Sorry, I encountered an error: {str(e)}"
```

**What it does**: This is the main function that handles user conversations - when someone sends a message, this processes it and sends back a response.

**What happens**:
1. **Connect Tools**: Sets up any external tools the agent might need for this conversation
2. **Run AI**: Sends the user's message to the AI model and gets a response
3. **Extract Answer**: Pulls out the text response from the AI's reply
4. **Handle Problems**: If something goes wrong, it gives a helpful error message instead of crashing

**Why it's important**: This is the "brain" of the agent - it's what actually makes conversations happen!

---

## Step 6: Cleanup and Resource Management

```python
async def cleanup(self):
        """Clean up resources"""
        try:
            # Cleanup runner
            if hasattr(self.runner, "cleanup"):
                await self.runner.cleanup()

            logger.info("✅ Cleanup completed")
        except Exception as e:
            logger.error(f"❌ Error during cleanup: {e}")
```

**What it does**: Properly shuts down the agent and cleans up connections when it's done working.

**What happens**: 
- Safely closes connections to external tools
- Makes sure no resources are left hanging around
- Logs any cleanup issues but doesn't crash if something goes wrong

**Why it's important**: Like turning off the lights and locking the door when you leave - keeps everything tidy and prevents problems!

---

## Step 7: Main Entry Point

```python
async def main():
    """Main function to run the OpenAI Agent with MCP servers"""
    try:
        # Create and initialize the agent
        agent = OpenAIAgentWithMCP()
        await agent.initialize()

    except Exception as e:
        logger.error(f"Failed to start agent: {e}")
        print(f"Error: {e}")

    finally:
        # Cleanup
        if "agent" in locals():
            await agent.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
```

**What it does**: This is the starting point that runs when you execute the agent file directly - like the "main" button that starts everything.

**What happens**:
- Starts the agent
- Ensures cleanup happens even if something goes wrong
- Provides a way to test the agent by running the file directly

**Why it's useful**: Makes it easy to test your agent and ensures it always shuts down properly!