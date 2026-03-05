# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Claude Agent SDK Agent with Microsoft 365 Integration

This agent uses the Claude Agent SDK and integrates with Microsoft 365 Agents SDK
for enterprise hosting, authentication, and observability.

Features:
- Claude Agent SDK with extended thinking capability
- Microsoft 365 Agents SDK hosting and authentication
- Complete observability with BaggageBuilder
- Conversation continuity across turns
- Comprehensive error handling and cleanup
"""

import logging
import os
import uuid
import json
from urllib.parse import urlparse

from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# =============================================================================
# DEPENDENCY IMPORTS
# =============================================================================
# <DependencyImports>

# Claude Agent SDK
from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    TextBlock,
    ThinkingBlock,
    ToolUseBlock,
    ToolResultBlock,
)

# Agent Interface
from agent_interface import AgentInterface

# Microsoft Agents SDK
from local_authentication_options import LocalAuthenticationOptions
from microsoft_agents.hosting.core import Authorization, TurnContext

# Observability Components
from microsoft_agents_a365.observability.core import (
    InvokeAgentScope,
    InferenceScope,
    InferenceCallDetails,
    InferenceOperationType,
    ExecuteToolScope,
    ToolCallDetails,
)
from microsoft_agents_a365.observability.core.middleware.baggage_builder import BaggageBuilder

# Observability configuration (must be imported early)
from observability_config import is_observability_configured

# Shared turn context utilities (similar to CrewAI pattern)
from turn_context_utils import (
    extract_turn_context_details,
    create_agent_details,
    create_invoke_agent_details,
    create_caller_details,
    create_tenant_details,
    create_request,
    build_baggage_builder,
)

# MCP Tooling Services
from mcp_tool_registration_service import McpToolRegistrationService, MCPToolDefinition

# MCP Tooling available for Claude SDK
MCP_AVAILABLE = True

# Notifications
from microsoft_agents_a365.notifications.agent_notification import NotificationTypes

# </DependencyImports>


class ClaudeAgent(AgentInterface):
    """Claude Agent integrated with Microsoft 365 Agents SDK"""

    # =========================================================================
    # INITIALIZATION
    # =========================================================================
    # <Initialization>

    def __init__(self):
        """Initialize the Claude agent."""
        self.logger = logging.getLogger(self.__class__.__name__)

        # Observability is already configured at module level
        # No need to configure again here

        # Initialize authentication options
        self.auth_options = LocalAuthenticationOptions.from_environment()

        # Create Claude client
        self._create_client()
        
        # Initialize MCP services
        self._initialize_mcp_services()
        
        logger.info("Claude Agent uses built-in tools: WebSearch, Read, Write, WebFetch")
        logger.info("MCP Tooling integration enabled for extended capabilities")

    # </Initialization>

    # =========================================================================
    # CLIENT CREATION
    # =========================================================================
    # <ClientCreation>

    def _create_client(self):
        """Create the Claude Agent SDK client options"""
        # Get model from environment or use default
        model = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-20250514")
        
        # Get API key
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise EnvironmentError("Missing ANTHROPIC_API_KEY. Please set it before running.")

        # =====================================================================
        # SYSTEM PROMPT - Define your agent's behavior here
        # =====================================================================
        self.system_prompt = """You are a Calendar Scheduling Assistant for Microsoft 365.

Your capabilities:
- Schedule, reschedule, and cancel meetings using the Calendar MCP tools
- Check calendar availability for users
- Send meeting invitations via email using Mail MCP tools
- Manage recurring meetings
- Find optimal meeting times across multiple attendees

