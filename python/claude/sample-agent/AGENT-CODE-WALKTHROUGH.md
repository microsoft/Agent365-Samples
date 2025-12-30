# Agent Code Walkthrough

Step-by-step walkthrough of the complete agent implementation in `python/claude/sample-agent`.

## Overview

| Component | Purpose |
|-----------|---------|
| **Claude Agent SDK** | Core AI orchestration with extended thinking and built-in tools |
| **Microsoft 365 Agents SDK** | Enterprise hosting and authentication integration |
| **Agent Notifications** | Handle @mentions from Outlook, Word, and Teams |
| **Microsoft Agent 365 Observability** | Comprehensive tracing and monitoring |

## File Structure and Organization

The code is organized into well-defined sections with clear separators for developer readability.

**Key Files**:
- `agent.py` - Core Claude agent implementation
- `host_agent_server.py` - Generic agent host with notification support
- `start_with_generic_host.py` - Server startup script
- `agent_interface.py` - Abstract interface for agent implementations
- `local_authentication_options.py` - Authentication configuration
- `observability_helpers.py` - Telemetry and tracing utilities

---

## Step 1: Dependency Imports

```python
# Claude Agent SDK
from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    TextBlock,
    ThinkingBlock,
)

# Agent Interface
from agent_interface import AgentInterface

# Microsoft Agents SDK
from local_authentication_options import LocalAuthenticationOptions
from microsoft_agents.hosting.core import Authorization, TurnContext

# Notifications (optional)
try:
    from microsoft_agents_a365.notifications.agent_notification import NotificationTypes
    NOTIFICATIONS_AVAILABLE = True
except ImportError:
    NOTIFICATIONS_AVAILABLE = False

# Observability (optional)
try:
    from microsoft_agents_a365.observability.core import (
        InferenceScope,
        InvokeAgentDetails,
        InvokeAgentScope,
    )
    from microsoft_agents_a365.observability.core.middleware.baggage_builder import BaggageBuilder
    from observability_helpers import (
        create_agent_details,
        create_tenant_details,
        create_request_details,
        create_inference_details,
    )
    OBSERVABILITY_AVAILABLE = True
except ImportError:
    OBSERVABILITY_AVAILABLE = False
```

**What it does**: Brings in all the external libraries and tools the agent needs to work.

**Key Imports**:
- **Claude Agent SDK**: Client, message types, and configuration options for Claude AI
- **Microsoft 365 Agents**: Enterprise security and hosting features
- **Notifications**: Handle @mentions from Outlook, Word, and Teams (optional)
- **Observability**: Tracks what the agent is doing for monitoring and debugging (optional)

**Unique to Claude**: The SDK uses an async context manager pattern with `ClaudeSDKClient` and provides structured message types (`AssistantMessage`, `TextBlock`, `ThinkingBlock`) for handling responses.

---

## Step 2: Agent Initialization

```python
def __init__(self):
    """Initialize the Claude agent."""
    self.logger = logging.getLogger(self.__class__.__name__)

    # Initialize authentication options
    self.auth_options = LocalAuthenticationOptions.from_environment()

    # Create Claude client configuration
    self._create_client()

    # Claude client instance (will be set per conversation)
    self.client: ClaudeSDKClient | None = None
```

**What it does**: Creates the Claude agent and sets up its basic configuration.

**What happens**:
1. **Sets up Logging**: Creates a logger for the agent
2. **Loads Auth Config**: Gets authentication settings from environment
3. **Configures Claude**: Creates Claude client options
4. **Prepares Client**: Sets up placeholder for per-conversation client instances

**Key Design**: The agent creates a new client for each conversation to maintain proper isolation and state management.

---

## Step 3: Client Configuration

```python
def _create_client(self):
    """Create the Claude Agent SDK client options"""
    # Get model from environment or use default
    model = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-20250514")
    
    # Get API key
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise EnvironmentError("Missing ANTHROPIC_API_KEY. Please set it before running.")

    # Configure Claude options
    self.claude_options = ClaudeAgentOptions(
        model=model,
        # Enable extended thinking for detailed reasoning
        max_thinking_tokens=1024,
        # Allow web search and basic file operations
        allowed_tools=["WebSearch", "Read", "Write", "WebFetch"],
        # Auto-accept edits for smoother operation
        permission_mode="acceptEdits",
        continue_conversation=True
    )

    logger.info(f"✅ Claude Agent configured with model: {model}")
```

