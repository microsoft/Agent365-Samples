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
from anthropic_ai.claude_agent_sdk import query

# Agent Interface
from agent_interface import AgentInterface

# Microsoft Agents SDK
from local_authentication_options import LocalAuthenticationOptions
from microsoft_agents.hosting.core import Authorization, TurnContext

# Notifications
from microsoft_agents_a365.notifications.agent_notification import (
    AgentNotificationActivity,
    NotificationTypes,
)

# Observability
from microsoft_agents_a365.observability.core.config import configure
from observability_helpers import create_agent_span, create_chat_span
```

**What it does**: Brings in all the external libraries and tools the agent needs to work.

**Key Imports**:
- **Claude Agent SDK**: Tools to interact with Claude AI with extended thinking
- **Microsoft 365 Agents**: Enterprise security and hosting features
- **Notifications**: Handle @mentions from Outlook, Word, and Teams
- **Observability**: Tracks what the agent is doing for monitoring and debugging

**Unique to Claude**: The `query` function from Claude Agent SDK provides a simple, powerful interface with built-in tools (Read, Write, WebSearch, Bash, Grep) - no additional MCP setup needed!

---

## Step 2: Agent Initialization

```python
def __init__(self, anthropic_api_key: str | None = None):
    """Initialize the Claude Agent."""
    self.logger = logging.getLogger(self.__class__.__name__)
    
    # Get API key
    self.anthropic_api_key = anthropic_api_key or os.getenv("ANTHROPIC_API_KEY")
    if not self.anthropic_api_key:
        raise ValueError("ANTHROPIC_API_KEY environment variable is required")
    
    # Set API key for Claude SDK
    os.environ["ANTHROPIC_API_KEY"] = self.anthropic_api_key
    
    # Configure Claude model
    self.model = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-20250514")
    
    # Setup observability
    self._setup_observability()
    
    # Initialize authentication options
    self.auth_options = LocalAuthenticationOptions.from_environment()
    
    self.logger.info(f"✅ Claude Agent configured with model: {self.model}")
```

**What it does**: Creates the Claude agent and sets up its basic behavior.

**What happens**:
1. **Gets API Key**: Retrieves the Anthropic API key from environment
2. **Configures Model**: Sets the Claude model (default: claude-sonnet-4-20250514)
3. **Sets up Monitoring**: Turns on tracking so we can see what the agent does
4. **Loads Auth Config**: Gets authentication settings from environment

**Settings**:
- Uses Claude Sonnet 4 by default (extended thinking model)
- API key must be set in environment or passed to constructor

**Unique to Claude**: Unlike OpenAI/AgentFramework, Claude doesn't need an explicit client object - the SDK handles this automatically through the API key.

---

## Step 3: Observability Configuration

```python
def _setup_observability(self):
    """Configure Microsoft Agent 365 observability"""
    try:
        status = configure(
            service_name=os.getenv("OBSERVABILITY_SERVICE_NAME", "claude-agent"),
            service_namespace=os.getenv("OBSERVABILITY_SERVICE_NAMESPACE", "agents.samples"),
            token_resolver=self.token_resolver,
        )
        
        if not status:
            self.logger.warning("⚠️ Observability configuration failed")
            return
        
        self.logger.info("✅ Observability configured")
        
    except Exception as e:
        self.logger.error(f"❌ Error setting up observability: {e}")

def token_resolver(self, agent_id: str, tenant_id: str) -> str | None:
    """Token resolver for secure Agent 365 Observability exporter"""
    try:
        from token_cache import get_cached_agentic_token
        cached_token = get_cached_agentic_token(tenant_id, agent_id)
        if cached_token:
            return cached_token
        return None
    except Exception as e:
        self.logger.error(f"Token resolver error: {e}")
        return None
