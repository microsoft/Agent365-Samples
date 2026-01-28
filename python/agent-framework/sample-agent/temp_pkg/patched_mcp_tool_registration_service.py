# Copyright (c) Microsoft. All rights reserved.

from typing import Optional, List, Any, Union
import logging
import httpx

from agent_framework import ChatAgent, MCPStreamableHTTPTool
from agent_framework.azure import AzureOpenAIChatClient
from agent_framework.openai import OpenAIChatClient

from microsoft_agents.hosting.core import Authorization, TurnContext

from microsoft_agents_a365.runtime.utility import Utility
from microsoft_agents_a365.tooling.services.mcp_tool_server_configuration_service import (
    McpToolServerConfigurationService,
)
from microsoft_agents_a365.tooling.utils.constants import Constants

from microsoft_agents_a365.tooling.utils.utility import (
    get_mcp_platform_authentication_scope,
)

# Timeout constant for HTTP client requests (in seconds)
MCP_HTTP_CLIENT_TIMEOUT_SECONDS = 60.0


class McpToolRegistrationService:
    """
    Provides MCP tool registration services for Agent Framework agents.

    This service handles registration and management of MCP (Model Context Protocol)
    tool servers with Agent Framework agents.
    """

    def __init__(self, logger: Optional[logging.Logger] = None):
        """
        Initialize the MCP Tool Registration Service for Agent Framework.

        Args:
            logger: Logger instance for logging operations.
        """
        self._logger = logger or logging.getLogger(self.__class__.__name__)
        self._mcp_server_configuration_service = McpToolServerConfigurationService(
            logger=self._logger
        )
        self._connected_servers = []
        self._http_clients = []

    async def add_tool_servers_to_agent(
        self,
        chat_client: Union[OpenAIChatClient, AzureOpenAIChatClient],
        agent_instructions: str,
        initial_tools: List[Any],
        auth: Authorization,
        auth_handler_name: str,
        turn_context: TurnContext,
        auth_token: Optional[str] = None,
    ) -> Optional[ChatAgent]:
        """
        Add MCP tool servers to a chat agent (mirrors .NET implementation).

        Args:
            chat_client: The chat client instance (Union[OpenAIChatClient, AzureOpenAIChatClient])
            agent_instructions: Instructions for the agent behavior
            initial_tools: List of initial tools to add to the agent
            auth: Authorization context for token exchange
            auth_handler_name: Name of the authorization handler.
            turn_context: Turn context for the operation
            auth_token: Optional bearer token for authentication

        Returns:
            ChatAgent instance with MCP tools registered, or None if creation failed
        """
        try:
            # Exchange token if not provided
            if not auth_token:
                scopes = get_mcp_platform_authentication_scope()
                authToken = await auth.exchange_token(turn_context, scopes, auth_handler_name)
                auth_token = authToken.token

            agentic_app_id = Utility.resolve_agent_identity(turn_context, auth_token)

            self._logger.info(f"Listing MCP tool servers for agent {agentic_app_id}")

            # Get MCP server configurations
            server_configs = await self._mcp_server_configuration_service.list_tool_servers(
                agentic_app_id=agentic_app_id,
                auth_token=auth_token,
            )

            self._logger.info(f"Loaded {len(server_configs)} MCP server configurations")

            # Create the agent with all tools (initial + MCP tools)
            all_tools = list(initial_tools)

            # Add servers as MCPStreamableHTTPTool instances
            for config in server_configs:
                try:
                    server_url = getattr(config, "server_url", None) or getattr(
                        config, "mcp_server_unique_name", None
                    )
                    if not server_url:
                        self._logger.warning(f"MCP server config missing server_url: {config}")
                        continue

                    # Prepare auth headers
                    headers = {}
                    if auth_token:
                        headers[Constants.Headers.AUTHORIZATION] = (
                            f"{Constants.Headers.BEARER_PREFIX} {auth_token}"
                        )

                    server_name = getattr(config, "mcp_server_name", "Unknown")

                    # Create HTTP client with headers configured
                    # MCPStreamableHTTPTool requires http_client parameter for headers to work
                    http_client = httpx.AsyncClient(
                        headers=headers,
                        timeout=MCP_HTTP_CLIENT_TIMEOUT_SECONDS
                    )
                    self._http_clients.append(http_client)

                    # Create and configure MCPStreamableHTTPTool
                    mcp_tools = MCPStreamableHTTPTool(
                        name=server_name,
                        url=server_url,
                        http_client=http_client,
                        description=f"MCP tools from {server_name}",
                    )

                    # Let Agent Framework handle the connection automatically
                    self._logger.info(f"Created MCP plugin for '{server_name}' at {server_url}")

                    all_tools.append(mcp_tools)
                    self._connected_servers.append(mcp_tools)

                    self._logger.info(f"Added MCP plugin '{server_name}' to agent tools")

                except Exception as tool_ex:
                    server_name = getattr(config, "mcp_server_name", "Unknown")
                    self._logger.warning(
                        f"Failed to create MCP plugin for {server_name}: {tool_ex}"
                    )
                    continue

            # Create the ChatAgent
            agent = ChatAgent(
                chat_client=chat_client,
                tools=all_tools,
                instructions=agent_instructions,
            )

            self._logger.info(f"Agent created with {len(all_tools)} total tools")
            return agent

        except Exception as ex:
            self._logger.error(f"Failed to add tool servers to agent: {ex}")
            raise

    async def cleanup(self):
        """Clean up any resources used by the service."""
        try:
            for plugin in self._connected_servers:
                try:
                    if hasattr(plugin, "close"):
                        await plugin.close()
                except Exception as cleanup_ex:
                    self._logger.debug(f"Error during cleanup: {cleanup_ex}")
            self._connected_servers.clear()

            # Clean up HTTP clients to prevent resource leaks
            for client in self._http_clients:
                try:
                    await client.aclose()
                except Exception as client_ex:
                    self._logger.debug(f"Error closing HTTP client: {client_ex}")
            self._http_clients.clear()
        except Exception as ex:
            self._logger.debug(f"Error during service cleanup: {ex}")
