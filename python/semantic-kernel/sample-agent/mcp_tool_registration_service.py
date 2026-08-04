# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
MCP Tool Registration Service for Semantic Kernel.

Thin wrapper around the Agent365 SDK's McpToolServerConfigurationService that
discovers MCP servers, builds properly authenticated headers, and registers
them as Semantic Kernel plugins via the MCP connector.
"""

import json
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


class McpToolRegistrationService:
    """
    Service for managing MCP tools and servers for Semantic Kernel agents.

    Delegates all discovery and configuration to the SDK's
    McpToolServerConfigurationService and exposes results so they can be
    registered as Semantic Kernel plugins.
    """

    _orchestrator_name: str = "SemanticKernel"

    def __init__(self, logger: Optional[logging.Logger] = None) -> None:
        self._logger = logger or logging.getLogger(self.__class__.__name__)
        self._config_service = McpToolServerConfigurationService(logger=self._logger)
        self._server_configs: list = []
        self._mcp_plugins: list = []  # Track connected plugins for cleanup
        self._auth_token: Optional[str] = None
        self._headers: Dict[str, str] = {}

    # ------------------------------------------------------------------
    # Discovery
    # ------------------------------------------------------------------

    async def discover_servers(
        self,
        auth: Authorization,
        auth_handler_name: str,
        context: TurnContext,
        auth_token: Optional[str] = None,
    ) -> None:
        """
        Discover MCP servers via the SDK and prepare authentication headers.

        Args:
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

        self._auth_token = auth_token

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

        self._server_configs = server_configs
        self._logger.info("Loaded %d MCP server configurations", len(server_configs))

        # --- Build headers (same logic as the SDK extensions) ------------
        self._headers = {
            Constants.Headers.AUTHORIZATION: (
                f"{Constants.Headers.BEARER_PREFIX} {auth_token}"
            ),
            Constants.Headers.USER_AGENT: Utility.get_user_agent_header(
                self._orchestrator_name
            ),
        }

    # ------------------------------------------------------------------
    # Semantic Kernel Registration
    # ------------------------------------------------------------------

    async def add_tools_to_kernel(self, kernel) -> int:
        """
        Register discovered MCP servers as Semantic Kernel plugins.

        Uses the Semantic Kernel MCP connector to register each MCP server
        as a plugin with auto-discovered tools.

        Args:
            kernel: The Semantic Kernel instance to register plugins with.

        Returns:
            Number of MCP servers registered.
        """
        if not self._server_configs:
            self._logger.info("No MCP servers to register with kernel")
            return 0

        registered = 0
        for config in self._server_configs:
            server_name = config.mcp_server_name or config.mcp_server_unique_name
            server_url = config.url

            try:
                # Use Semantic Kernel's MCP plugin loading
                # SK Python supports adding MCP servers as plugins
                from semantic_kernel.connectors.mcp import MCPStreamableHttpPlugin

                plugin = MCPStreamableHttpPlugin(
                    url=server_url,
                    headers=dict(self._headers),
                    name=server_name,
                )
                # Must connect before tools are available
                await plugin.connect()
                kernel.add_plugin(plugin, plugin_name=server_name)
                self._mcp_plugins.append(plugin)
                registered += 1
                self._logger.info(
                    "Registered MCP server '%s' at %s as SK plugin (%d tools loaded)",
                    server_name,
                    server_url,
                    len(plugin.functions) if hasattr(plugin, 'functions') else 0,
                )
            except ImportError:
                self._logger.warning(
                    "MCPStreamableHttpPlugin not available in this semantic-kernel version. "
                    "Falling back to manual MCP tool registration for '%s'.",
                    server_name,
                )
                # Fallback: register tools manually via httpx MCP calls
                await self._register_mcp_tools_manually(kernel, server_name, server_url)
                registered += 1
            except Exception as e:
                self._logger.error(
                    "Failed to register MCP server '%s': %s", server_name, e
                )

        return registered

    async def _register_mcp_tools_manually(
        self, kernel, server_name: str, server_url: str
    ) -> None:
        """
        Fallback: manually discover and register MCP tools as kernel functions.

        Uses the MCP JSON-RPC protocol to list tools and creates kernel functions
        for each discovered tool.

        Args:
            kernel: The Semantic Kernel instance.
            server_name: Name of the MCP server.
            server_url: URL of the MCP server.
        """
        import httpx
        from semantic_kernel.functions import KernelFunction, KernelPlugin

        try:
            # Initialize MCP session
            async with httpx.AsyncClient(timeout=30.0) as client:
                # Send initialize request
                init_response = await client.post(
                    server_url,
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "protocolVersion": "2025-03-26",
                            "capabilities": {},
                            "clientInfo": {
                                "name": "semantic-kernel-agent",
                                "version": "1.0.0",
                            },
                        },
                    },
                    headers=self._headers,
                )
                init_data = init_response.json()
                session_id = init_response.headers.get("mcp-session-id")

                headers_with_session = dict(self._headers)
                if session_id:
                    headers_with_session["mcp-session-id"] = session_id

                # Send initialized notification
                await client.post(
                    server_url,
                    json={
                        "jsonrpc": "2.0",
                        "method": "notifications/initialized",
                    },
                    headers=headers_with_session,
                )

                # List tools
                tools_response = await client.post(
                    server_url,
                    json={
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/list",
                        "params": {},
                    },
                    headers=headers_with_session,
                )
                tools_data = tools_response.json()
                tools = tools_data.get("result", {}).get("tools", [])

                self._logger.info(
                    "Discovered %d tools from MCP server '%s'", len(tools), server_name
                )

                # Create kernel functions for each tool
                functions = []
                for tool in tools:
                    tool_name = tool.get("name", "unknown")
                    tool_description = tool.get("description", "")
                    input_schema = tool.get("inputSchema", {})

                    # Create a closure-based kernel function for each MCP tool
                    fn = self._create_mcp_tool_function(
                        server_name=server_name,
                        server_url=server_url,
                        session_id=session_id,
                        tool_name=tool_name,
                        tool_description=tool_description,
                        input_schema=input_schema,
                    )
                    functions.append(fn)

                if functions:
                    plugin = KernelPlugin(name=server_name, functions=functions)
                    kernel.add_plugin(plugin)
                    self._logger.info(
                        "Registered %d tools from '%s' as kernel plugin",
                        len(functions),
                        server_name,
                    )

        except Exception as e:
            self._logger.error(
                "Failed to discover tools from MCP server '%s': %s", server_name, e
            )

    def _create_mcp_tool_function(
        self,
        server_name: str,
        server_url: str,
        session_id: Optional[str],
        tool_name: str,
        tool_description: str,
        input_schema: dict,
    ) -> "KernelFunction":
        """
        Create a KernelFunction that calls an MCP tool via JSON-RPC.

        Args:
            server_name: Name of the MCP server.
            server_url: URL of the MCP server.
            session_id: MCP session ID from initialization.
            tool_name: Name of the tool.
            tool_description: Description of the tool.
            input_schema: JSON schema for tool input.

        Returns:
            A KernelFunction wrapping the MCP tool call.
        """
        from semantic_kernel.functions import kernel_function

        headers = dict(self._headers)
        if session_id:
            headers["mcp-session-id"] = session_id

        @kernel_function(name=tool_name, description=tool_description)
        async def mcp_tool_call(**kwargs) -> str:
            """Execute an MCP tool via JSON-RPC."""
            import httpx

            # Filter out SK internal kwargs
            arguments = {
                k: v for k, v in kwargs.items()
                if k not in ("kernel", "service_id", "execution_settings", "arguments")
            }

            try:
                async with httpx.AsyncClient(timeout=60.0) as client:
                    response = await client.post(
                        server_url,
                        json={
                            "jsonrpc": "2.0",
                            "id": 3,
                            "method": "tools/call",
                            "params": {
                                "name": tool_name,
                                "arguments": arguments,
                            },
                        },
                        headers=headers,
                    )
                    result = response.json()
                    tool_result = result.get("result", {})

                    # Extract content from MCP response
                    content_list = tool_result.get("content", [])
                    text_parts = []
                    for item in content_list:
                        if item.get("type") == "text":
                            text_parts.append(item.get("text", ""))

                    return "\n".join(text_parts) if text_parts else json.dumps(tool_result)

            except Exception as e:
                return f"Error calling MCP tool '{tool_name}': {e}"

        return mcp_tool_call

    # ------------------------------------------------------------------
    # Accessors
    # ------------------------------------------------------------------

    def get_server_names(self) -> List[str]:
        """Get list of discovered MCP server names."""
        return [
            c.mcp_server_name or c.mcp_server_unique_name
            for c in self._server_configs
        ]

    def get_server_count(self) -> int:
        """Get number of discovered MCP servers."""
        return len(self._server_configs)

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    async def cleanup(self) -> None:
        """Clean up all MCP server connections."""
        for plugin in self._mcp_plugins:
            try:
                await plugin.close()
            except Exception as e:
                self._logger.warning("Error closing MCP plugin: %s", e)
        self._mcp_plugins = []
        self._server_configs = []
        self._auth_token = None
        self._headers = {}
        self._logger.info("MCP tool registration service cleaned up")