```

**What it does**: Turns on detailed logging and monitoring so you can see what your agent is doing.

**What happens**:
1. Sets up tracking with a service name (like giving your agent an ID badge)
2. Configures token resolver for secure telemetry export
3. Enables console output for development debugging

**Environment Variables**:
- `OBSERVABILITY_SERVICE_NAME`: What to call your agent in logs (default: "claude-agent")
- `OBSERVABILITY_SERVICE_NAMESPACE`: Which group it belongs to (default: "agents.samples")
- `ENABLE_OBSERVABILITY`: Set to "true" to enable (default: true)

**Note**: Claude Agent SDK doesn't yet have auto-instrumentation like OpenAI/Semantic Kernel, so we use manual telemetry with helper functions.

---

## Step 4: Message Processing with Extended Thinking

```python
async def process_user_message(
    self, message: str, auth: Authorization, context: TurnContext
) -> str:
    """Process user message using Claude Agent SDK"""
    try:
        self.logger.info(f"📨 Processing message: {message[:50]}...")
        
        # Create observability span
        with create_chat_span(
            model=self.model,
            input_message=message,
            conversation_id=context.activity.conversation.id,
        ):
            # Clean environment for Claude
            clean_env = {**os.environ}
            delete clean_env.NODE_OPTIONS
            delete clean_env.VSCODE_INSPECTOR_OPTIONS
            
            # Configure Claude options
            claude_options = {
                "appendSystemPrompt": self._get_system_prompt(),
                "maxTurns": 5,
                "allowedTools": ["Read", "Write", "WebSearch", "Bash", "Grep"],
                "env": clean_env,
            }
            
            # Query Claude with streaming
            thinking = ""
            response = ""
            
            for message_chunk in query(prompt=message, options=claude_options):
                if message_chunk.type == "thinking":
                    thinking += message_chunk.thinking
                elif message_chunk.type == "result":
                    response = message_chunk.result
                    break
            
            # Log thinking and response
            if thinking:
                self.logger.info(f"💭 Claude thinking: {thinking[:200]}...")
            
            self.logger.info(f"💬 Claude response: {response[:200]}...")
            
            # Format response with thinking
            formatted_response = self._format_response(thinking, response)
            return formatted_response
            
    except Exception as e:
        self.logger.error(f"Error processing message: {e}")
        return f"Sorry, I encountered an error: {str(e)}"