Guidelines:
- Always be helpful, professional, and concise
- Confirm actions before making changes to calendars
- When scheduling meetings, gather: title, attendees, date/time, duration
- Use the MCP tools provided to interact with Microsoft 365 calendars and email
- If you cannot complete a task, explain what additional information you need
"""

        # Configure Claude options
        self.claude_options = ClaudeAgentOptions(
            model=model,
            system_prompt=self.system_prompt,
            max_thinking_tokens=1024,
            allowed_tools=["WebSearch", "Read", "Write", "WebFetch"],
            permission_mode="acceptEdits",
            continue_conversation=True
        )

        logger.info(f"✅ Claude Agent configured with model: {model}")

    # </ClientCreation>

    # =========================================================================
    # MCP TOOLING INTEGRATION
    # =========================================================================
    # <McpTooling>

    def _initialize_mcp_services(self):
        """
        Initialize MCP services for tool discovery.
        
        Uses McpToolRegistrationService to:
        - Discover MCP servers via McpToolServerConfigurationService (production)
        - Fallback to ToolingManifest.json (development)
        - Connect to MCP servers and fetch available tools
        - Provide tool execution capabilities
        """
        self.mcp_service = McpToolRegistrationService(logger=self.logger)
        self.mcp_tools: list[MCPToolDefinition] = []
        logger.info("✅ MCP tool registration service initialized")

    async def setup_mcp_servers(
        self, auth: Authorization, auth_handler_name: str, context: TurnContext
    ):
        """
        Discover MCP servers, connect to them, and fetch available tools.
        
        This method uses the McpToolRegistrationService to:
        1. Authenticate with the MCP platform
        2. Discover available MCP servers via SDK or ToolingManifest.json fallback
        3. Connect to each server
        4. Fetch and index all available tools
        
        Args:
            auth: Authorization for token exchange
            auth_handler_name: Name of the auth handler
            context: Turn context from M365 SDK
        """
        try:
            # Get agentic_app_id from context or environment
            agentic_app_id = None
            if context.activity and context.activity.recipient:
                agentic_app_id = context.activity.recipient.agentic_app_id
            if not agentic_app_id:
                agentic_app_id = os.getenv("AGENT_ID", "claude-agent")
            
            # Get auth token - prefer token exchange for proper MCP authentication
            # When USE_AGENTIC_AUTH=true, the service will exchange token with proper scopes
            # Otherwise, we fall back to the static bearer token (for local dev)
            use_agentic_auth = os.getenv("USE_AGENTIC_AUTH", "true").lower() == "true"
            auth_token = None
            
            if not use_agentic_auth:
                # Use static bearer token for local development
                auth_token = self.auth_options.bearer_token
                logger.info("ℹ️ Using static bearer token for MCP (USE_AGENTIC_AUTH=false)")
            else:
                # Let the MCP service exchange the token with proper scopes
                logger.info("ℹ️ MCP will use token exchange for authentication")
            
            # Discover and connect to MCP servers
            self.mcp_tools = await self.mcp_service.discover_and_connect_servers(
                agentic_app_id=agentic_app_id,
                auth=auth,
                auth_handler_name=auth_handler_name,
                context=context,
                auth_token=auth_token,  # None = service will exchange token
            )
            
            if self.mcp_tools:
                logger.info(f"✅ {len(self.mcp_tools)} MCP tool(s) available:")
                for tool in self.mcp_tools:
                    logger.info(f"   🔧 {tool.name}: {tool.description[:50]}...")
            else:
                logger.info("ℹ️ No MCP tools discovered")
            
        except Exception as e:
            logger.error(f"Error setting up MCP servers: {e}")
            self.mcp_tools = []

    def get_mcp_tool_names(self) -> list[str]:
        """
        Get list of available MCP tool names.
        
        Returns:
            List of tool names that can be called
        """
        return self.mcp_service.get_available_tool_names()

    def get_mcp_tools_for_claude(self) -> list[dict]:
        """
        Get MCP tool definitions in Claude's expected format.
        
        Returns:
            List of tool definitions compatible with Claude's tool use
        """
        return self.mcp_service.get_tools_for_claude()

    def get_mcp_servers_for_claude(self) -> dict:
        """
        Get MCP servers in Claude SDK's McpHttpServerConfig format.
        
        Returns:
            Dict mapping server names to server configs
        """
        return self.mcp_service.get_mcp_servers_for_claude()

    def get_allowed_mcp_tool_names(self) -> list[str]:
        """
        Get MCP tool names in Claude's mcp__<server>__<tool> format.
        
        Returns:
            List of prefixed tool names for allowed_tools
        """
        return self.mcp_service.get_allowed_tool_names_for_claude()

    # </McpTooling>

    # =========================================================================
    # INITIALIZATION AND MESSAGE PROCESSING
    # =========================================================================
    # <MessageProcessing>

    async def initialize(self):
        """Initialize the agent and MCP services"""
        logger.info("Initializing Claude Agent...")
        logger.info("MCP configuration service ready for tool discovery")
        logger.info("Claude Agent initialized successfully")



    async def process_user_message(
        self,
        message: str,
        auth: Authorization,
        context: TurnContext,
        auth_handler_name: str | None = None,
    ) -> str:
        """Process user message using the Claude Agent SDK with observability tracing"""
        
        # Extract context details using shared utility (similar to CrewAI pattern)
        ctx_details = extract_turn_context_details(context)
        
        try:
            logger.info(f"📨 Processing message: {message[:100]}...")
            
            # Setup MCP servers for this request
            await self.setup_mcp_servers(auth, auth_handler_name, context)
            
            # Verify observability is configured before using BaggageBuilder
            if not is_observability_configured():
                logger.warning("⚠️ Observability not configured, spans may not be exported")
            
            # Use BaggageBuilder to set contextual information that flows through all spans
            with build_baggage_builder(context, ctx_details.correlation_id).build():
                # Create observability details using shared utilities (CrewAI pattern)
                agent_details = create_agent_details(ctx_details)
                caller_details = create_caller_details(ctx_details)
                tenant_details = create_tenant_details(ctx_details)
                request = create_request(ctx_details, message)
                invoke_details = create_invoke_agent_details(ctx_details)
                
                # Use context manager pattern per documentation
                with InvokeAgentScope.start(
                    invoke_agent_details=invoke_details,
                    tenant_details=tenant_details,
                    request=request,
                    caller_details=caller_details,
                ) as invoke_scope:
                    # Record input message
                    if hasattr(invoke_scope, 'record_input_messages'):
                        invoke_scope.record_input_messages([message])
                    
                    # Create InferenceScope for tracking LLM call
                    inference_details = InferenceCallDetails(
                        operationName=InferenceOperationType.CHAT,
                        model=self.claude_options.model,
                        providerName="Anthropic Claude",
                    )
                    
                    with InferenceScope.start(
                        details=inference_details,
                        agent_details=agent_details,
                        tenant_details=tenant_details,
                        request=request,
                    ) as inference_scope:
                        # Get MCP servers in Claude SDK format
                        mcp_servers = self.get_mcp_servers_for_claude()
                        mcp_allowed_tools = self.get_allowed_mcp_tool_names()
                        
                        # Debug: Log MCP server configuration being passed to Claude
                        if mcp_servers:
                            for server_name, config in mcp_servers.items():
                                headers = config.get("headers", {})
                                has_auth = "Authorization" in headers or "authorization" in headers
                                logger.info(f"🔐 MCP Server '{server_name}': URL={config.get('url')}, HasAuth={has_auth}")
                        
                        # Combine base allowed_tools with MCP tool names
                        all_allowed_tools = list(self.claude_options.allowed_tools) + mcp_allowed_tools
                        
                        # Create client options WITH mcp_servers so Claude knows about MCP tools
                        # Claude SDK will handle tool execution via SSE transport
                        if mcp_servers:
                            logger.info(f"📋 Registering {len(mcp_servers)} MCP server(s) with Claude")
                            logger.info(f"📋 MCP tools available: {mcp_allowed_tools}")
                            client_options = ClaudeAgentOptions(
                                model=self.claude_options.model,
                                max_thinking_tokens=self.claude_options.max_thinking_tokens,
                                allowed_tools=all_allowed_tools,
                                mcp_servers=mcp_servers,  # Pass MCP servers so Claude knows about tools
                                permission_mode=self.claude_options.permission_mode,
                                continue_conversation=self.claude_options.continue_conversation,
                            )
                        else:
                            client_options = self.claude_options
                        
                        # Create a new client for this conversation with MCP servers
                        async with ClaudeSDKClient(client_options) as client:
                            # Send the user message
                            await client.query(message)

                            # Collect the response
                            response_parts = []
                            thinking_parts = []
                            
                            # Track active tool scopes for recording results
                            active_tool_scopes: dict = {}
                            
                            # Claude SDK handles MCP tool execution automatically
                            # when mcp_servers is configured. We just process the response.
                            
                            # Receive and process messages
                            async for msg in client.receive_response():
                                if isinstance(msg, AssistantMessage):
                                    for block in msg.content:
                                        if isinstance(block, ThinkingBlock):
                                            thinking_parts.append(f"💭 {block.thinking}")
                                            logger.info(f"💭 Claude thinking: {block.thinking[:100]}...")
                                        
                                        elif isinstance(block, TextBlock):
                                            response_parts.append(block.text)
                                            logger.info(f"💬 Claude response: {block.text[:100]}...")
                                        
                                        elif isinstance(block, ToolUseBlock):
                                            # Log tool usage with ExecuteToolScope
                                            tool_name = block.name
                                            tool_input = block.input
                                            tool_call_id = getattr(block, 'id', str(uuid.uuid4()))
                                            
                                            logger.info(f"🔧 Claude using tool: {tool_name}")
                                            logger.debug(f"   Input: {str(tool_input)[:200]}...")
                                            
                                            # Determine tool type and endpoint
                                            if tool_name.startswith("mcp__"):
                                                tool_type = "mcp_extension"
                                                # Extract server name from mcp__<server>__<tool>
                                                parts = tool_name.split("__")
                                                server_name = parts[1] if len(parts) >= 2 else "unknown"
                                                endpoint_url = mcp_servers.get(server_name, {}).get("url", "")
                                                # Parse the URL - ToolCallDetails expects a parsed URL object
                                                endpoint = urlparse(endpoint_url) if endpoint_url else None
                                            else:
                                                tool_type = "function"
                                                endpoint = None  # Built-in tools don't have external endpoints
                                            
                                            # Create ToolCallDetails for observability
                                            # Use json.dumps for proper serialization of arguments
                                            try:
                                                args_str = json.dumps(tool_input) if tool_input else ""
                                            except (TypeError, ValueError):
                                                args_str = str(tool_input) if tool_input else ""
                                            
                                            tool_call_details = ToolCallDetails(
                                                tool_name=tool_name,
                                                arguments=args_str,
                                                tool_call_id=tool_call_id,
                                                description=f"Executing {tool_name} tool",
                                                tool_type=tool_type,
                                                endpoint=endpoint,
                                            )
                                            
                                            # Start ExecuteToolScope and track it
                                            tool_scope = ExecuteToolScope.start(
                                                details=tool_call_details,
                                                agent_details=agent_details,
                                                tenant_details=tenant_details,
                                            )
                                            active_tool_scopes[tool_call_id] = {
                                                "scope": tool_scope,
                                                "name": tool_name,
                                            }
                                            logger.info(f"📊 ExecuteToolScope started for: {tool_name} (id: {tool_call_id})")
                                            
                                            # NOTE: Claude SDK handles MCP tool execution automatically
                                            # when mcp_servers is passed to ClaudeAgentOptions.
                                            # We just track the scope here for observability.
                                            # The actual tool result will come via ToolResultBlock.
                                        
                                        elif isinstance(block, ToolResultBlock):
                                            # Log tool results and close the scope
                                            result_tool_use_id = getattr(block, 'tool_use_id', None)
                                            result_content = getattr(block, 'content', None)
                                            
                                            logger.info(f"✅ Tool result received (id: {result_tool_use_id})")
                                            if result_content:
                                                logger.info(f"   Result: {str(result_content)[:200]}...")
                                            
                                            # Find and close the corresponding tool scope
                                            if result_tool_use_id and result_tool_use_id in active_tool_scopes:
                                                tool_info = active_tool_scopes.pop(result_tool_use_id)
                                                tool_scope = tool_info["scope"]
                                                
                                                # Record the response if available
                                                if tool_scope and hasattr(tool_scope, 'record_response'):
                                                    tool_scope.record_response(str(result_content) if result_content else "")
                                                
                                                # Close the scope
                                                if tool_scope:
                                                    tool_scope.__exit__(None, None, None)
                                                    logger.info(f"📊 ExecuteToolScope closed for: {tool_info['name']}")

                            # Clean up any remaining open tool scopes (shouldn't happen normally)
                            for tool_id, tool_info in active_tool_scopes.items():
                                tool_scope = tool_info.get("scope")
                                if tool_scope:
                                    logger.warning(f"⚠️ Closing orphaned ExecuteToolScope for: {tool_info['name']}")
                                    tool_scope.__exit__(None, None, None)
                            active_tool_scopes.clear()

                            # Combine thinking and response
                            full_response = ""
                            if thinking_parts:
                                full_response += "**Claude's Thinking:**\n"
                                full_response += "\n".join(thinking_parts)
                                full_response += "\n\n**Response:**\n"
                            
                            if response_parts:
                                full_response += "".join(response_parts)
                            else:
                                full_response += "I couldn't process your request at this time."
                        
                            # Capture usage statistics
                            usage = getattr(client, "last_usage", None)
                            if usage and hasattr(inference_scope, "record_input_tokens"):
                                try:
                                    input_tokens = getattr(usage, "input_tokens", 0) or 0
                                    output_tokens = getattr(usage, "output_tokens", 0) or 0
                                    inference_scope.record_input_tokens(int(input_tokens))
                                    inference_scope.record_output_tokens(int(output_tokens))
                                    logger.info(f"📊 Tokens: {input_tokens} in, {output_tokens} out")
                                except Exception as e:
                                    logger.debug(f"Could not record tokens: {e}")
                            
                            # Record finish reasons
                            if hasattr(inference_scope, 'record_finish_reasons'):
                                inference_scope.record_finish_reasons(["end_turn"])
                            
                            # Record output messages on inference scope (gen_ai.output.messages)
                            if hasattr(inference_scope, 'record_output_messages'):
                                inference_scope.record_output_messages([full_response])
                        
                        # Record output message on invoke scope (inside invoke scope, after inference scope closes)
                        if hasattr(invoke_scope, 'record_output_messages'):
                            invoke_scope.record_output_messages([full_response])
                
                # Note: Scopes are automatically closed by the 'with' context managers
                # Do NOT manually call __exit__ - that causes "Token already used" errors
                
                logger.info("✅ Observability scopes closed successfully")

                return full_response

        except Exception as e:
            logger.error(f"Error processing message: {e}")
            logger.exception("Full error details:")
            
            # Note: Scopes are automatically closed by 'with' context managers on exception
            # The exception info is passed to __exit__ automatically
            # Do NOT manually call __exit__ - that causes "Token already used" errors

            return f"Sorry, I encountered an error: {str(e)}"

    # </MessageProcessing>

    # =========================================================================
    # NOTIFICATION HANDLING
    # =========================================================================
    # <NotificationHandling>

    async def handle_agent_notification_activity(
        self,
        notification_activity,
        auth: Authorization,
        context: TurnContext,
        auth_handler_name: str | None = None,
    ) -> str:
        """
        Handle agent notification activities (email, Word mentions, etc.)
        
        Args:
            notification_activity: The notification activity from Agent365
            auth: Authorization for token exchange
            context: Turn context from M365 SDK
            auth_handler_name: Optional auth handler name for token exchange
            
        Returns:
            Response string to send back
        """
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
                
                response = await self.process_user_message(message, auth, context, auth_handler_name)
                return response or "Email notification processed."

            # Handle Word Comment Notifications
            elif notification_type == NotificationTypes.WPX_COMMENT:
                if not hasattr(notification_activity, "wpx_comment") or not notification_activity.wpx_comment:
                    return "I could not find the Word notification details."
                
                wpx = notification_activity.wpx_comment
                doc_id = getattr(wpx, "document_id", "")
                comment_text = notification_activity.text or ""
                
                logger.info(f"📄 Processing Word comment notification for doc {doc_id}")
                
                message = (
                    f"You have been mentioned in a Word document comment.\n"
                    f"Document ID: {doc_id}\n"
                    f"Comment: {comment_text}\n\n"
                    f"Please respond to this comment appropriately."
                )
                
                response = await self.process_user_message(message, auth, context, auth_handler_name)
                return response or "Word notification processed."

            # Generic notification handling
            else:
                logger.info(f"🔍 Full notification activity structure:")
                logger.info(f"   Type: {notification_activity.activity.type}")
                logger.info(f"   Name: {notification_activity.activity.name}")
                logger.info(f"   Text: {getattr(notification_activity.activity, 'text', 'N/A')}")
                logger.info(f"   Value: {getattr(notification_activity.activity, 'value', 'N/A')}")
                logger.info(f"   Entities: {notification_activity.activity.entities}")
                logger.info(f"   Channel ID: {notification_activity.activity.channel_id}")
                
                notification_message = (
                    getattr(notification_activity.activity, 'text', None) or 
                    str(getattr(notification_activity.activity, 'value', None)) or 
                    f"Notification received: {notification_type}"
                )
                logger.info(f"📨 Processing generic notification: {notification_type}")
                
                response = await self.process_user_message(notification_message, auth, context, auth_handler_name)
                return response or "Notification processed successfully."

        except Exception as e:
            logger.error(f"Error processing notification: {e}")
            logger.exception("Full error details:")
            return f"Sorry, I encountered an error processing the notification: {str(e)}"

    # </NotificationHandling>

    # =========================================================================
    # CLEANUP
    # =========================================================================
    # <Cleanup>

    async def cleanup(self) -> None:
        """Clean up agent resources including MCP connections"""
        try:
            logger.info("Cleaning up agent resources...")
            
            # Clean up MCP tool registration service
            if hasattr(self, 'mcp_service'):
                await self.mcp_service.cleanup()
                logger.info("MCP tool registration service cleaned up")
            
            # Claude SDK client cleanup is handled by context manager
            # No additional cleanup needed
            
            logger.info("Agent cleanup completed")

        except Exception as e:
            logger.error(f"Error during cleanup: {e}")

    # </Cleanup>
