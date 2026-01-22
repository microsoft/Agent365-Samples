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
    InvokeAgentDetails,
    InferenceScope,
    InferenceCallDetails,
    InferenceOperationType,
    AgentDetails,
    TenantDetails,
    Request,
    ExecutionType,
)
from microsoft_agents_a365.observability.core.models.caller_details import CallerDetails
from microsoft_agents_a365.observability.core.middleware.baggage_builder import BaggageBuilder

# Observability configuration (must be imported early)
from observability_config import is_observability_configured

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

        # Configure Claude options
        self.claude_options = ClaudeAgentOptions(
            model=model,
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
        - Discover MCP servers from ToolingManifest.json (dev) or Gateway (prod)
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
        2. Discover available MCP servers
        3. Connect to each server
        4. Fetch and index all available tools
        
        Args:
            auth: Authorization for token exchange
            auth_handler_name: Name of the auth handler
            context: Turn context from M365 SDK
        """
        try:
            # Get auth token based on configuration
            use_agentic_auth = os.getenv("USE_AGENTIC_AUTH", "false").lower() == "true"
            auth_token = None
            
            if not use_agentic_auth:
                auth_token = self.auth_options.bearer_token
            
            # Discover and connect to MCP servers
            self.mcp_tools = await self.mcp_service.discover_and_connect_servers(
                auth=auth,
                auth_handler_name=auth_handler_name,
                context=context,
                auth_token=auth_token,
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

    async def call_mcp_tool(self, tool_name: str, arguments: dict) -> str:
        """
        Call an MCP tool by name and return the result.
        
        Args:
            tool_name: Name of the tool to call
            arguments: Tool arguments as a dictionary
            
        Returns:
            The tool result as a string
        """
        return await self.mcp_service.call_tool(tool_name, arguments)

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
        self, message: str, auth: Authorization, auth_handler_name: str, context: TurnContext
    ) -> str:
        """Process user message using the Claude Agent SDK with observability tracing"""
        
        # Extract context details for observability
        activity = context.activity
        recipient = activity.recipient if activity.recipient else None
        tenant_id = recipient.tenant_id if recipient else None
        agent_id = recipient.agentic_app_id if recipient else None
        agent_upn = getattr(recipient, "user_principal_name", None) or getattr(recipient, "upn", None) if recipient else None
        conversation_id = activity.conversation.id if activity.conversation else None
        
        # Extract caller information
        caller_id = activity.from_property.id if activity.from_property else None
        caller_name = activity.from_property.name if activity.from_property else None
        caller_aad_object_id = activity.from_property.aad_object_id if activity.from_property else None
        
        try:
            logger.info(f"📨 Processing message: {message[:100]}...")
            
            # Setup MCP servers for this request
            await self.setup_mcp_servers(auth, auth_handler_name, context)
            
            # Verify observability is configured before using BaggageBuilder
            if not is_observability_configured():
                logger.warning("⚠️ Observability not configured, spans may not be exported")
            
            # Use BaggageBuilder to set contextual information that flows through all spans
            with (
                BaggageBuilder()
                .tenant_id(tenant_id or "default-tenant")
                .agent_id(agent_id or os.getenv("AGENT_ID", "claude-agent"))
                .correlation_id(conversation_id or str(uuid.uuid4()))
                .build()
            ):
                # Create AgentDetails with valid parameters only
                agent_details = AgentDetails(
                    agent_id=agent_id or os.getenv("AGENT_ID", "claude-agent"),
                    conversation_id=conversation_id,
                    agent_name=os.getenv("OBSERVABILITY_SERVICE_NAME", "Claude Agent"),
                    agent_description="AI agent powered by Anthropic Claude Agent SDK",
                    tenant_id=tenant_id or "default-tenant",
                    agent_upn=agent_upn,  # Get from turn context recipient
                    agent_blueprint_id=os.getenv("CLIENT_ID") or os.getenv("AGENT_BLUEPRINT_ID"),
                    agent_auid=os.getenv("AGENT_AUID"),
                )

                
                # Extract caller information (add UPN and IP if available)
                caller = activity.from_property if activity and activity.from_property else None
                caller_id = getattr(caller, "id", None)
                caller_name = getattr(caller, "name", None)
                caller_upn = (
                    getattr(caller, "user_principal_name", None)
                    or getattr(caller, "upn", None)
                )
                # Client IP may be set by hosting middleware. If you can’t read it directly,
                # carry it via source_metadata so exporter can reflect it in attributes.
                client_ip = getattr(activity, "caller_client_ip", None)

                
                # Create CallerDetails (don't include tenant_id per schema)
                caller_details = CallerDetails(
                    caller_id=caller_id or "unknown-caller",
                    caller_upn=caller_upn or caller_name or "unknown-user",
                    caller_user_id=caller_aad_object_id or caller_id or "unknown-user-id",
                )
                
                tenant_details = TenantDetails(tenant_id=tenant_id or "default-tenant")
                
                # Create Request without source_metadata (causes incorrect attributes)
                request = Request(
                    content=message,
                    execution_type=ExecutionType.HUMAN_TO_AGENT,
                    session_id=conversation_id,
                )
                
                invoke_details = InvokeAgentDetails(
                    details=agent_details,
                    session_id=conversation_id,
                )
                
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
                        # Get MCP tools in Claude format to pass to the client
                        mcp_tools_for_claude = self.get_mcp_tools_for_claude()
                        
                        # Create client options with MCP tools included
                        if mcp_tools_for_claude:
                            logger.info(f"📋 Registering {len(mcp_tools_for_claude)} MCP tool(s) with Claude")
                            client_options = ClaudeAgentOptions(
                                model=self.claude_options.model,
                                max_thinking_tokens=self.claude_options.max_thinking_tokens,
                                allowed_tools=self.claude_options.allowed_tools,
                                custom_tools=mcp_tools_for_claude,  # Add MCP tools here
                                permission_mode=self.claude_options.permission_mode,
                                continue_conversation=self.claude_options.continue_conversation,
                            )
                        else:
                            client_options = self.claude_options
                        
                        # Create a new client for this conversation with MCP tools
                        async with ClaudeSDKClient(client_options) as client:
                            # Send the user message
                            await client.query(message)

                            # Collect the response
                            response_parts = []
                            thinking_parts = []
                            
                            # Get available MCP tool names for routing
                            mcp_tool_names = self.get_mcp_tool_names()
                            
                            # Tool execution loop - continues until Claude provides final response
                            max_tool_iterations = 10  # Prevent infinite loops
                            iteration = 0
                            
                            while iteration < max_tool_iterations:
                                iteration += 1
                                pending_tool_calls = []
                                has_final_response = False
                                
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
                                                has_final_response = True
                                            
                                            elif isinstance(block, ToolUseBlock):
                                                # Claude wants to use a tool
                                                tool_name = block.name
                                                tool_input = block.input
                                                tool_use_id = block.id
                                                
                                                logger.info(f"🔧 Claude requesting tool: {tool_name}")
                                                logger.info(f"   Input: {str(tool_input)[:200]}...")
                                                
                                                pending_tool_calls.append({
                                                    "id": tool_use_id,
                                                    "name": tool_name,
                                                    "input": tool_input,
                                                })
                                
                                # If no pending tool calls, we're done
                                if not pending_tool_calls:
                                    break
                                
                                # Execute pending tool calls
                                tool_results = []
                                for tool_call in pending_tool_calls:
                                    tool_name = tool_call["name"]
                                    tool_input = tool_call["input"]
                                    tool_use_id = tool_call["id"]
                                    
                                    try:
                                        # Check if this is an MCP tool
                                        if tool_name in mcp_tool_names:
                                            logger.info(f"🔄 Executing MCP tool: {tool_name}")
                                            result = await self.call_mcp_tool(tool_name, tool_input)
                                            logger.info(f"✅ MCP tool result: {str(result)[:200]}...")
                                        else:
                                            # Built-in tool or unknown - let Claude handle it
                                            logger.info(f"ℹ️ Tool '{tool_name}' is not an MCP tool, skipping...")
                                            result = f"Tool '{tool_name}' is a built-in tool handled by Claude Agent SDK."
                                        
                                        tool_results.append({
                                            "tool_use_id": tool_use_id,
                                            "content": result,
                                            "is_error": False,
                                        })
                                        
                                    except Exception as tool_error:
                                        logger.error(f"❌ Tool execution error: {tool_error}")
                                        tool_results.append({
                                            "tool_use_id": tool_use_id,
                                            "content": f"Error executing tool: {str(tool_error)}",
                                            "is_error": True,
                                        })
                                
                                # Send tool results back to Claude
                                if tool_results:
                                    logger.info(f"📤 Sending {len(tool_results)} tool result(s) to Claude")
                                    await client.send_tool_results(tool_results)
                            
                            # Warn if max iterations reached
                            if iteration >= max_tool_iterations:
                                logger.warning(f"⚠️ Max tool iterations ({max_tool_iterations}) reached")

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
                
                # Record finish reason
                if inference_scope and hasattr(inference_scope, 'record_finish_reasons'):
                    inference_scope.record_finish_reasons(["end_turn"])
                
                # Close scopes successfully
                if inference_scope:
                    inference_scope.__exit__(None, None, None)
                if invoke_scope:
                    invoke_scope.__exit__(None, None, None)
                
                logger.info("✅ Observability scopes closed successfully")

                return full_response

        except Exception as e:
            logger.error(f"Error processing message: {e}")
            logger.exception("Full error details:")
            
            # Record error in scopes
            if invoke_scope and hasattr(invoke_scope, 'record_error'):
                invoke_scope.record_error(e)
            if inference_scope and hasattr(inference_scope, 'record_error'):
                inference_scope.record_error(e)
            
            # Close scopes with error
            if inference_scope:
                try:
                    inference_scope.__exit__(type(e), e, e.__traceback__)
                except Exception:
                    pass
            if invoke_scope:
                try:
                    invoke_scope.__exit__(type(e), e, e.__traceback__)
                except Exception:
                    pass

            return f"Sorry, I encountered an error: {str(e)}"

    # </MessageProcessing>

    # =========================================================================
    # NOTIFICATION HANDLING
    # =========================================================================
    # <NotificationHandling>

    async def handle_agent_notification_activity(
        self, notification_activity, auth: Authorization, auth_handler_name: str, context: TurnContext
    ) -> str:
        """
        Handle agent notification activities (email, Word mentions, etc.)
        
        Args:
            notification_activity: The notification activity from Agent365
            auth: Authorization for token exchange
            context: Turn context from M365 SDK
            
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
                
                response = await self.process_user_message(message, auth, auth_handler_name, context)
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
                
                response = await self.process_user_message(message, auth, auth_handler_name, context)
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
                
                response = await self.process_user_message(notification_message, auth, auth_handler_name, context)
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
