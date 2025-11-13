# Agent Code Walkthrough

Step-by-step walkthrough of the complete agent implementation in `sample_agent\agent.py`.

## Overview

| Component | Purpose |
|-----------|---------|
| **AgentFramework SDK** | Core AI orchestration and conversation management |
| **Microsoft 365 Agents SDK** | Enterprise hosting and authentication integration |
| **Agent Notifications** | Handle @mentions from Outlook, Word, and Excel |
| **MCP Servers** | External tool access and integration |
| **Microsoft Agent 365 Observability** | Comprehensive tracing and monitoring |

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
# AgentFramework SDK
from agent_framework.azure import AzureOpenAIChatClient
from agent_framework import ChatAgent
from azure.identity import AzureCliCredential

# Agent Interface
from agent_interface import AgentInterface

# Microsoft Agents SDK
from local_authentication_options import LocalAuthenticationOptions
from microsoft_agents.hosting.core import Authorization, TurnContext

# Notifications
from microsoft_agents_a365.notifications.agent_notification import NotificationTypes

# Observability Components
from microsoft_agents_a365.observability.core.config import configure

# MCP Tooling
from microsoft_agents_a365.tooling.extensions.agentframework.services.mcp_tool_registration_service import (
    McpToolRegistrationService,
)
```

**What it does**: Brings in all the external libraries and tools the agent needs to work.

**Key Imports**:
- **AgentFramework**: Tools to talk to AI models and manage conversations
- **Microsoft 365 Agents**: Enterprise security and hosting features
- **Notifications**: Handle @mentions from Outlook, Word, and Excel
- **MCP Tooling**: Connects the agent to external tools and services
- **Observability**: Tracks what the agent is doing for monitoring and debugging

---

## Step 2: Agent Initialization

```python
def __init__(self):
    """Initialize the AgentFramework agent."""
    self.logger = logging.getLogger(self.__class__.__name__)

    # Initialize observability
    self._setup_observability()

    # Initialize authentication options
    self.auth_options = LocalAuthenticationOptions.from_environment()

    # Create Azure OpenAI chat client
    self._create_chat_client()

    # Create the agent with initial configuration
    self._create_agent()

    # Initialize MCP services
    self._initialize_services()
```

**What it does**: Creates the main AI agent and sets up its basic behavior.

**What happens**:
1. **Sets up Monitoring**: Turns on tracking so we can see what the agent does
2. **Gets Authentication**: Loads security settings from environment variables
3. **Creates AI Client**: Makes a connection to Azure OpenAI's servers
4. **Builds the Agent**: Creates the actual AI assistant with instructions
5. **Initializes Tools**: Sets up access to external MCP tools

---

## Step 3: Chat Client Creation

```python
def _create_chat_client(self):
    """Create the Azure OpenAI chat client"""
    endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
    deployment = os.getenv("AZURE_OPENAI_DEPLOYMENT")
    api_version = os.getenv("AZURE_OPENAI_API_VERSION")

    if not endpoint:
        raise ValueError("AZURE_OPENAI_ENDPOINT environment variable is required")
    if not deployment:
        raise ValueError("AZURE_OPENAI_DEPLOYMENT environment variable is required")
    if not api_version:
        raise ValueError("AZURE_OPENAI_API_VERSION environment variable is required")

    self.chat_client = AzureOpenAIChatClient(
        endpoint=endpoint,
        credential=AzureCliCredential(),
        deployment_name=deployment,
        api_version=api_version
    )
```

**What it does**: Sets up the connection to Azure OpenAI so the agent can talk to the AI model.

**What happens**:
1. **Gets Configuration**: Reads Azure OpenAI settings from environment variables
2. **Validates Settings**: Makes sure all required settings are present
3. **Creates Client**: Establishes authenticated connection to Azure OpenAI

**Environment Variables**:
- `AZURE_OPENAI_ENDPOINT`: Your Azure OpenAI service URL
- `AZURE_OPENAI_DEPLOYMENT`: Which AI model deployment to use
- `AZURE_OPENAI_API_VERSION`: API version for compatibility

---

## Step 4: Agent Creation

```python
def _create_agent(self):
    """Create the AgentFramework agent with initial configuration"""
    try:
        logger.info("Creating AgentFramework agent...")

        self.agent = ChatAgent(
            chat_client=self.chat_client,
            instructions="You are a helpful assistant with access to tools.",
            tools=[]  # Tools will be added dynamically by MCP setup
        )

        logger.info("✅ AgentFramework agent created successfully")

    except Exception as e:
        logger.error(f"Failed to create agent: {e}")
        raise
