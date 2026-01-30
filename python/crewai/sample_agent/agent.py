# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
CrewAI Agent wrapper hosted with Microsoft Agents SDK.

This keeps the CrewAI logic inside src/crew_agent and wraps it with:
- Generic host contract (AgentInterface)
- Complete observability with BaggageBuilder, InvokeAgentScope, InferenceScope, ExecuteToolScope
- Full MCP server discovery, connection, and tool execution
"""

import asyncio
import logging
import os
import json
import uuid
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

# Agent Interface
from agent_interface import AgentInterface

# Microsoft Agents SDK
from local_authentication_options import LocalAuthenticationOptions
from mcp_tool_registration_service import McpToolRegistrationService, MCPToolDefinition
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

# Notifications
from microsoft_agents_a365.notifications import NotificationTypes

# Observability configuration (must be imported early)
from observability_config import is_observability_configured

# Shared turn context utilities
from turn_context_utils import (
    extract_turn_context_details,
    create_agent_details,
    create_invoke_agent_details,
    create_caller_details,
    create_tenant_details,
    create_request,
    build_baggage_builder,
)

# </DependencyImports>


class CrewAIAgent(AgentInterface):
    """CrewAI Agent wrapper suitable for GenericAgentHost."""

    # =========================================================================
    # INITIALIZATION
    # =========================================================================
    # <Initialization>

    def __init__(self):
        self.auth_options = LocalAuthenticationOptions.from_environment()
        self.mcp_service = McpToolRegistrationService(logger=logger)
        self.mcp_servers_initialized = False
        self.mcp_tools: list[MCPToolDefinition] = []
        
        # Context for observability - set during message processing
        self._current_agent_details = None
        self._current_tenant_details = None

        self._log_env_configuration()

        # Observability is already configured at module level via observability_config.py
        # Verify it's configured
        if not is_observability_configured():
            logger.warning("⚠️ Observability not configured, spans may not be exported")
        else:
            logger.info("✅ CrewAI Agent uses observability configured at module level")

    # </Initialization>

    def _log_env_configuration(self):
        """Log environment configuration for debugging."""
        logger.info("CrewAI Agent Configuration:")
        logger.info("  - OPENAI_API_KEY: %s", "***" if os.getenv("OPENAI_API_KEY") else "NOT SET")
        logger.info("  - AZURE_OPENAI_API_KEY: %s", "***" if os.getenv("AZURE_OPENAI_API_KEY") else "NOT SET")
        logger.info("  - AZURE_OPENAI_ENDPOINT: %s", os.getenv("AZURE_OPENAI_ENDPOINT", "NOT SET"))
        logger.info("  - USE_AGENTIC_AUTH: %s", os.getenv("USE_AGENTIC_AUTH", "false"))
        logger.info("  - AGENTIC_APP_ID: %s", os.getenv("AGENTIC_APP_ID", "crewai-agent"))

    # =========================================================================
    # MCP SERVER SETUP
    # =========================================================================
    # <McpSetup>

    async def _setup_mcp_servers(self, auth: Authorization, auth_handler_name: str, context: TurnContext):
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
        if self.mcp_servers_initialized:
            return

        try:
            # Get agentic_app_id from context or environment
            agentic_app_id = None
            if context.activity and context.activity.recipient:
                agentic_app_id = context.activity.recipient.agentic_app_id
            if not agentic_app_id:
                agentic_app_id = os.getenv("AGENTIC_APP_ID", "crewai-agent")
            
            # Get auth token - prefer token exchange for proper MCP authentication
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
        finally:
            self.mcp_servers_initialized = True

    async def call_mcp_tool(
        self,
        tool_name: str,
        arguments: dict,
        agent_details,
        tenant_details,
    ) -> str:
        """
        Call an MCP tool by name with ExecuteToolScope observability.
        
        Args:
            tool_name: Name of the tool to call
            arguments: Tool arguments as a dictionary
            agent_details: AgentDetails for observability
            tenant_details: TenantDetails for observability
            
        Returns:
            The tool result as a string
        """
        tool = self.mcp_service.get_tool_by_name(tool_name)
        tool_call_id = str(uuid.uuid4())
        
        # Serialize arguments for observability
        try:
            args_str = json.dumps(arguments) if arguments else ""
        except (TypeError, ValueError):
            args_str = str(arguments) if arguments else ""
        
        # Determine endpoint URL
        endpoint_url = tool.server_url if tool else ""
        endpoint = urlparse(endpoint_url) if endpoint_url else None
        
        # Create ToolCallDetails for observability
        tool_call_details = ToolCallDetails(
            tool_name=tool_name,
            arguments=args_str,
            tool_call_id=tool_call_id,
            description=f"Executing MCP tool: {tool_name}",
            tool_type="mcp_extension",
            endpoint=endpoint,
        )
        
        # Execute with ExecuteToolScope for observability
        with ExecuteToolScope.start(
            details=tool_call_details,
            agent_details=agent_details,
            tenant_details=tenant_details,
        ) as tool_scope:
            try:
                logger.info(f"🔧 Calling MCP tool: {tool_name}")
                result = await self.mcp_service.call_tool(tool_name, arguments)
                
                # Record the response
                if hasattr(tool_scope, 'record_response'):
                    tool_scope.record_response(str(result) if result else "")
                
                logger.info(f"✅ MCP tool '{tool_name}' executed successfully")
                return result
                
            except Exception as e:
                logger.error(f"❌ MCP tool '{tool_name}' failed: {e}")
                raise

    def get_mcp_tools_for_crewai(self) -> list[dict]:
        """
        Get MCP server configurations in CrewAI's expected format.
        
        Returns:
            List of MCP server configs formatted for CrewAI
        """
        return self.mcp_service.get_tools_for_crewai()

    def get_mcp_tool_names(self) -> list[str]:
        """
        Get list of available MCP tool names.
        
        Returns:
            List of tool names that can be called
        """
        return self.mcp_service.get_available_tool_names()

    def create_observable_mcp_tools(self) -> list:
        """
        Create CrewAI-compatible tool wrappers for MCP tools with ExecuteToolScope observability.
        
        Instead of using CrewAI's native `mcps` parameter (which handles tool execution internally
        without observability hooks), this method creates custom CrewAI tools that wrap MCP calls
        with ExecuteToolScope for proper tracing.
        
        Returns:
            List of CrewAI BaseTool instances that wrap MCP tools with observability
        """
        from crewai.tools import BaseTool
        from pydantic import BaseModel, Field, create_model
        from typing import Type, Any
        import asyncio
        
        observable_tools = []
        
        for mcp_tool in self.mcp_tools:
            # Create dynamic input schema from MCP tool's input schema
            input_fields = {}
            if mcp_tool.input_schema and "properties" in mcp_tool.input_schema:
                for prop_name, prop_def in mcp_tool.input_schema.get("properties", {}).items():
                    field_type = str  # Default to string
                    if prop_def.get("type") == "integer":
                        field_type = int
                    elif prop_def.get("type") == "number":
                        field_type = float
                    elif prop_def.get("type") == "boolean":
                        field_type = bool
                    elif prop_def.get("type") == "array":
                        field_type = list
                    elif prop_def.get("type") == "object":
                        field_type = dict
                    
                    description = prop_def.get("description", f"Parameter {prop_name}")
                    required = prop_name in mcp_tool.input_schema.get("required", [])
                    
                    if required:
                        input_fields[prop_name] = (field_type, Field(..., description=description))
                    else:
                        input_fields[prop_name] = (field_type, Field(default=None, description=description))
            
            # If no input schema, create a generic one
            if not input_fields:
                input_fields["input"] = (str, Field(default="", description="Input for the tool"))
            
            # Create dynamic Pydantic model for input schema
            InputModel = create_model(f"{mcp_tool.name}Input", **input_fields)
            
            # Create a closure to capture the tool definition and agent reference
            def create_tool_class(tool_def: MCPToolDefinition, agent_ref: 'CrewAIAgent'):
                class ObservableMCPTool(BaseTool):
                    name: str = tool_def.name
                    description: str = tool_def.description or f"MCP tool: {tool_def.name}"
                    args_schema: Type[BaseModel] = InputModel
                    
                    def _run(self, **kwargs) -> str:
                        """Execute MCP tool with ExecuteToolScope observability."""
                        # Run async call_mcp_tool in sync context
                        loop = asyncio.new_event_loop()
                        try:
                            result = loop.run_until_complete(
                                agent_ref.call_mcp_tool(
                                    tool_name=tool_def.name,
                                    arguments=kwargs,
                                    agent_details=agent_ref._current_agent_details,
                                    tenant_details=agent_ref._current_tenant_details,
                                )
                            )
                            return result
                        except Exception as e:
                            logger.error(f"❌ MCP tool '{tool_def.name}' error: {e}")
                            return f"Error executing {tool_def.name}: {str(e)}"
                        finally:
                            loop.close()
                
                return ObservableMCPTool()
            
            observable_tools.append(create_tool_class(mcp_tool, self))
            logger.info(f"📊 Created observable wrapper for MCP tool: {mcp_tool.name}")
        
        return observable_tools

    # </McpSetup>

    # =========================================================================
    # MESSAGE PROCESSING
    # =========================================================================
    # <MessageProcessing>

    async def initialize(self):
        """Initialize the agent (no-op for CrewAI wrapper)."""
        logger.info("CrewAIAgent initialized")

    async def process_user_message(
        self, message: str, auth: Authorization, auth_handler_name: str, context: TurnContext
    ) -> str:
        """
        Process a user message by running the CrewAI flow with observability tracing.

        The message is treated as the location/prompt input to the crew.
        """
        # Extract context details using shared utility
        ctx_details = extract_turn_context_details(context)

        try:
            logger.info(f"Processing message: {message[:100]}...")

            # Verify observability is configured before using BaggageBuilder
            if not is_observability_configured():
                logger.warning("⚠️ Observability not configured, spans may not be exported")

            # Use BaggageBuilder to set contextual information that flows through all spans
            with build_baggage_builder(context, ctx_details.correlation_id).build():
                # Create observability details using shared utility
                agent_details = create_agent_details(ctx_details, "AI agent powered by CrewAI framework")
                caller_details = create_caller_details(ctx_details)
                tenant_details = create_tenant_details(ctx_details)
                request = create_request(ctx_details, message)
                invoke_details = create_invoke_agent_details(ctx_details, "AI agent powered by CrewAI framework")

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

                    # Setup MCP servers
                    await self._setup_mcp_servers(auth, auth_handler_name, context)

                    # Store context for observable MCP tool wrappers
                    # These are used by create_observable_mcp_tools() to add ExecuteToolScope
                    self._current_agent_details = agent_details
                    self._current_tenant_details = tenant_details

                    # Create observable MCP tool wrappers with ExecuteToolScope tracing
                    # This replaces direct mcps parameter usage for better observability
                    observable_mcp_tools = self.create_observable_mcp_tools()
                    if observable_mcp_tools:
                        logger.info(f"📊 Created {len(observable_mcp_tools)} observable MCP tool wrapper(s)")
                        for tool in observable_mcp_tools:
                            logger.info(f"   🔧 {tool.name}: ExecuteToolScope enabled")

                    # Create InferenceScope for tracking LLM call
                    # Note: CrewAI may use multiple LLM calls internally, this wraps the overall crew execution
                    inference_details = InferenceCallDetails(
                        operationName=InferenceOperationType.CHAT,
                        model=os.getenv("OPENAI_MODEL", os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o-mini")),
                        providerName="CrewAI (OpenAI/Azure)",
                    )

                    with InferenceScope.start(
                        details=inference_details,
                        agent_details=agent_details,
                        tenant_details=tenant_details,
                        request=request,
                    ) as inference_scope:
                        # Run the crew synchronously in a thread to avoid blocking the event loop
                        from crew_agent.agent_runner import run_crew

                        logger.info("Running CrewAI with input: %s", message)
                        result = await asyncio.to_thread(
                            run_crew,
                            message,
                            True,
                            False,
                            observable_mcp_tools,  # Pass observable tools instead of raw MCP configs
                        )
                        logger.info("CrewAI completed")

                        full_response = self._extract_result(result)

                        # Record finish reasons on inference scope
                        if hasattr(inference_scope, 'record_finish_reasons'):
                            inference_scope.record_finish_reasons(["end_turn"])

                        # Record output messages on inference scope
                        if hasattr(inference_scope, 'record_output_messages'):
                            inference_scope.record_output_messages([full_response])

                    # Record output message on invoke scope (after inference scope closes)
                    if hasattr(invoke_scope, 'record_output_messages'):
                        invoke_scope.record_output_messages([full_response])
                    
                    # Clear context after processing
                    self._current_agent_details = None
                    self._current_tenant_details = None

                logger.info("✅ Observability scopes closed successfully")
                return full_response

        except Exception as e:
            logger.error("Error processing message: %s", e)
            logger.exception("Full error details:")
            # Note: Context managers handle scope closure automatically, including error recording
            return f"Sorry, I encountered an error: {str(e)}"

    # </MessageProcessing>

    def _extract_result(self, result) -> str:
        """Extract text content from crew result."""
        if result is None:
            return "No result returned from the crew."
        if isinstance(result, str):
            return result
        return str(result)

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
                logger.info("📧 Processing email notification")

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
                logger.info("🔍 Full notification activity structure:")
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
        """Clean up agent resources including MCP connections."""
        try:
            logger.info("Cleaning up CrewAI agent resources...")
            
            # Clean up MCP tool registration service
            if hasattr(self, 'mcp_service'):
                await self.mcp_service.cleanup()
                logger.info("MCP tool registration service cleaned up")
            
            logger.info("CrewAIAgent cleanup completed")
        except Exception as e:
            logger.error(f"Error during cleanup: {e}")

    # </Cleanup>