```

**What it does**: This is the main function that handles user conversations using Claude's extended thinking.

**What happens**:
1. **Creates Tracking**: Wraps the conversation in an observability span
2. **Cleans Environment**: Removes debug variables that interfere with Claude
3. **Configures Options**: Sets system prompt, max turns, and allowed tools
4. **Streams Response**: Gets thinking process and final answer from Claude
5. **Formats Output**: Combines thinking and response for visibility

**Claude Options**:
- `appendSystemPrompt`: Custom instructions for the agent
- `maxTurns`: Maximum tool calls allowed (prevents infinite loops)
- `allowedTools`: Which built-in Claude tools to enable
- `env`: Clean environment without debug variables

**Unique to Claude**: The extended thinking feature provides visibility into the AI's reasoning process - you can see how it decides to use tools and solve problems!

---

## Step 5: Built-in Tools (No MCP Setup!)

**What it does**: Claude Agent SDK comes with powerful built-in tools - no additional setup required!

**Available Tools**:
- **Read**: Read files from the workspace
- **Write**: Create and modify files
- **WebSearch**: Search the internet for information
- **Bash**: Execute shell commands
- **Grep**: Search file contents with patterns

**How it works**: Just specify tools in `allowedTools` array:

```python
claude_options = {
    "allowedTools": ["Read", "Write", "WebSearch", "Bash", "Grep"],
}
```

Claude automatically:
- Decides when to use tools based on user's request
- Executes tool calls with proper parameters
- Integrates results into the response
- Shows thinking process for each tool use

**Example Interaction**:
```
User: "Search for Python async best practices"
Claude thinking: I need to search the web for information about Python async...
[Uses WebSearch tool]
Claude: Based on my search, here are the key best practices...
```

**No MCP Server Configuration Needed**: Unlike agent-framework and OpenAI samples which need MCP server setup for tools, Claude's built-in tools work immediately!

---

## Step 6: Notification Handling

```python
async def handle_agent_notification_activity(
    self,
    notification_activity: AgentNotificationActivity,
    auth: Authorization,
    context: TurnContext,
) -> str:
    """Handle agent notifications from Outlook, Word, Teams, etc."""
    try:
        notification_type = notification_activity.notification_type
        self.logger.info(f"📬 Processing notification: {notification_type}")
        
        # Handle email notifications
        if notification_type == NotificationTypes.EMAIL_NOTIFICATION:
            email = notification_activity.email_reference
            if email:
                subject = email.subject or "No subject"
                message = (
                    f"You were mentioned in an email:\n"
                    f"Subject: {subject}\n"
                    f"From: {email.sender_display_name}\n\n"
                    f"How can I help with this email?"
                )
                
                response = await self.process_user_message(message, auth, context)
                return response or "Email notification processed."
        
        # Handle Word comment notifications
        elif notification_type == NotificationTypes.WPX_COMMENT:
            comment = notification_activity.wpx_comment
            if comment:
                message = (
                    f"You were mentioned in a Word document comment:\n"
                    f"Comment: {comment.comment_text}\n"
                    f"Document: {comment.document_name}\n\n"
                    f"How can I help with this?"
                )
                
                response = await self.process_user_message(message, auth, context)
                return response or "Word notification processed."
        
        # Handle generic notifications
        else:
            notification_message = (
                getattr(notification_activity.activity, 'text', None) or 
                str(getattr(notification_activity.activity, 'value', None)) or 
                f"Notification received: {notification_type}"
            )
            
            response = await self.process_user_message(notification_message, auth, context)
            return response or "Notification processed successfully."
            
    except Exception as e:
        self.logger.error(f"Error processing notification: {e}")
        return f"Sorry, I encountered an error processing the notification: {str(e)}"
```

**What it does**: Handles @mentions from various Microsoft 365 applications.

**Notification Types**:
- **EMAIL_NOTIFICATION**: User @mentioned agent in Outlook
- **WPX_COMMENT**: User @mentioned agent in Word comment
- **Generic**: Other notification types (Teams messages, etc.)

**What happens**:
1. **Identifies Type**: Determines what kind of notification it is
2. **Extracts Context**: Gets relevant information (subject, comment text, etc.)
3. **Formats Message**: Creates a clear prompt for Claude
4. **Processes with AI**: Uses Claude to generate intelligent response
5. **Returns Result**: Sends response back to user

**Unique Feature**: The agent can intelligently respond to notifications using Claude's extended thinking to understand context and provide helpful answers.

---

## Step 7: Dual Channel Notification Routing

In `host_agent_server.py`, the agent registers handlers for both channels:

```python
# Register for 'agents' channel (production - Outlook, Teams notifications)
@self.agent_notification.on_agent_notification(
    channel_id=ChannelId(channel="agents", sub_channel="*"),
    auth_handlers=handler,
)
async def on_notification_agents(context, state, notification_activity):
    await handle_notification_common(context, state, notification_activity)

# Register for 'msteams' channel (testing - Agents Playground)
@self.agent_notification.on_agent_notification(
    channel_id=ChannelId(channel="msteams", sub_channel="*"),
    auth_handlers=handler,
)
async def on_notification_msteams(context, state, notification_activity):
    await handle_notification_common(context, state, notification_activity)