```

**What it does**: Creates the AI agent that will handle conversations.

**What happens**:
1. **Creates Agent**: Builds the chat agent with the AI client
2. **Sets Instructions**: Gives the agent its base personality and behavior
3. **Prepares for Tools**: Tools will be added later when MCP servers connect

**Settings**:
- Instructions define how the agent behaves
- Tools array starts empty and gets filled when MCP servers connect

---

## Step 5: Observability Configuration

```python
def _setup_observability(self):
    """Configure Microsoft Agent 365 observability"""
    try:
        # Step 1: Configure with service information
        status = configure(
            service_name=os.getenv("OBSERVABILITY_SERVICE_NAME", "agentframework-agent"),
            service_namespace=os.getenv("OBSERVABILITY_SERVICE_NAMESPACE", "agent365-samples"),
            token_resolver=self.token_resolver,
        )

        if not status:
            logger.warning("⚠️ Configuration failed")
            return

        logger.info("✅ Configured successfully")

        # Note: AgentFramework instrumentation would be added here when available
        # This would be similar to: InstrumentorAgentFramework().instrument()

    except Exception as e:
        logger.error(f"❌ Error setting up observability: {e}")

def token_resolver(self, agent_id: str, tenant_id: str) -> str | None:
    """Token resolver function for exporter"""
    try:
        logger.info(f"Token resolver called for agent_id: {agent_id}, tenant_id: {tenant_id}")
        # Token resolution logic would go here
        return None
    except Exception as e:
        logger.error(f"Error resolving token: {e}")
        return None
```

**What it does**: Turns on detailed logging and monitoring so you can see what your agent is doing.

**What happens**:
1. Sets up tracking with a service name (like giving your agent an ID badge)
2. Automatically records all AI conversations and tool usage
3. Helps you debug problems and understand performance

**Environment Variables**:
- `OBSERVABILITY_SERVICE_NAME`: What to call your agent in logs (default: "agentframework-agent")
- `OBSERVABILITY_SERVICE_NAMESPACE`: Which group it belongs to (default: "agent365-samples")
- `ENABLE_A365_OBSERVABILITY_EXPORTER`: Set to "false" for console output during development

**Why it's useful**: Like having a detailed diary of everything your agent does - great for troubleshooting!

---

## Step 6: MCP Server Setup

```python
def _initialize_services(self):
    """Initialize MCP services and authentication options"""
    try:
        # Create MCP tool registration service
        self.tool_service = McpToolRegistrationService()
        logger.info("✅ AgentFramework MCP tool registration service initialized")
    except Exception as e:
        logger.warning(f"⚠️ Could not initialize MCP tool service: {e}")
        self.tool_service = None

async def setup_mcp_servers(self, auth: Authorization, context: TurnContext):
    """Set up MCP server connections"""
    try:
        if not self.tool_service:
            logger.warning("⚠️ MCP tool service not available - skipping MCP server setup")
            return

        agent_user_id = os.getenv("AGENT_ID", "user123")
        use_agentic_auth = os.getenv("USE_AGENTIC_AUTH", "false").lower() == "true"

        if use_agentic_auth:
            self.agent = await self.tool_service.add_tool_servers_to_agent(
                chat_client=self.chat_client,
                agent_instructions="You are a helpful assistant with access to tools.",
                initial_tools=[],
                agent_user_id=agent_user_id,
                auth=auth,
                turn_context=context,
            )
        else:
            self.agent = await self.tool_service.add_tool_servers_to_agent(
                chat_client=self.chat_client,
                agent_instructions="You are a helpful assistant with access to tools.",
                initial_tools=[],
                agent_user_id=agent_user_id,
                auth=auth,
                auth_token=self.auth_options.bearer_token,
                turn_context=context,
            )

        if self.agent:
            logger.info("✅ Agent MCP setup completed successfully")
        else:
            logger.error("❌ Agent is None after MCP setup")

    except Exception as e:
        logger.error(f"Error setting up MCP servers: {e}")
