# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

import os
from typing import Optional
import logging

from google.adk.agents import Agent
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset, StreamableHTTPConnectionParams

from microsoft_agents.hosting.core import Authorization, TurnContext

from microsoft_agents_a365.tooling.services.mcp_tool_server_configuration_service import (
    McpToolServerConfigurationService,
)

from microsoft_agents_a365.tooling.utils.utility import (
    get_mcp_platform_authentication_scope,
)

class McpToolRegistrationService:
    """Service for managing MCP tools and servers for an agent"""

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
            context: TurnContext object representing the current turn/session context.
            auth_token: Authentication token to access the MCP servers. If not provided, will be obtained using `auth` and `context`.

        Returns:
            New Agent instance with all MCP servers
        """

        # Acquire auth token if not provided
        if not auth_token:
            scopes = get_mcp_platform_authentication_scope()
            auth_token_obj = await auth.exchange_token(context, scopes, auth_handler_name)
            auth_token = auth_token_obj.token

        self._logger.info(f"Listing MCP tool servers for agent {agentic_app_id}")
        mcp_server_configs = await self.config_service.list_tool_servers(
            agentic_app_id=agentic_app_id,
            auth_token=auth_token or "",
        )

        self._logger.info(f"Loaded {len(mcp_server_configs)} MCP server configurations")

        # Base headers used as fallback when no per-server headers are provided (V1)
        base_headers = {
            "Authorization": f"Bearer {auth_token}"
        }

        # Convert MCP server configs to McpToolset objects
        mcp_servers_info = []

        for server_config in mcp_server_configs:
            if not server_config.url:
                self._logger.warning(
                    "Skipping MCP server '%s' — no URL configured (dev mode or manifest-only config).",
                    server_config.mcp_server_unique_name,
                )
                continue

            # V2: look up per-server token from env (BEARER_TOKEN_MCP_{SERVERNAME_UPPER})
            # e.g. mcp_CalendarTools → BEARER_TOKEN_MCP_CALENDARTOOLS
            env_key = f"BEARER_TOKEN_{server_config.mcp_server_unique_name.upper()}"
            per_server_token = os.getenv(env_key)
            if per_server_token:
                mcp_server_headers = {"Authorization": f"Bearer {per_server_token}"}
            else:
                # Fall back: merge base headers with any server_config.headers (V1 path)
                server_level_headers = getattr(server_config, "headers", None) or {}
                mcp_server_headers = {**base_headers, **server_level_headers}

            server_url = getattr(server_config, "url", None) or server_config.mcp_server_unique_name

            server_info = McpToolset(
                connection_params=StreamableHTTPConnectionParams(
                    url=server_url,
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
