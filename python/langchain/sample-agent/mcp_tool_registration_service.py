# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

from typing import Optional
import logging

from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_core.tools import BaseTool

from microsoft_agents.hosting.core import Authorization, TurnContext

from microsoft_agents_a365.tooling.services.mcp_tool_server_configuration_service import (
    McpToolServerConfigurationService,
)

from microsoft_agents_a365.tooling.utils.utility import (
    get_mcp_platform_authentication_scope,
)


class McpToolRegistrationService:
    """Service for managing MCP tools and servers for a LangChain agent."""

    def __init__(self, logger: Optional[logging.Logger] = None):
        self._logger = logger or logging.getLogger(self.__class__.__name__)
        self.config_service = McpToolServerConfigurationService(logger=self._logger)

    async def get_mcp_tools(
        self,
        agentic_app_id: str,
        auth: Authorization,
        auth_handler_name: str,
        context: TurnContext,
        auth_token: Optional[str] = None,
    ) -> tuple[list[BaseTool], Optional[MultiServerMCPClient]]:
        """
        Discover MCP servers and return LangChain-compatible tools.

        Args:
            agentic_app_id: Agentic App ID for the agent.
            auth: Authorization object used to exchange tokens for MCP server access.
            auth_handler_name: Name of the auth handler for token exchange.
            context: TurnContext for the current turn/session.
            auth_token: Optional pre-existing auth token.

        Returns:
            Tuple of (list of LangChain tools, MCP client to keep alive during the turn).
        """
        if not auth_token:
            scopes = get_mcp_platform_authentication_scope()
            auth_token_obj = await auth.exchange_token(context, scopes, auth_handler_name)
            auth_token = auth_token_obj.token

        self._logger.info("Listing MCP tool servers for agent %s", agentic_app_id)
        mcp_server_configs = await self.config_service.list_tool_servers(
            agentic_app_id=agentic_app_id,
            auth_token=auth_token,
        )

        self._logger.info("Loaded %d MCP server configurations", len(mcp_server_configs))

        # Build connection config for langchain-mcp-adapters
        server_connections = {}
        for server_config in mcp_server_configs:
            if not server_config.url:
                self._logger.warning(
                    "Skipping MCP server '%s' — no URL configured.",
                    server_config.mcp_server_unique_name,
                )
                continue

            server_connections[server_config.mcp_server_unique_name] = {
                "url": server_config.url,
                "transport": "http",
                "headers": {
                    "Authorization": f"Bearer {auth_token}",
                },
            }

        if not server_connections:
            self._logger.info("No MCP server connections configured — running without tools")
            return [], None

        # Connect to MCP servers and get LangChain tools
        client = MultiServerMCPClient(server_connections)
        tools = await client.get_tools()
        self._logger.info("Registered %d MCP tools from %d servers", len(tools), len(server_connections))

        return tools, client
