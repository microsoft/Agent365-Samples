# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
MCP Tool Registration Service for Claude Agent SDK.

Thin wrapper around the Agent365 SDK's McpToolServerConfigurationService that
discovers MCP servers, builds properly authenticated headers, and exposes the
result in the format Claude SDK expects.
"""

import logging
from typing import Dict, List, Optional

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


# Claude SDK MCP server config type: {"type": "http", "url": str, "headers": dict}
McpHttpServerConfig = Dict[str, object]


class McpToolRegistrationService:
    """
    Service for managing MCP tools and servers for Claude agents.

    Delegates all discovery and configuration to the SDK's
    McpToolServerConfigurationService and exposes results in the
    ``{server_name: {type, url, headers}}`` format that the Claude SDK expects.
    """

    _orchestrator_name: str = "Claude"

    def __init__(self, logger: Optional[logging.Logger] = None) -> None:
        self._logger = logger or logging.getLogger(self.__class__.__name__)
        self._config_service = McpToolServerConfigurationService(logger=self._logger)
        self._connected_servers: Dict[str, McpHttpServerConfig] = {}
        self._allowed_tool_names: List[str] = []

    # ------------------------------------------------------------------
    # Discovery
    # ------------------------------------------------------------------

    async def discover_and_connect_servers(
        self,
        agentic_app_id: str,
        auth: Authorization,
        auth_handler_name: str,
        context: TurnContext,
        auth_token: Optional[str] = None,
    ) -> None:
        """
        Discover MCP servers via the SDK and prepare them for Claude.

        Args:
            agentic_app_id: The agent's application ID for server discovery.
            auth: Authorization handler for token exchange.
            auth_handler_name: Name of the authorization handler.
            context: Turn context for the current operation.
            auth_token: Optional pre-configured authentication token.
        """
        # --- Authenticate ------------------------------------------------
        if auth_token is None or auth_token.strip() == "":
            scopes = get_mcp_platform_authentication_scope()
            self._logger.info("Exchanging token with scopes: %s", scopes)
            auth_result = await auth.exchange_token(context, scopes, auth_handler_name)
            if not auth_result or not auth_result.token:
                raise RuntimeError(
                    f"Auth handler '{auth_handler_name}' failed to provide a token."
                )
            auth_token = auth_result.token

        # --- Discover servers via SDK ------------------------------------
        agentic_app_id = Utility.resolve_agent_identity(context, auth_token)
        options = ToolOptions(orchestrator_name=self._orchestrator_name)

        self._logger.info("Listing MCP tool servers for agent %s", agentic_app_id)
        try:
            server_configs = await self._config_service.list_tool_servers(
                agentic_app_id=agentic_app_id,
                auth_token=auth_token,
                options=options,
            )
        except Exception as e:
            self._logger.warning("SDK server discovery failed: %s", e)
            server_configs = []

        if not server_configs:
            self._logger.info("Falling back to ToolingManifest.json for server discovery")
            server_configs = self._config_service._load_servers_from_manifest()

        self._logger.info("Loaded %d MCP server configurations", len(server_configs))

        # --- Build headers (same logic as the SDK extensions) ------------
        headers: Dict[str, str] = {
            Constants.Headers.AUTHORIZATION: (
                f"{Constants.Headers.BEARER_PREFIX} {auth_token}"
            ),
            Constants.Headers.USER_AGENT: Utility.get_user_agent_header(
                self._orchestrator_name
            ),
        }

        # --- Register each server in Claude format ----------------------
        self._connected_servers = {}
        self._allowed_tool_names = []

        for config in server_configs:
            server_name = config.mcp_server_name or config.mcp_server_unique_name
            server_url = config.url

            self._connected_servers[server_name] = {
                "type": "http",
                "url": server_url,
                "headers": dict(headers),
            }

            # Allow all tools from this server via wildcard pattern
            self._allowed_tool_names.append(f"mcp__{server_name}__*")

            self._logger.info(
                "Registered MCP server '%s' at %s", server_name, server_url
            )

    # ------------------------------------------------------------------
    # Claude SDK accessors
    # ------------------------------------------------------------------

    def get_mcp_servers_for_claude(self) -> Dict[str, McpHttpServerConfig]:
        """
        Get MCP server configurations in Claude SDK's expected format.

        Returns:
            Dict mapping server names to ``{type, url, headers}`` configs.
        """
        return dict(self._connected_servers)

    def get_allowed_tool_names_for_claude(self) -> List[str]:
        """
        Get tool names in Claude's MCP format: ``mcp__<server>__<tool>``.

        Returns:
            List of prefixed tool names for ``allowed_tools``.
        """
        return list(self._allowed_tool_names)

    def get_available_tool_names(self) -> List[str]:
        """Get list of connected MCP server names."""
        return list(self._connected_servers.keys())

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    async def cleanup(self) -> None:
        """Clean up all connected MCP servers."""
        self._connected_servers = {}
        self._allowed_tool_names = []
        self._logger.info("MCP tool registration service cleaned up")