**What it does**: Configures the Claude Agent SDK with model settings and capabilities.

**Configuration Options**:
- `model`: Claude model to use (default: claude-sonnet-4-20250514)
- `max_thinking_tokens`: Tokens allocated for extended thinking (1024)
- `allowed_tools`: Built-in tools available to the agent
- `permission_mode`: Auto-accept file edits for smoother operation
- `continue_conversation`: Maintain conversation context across turns

**Available Tools**:
- **WebSearch**: Search the internet for information
- **Read**: Read files from the filesystem
- **Write**: Create and modify files
- **WebFetch**: Fetch content from web URLs

**Environment Variables**:
- `CLAUDE_MODEL`: Model version to use
- `ANTHROPIC_API_KEY`: Required API key for authentication

---

## Step 4: Message Processing with Observability

```python
async def process_user_message(
    self, message: str, auth: Authorization, context: TurnContext
) -> str:
    """Process user message using the Claude Agent SDK with observability tracing"""
    
    # Check if observability is enabled
    enable_observability = os.getenv("ENABLE_OBSERVABILITY", "false").lower() in ("true", "1", "yes")
    
    # Create observability objects if available and enabled
    invoke_scope = None
    baggage_context = None
    if OBSERVABILITY_AVAILABLE and enable_observability:
        try:
            agent_details = create_agent_details(context)
            tenant_details = create_tenant_details(context)
            
            # Get session ID from conversation
            session_id = context.activity.conversation.id if context and context.activity and context.activity.conversation else None
            
            # Create invoke details
            invoke_details = InvokeAgentDetails(
                details=agent_details,
                session_id=session_id,
            )
            request_details = create_request_details(message, session_id)
            
            # Extract tenant_id and agent_id from context
            tenant_id = None
            agent_id = None
            if context and context.activity and hasattr(context.activity, 'recipient'):
                tenant_id = getattr(context.activity.recipient, 'tenant_id', None)
                agent_id = getattr(context.activity.recipient, 'agentic_app_id', None)
            
            # Build and start baggage context
            baggage_context = BaggageBuilder().tenant_id(tenant_id).agent_id(agent_id).build()
            baggage_context.__enter__()
            
            invoke_scope = InvokeAgentScope.start(
                invoke_agent_details=invoke_details,
                tenant_details=tenant_details,
                request=request_details,
            )
            invoke_scope.__enter__()
            
        except Exception as e:
            logger.warning(f"Failed to start observability scope: {e}")
            invoke_scope = None
            baggage_context = None
```

**What it does**: Sets up comprehensive observability tracing for the agent invocation.

**What happens**:
1. **Checks Observability**: Determines if tracing is enabled via environment variable
2. **Creates Agent Details**: Extracts agent ID, conversation ID, and metadata
3. **Creates Tenant Details**: Extracts tenant information for multi-tenant scenarios
4. **Builds Baggage Context**: Sets up distributed tracing context with tenant/agent IDs
5. **Starts Invoke Scope**: Begins tracking the agent invocation lifecycle

**Key Components**:
- `InvokeAgentScope`: Tracks the entire agent invocation
- `BaggageBuilder`: Propagates tenant/agent IDs through distributed traces
- `create_agent_details()`: Helper that extracts agent metadata from context
- `create_tenant_details()`: Helper that extracts tenant metadata from context

**Environment Variable**:
- `ENABLE_OBSERVABILITY`: Set to "true", "1", or "yes" to enable tracing

---

## Step 5: Inference Processing with Token Tracking

```python
    try:
        logger.info(f"📨 Processing message: {message[:100]}...")

        # Track tokens for observability
        total_input_tokens = 0
        total_output_tokens = 0
        total_thinking_tokens = 0
        
        # Create inference scope if observability enabled
        inference_scope = None
        if OBSERVABILITY_AVAILABLE and enable_observability:
            try:
                inference_details = create_inference_details(
                    model=self.claude_options.model,
                    input_tokens=0,  # Will update after response
                    output_tokens=0,
                )
                
                inference_scope = InferenceScope.start(
                    details=inference_details,
                    agent_details=agent_details,
                    tenant_details=tenant_details,
                    request=request_details,
                )
                inference_scope.__enter__()
            except Exception as e:
                logger.warning(f"Failed to start inference scope: {e}")

        # Create a new client for this conversation
        async with ClaudeSDKClient(self.claude_options) as client:
            # Send the user message
            await client.query(message)

            # Collect the response
            response_parts = []
            thinking_parts = []
            
            # Receive and process messages
            async for msg in client.receive_response():
                if isinstance(msg, AssistantMessage):
                    for block in msg.content:
                        # Collect thinking (Claude's reasoning)
                        if isinstance(block, ThinkingBlock):
                            thinking_parts.append(f"💭 {block.thinking}")
                            total_thinking_tokens += len(block.thinking.split())
                            logger.info(f"💭 Claude thinking: {block.thinking[:100]}...")
                        
                        # Collect actual response text
                        elif isinstance(block, TextBlock):
                            response_parts.append(block.text)
                            total_output_tokens += len(block.text.split())
                            logger.info(f"💬 Claude response: {block.text[:100]}...")
```

