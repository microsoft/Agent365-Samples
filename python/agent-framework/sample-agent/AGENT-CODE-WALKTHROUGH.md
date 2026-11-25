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
# Observability is initialized by the Microsoft OpenTelemetry distro in
# host_agent_server.py via use_microsoft_opentelemetry().
# See: https://github.com/microsoft/opentelemetry-distro-python

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

    # Initialize authentication options
    self.auth_options = LocalAuthenticationOptions.from_environment()

    # Create Azure OpenAI chat client
    self._create_chat_client()
```

**What it does**: Sets up what every turn shares: the logger, authentication settings and the Azure OpenAI client. The agent itself, with its MCP tools, is created for each turn (see Step 4).

**What happens**:
1. **Gets Authentication**: Loads security settings from environment variables
2. **Creates AI Client**: Makes a connection to Azure OpenAI's servers

Observability is set up by the host (`host_agent_server.py`), not by the agent.

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

## Step 4: Per-Turn Agent and Instructions

```python
@classmethod
def _get_instructions(cls, context: TurnContext) -> str:
    """Return the agent prompt with the name of the user who sent this activity."""
    from_prop = context.activity.from_property
    user_name = getattr(from_prop, "name", None) or "unknown"
    return cls.AGENT_PROMPT.replace("{user_name}", user_name)
```

**What it does**: Builds the instructions for one turn. There's no shared agent: every message and notification gets a new `ChatAgent` from `setup_mcp_servers` (Step 6), created with these instructions and that turn's MCP tools.

**What happens**:
1. **Reads the Sender**: Takes the display name of the user who sent the message or notification
2. **Personalizes the Prompt**: Fills the `{user_name}` placeholder in `AGENT_PROMPT`

**Settings**:
- Instructions define how the agent behaves
- Messages and notifications use the same helper, so the prompt never contains a literal `{user_name}`

---

## Step 5: Observability Configuration

The host initializes the Microsoft OpenTelemetry distro before creating the agent:

```python
from microsoft.opentelemetry import use_microsoft_opentelemetry
from observability_token_service import create_observability_token_resolver

use_microsoft_opentelemetry(
    enable_a365=True,
    enable_azure_monitor=False,
    a365_use_s2s_endpoint=True,
    a365_token_resolver=create_observability_token_resolver(),
)
```

OBS uses `/observabilityService` for AI Teammate and OBO turns alike. The dedicated
resolver validates the four `AGENT365_OBS_*` settings in the README and acquires an
app-only token through the two-step FMI flow, using the actual agent instance client
ID (not the blueprint). Permissionless S2S export is conditional on eligible agent
registration for the exact agent instance, not merely Entra identity creation or
selecting the S2S endpoint. The resolver checks tenant/agent identity, accepts
absent/empty `roles` only with `idtyp=app` or with absent `idtyp` and `oid` equal to `sub`,
and also supports valid nonempty roles on legacy app tokens without `idtyp`. It rejects any `scp` claim and refreshes from real token expiry.
Failures never return stale/empty tokens or fall back to `/observability`.
MCP/Graph/OBO authentication and original caller/agent baggage remain unchanged;
workload permissions remain independent.

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
async def setup_mcp_servers(self, tool_service: McpToolRegistrationService, auth: Authorization, auth_handler_name: str, context: TurnContext, instructions: str):
    """Return an agent with MCP servers authenticated as the current turn's caller."""
    try:
        use_agentic_auth = os.getenv("USE_AGENTIC_AUTH", "false").lower() == "true"

        if use_agentic_auth:
            agent = await tool_service.add_tool_servers_to_agent(
                chat_client=self.chat_client,
                agent_instructions=instructions,
                initial_tools=[],
                auth=auth,
                auth_handler_name=auth_handler_name,
                turn_context=context,
            )
        else:
            agent = await tool_service.add_tool_servers_to_agent(
                chat_client=self.chat_client,
                agent_instructions=instructions,
                initial_tools=[],
                auth=auth,
                auth_handler_name=auth_handler_name,
                auth_token=self.auth_options.bearer_token,
                turn_context=context,
            )

        logger.info("✅ MCP setup completed")
        return agent

    except Exception as e:
        logger.error(f"❌ Error setting up MCP servers: {e}")
        if self.should_skip_tooling_on_errors():
            # Continue without MCP tools, never with another turn's agent
            return ChatAgent(chat_client=self.chat_client, instructions=instructions, tools=[])
        raise
```

**What it does**: Connects your agent to external tools (like mail, calendar, notifications) that it can use to help users.

The agent supports multiple authentication modes and extensive configuration options:

**Environment Variables**:
- `USE_AGENTIC_AUTH`: Choose between enterprise security (true) or simple tokens (false)
- `ENV_ID`: Agent365 environment identifier
- `BEARER_TOKEN`: Authentication token for MCP servers

**Authentication Modes**:
- **Agentic Authentication**: Enterprise-grade security with Azure AD (for production)
- **Bearer Token Authentication**: Simple token-based security (for development and testing)

**What happens**:
1. Uses the per-turn tool service passed in by the caller
2. Sets up security and authentication for the user who sent this message
3. Finds available tools and connects them using that user's token
4. Returns a new agent with the tools attached, used only for this turn

**If setup fails**: the error is raised, so the turn fails and the user gets an error message instead of an agent that silently has no tools. To continue without MCP tools while developing locally, set `ENVIRONMENT=Development` and `SKIP_TOOLING_ON_ERRORS=true`. The OpenAI sample behaves the same way.

> **Important:** MCP tools carry the token of the user who sent the message. Set them up for every message and notification, and never store the returned agent on `self` or reuse it for another message: one agent instance serves every user.

---

## Step 7: Message Processing

