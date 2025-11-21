# Copyright (c) Microsoft. All rights reserved.
"""
CrewAI Agent wrapper hosted with Microsoft Agents SDK.

This keeps the CrewAI logic inside src/crew_agent  and wraps it with:
- Generic host contract (AgentInterface)
- Observability token resolution for Agent 365
- Optional MCP server discovery (metadata only today)
"""

import asyncio
import logging
import os
from datetime import datetime

from dotenv import load_dotenv

from agent_interface import AgentInterface
from local_authentication_options import LocalAuthenticationOptions
from mcp_tool_registration_service import McpToolRegistrationService
from microsoft_agents.hosting.core import Authorization, TurnContext
from microsoft_agents_a365.observability.core.config import configure
from microsoft_agents_a365.tooling.utils.utility import get_mcp_platform_authentication_scope
from token_cache import get_cached_agentic_token

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class CrewAIAgent(AgentInterface):
    """CrewAI Agent wrapper suitable for GenericAgentHost."""

    def __init__(self):
        self.auth_options = LocalAuthenticationOptions.from_environment()
        self.mcp_service = McpToolRegistrationService(logger=logger)
        self.mcp_servers_initialized = False
        self.mcp_servers = []

        self._log_env_configuration()

        # Observability setup (minimal configure + token resolver)
        self._setup_observability()

    def token_resolver(self, agent_id: str, tenant_id: str) -> str | None:
        """Resolve cached agentic token for Agent 365 Observability exporter."""
        try:
            return get_cached_agentic_token(tenant_id, agent_id)
        except Exception as e:
            logger.error("Error resolving token for agent %s tenant %s: %s", agent_id, tenant_id, e)
            return None

    def _setup_observability(self):
        """Configure A365 observability; CrewAI has no dedicated instrumentor yet."""
        try:
            status = configure(
                service_name=os.getenv("OBSERVABILITY_SERVICE_NAME", "crewai-sample-agent"),
                service_namespace=os.getenv("OBSERVABILITY_SERVICE_NAMESPACE", "agent365-samples"),
                token_resolver=self.token_resolver,
            )
            if not status:
                logger.warning("Observability configuration failed")
        except Exception as e:
            logger.error("Error setting up observability: %s", e)

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

    async def initialize(self):
        """Initialize the agent (no-op for CrewAI wrapper)."""
        logger.info("CrewAIAgent initialized")

    async def process_user_message(
        self, message: str, auth: Authorization, auth_handler_name: str, context: TurnContext
    ) -> str:
        """
        Process a user message by running the CrewAI flow.

        The message is treated as the location/prompt input to the crew.
        """
        try:
            await self._setup_mcp_servers(auth, auth_handler_name, context)

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
            return self._extract_result(result)
        except Exception as e:
            logger.error("Error processing message: %s", e)
            return f"Sorry, I encountered an error: {str(e)}"

    def _extract_result(self, result) -> str:
        """Extract text content from crew result."""
        if result is None:
            return "No result returned from the crew."
        if isinstance(result, str):
            return result
        return str(result)

    async def cleanup(self) -> None:
        """Cleanup hook for parity with other samples."""
        logger.info("CrewAIAgent cleanup completed")

    def _log_env_configuration(self) -> None:
        """Log key environment values (sensitive values masked)."""
        def mask(value: str | None) -> str:
            if not value:
                return "NOT SET"
            if len(value) <= 8:
                return "***"
            return f"{value[:4]}...{value[-4:]}"

        env_snapshot = {
            "USE_AGENTIC_AUTH": os.getenv("USE_AGENTIC_AUTH", "false"),
            "AGENTIC_APP_ID": mask(os.getenv("AGENTIC_APP_ID")),
            "OBSERVABILITY_SERVICE_NAME": os.getenv("OBSERVABILITY_SERVICE_NAME"),
            "OBSERVABILITY_SERVICE_NAMESPACE": os.getenv("OBSERVABILITY_SERVICE_NAMESPACE"),
            "OPENAI_MODEL": os.getenv("OPENAI_MODEL"),
            "MCP_SERVER_HOST": os.getenv("MCP_SERVER_HOST"),
            "MCP_SERVER_PORT": os.getenv("MCP_SERVER_PORT"),
            "CLIENT_ID": mask(os.getenv("CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID")),
            "TENANT_ID": mask(os.getenv("CONNECTIONS__SERVICE_CONNECTION__SETTINGS__TENANTID")),
            "CLIENT_SECRET": mask(os.getenv("CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTSECRET")),
            "BEARER_TOKEN": mask(os.getenv("BEARER_TOKEN")),
        }
        logger.info("Environment configuration (masked): %s", env_snapshot)