**What it does**: Processes the message using Claude Agent SDK with async context management and token tracking.

**Key Pattern - Async Context Manager**:
```python
async with ClaudeSDKClient(self.claude_options) as client:
```
This creates a new client for each conversation, ensuring proper isolation and automatic cleanup.

**Message Flow**:
1. **Send Query**: `await client.query(message)` sends the user's message to Claude
2. **Receive Responses**: `async for msg in client.receive_response()` streams back responses
3. **Process Blocks**: Each message contains blocks (thinking or text)
4. **Track Tokens**: Approximates token counts for observability

**Message Types**:
- `AssistantMessage`: Container for Claude's response
- `ThinkingBlock`: Contains Claude's extended thinking/reasoning
- `TextBlock`: Contains the actual response text

**Unique to Claude**: Extended thinking blocks show Claude's reasoning process, providing transparency into how it arrives at answers and decides to use tools.

---

## Step 6: Response Formatting and Cleanup

```python
            # Track input tokens (approximate)
            total_input_tokens = len(message.split())

            # Combine thinking and response
            full_response = ""
            
            # Add thinking if present (for transparency)
            if thinking_parts:
                full_response += "**Claude's Thinking:**\n"
                full_response += "\n".join(thinking_parts)
                full_response += "\n\n**Response:**\n"
            
            # Add the actual response
            if response_parts:
                full_response += "".join(response_parts)
            else:
                full_response += "I couldn't process your request at this time."

            # Close inference scope with token counts
            if inference_scope:
                try:
                    logger.info(f"📊 Tokens - Input: {total_input_tokens}, Output: {total_output_tokens}, Thinking: {total_thinking_tokens}")
                    inference_scope.__exit__(None, None, None)
                except Exception as e:
                    logger.warning(f"Failed to close inference scope: {e}")

            # Close invoke scope successfully
            if invoke_scope:
                try:
                    invoke_scope.__exit__(None, None, None)
                    if baggage_context is not None:
                        baggage_context.__exit__(None, None, None)
                except Exception as e:
                    logger.warning(f"Failed to close invoke scope: {e}")

            return full_response

    except Exception as e:
        logger.error(f"Error processing message: {e}")
        
        # Record error in scopes
        if invoke_scope:
            try:
                invoke_scope.record_error(e)
                invoke_scope.__exit__(type(e), e, e.__traceback__)
                if baggage_context is not None:
                    baggage_context.__exit__(None, None, None)
            except Exception as cleanup_error:
                logger.warning(f"Failed to clean up after error: {cleanup_error}")
        
        return f"Sorry, I encountered an error: {str(e)}"
```

**What it does**: Formats the final response and ensures proper cleanup of observability resources.

**Response Formatting**:
1. **Combines Thinking**: If extended thinking is present, shows it first with a header
2. **Adds Response**: Appends the actual response text
3. **Fallback Message**: Provides friendly error message if no response generated

**Observability Cleanup**:
- Logs token counts (input, output, thinking) for metrics
- Closes inference scope to complete tracing span
- Closes invoke scope and baggage context
- Records errors in traces if exceptions occur

**Error Handling**:
- Catches all exceptions to prevent crashes
- Records errors in observability spans for debugging
- Ensures all scopes are properly closed even on failure
- Returns user-friendly error messages

---

## Step 7: Notification Handling