```python
async def process_user_message(
    self, message: str, auth: Authorization, auth_handler_name: str, context: TurnContext
) -> str:
    """Process user message using the AgentFramework SDK"""
    # MCP servers carry this caller's token, so they are created and closed per turn
    tool_service = McpToolRegistrationService()
    try:
        turn_agent = await self.setup_mcp_servers(tool_service, auth, auth_handler_name, context, self._get_instructions(context))
        result = await turn_agent.run(message)
        return self._extract_result(result) or "I couldn't process your request at this time."
    except Exception as e:
        logger.error(f"Error processing message: {e}")
        return f"Sorry, I encountered an error: {str(e)}"
    finally:
        await tool_service.cleanup()
```

**What it does**: Handles regular chat messages from users.

**What happens**:
1. **Setup Tools**: Connects MCP tools for this message, authenticated as the user who sent it
2. **Run Agent**: Sends the message to the AI agent for processing
3. **Extract Response**: Pulls out the text response from the agent's result
4. **Error Handling**: Catches problems and returns friendly error messages
5. **Close Tools**: Closes this message's MCP connections

---

## Step 8: Notification Handling

```python
async def handle_agent_notification_activity(
    self, notification_activity, auth: Authorization, auth_handler_name: str, context: TurnContext
) -> str:
    """Handle agent notification activities (email, Word mentions, etc.)"""
    # MCP servers carry this caller's token, so they are created and closed per notification
    tool_service = McpToolRegistrationService()
    try:
        notification_type = notification_activity.notification_type
        logger.info(f"📬 Processing notification: {notification_type}")

        turn_agent = await self.setup_mcp_servers(tool_service, auth, auth_handler_name, context, self._get_instructions(context))

        # Handle Email Notifications
        if notification_type == NotificationTypes.EMAIL_NOTIFICATION:
            if not hasattr(notification_activity, "email") or not notification_activity.email:
                return "I could not find the email notification details."

            email = notification_activity.email
            email_body = getattr(email, "html_body", "") or getattr(email, "body", "")
            message = _build_email_reply_prompt(email_body)

            result = await turn_agent.run(message)
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
            doc_result = await turn_agent.run(doc_message)
            word_content = self._extract_result(doc_result)

            # Process the comment with document context
            comment_text = notification_activity.text or ""
            response_message = f"You have received the following Word document content and comments. Please refer to these when responding to comment '{comment_text}'. {word_content}"
            result = await turn_agent.run(response_message)
            return self._extract_result(result) or "Word notification processed."

        # Generic notification handling
        else:
            notification_message = notification_activity.text or f"Notification received: {notification_type}"
            result = await turn_agent.run(notification_message)
            return self._extract_result(result) or "Notification processed successfully."

    except Exception as e:
        logger.error(f"Error processing notification: {e}")
        return f"Sorry, I encountered an error processing the notification: {str(e)}"

    finally:
        await tool_service.cleanup()
```

**What it does**: Handles notifications from Microsoft 365 apps like Outlook and Word.

**What happens**:
1. **Setup Tools**: Connects MCP tools for this notification, authenticated as its caller
2. **Identify Type**: Checks what kind of notification it is (email, Word comment, etc.)
3. **Email Notifications**: Wraps the email body as untrusted data with `_build_email_reply_prompt` and asks the agent to write a reply, so instructions inside an email are never followed (prompt-injection protection)
4. **Word Comments**: Retrieves document content, then processes the comment with context
5. **Generic Handling**: Falls back to simple text processing for other notification types

**Supported Notification Types**:
- `NotificationTypes.EMAIL_NOTIFICATION`: @mentions in Outlook emails
- `NotificationTypes.WPX_COMMENT`: @mentions in Word/Excel comments
- Other notification types handled generically

**Why MCP Setup Runs Every Time**: Notifications need access to tools (like Microsoft Graph to read documents) just like regular messages. MCP tools carry the caller's token, so setup runs for every message and notification, and tools set up for an earlier turn are never reused.

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
    self, message: str, auth: Authorization, auth_handler_name: str, context: TurnContext
) -> str:
    """Process user message using the AgentFramework SDK"""
    # MCP servers carry this caller's token, so they are created and closed per turn
    tool_service = McpToolRegistrationService()
    try:
        # Setup MCP servers for this turn's caller
        turn_agent = await self.setup_mcp_servers(tool_service, auth, auth_handler_name, context, self._get_instructions(context))

        # Run the agent with the user message
        result = await turn_agent.run(message)

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

    finally:
        await tool_service.cleanup()
```

**What it does**: This is the main function that handles user conversations - when someone sends a message, this processes it and sends back a response.

**What happens**:
1. **Connect Tools**: Connects the external tools for this turn, authenticated as the user who sent the message
2. **Run AI**: Sends the user's message to the AI model and gets a response
3. **Extract Answer**: Pulls out the text response from the AI's reply
4. **Handle Problems**: If something goes wrong, it gives a helpful error message instead of crashing

**Why it's important**: This is the "brain" of the agent - it's what actually makes conversations happen!

---

## Step 8: Cleanup and Resource Management

```python
async def cleanup(self) -> None:
    """Clean up agent resources. MCP connections are closed at the end of each turn."""
    logger.info("Agent cleanup completed")
```

**What it does**: Properly shuts down the agent when it's done working.

**What happens**:
- MCP tool connections are already closed at the end of each message (`tool_service.cleanup()` in `finally`)
- Makes sure no resources are left hanging around

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
MCP servers aren't added in code. `setup_mcp_servers` connects the servers configured for the agent on every turn: in development, the ones listed in `ToolingManifest.json` in this folder (add servers with `a365 develop add-mcp-servers`), and in production, the ones configured for the agent in Agent 365. No code change is needed when you add a server.

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