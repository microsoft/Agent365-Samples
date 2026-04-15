# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

from typing import Optional
import logging

from google.adk.agents import Agent
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset, StreamableHTTPConnectionParams

from microsoft_agents.hosting.core import Authorization, TurnContext

from microsoft_agents_a365.runtime.utility import Utility
from microsoft_agents_a365.tooling.models import ToolOptions
from microsoft_agents_a365.tooling.services.mcp_tool_server_configuration_service import (
    McpToolServerConfigurationService,
)
from microsoft_agents_a365.tooling.utils.constants import Constants
from microsoft_agents_a365.tooling.utils.utility import (
    get_mcp_platform_authentication_scope,
)


class McpToolRegistrationService:
    """Service for managing MCP tools and servers for an agent"""

    _orchestrator_name: str = "GoogleADK"

    def __init__(self, logger: Optional[logging.Logger] = None):
        """
        Initialize the MCP Tool Registration Service for Google ADK.

        Args:
            logger: Logger instance for logging operations.
        """
        self._logger = logger or logging.getLogger(self.__class__.__name__)
        self.config_service = McpToolServerConfigurationService(logger=self._logger)

    async def add_tool_servers_to_agent(
        self,
        agent: Agent,
        agentic_app_id: str,
        auth: Authorization,
        auth_handler_name: str,
        context: TurnContext,
        auth_token: Optional[str] = None,
    ):
        """
        Add new MCP servers to the agent by creating a new Agent instance.

        Note: This method creates a new Agent instance with MCP servers configured.

        Args:
            agent: The existing agent to add servers to.
            agentic_app_id: Agentic App ID for the agent.
            auth: Authorization object used to exchange tokens for MCP server access.
            auth_handler_name: Name of the authorization handler.
            context: TurnContext object representing the current turn/session context.
            auth_token: Authentication token to access the MCP servers. If not provided,
                        will be obtained using `auth` and `context`.

        Returns:
            New Agent instance with all MCP servers
        """
        # Acquire auth token if not provided
        if not auth_token:
            scopes = get_mcp_platform_authentication_scope()
            auth_token_obj = await auth.exchange_token(context, scopes, auth_handler_name)
            auth_token = auth_token_obj.token

        self._logger.info(f"Listing MCP tool servers for agent {agentic_app_id}")

        options = ToolOptions(orchestrator_name=self._orchestrator_name)

        # Pass auth context for V2 per-audience token acquisition (production path).
        # In dev/Playground mode (empty auth_handler_name), the SDK reads per-server
        # tokens from BEARER_TOKEN_MCP_<SERVER> / BEARER_TOKEN env vars automatically
        # via its internal _attach_dev_tokens method.
        list_kwargs = {}
        if auth_handler_name:
            list_kwargs = {
                "authorization": auth,
                "auth_handler_name": auth_handler_name,
                "turn_context": context,
            }

        mcp_server_configs = await self.config_service.list_tool_servers(
            agentic_app_id=agentic_app_id,
            auth_token=auth_token,
            options=options,
            **list_kwargs,
        )

        self._logger.info(f"Loaded {len(mcp_server_configs)} MCP server configurations")

        # Convert MCP server configs to McpToolset objects
        mcp_servers_info = []

        for server_config in mcp_server_configs:
            if not server_config.url:
                self._logger.warning(
                    "Skipping MCP server '%s' — no URL configured (dev mode or manifest-only config).",
                    server_config.mcp_server_unique_name,
                )
                continue

            # server_config.headers already contains the per-audience Authorization token:
            # - Dev mode:  set by SDK's _create_dev_token_acquirer (reads BEARER_TOKEN_MCP_* / BEARER_TOKEN)
            # - Prod mode: set by SDK's _create_obo_token_acquirer (per-audience OBO exchange)
            base_headers = {
                Constants.Headers.USER_AGENT: Utility.get_user_agent_header(
                    self._orchestrator_name
                )
            }
            server_level_headers = dict(server_config.headers) if server_config.headers else {}
            mcp_server_headers = {**base_headers, **server_level_headers}

            has_auth = Constants.Headers.AUTHORIZATION in mcp_server_headers
            self._logger.info(
                "Configuring MCP server '%s' → %s (auth_header=%s)",
                server_config.mcp_server_name,
                server_config.url,
                "present" if has_auth else "MISSING — MCP calls will fail without a valid token",
            )

            server_info = McpToolset(
                connection_params=StreamableHTTPConnectionParams(
                    url=server_config.url,
                    headers=mcp_server_headers,
                    timeout=30.0,
                )
            )

            mcp_servers_info.append(server_info)

        all_tools = agent.tools + mcp_servers_info

        return Agent(
            name=agent.name,
            model=agent.model,
            description=agent.description,
            instruction=agent.instruction,
            tools=all_tools,
        )