```

**What it does**: Registers notification handlers for both production and testing channels.

**Why Two Channels**:
- **agents**: Production notifications from Outlook, Word, Teams
- **msteams**: Testing notifications from Agents Playground

**What happens**:
1. Both handlers use the same processing logic
2. Notifications route correctly based on source
3. Testing works without production credentials

**Implementation Detail**: This dual registration was necessary because the Agents Playground sends notifications with `channel="msteams"` while production uses `channel="agents"`.

---

## Step 8: Response Formatting

```python
def _format_response(self, thinking: str, response: str) -> str:
    """Format Claude's response with thinking process"""
    if not thinking:
        return response
    
    # Show thinking for transparency
    formatted = f"**Claude's Thinking:**\n💭 {thinking[:500]}"
    if len(thinking) > 500:
        formatted += "...\n\n"
    else:
        formatted += "\n\n"
    
    formatted += f"**Response:**\n{response}"
    return formatted

def _get_system_prompt(self) -> str:
    """Get the system prompt for Claude"""
    return """
You are a helpful AI assistant with access to powerful tools.
When users ask questions or request actions:
- Use Read to examine files
- Use Write to create or modify files  
- Use WebSearch to find current information
- Use Bash to execute commands
- Use Grep to search file contents

Always explain your reasoning and show your work.
Be friendly and helpful!
    """.strip()
```

**What it does**: Formats responses to show both Claude's thinking and the final answer.

**What happens**:
1. **Shows Thinking**: Displays first 500 chars of reasoning process
2. **Shows Response**: Displays the final answer
3. **Truncates Long Thinking**: Keeps messages readable

**Why it's useful**: Users can see how Claude reasoned through their request, building trust and understanding!

**System Prompt**: Instructs Claude on how to use its built-in tools effectively.

---

## Step 9: Cleanup and Resource Management

```python
async def initialize(self):
    """Initialize the agent"""
    self.logger.info("Initializing Claude Agent...")
    try:
        self.logger.info("Claude Agent initialized successfully")
    except Exception as e:
        self.logger.error(f"Failed to initialize agent: {e}")
        raise

async def cleanup(self) -> None:
    """Clean up agent resources"""
    try:
        self.logger.info("Cleaning up Claude agent resources...")
        # Claude Agent SDK handles cleanup automatically
        self.logger.info("Cleanup completed")
    except Exception as e:
        self.logger.error(f"Error during cleanup: {e}")
```

**What it does**: Properly initializes and shuts down the agent.

**What happens**:
- Initialize validates configuration
- Cleanup ensures graceful shutdown
- Errors are logged but don't crash

**Unique to Claude**: The Claude Agent SDK handles most cleanup automatically - no need to manually close MCP server connections like in other samples!

---

## Step 10: Main Entry Point

```python
async def main():
    """Main function to run the Claude Agent"""
    try:
        agent = ClaudeAgent()
        await agent.initialize()
        
        # Example interaction
        message = "Search the web for Python async best practices"
        auth = None  # Anonymous mode for testing
        context = None  # Would be provided by host in production
        
        response = await agent.process_user_message(message, auth, context)
        print(f"\n{response}\n")
        
    except Exception as e:
        logger.error(f"Failed to start agent: {e}")
    finally:
        if "agent" in locals():
            await agent.cleanup()

if __name__ == "__main__":
    asyncio.run(main())
```

**What it does**: Starting point for testing the agent directly.

**What happens**:
- Creates and initializes the agent
- Runs a test conversation
- Ensures cleanup happens

**Why it's useful**: Quick way to test Claude integration without starting the full server!

---

## Architecture Patterns

### 1. **Separation of Concerns**
```
agent.py           -> AI logic and Claude integration
host_agent_server.py -> HTTP hosting and routing
agent_interface.py   -> Abstract contract
```

### 2. **Clean Environment Management**
```python
clean_env = {**os.environ}
delete clean_env.NODE_OPTIONS  # Remove debug variables
delete clean_env.VSCODE_INSPECTOR_OPTIONS
```

**Why**: Claude Agent SDK spawns child processes that fail with debug variables set.

### 3. **Observability Integration**
```python
with create_chat_span(model=self.model, input_message=message):
    # AI processing here
```

Manual spans bridge the gap until auto-instrumentation is available.

### 4. **Error Resilience**
```python
try:
    response = await self.process_user_message(...)
except Exception as e:
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