```python
async def handle_agent_notification_activity(
    self, notification_activity, auth: Authorization, context: TurnContext
) -> str:
    """Handle agent notification activities (email, Word mentions, etc.)"""
    if not NOTIFICATIONS_AVAILABLE:
        return "Notification handling is not available in this configuration."
    
    try:
        notification_type = notification_activity.notification_type
        logger.info(f"📬 Processing notification: {notification_type}")

        # Handle Email Notifications
        if notification_type == NotificationTypes.EMAIL_NOTIFICATION:
            if not hasattr(notification_activity, "email") or not notification_activity.email:
                return "I could not find the email notification details."
            
            email = notification_activity.email
            email_body = getattr(email, "html_body", "") or getattr(email, "body", "")
            
            message = f"You have received the following email. Please follow any instructions in it.\n\n{email_body}"
            logger.info(f"📧 Processing email notification")
            
            response = await self.process_user_message(message, auth, context)
            return response or "Email notification processed."

        # Handle Word Comment Notifications
        elif notification_type == NotificationTypes.WPX_COMMENT:
            if not hasattr(notification_activity, "wpx_comment") or not notification_activity.wpx_comment:
                return "I could not find the Word notification details."
            
            wpx = notification_activity.wpx_comment
            doc_id = getattr(wpx, "document_id", "")
            comment_text = notification_activity.text or ""
            
            message = (
                f"You have been mentioned in a Word document comment.\n"
                f"Document ID: {doc_id}\n"
                f"Comment: {comment_text}\n\n"
                f"Please respond to this comment appropriately."
            )
            
            response = await self.process_user_message(message, auth, context)
            return response or "Word notification processed."

        # Generic notification handling
        else:
            notification_message = (
                getattr(notification_activity.activity, 'text', None) or 
                str(getattr(notification_activity.activity, 'value', None)) or 
                f"Notification received: {notification_type}"
            )
            
            response = await self.process_user_message(notification_message, auth, context)
            return response or "Notification processed successfully."
            
    except Exception as e:
        logger.error(f"Error processing notification: {e}")
        return f"Sorry, I encountered an error processing the notification: {str(e)}"
```

**What it does**: Handles @mentions from various Microsoft 365 applications.

**Notification Types**:
- **EMAIL_NOTIFICATION**: User @mentioned agent in Outlook
- **WPX_COMMENT**: User @mentioned agent in Word comment
- **Generic**: Other notification types (Teams messages, etc.)

**What happens**:
1. **Checks Availability**: Verifies notification packages are installed
2. **Identifies Type**: Determines what kind of notification it is
3. **Extracts Context**: Gets relevant information (email body, comment text, etc.)
4. **Formats Message**: Creates a clear prompt for Claude
5. **Processes with AI**: Uses Claude to generate intelligent response
6. **Returns Result**: Sends response back to user

**Key Feature**: The agent intelligently responds to notifications by processing the context through Claude's extended thinking, enabling contextual and helpful responses.

---

## Step 8: Agent Cleanup

```python
async def cleanup(self) -> None:
    """Clean up agent resources"""
    try:
        logger.info("Cleaning up agent resources...")
        
        # Claude SDK client cleanup is handled by context manager
        # No additional cleanup needed
        
        logger.info("Agent cleanup completed")

    except Exception as e:
        logger.error(f"Error during cleanup: {e}")
```

**What it does**: Properly cleans up agent resources when shutting down.

**What happens**:
- Logs cleanup start and completion
- Claude SDK handles client cleanup automatically via async context manager
- No manual resource management needed
- Errors are logged but don't crash

**Unique to Claude**: The async context manager pattern (`async with ClaudeSDKClient`) handles all cleanup automatically, making resource management simple and reliable.

---

## Step 9: Main Entry Point for Testing

```python
async def main():
    """Main function to run the Claude Agent"""
    try:
        # Create and initialize the agent
        agent = ClaudeAgent()
        await agent.initialize()

        # Test the agent with a simple message
        logger.info("\n" + "=" * 80)
        logger.info("Testing Claude Agent")
        logger.info("=" * 80 + "\n")

        # Dummy auth and context for standalone testing
        class DummyAuth:
            async def exchange_token(self, context, scopes, handler_id):
                return type('obj', (object,), {'token': 'dummy-token'})()

        class DummyContext:
            pass

        response = await agent.process_user_message(
            "What is the capital of France?",
            DummyAuth(),
            DummyContext()
        )

        logger.info("\n" + "=" * 80)
        logger.info("Response:")
        logger.info("=" * 80)
        logger.info(response)
        logger.info("=" * 80 + "\n")

    except Exception as e:
        logger.error(f"Failed to start agent: {e}")

    finally:
        # Cleanup
        if "agent" in locals():
            await agent.cleanup()

if __name__ == "__main__":
    asyncio.run(main())
```