```

**What it does**: Connects your agent to external tools (like mail, calendar, notifications) that it can use to help users.

The agent supports multiple authentication modes and extensive configuration options:

**Environment Variables**:
- `AGENT_ID`: Unique identifier for this agent instance
- `USE_AGENTIC_AUTH`: Choose between enterprise security (true) or simple tokens (false)
- `ENV_ID`: Agent365 environment identifier
- `BEARER_TOKEN`: Authentication token for MCP servers

**Authentication Modes**:
- **Agentic Authentication**: Enterprise-grade security with Azure AD (for production)
- **Bearer Token Authentication**: Simple token-based security (for development and testing)

**What happens**:
1. Creates services to find and manage external tools
2. Sets up security and authentication
3. Finds available tools and connects them to the agent
4. Recreates the agent with the new tools attached

---

## Step 7: Message Processing

```python
async def process_user_message(
    self, message: str, auth: Authorization, context: TurnContext
) -> str:
    """Process user message using the AgentFramework SDK"""
    try:
        await self.setup_mcp_servers(auth, context)
        result = await self.agent.run(message)
        return self._extract_result(result) or "I couldn't process your request at this time."
    except Exception as e:
        logger.error(f"Error processing message: {e}")
        return f"Sorry, I encountered an error: {str(e)}"
```

**What it does**: Handles regular chat messages from users.

**What happens**:
1. **Setup Tools**: Makes sure MCP tools are connected (only runs once on first message)
2. **Run Agent**: Sends the message to the AI agent for processing
3. **Extract Response**: Pulls out the text response from the agent's result
4. **Error Handling**: Catches problems and returns friendly error messages

---

## Step 8: Notification Handling

```python
async def handle_agent_notification_activity(
    self, notification_activity, auth: Authorization, context: TurnContext
) -> str:
    """Handle agent notification activities (email, Word mentions, etc.)"""
    try:
        notification_type = notification_activity.notification_type
        logger.info(f"📬 Processing notification: {notification_type}")

        await self.setup_mcp_servers(auth, context)

        # Handle Email Notifications
        if notification_type == NotificationTypes.EMAIL_NOTIFICATION:
            if not hasattr(notification_activity, "email") or not notification_activity.email:
                return "I could not find the email notification details."

            email = notification_activity.email
            email_body = getattr(email, "html_body", "") or getattr(email, "body", "")
            message = f"You have received the following email. Please follow any instructions in it. {email_body}"

            result = await self.agent.run(message)
            return self._extract_result(result) or "Email notification processed."

        # Handle Word Comment Notifications
        elif notification_type == NotificationTypes.WPX_COMMENT:
            if not hasattr(notification_activity, "wpx_comment") or not notification_activity.wpx_comment:
                return "I could not find the Word notification details."

            wpx = notification_activity.wpx_comment
            doc_id = getattr(wpx, "document_id", "")
            comment_id = getattr(wpx, "initiating_comment_id", "")
            drive_id = "default"

            # Get Word document content
            doc_message = f"You have a new comment on the Word document with id '{doc_id}', comment id '{comment_id}', drive id '{drive_id}'. Please retrieve the Word document as well as the comments and return it in text format."
            doc_result = await self.agent.run(doc_message)
            word_content = self._extract_result(doc_result)

            # Process the comment with document context
            comment_text = notification_activity.text or ""
            response_message = f"You have received the following Word document content and comments. Please refer to these when responding to comment '{comment_text}'. {word_content}"
            result = await self.agent.run(response_message)
            return self._extract_result(result) or "Word notification processed."

        # Generic notification handling
        else:
            notification_message = notification_activity.text or f"Notification received: {notification_type}"
            result = await self.agent.run(notification_message)
            return self._extract_result(result) or "Notification processed successfully."

    except Exception as e:
        logger.error(f"Error processing notification: {e}")
        return f"Sorry, I encountered an error processing the notification: {str(e)}"
```

**What it does**: Handles notifications from Microsoft 365 apps like Outlook and Word.

**What happens**:
1. **Setup Tools**: Makes sure MCP tools are connected (notifications might arrive before any regular messages)
2. **Identify Type**: Checks what kind of notification it is (email, Word comment, etc.)
3. **Email Notifications**: Extracts email body and processes with the agent
4. **Word Comments**: Retrieves document content, then processes the comment with context
5. **Generic Handling**: Falls back to simple text processing for other notification types

**Supported Notification Types**:
- `NotificationTypes.EMAIL_NOTIFICATION`: @mentions in Outlook emails
- `NotificationTypes.WPX_COMMENT`: @mentions in Word/Excel comments
- Other notification types handled generically

**Why MCP Setup is Needed**: Notifications need access to tools (like Microsoft Graph to read documents) just like regular messages. The `mcp_servers_initialized` flag ensures setup only runs once regardless of whether a message or notification arrives first.

---

## Step 9: Cleanup

```python
async def initialize(self):
    """Initialize the agent and MCP server connections"""
    logger.info("Initializing AgentFramework Agent with MCP servers...")
    try:
        logger.info("Agent initialized successfully")
    except Exception as e:
        logger.error(f"Failed to initialize agent: {e}")
        raise

