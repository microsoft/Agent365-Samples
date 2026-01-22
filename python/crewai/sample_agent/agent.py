# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""
CrewAI Agent wrapper hosted with Microsoft Agents SDK.

This keeps the CrewAI logic inside src/crew_agent and wraps it with:
- Generic host contract (AgentInterface)
- Complete observability with BaggageBuilder, InvokeAgentScope, InferenceScope
- Optional MCP server discovery (metadata only today)
"""

import asyncio
import logging
import os

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
from mcp_tool_registration_service import McpToolRegistrationService
from microsoft_agents.hosting.core import Authorization, TurnContext

# Observability Components
from microsoft_agents_a365.observability.core import (
    InvokeAgentScope,
    InferenceScope,
    InferenceCallDetails,
    InferenceOperationType,
)
from microsoft_agents_a365.observability.core.middleware.baggage_builder import BaggageBuilder

# MCP Tooling
from microsoft_agents_a365.tooling.utils.utility import get_mcp_platform_authentication_scope

# Shared turn context utilities
from turn_context_utils import (
    extract_turn_context_details,
    create_agent_details,
    create_invoke_agent_details,
    create_caller_details,
    create_tenant_details,
    create_request,
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
        self.mcp_servers = []

        self._log_env_configuration()

        # Observability is already configured at module level via observability_config.py
        # No need to configure again here
        logger.info("CrewAI Agent uses observability configured at module level")

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
        """Fetch MCP server configs and convert to CrewAI MCP definitions."""
        if self.mcp_servers_initialized:
            return

        try:
            use_agentic_auth = os.getenv("USE_AGENTIC_AUTH", "false").lower() == "true"
            auth_token = None

            if use_agentic_auth:
                # Fetch token for MCP platform and pass it through
                scopes = get_mcp_platform_authentication_scope()
                token_obj = await auth.exchange_token(
                    context,
                    scopes=scopes,
                    auth_handler_id=auth_handler_name,
                )
                auth_token = token_obj.token
                self.mcp_servers = await self.mcp_service.list_tool_servers(
                    agentic_app_id=os.getenv("AGENTIC_APP_ID", "crewai-agent"),
                    auth=auth,
                    context=context,
                    auth_token=auth_token,
                )
            else:
                auth_token = self.auth_options.bearer_token
                self.mcp_servers = await self.mcp_service.list_tool_servers(
                    agentic_app_id=os.getenv("AGENTIC_APP_ID", "crewai-agent"),
                    auth=auth,
                    context=context,
                    auth_token=auth_token,
                )

            mcp_entries = []
            for server in self.mcp_servers:
                server_url = getattr(server, "url", None) or getattr(server, "mcp_server_unique_name", None)
                server_id = getattr(server, "mcp_server_name", None) or getattr(server, "mcp_server_unique_name", None)
                if not server_url or not server_id:
                    continue
                mcp_entries.append(
                    {
                        "id": server_id,
                        "transport": "sse",
                        "options": {
                            "url": server_url,
                            "headers": {"Authorization": f"Bearer {auth_token}"} if auth_token else {},
                        },
                    }
                )
            self.mcp_servers = mcp_entries
            logger.info("MCP setup completed with %d servers (CrewAI formatted)", len(self.mcp_servers))
        except Exception as e:
            logger.warning("MCP setup error: %s", e)
        finally:
            self.mcp_servers_initialized = True

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

            # Use BaggageBuilder to set contextual information that flows through all spans
            with (
                BaggageBuilder()
                .tenant_id(ctx_details.tenant_id)
                .agent_id(ctx_details.agent_id)
                .correlation_id(ctx_details.correlation_id)
                .build()
            ):
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
                            self.mcp_servers,
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

                logger.info("Observability scopes closed successfully")
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
    # CLEANUP
    # =========================================================================
    # <Cleanup>

    async def cleanup(self) -> None:
        """Clean up agent resources."""
        try:
            logger.info("Cleaning up CrewAI agent resources...")
            # CrewAI doesn't require explicit cleanup
            logger.info("CrewAIAgent cleanup completed")
        except Exception as e:
            logger.error(f"Error during cleanup: {e}")

    # </Cleanup>