**What it does**: Provides a standalone test entry point for the agent.

**What happens**:
1. **Creates Agent**: Instantiates the ClaudeAgent class
2. **Initializes**: Calls the initialize method
3. **Creates Test Fixtures**: Creates dummy auth and context objects
4. **Tests Message**: Sends a simple test message to verify functionality
5. **Displays Response**: Logs the response with clear formatting
6. **Ensures Cleanup**: Always cleans up resources in finally block

**Why it's useful**: Allows quick testing of the agent without starting the full server, useful for development and debugging.

---

## Step 10: Observability Helper Functions

The `observability_helpers.py` file provides utility functions for creating observability objects:

```python
def create_agent_details(context: Optional[TurnContext] = None) -> AgentDetails:
    """Create agent details for observability"""
    agent_id = environ.get("AGENT_ID", "claude-agent")
    conversation_id = None
    
    if context and context.activity:
        if hasattr(context.activity, "recipient"):
            agent_id = context.activity.recipient.agentic_app_id or agent_id
        if context.activity.conversation:
            conversation_id = context.activity.conversation.id
    
    return AgentDetails(
        agent_id=agent_id,
        conversation_id=conversation_id,
        agent_name=environ.get("OBSERVABILITY_SERVICE_NAME", "Claude Agent"),
        agent_description="AI agent powered by Anthropic Claude Agent SDK with extended thinking",
    )

def create_inference_details(
    model: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    thinking_tokens: int = 0,
    finish_reasons: Optional[list[str]] = None,
    response_id: Optional[str] = None
) -> InferenceCallDetails:
    """Create inference call details for observability"""
    return InferenceCallDetails(
        operationName=InferenceOperationType.CHAT,
        model=model,
        providerName="anthropic-claude",
        inputTokens=input_tokens,
        outputTokens=output_tokens + thinking_tokens,  # Total includes thinking
        finishReasons=finish_reasons or ["end_turn"],
        responseId=response_id,
    )
```

**What it does**: Provides reusable functions for creating observability objects.

**Helper Functions**:
- `create_agent_details()`: Extracts agent metadata from context
- `create_tenant_details()`: Extracts tenant information for multi-tenancy
- `create_request_details()`: Creates request tracking objects
- `create_inference_details()`: Creates inference call tracking with token counts
- `create_tool_call_details()`: Creates tool execution tracking

**Key Features**:
- Safely extracts data with fallbacks
- Handles missing context gracefully
- Includes Claude-specific fields (thinking_tokens)
- Provides sensible defaults

---

## Architecture Patterns

### 1. **Async Context Manager Pattern**
```python
async with ClaudeSDKClient(self.claude_options) as client:
    await client.query(message)
    async for msg in client.receive_response():
        # Process streaming response
```

**Why**: Ensures proper resource cleanup and connection management automatically.

### 2. **Optional Dependencies**
```python
try:
    from microsoft_agents_a365.notifications.agent_notification import NotificationTypes
    NOTIFICATIONS_AVAILABLE = True
except ImportError:
    NOTIFICATIONS_AVAILABLE = False
```

**Why**: Allows the agent to work without optional packages, improving flexibility and reducing dependencies.

### 3. **Separation of Concerns**
```
agent.py                 -> AI logic and Claude integration
host_agent_server.py     -> HTTP hosting and routing
agent_interface.py       -> Abstract contract
observability_helpers.py -> Telemetry utilities
```

**Why**: Clean architecture makes the code maintainable and testable.

### 4. **Structured Observability**
```python
# Invoke scope for entire agent invocation
with InvokeAgentScope.start(...):
    # Inference scope for specific AI call
    with InferenceScope.start(...):
        # Process with Claude
```

**Why**: Provides hierarchical tracing with proper context propagation.

### 5. **Error Resilience**
```python
try:
    response = await self.process_user_message(...)
except Exception as e:
    # Record error in traces
    if invoke_scope:
        invoke_scope.record_error(e)
    return f"Sorry, I encountered an error: {str(e)}"
```

**Why**: Always returns helpful errors to users instead of crashing, while tracking failures for debugging.

---

## Key Differences from Other Samples

