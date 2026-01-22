# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""
Lightweight MCP tool registration for CrewAI wrapper.

"""

from typing import Optional, List
import logging

from microsoft_agents.hosting.core import Authorization, TurnContext

from microsoft_agents_a365.tooling.services.mcp_tool_server_configuration_service import (
    McpToolServerConfigurationService,
)
from microsoft_agents_a365.tooling.utils.utility import (
    get_mcp_platform_authentication_scope,
)


class McpToolRegistrationService:
    """Service for listing MCP tool servers for an agentic app id."""

    def __init__(self, logger: Optional[logging.Logger] = None):
        self._logger = logger or logging.getLogger(self.__class__.__name__)
        self.config_service = McpToolServerConfigurationService(logger=self._logger)

    async def list_tool_servers(
        self,
        agentic_app_id: str,
        auth: Authorization,
        context: TurnContext,
        auth_token: Optional[str] = None,
        auth_handler_name: str = "AGENTIC"
    ) -> List:
        """
        Fetch MCP server configurations the agent is allowed to use.

        Returns a list of MCP server configuration objects (metadata only).
        """
        token = auth_token
        if not token:
            scopes = get_mcp_platform_authentication_scope()
            auth_token_obj = await auth.exchange_token(context, scopes, auth_handler_name)
            token = auth_token_obj.token

        self._logger.info("Listing MCP tool servers for agent %s", agentic_app_id)
        mcp_server_configs = await self.config_service.list_tool_servers(
            agentic_app_id=agentic_app_id,
            auth_token=token,
        )

        self._logger.info("Loaded %d MCP server configurations", len(mcp_server_configs))
        return mcp_server_configs
