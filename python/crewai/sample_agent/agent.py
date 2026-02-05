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
import contextvars
import logging
import os

from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# =============================================================================
# IMPORTS
# =============================================================================

# Agent Interface
from agent_interface import AgentInterface

# Microsoft Agents SDK
from local_authentication_options import LocalAuthenticationOptions
from mcp_tool_registration_service import McpToolRegistrationService, MCPToolDefinition
from microsoft_agents.hosting.core import Authorization, TurnContext

# MCP Observable Tools
from mcp_observable_tools import MCPToolExecutor, create_observable_mcp_tools

# Notification Handler
from notification_handler import handle_notification

# Observability Components
from microsoft_agents_a365.observability.core import (
    InvokeAgentScope,
    InferenceScope,
    InferenceCallDetails,
    InferenceOperationType,
)

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
from constants import DEFAULT_AGENT_ID

# Context variables for thread/async-safe observability context
# These are used by MCP tool wrappers to access the current request's context
# without risk of concurrent request interference
_current_agent_details: contextvars.ContextVar = contextvars.ContextVar('agent_details', default=None)
_current_tenant_details: contextvars.ContextVar = contextvars.ContextVar('tenant_details', default=None)


class CrewAIAgent(AgentInterface):
    """CrewAI Agent wrapper suitable for GenericAgentHost."""

    def __init__(self):
        self.auth_options = LocalAuthenticationOptions.from_environment()
        self.mcp_service = McpToolRegistrationService(logger=logger)
        self.mcp_tool_executor = MCPToolExecutor(self.mcp_service)
        self.mcp_servers_initialized = False
        self.mcp_tools: list[MCPToolDefinition] = []

        logger.info("CrewAIAgent initialized")

    # =========================================================================
    # MCP SERVER SETUP
    # =========================================================================

    async def _setup_mcp_servers(
        self, auth: Authorization, auth_handler_name: str, context: TurnContext
    ):
        """
        Discover MCP servers, connect to them, and fetch available tools.
        """
        if self.mcp_servers_initialized:
            return

        try:
            # Get agentic_app_id from context or environment
            agentic_app_id = None
            if context.activity and context.activity.recipient:
                agentic_app_id = context.activity.recipient.agentic_app_id
            if not agentic_app_id:
                agentic_app_id = os.getenv("AGENTIC_APP_ID", DEFAULT_AGENT_ID)
            
            # Get auth token - prefer token exchange for proper MCP authentication
            use_agentic_auth = os.getenv("USE_AGENTIC_AUTH", "true").lower() == "true"
            auth_token = None
            
            if not use_agentic_auth:
                auth_token = self.auth_options.bearer_token
                logger.info("ℹ️ Using static bearer token for MCP (USE_AGENTIC_AUTH=false)")
            else:
                logger.info("ℹ️ MCP will use token exchange for authentication")
            
            # Discover and connect to MCP servers
            self.mcp_tools = await self.mcp_service.discover_and_connect_servers(
                agentic_app_id=agentic_app_id,
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
        finally:
            self.mcp_servers_initialized = True

    def _create_observable_tools(self) -> list:
        """Create observable MCP tool wrappers with ExecuteToolScope tracing."""
        return create_observable_mcp_tools(
            mcp_tools=self.mcp_tools,
            tool_executor=self.mcp_tool_executor,
            get_agent_details=lambda: _current_agent_details.get(),
            get_tenant_details=lambda: _current_tenant_details.get(),
        )

    # =========================================================================
    # MESSAGE PROCESSING
    # =========================================================================

    async def initialize(self):
        """Initialize the agent (no-op for CrewAI wrapper)."""
        logger.info("CrewAIAgent initialized")

    async def process_user_message(
        self, message: str, auth: Authorization, auth_handler_name: str, context: TurnContext
    ) -> str:
        """
        Process a user message by running the CrewAI flow with observability tracing.
        """
        ctx_details = extract_turn_context_details(context)

        try:
            logger.info(f"Processing message: {message[:100]}...")

            with build_baggage_builder(context, ctx_details.correlation_id).build():
                # Create observability details
                agent_details = create_agent_details(ctx_details, "AI agent powered by CrewAI framework")
                caller_details = create_caller_details(ctx_details)
                tenant_details = create_tenant_details(ctx_details)
                request = create_request(ctx_details, message)
                invoke_details = create_invoke_agent_details(ctx_details, "AI agent powered by CrewAI framework")

                with InvokeAgentScope.start(
                    invoke_agent_details=invoke_details,
                    tenant_details=tenant_details,
                    request=request,
                    caller_details=caller_details,
                ) as invoke_scope:
                    if hasattr(invoke_scope, 'record_input_messages'):
                        invoke_scope.record_input_messages([message])

                    # Setup MCP servers
                    await self._setup_mcp_servers(auth, auth_handler_name, context)

                    # Store context for observable MCP tool wrappers using context variables
                    # This is thread/async-safe for concurrent request handling
                    agent_details_token = _current_agent_details.set(agent_details)
                    tenant_details_token = _current_tenant_details.set(tenant_details)

                    try:
                        # Create observable MCP tool wrappers
                        observable_mcp_tools = self._create_observable_tools()
                        if observable_mcp_tools:
                            logger.info(f"📊 Created {len(observable_mcp_tools)} observable MCP tool wrapper(s)")
                            for tool in observable_mcp_tools:
                                logger.info(f"   🔧 {tool.name}: ExecuteToolScope enabled")

                        # Run CrewAI with InferenceScope
                        full_response = await self._run_crew_with_inference_scope(
                            message, observable_mcp_tools, agent_details, tenant_details, request
                        )

                        if hasattr(invoke_scope, 'record_output_messages'):
                            invoke_scope.record_output_messages([full_response])
                    finally:
                        # Reset context variables to previous values
                        _current_agent_details.reset(agent_details_token)
                        _current_tenant_details.reset(tenant_details_token)

                logger.info("✅ Observability scopes closed successfully")
                return full_response

        except Exception as e:
            logger.error("Error processing message: %s", e)
            logger.exception("Full error details:")
            return f"Sorry, I encountered an error: {str(e)}"

    async def _run_crew_with_inference_scope(
        self, message: str, observable_mcp_tools: list, agent_details, tenant_details, request
    ) -> str:
        """Run CrewAI with InferenceScope for LLM call tracking."""
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
            from crew_agent.agent_runner import run_crew

            logger.info("Running CrewAI with input: %s", message)
            result = await asyncio.to_thread(
                run_crew,
                message,
                True,
                False,
                observable_mcp_tools,
            )
            logger.info("CrewAI completed")

            full_response = self._extract_result(result)

            if hasattr(inference_scope, 'record_finish_reasons'):
                inference_scope.record_finish_reasons(["end_turn"])

            if hasattr(inference_scope, 'record_output_messages'):
                inference_scope.record_output_messages([full_response])

        return full_response

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

    async def handle_agent_notification_activity(
        self,
        notification_activity,
        auth: Authorization,
        context: TurnContext,
        auth_handler_name: str | None = None,
    ) -> str:
        """Handle agent notification activities (email, Word mentions, etc.)"""
        return await handle_notification(
            agent=self,
            notification_activity=notification_activity,
            auth=auth,
            context=context,
            auth_handler_name=auth_handler_name,
        )

    # =========================================================================
    # CLEANUP
    # =========================================================================

    async def cleanup(self) -> None:
        """Clean up agent resources including MCP connections."""
        try:
            logger.info("Cleaning up CrewAI agent resources...")
            
            if hasattr(self, 'mcp_service'):
                await self.mcp_service.cleanup()
                logger.info("MCP tool registration service cleaned up")
            
            logger.info("CrewAIAgent cleanup completed")
        except Exception as e:
            logger.error(f"Error during cleanup: {e}")