### vs. AgentFramework Sample
- ✅ **Built-in Tools**: Claude includes WebSearch, Read, Write, WebFetch without MCP setup
- ✅ **Extended Thinking**: See Claude's reasoning process transparently
- ✅ **Simpler Configuration**: Just API key and model selection needed
- ✅ **Async Context Manager**: Cleaner resource management pattern
- ❌ **No Custom MCP Servers**: Can't add Mail, Calendar, SharePoint tools (yet)

### vs. OpenAI Sample  
- ✅ **Built-in Tools**: No tool registration or function schemas needed
- ✅ **Extended Thinking**: Unique transparency into AI reasoning
- ✅ **Notification Support**: Full Outlook/Word/@mention handling
- ✅ **Streaming Responses**: Process thinking and text as it arrives
- ❌ **No MCP Extensibility**: Can't add custom tools (yet)
- ❌ **Manual Observability**: No auto-instrumentation yet

### Unique Advantages
1. **Simplicity**: Fewer dependencies, easier setup, no MCP server configuration
2. **Transparency**: Extended thinking shows reasoning process
3. **Built-in Tools**: Powerful capabilities out of the box (WebSearch, Read, Write, WebFetch)
4. **Notifications**: Full support for Microsoft 365 integrations
5. **Resource Safety**: Async context managers ensure proper cleanup

### Current Limitations
1. **No MCP Support**: Can't add custom tools like Mail, Calendar, SharePoint
2. **Manual Observability**: Requires helper functions until auto-instrumentation arrives
3. **Token Approximation**: Token counts are word-based estimates, not actual tokens

---

## Environment Variables Reference

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ANTHROPIC_API_KEY` | ✅ Yes | - | Authentication for Claude API |
| `CLAUDE_MODEL` | No | claude-sonnet-4-20250514 | Claude model version to use |
| `ENABLE_OBSERVABILITY` | No | false | Enable/disable observability tracing |
| `OBSERVABILITY_SERVICE_NAME` | No | claude-agent | Service name for telemetry |
| `OBSERVABILITY_SERVICE_NAMESPACE` | No | agent365-samples | Service namespace for telemetry |
| `AGENT_ID` | No | claude-agent | Agent identifier for observability |
| `TENANT_ID` | No | default-tenant | Tenant identifier for multi-tenancy |
| `PORT` | No | 3978 | Server port |
| `LOG_LEVEL` | No | INFO | Logging level (DEBUG, INFO, WARNING, ERROR) |

---

## Testing Checklist

- [ ] Anthropic API key set in `.env` file
- [ ] Dependencies installed (`uv pip install -e .` or `pip install -e .`)
- [ ] Server starts without errors (`python start_with_generic_host.py`)
- [ ] Can send messages and get responses
- [ ] Extended thinking appears in responses
- [ ] Built-in tools work (WebSearch, Read, Write, WebFetch)
- [ ] Notifications route correctly (if enabled)
- [ ] Observability traces appear (if enabled)
- [ ] Error handling works gracefully

---

## Debugging Guide

### 1. Enable Debug Logging
```bash
export LOG_LEVEL=DEBUG
python start_with_generic_host.py
```

### 2. Test Agent Standalone
```bash
python agent.py
```
This runs the agent without the server to isolate issues.

### 3. Check API Key
```bash
python -c "import os; from dotenv import load_dotenv; load_dotenv(); print('API Key:', 'SET' if os.getenv('ANTHROPIC_API_KEY') else 'MISSING')"
```

### 4. Verify Observability
Check logs for:
```
✅ Observability scope started
📊 Tokens - Input: X, Output: Y, Thinking: Z
```

### 5. Test Notifications
Check logs for notification routing:
```
📬 Processing notification: EMAIL_NOTIFICATION
📧 Processing email notification
```

### 6. Common Issues

**Issue**: "Missing ANTHROPIC_API_KEY"
- **Solution**: Add `ANTHROPIC_API_KEY=your-key-here` to `.env` file

**Issue**: No extended thinking in responses
- **Solution**: Verify `max_thinking_tokens=1024` in `claude_options`

**Issue**: Tools not working
- **Solution**: Check `allowed_tools` list in `claude_options`

**Issue**: Observability not working
- **Solution**: Set `ENABLE_OBSERVABILITY=true` and verify packages installed

---

This architecture provides a solid foundation for building production-ready AI agents with Claude Agent SDK, emphasizing simplicity, transparency, and proper resource management while integrating seamlessly with Microsoft 365 Agents SDK for enterprise features.

3. Testing works without production credentials

**Implementation Detail**: This dual registration was necessary because the Agents Playground sends notifications with `channel="msteams"` while production uses `channel="agents"`.

---

This architecture provides a solid foundation for building production-ready AI agents with Claude Agent SDK, emphasizing simplicity, transparency, and proper resource management while integrating seamlessly with Microsoft 365 Agents SDK for enterprise features.


This architecture provides a solid foundation for building production-ready AI agents with Claude Agent SDK, emphasizing simplicity, transparency, and proper resource management while integrating seamlessly with Microsoft 365 Agents SDK for enterprise features.

    return f"Sorry, I encountered an error: {str(e)}"
```