async def process_user_message(
    self, message: str, auth: Authorization, context: TurnContext
) -> str:
    """Process user message using the AgentFramework SDK"""
    try:
        # Setup MCP servers
        await self.setup_mcp_servers(auth, context)

        # Run the agent with the user message
        result = await self.agent.run(message)

        # Extract the response from the result
        if result:
            if hasattr(result, 'contents'):
                return str(result.contents)
            elif hasattr(result, 'text'):
                return str(result.text)
            elif hasattr(result, 'content'):
                return str(result.content)
            else:
                return str(result)
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

## Step 8: Cleanup and Resource Management

```python
async def cleanup(self) -> None:
    """Clean up agent resources and MCP server connections"""
    try:
        logger.info("Cleaning up agent resources...")

        # Cleanup MCP tool service if it exists
        if hasattr(self, "tool_service") and self.tool_service:
            try:
                await self.tool_service.cleanup()
                logger.info("MCP tool service cleanup completed")
            except Exception as cleanup_ex:
                logger.warning(f"Error cleaning up MCP tool service: {cleanup_ex}")

        logger.info("Agent cleanup completed")

    except Exception as e:
        logger.error(f"Error during cleanup: {e}")
```

**What it does**: Properly shuts down the agent and cleans up connections when it's done working.

**What happens**:
- Safely closes connections to MCP tool servers
- Makes sure no resources are left hanging around
- Logs any cleanup issues but doesn't crash if something goes wrong

**Why it's important**: Like turning off the lights and locking the door when you leave - keeps everything tidy and prevents problems!

---

## Step 9: Main Entry Point

```python
async def main():
    """Main function to run the AgentFramework Agent with MCP servers"""
    try:
        # Create and initialize the agent
        agent = AgentFrameworkAgent()
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
    result = await agent_context.run(message)
```

### 3. **Interface Segregation**
Clean separation of concerns through interfaces:
```python
class AgentInterface(ABC):
    # Define contract without implementation details

class AgentFrameworkInterface(AgentInterface):
    # Specific implementation for AgentFramework
```

### 4. **Configuration Pattern**
Centralized configuration with validation:
```python
config = {
    "endpoint": os.environ.get("AZURE_OPENAI_ENDPOINT"),
    "deployment": os.environ.get("AZURE_OPENAI_DEPLOYMENT_NAME"),
    # ... other config
}
```

## 🔍 Observability Implementation

### 1. **Structured Logging**
```python
self.logger.info("🚀 Starting AgentFramework Agent initialization...")
self.logger.error(f"❌ Missing required environment variables: {missing}")
```

### 2. **Telemetry Configuration**
```python
configure(
    console_trace_output=True,
    enable_telemetry=True,
    service_name="agentframework-agent",
    service_version="1.0.0"
)
```

### 3. **Error Context**
```python
except Exception as ex:
    self.logger.error(f"❌ Agent initialization failed: {type(ex).__name__}: {ex}")
    self.logger.debug("Full error details:", exc_info=True)
```

## 🚀 Extension Points

### 1. **Adding New Capabilities**
Extend the `AgentInterface` to add new methods:
```python
@abstractmethod
async def custom_capability(self, params: Dict[str, Any]) -> Any:
    pass
```

### 2. **Custom MCP Servers**
Add new MCP servers through the tool registration service:
```python
await self.tool_service.add_custom_mcp_server(server_config)
```

### 3. **Additional Endpoints**
Add new HTTP endpoints in the server:
```python
self.app.router.add_post("/custom", self.custom_handler)
```

## 📊 Performance Considerations

### 1. **Async Operations**
- All I/O operations are asynchronous
- Connection pooling for HTTP clients
- Efficient resource management

### 2. **Memory Management**
- Proper cleanup in finally blocks
- Context managers for resource handling
- Garbage collection friendly patterns

### 3. **Error Recovery**
- Graceful degradation on failures
- Retry mechanisms where appropriate
- Comprehensive error logging

## 🔧 Debugging Guide

### 1. **Enable Debug Logging**
```bash
export LOG_LEVEL=DEBUG
python agent.py
```

### 2. **Trace Network Calls**
```bash
export CONSOLE_TRACE_OUTPUT=true
python agent.py
```

### 3. **Test Authentication**
```python
from local_authentication_options import validate_auth_environment
validate_auth_environment()
```

This architecture provides a solid foundation for building production-ready AI agents with AgentFramework while maintaining flexibility for customization and extension.