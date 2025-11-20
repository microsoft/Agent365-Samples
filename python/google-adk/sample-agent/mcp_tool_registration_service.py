# Copyright (c) Microsoft. All rights reserved.

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
        Initialize the MCP Tool Registration Service for OpenAI.

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
        context: TurnContext,
        auth_token: Optional[str] = None,
    ):
        """
        Add new MCP servers to the agent by creating a new Agent instance.

        Note: This method creates a new Agent instance with MCP servers configured.

        Args:
            agent: The existing agent to add servers to
            agentic_app_id: Agentic App ID for the agent
            auth_token: Authentication token to access the MCP servers

        Returns:
            New Agent instance with all MCP servers, or original agent if no new servers
        """

        if not auth_token:
            scopes = get_mcp_platform_authentication_scope()
            authToken = await auth.exchange_token(context, scopes, "AGENTIC")
            auth_token = authToken.token

        self._logger.info(f"Listing MCP tool servers for agent {agentic_app_id}")
        mcp_server_configs = await self.config_service.list_tool_servers(
                agentic_app_id=agentic_app_id,
                auth_token=auth_token
            )

        self._logger.info(f"Loaded {len(mcp_server_configs)} MCP server configurations")

        # Convert MCP server configs to MCPServerInfo objects
        mcp_servers_info = []
        mcp_server_headers = {
            "Authorization": f"Bearer {auth_token}"
        }

        for server_config in mcp_server_configs:
            server_info = McpToolset(
                connection_params=StreamableHTTPConnectionParams(
                    url=server_config.mcp_server_unique_name,
                    headers=mcp_server_headers
                )
            )

            mcp_servers_info.append(server_info)

        allTools = agent.tools + mcp_servers_info

        return Agent(
            name=agent.name,
            model=agent.model,
            description=agent.description,
            tools=allTools,
        )