Always return helpful errors to users instead of crashing.

---

## Package Patches Required

The Microsoft Agent 365 notification package has bugs requiring 3 patches:

### 1. `__init__.py` - Fixed Imports
```python
# Fixed: Removed broken agents_sdk_extensions import
from .agent_notification import AgentNotification
from .models.agent_notification_activity import AgentNotificationActivity, NotificationTypes
```

### 2. `agent_notification.py` - Fixed NoneType Handling
```python
# Fixed: Default to "agents" channel when channel_id is None
received_channel = (ch.channel if ch and ch.channel else "agents").lower()
received_subchannel = (ch.sub_channel if ch and ch.sub_channel else "").lower()
```

### 3. `agent_notification_activity.py` - Fixed None Activity Name
```python
# Fixed: Check for None before creating NotificationTypes enum
if self._notification_type is None and self.activity.name is not None:
    try:
        self._notification_type = NotificationTypes(self.activity.name)
    except ValueError:
        self._notification_type = None
```

**Note**: These patches are automatically applied when you run the agent for the first time and encounter notification errors.

---

## Key Differences from Other Samples

### vs. AgentFramework Sample
- ✅ **No MCP Setup**: Claude has built-in tools (Read, Write, WebSearch, Bash, Grep)
- ✅ **Extended Thinking**: See Claude's reasoning process
- ✅ **Simpler Configuration**: Just API key needed
- ❌ **No Custom MCP Servers**: Can't add Mail, Calendar, SharePoint tools (yet)

### vs. OpenAI Sample  
- ✅ **Built-in Tools**: No tool registration needed
- ✅ **Extended Thinking**: Transparency into AI reasoning
- ✅ **Notification Support**: Full Outlook/Word/@mention handling (OpenAI sample lacks this)
- ❌ **No MCP Extensibility**: Can't add custom tools (yet)

### Unique Advantages
1. **Simplicity**: Fewer dependencies, easier setup
2. **Transparency**: Extended thinking shows reasoning
3. **Built-in Tools**: Powerful capabilities out of the box
4. **Notifications**: Full support for Microsoft 365 integrations

### Current Limitations
1. **No MCP Support**: Can't add Mail, Calendar, SharePoint tools
2. **No Auto-instrumentation**: Manual telemetry required
3. **Package Bugs**: Requires 3 patches to notification package

---

## Debugging Guide

### 1. Enable Debug Logging
```bash
export LOG_LEVEL=DEBUG
python start_with_generic_host.py
```

### 2. Test Notification Routing
```python
# Check debug logs for channel matching
INFO:agent_notification:🔍 Route selector check:
INFO:agent_notification:   Received channel: 'msteams' vs Registered: 'msteams'
INFO:agent_notification:   ✅ Channel match!
```

### 3. Verify Claude Authentication
```bash
claude login
# Test with a simple query
python -c "from anthropic_ai.claude_agent_sdk import query; print(list(query('hello')))"
```

### 4. Check Environment Variables
```python
python -c "import os; print('API Key:', 'SET' if os.getenv('ANTHROPIC_API_KEY') else 'MISSING')"
```

---

## Testing Checklist

- [ ] Claude CLI authenticated (`claude login`)
- [ ] API key set in `.env`
- [ ] Dependencies installed (`uv pip install -e .`)
- [ ] Server starts without errors
- [ ] Can send messages and get responses
- [ ] Extended thinking appears in responses
- [ ] Notifications route correctly (both channels)
- [ ] Observability traces appear in console
- [ ] Tools work (Read, Write, WebSearch, etc.)

---

This architecture provides a solid foundation for building production-ready AI agents with Claude Agent SDK while maintaining flexibility for future enhancements like MCP support.
