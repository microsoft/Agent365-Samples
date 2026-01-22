# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
MCP Tool Registration Service for Claude Agent SDK

This service provides MCP (Model Context Protocol) tool integration for Claude agents,
similar to the OpenAI extension but adapted for Claude's tool calling mechanism.

Features:
- Discovers MCP servers from configuration
- Connects to MCP servers via Streamable HTTP
- Lists available tools from MCP servers
- Executes MCP tool calls and returns results
- Handles authentication and authorization
"""

from typing import Dict, List, Optional, Any
from dataclasses import dataclass, field
import logging
import aiohttp

from microsoft_agents.hosting.core import Authorization, TurnContext
from microsoft_agents_a365.runtime.utility import Utility
from microsoft_agents_a365.tooling.services.mcp_tool_server_configuration_service import (
    McpToolServerConfigurationService,
)
from microsoft_agents_a365.tooling.utils.constants import Constants


@dataclass
class MCPToolDefinition:
    """Definition of an MCP tool"""
    name: str
    description: str
    input_schema: Dict[str, Any]
    server_url: str
    server_name: str


@dataclass
class MCPServerConnection:
    """Information about a connected MCP server"""
    name: str
    url: str
    headers: Dict[str, str] = field(default_factory=dict)
    tools: List[MCPToolDefinition] = field(default_factory=list)
    connected: bool = False


class McpToolRegistrationService:
    """
    Service for managing MCP tools and servers for Claude agents.
    
    This service provides equivalent functionality to the OpenAI extension's
    McpToolRegistrationService, but adapted for Claude Agent SDK which doesn't
    have native MCP support.
    """
    
    _orchestrator_name: str = "Claude"

    def __init__(self, logger: Optional[logging.Logger] = None):
        """
        Initialize the MCP Tool Registration Service for Claude.
        
        Args:
            logger: Logger instance for logging operations.
        """
        self._logger = logger or logging.getLogger(self.__class__.__name__)
        self.config_service = McpToolServerConfigurationService(logger=self._logger)
        self._connected_servers: List[MCPServerConnection] = []
        self._tools_by_name: Dict[str, MCPToolDefinition] = {}
        self._auth_token: Optional[str] = None

    async def discover_and_connect_servers(
        self,
        auth: Authorization,
        auth_handler_name: str,
        context: TurnContext,
        auth_token: Optional[str] = None,
    ) -> List[MCPToolDefinition]:
        """
        Discover MCP servers and connect to them.
        
        Args:
            auth: Authorization handler for token exchange.
            auth_handler_name: Name of the authorization handler.
            context: Turn context for the current operation.
            auth_token: Optional pre-configured authentication token.
            
        Returns:
            List of all available tool definitions from connected servers.
        """
        # Get authentication token if not provided
        if not auth_token:
            from microsoft_agents_a365.tooling.utils.utility import (
                get_mcp_platform_authentication_scope,
            )
            scopes = get_mcp_platform_authentication_scope()
            auth_result = await auth.exchange_token(context, scopes, auth_handler_name)
            auth_token = auth_result.token
        
        self._auth_token = auth_token
        
        # Get MCP server configurations
        agentic_app_id = Utility.resolve_agent_identity(context, auth_token)
        
        self._logger.info(f"Discovering MCP tool servers for agent {agentic_app_id}")
        
        mcp_server_configs = await self.config_service.list_tool_servers(
            agentic_app_id=agentic_app_id,
            auth_token=auth_token,
        )
        
        self._logger.info(f"Found {len(mcp_server_configs)} MCP server configurations")
        
        # Connect to each server and fetch tools
        all_tools: List[MCPToolDefinition] = []
        
        for server_config in mcp_server_configs:
            try:
                connection = await self._connect_to_server(
                    name=server_config.mcp_server_name,
                    url=server_config.mcp_server_unique_name,
                    auth_token=auth_token,
                )
                
                if connection and connection.connected:
                    self._connected_servers.append(connection)
                    all_tools.extend(connection.tools)
                    
                    # Index tools by name for quick lookup
                    for tool in connection.tools:
                        self._tools_by_name[tool.name] = tool
                    
                    self._logger.info(
                        f"Connected to MCP server '{connection.name}' with "
                        f"{len(connection.tools)} tools"
                    )
                    
            except Exception as e:
                self._logger.warning(
                    f"Failed to connect to MCP server {server_config.mcp_server_name}: {e}"
                )
                continue
        
        self._logger.info(f"Total {len(all_tools)} MCP tools available")
        return all_tools

    async def _connect_to_server(
        self,
        name: str,
        url: str,
        auth_token: str,
    ) -> Optional[MCPServerConnection]:
        """
        Connect to an MCP server and fetch its tools.
        
        Args:
            name: Server display name.
            url: Server URL endpoint.
            auth_token: Authentication token.
            
        Returns:
            MCPServerConnection with tools, or None if connection failed.
        """
        headers = {
            Constants.Headers.AUTHORIZATION: f"{Constants.Headers.BEARER_PREFIX} {auth_token}",
            Constants.Headers.USER_AGENT: Utility.get_user_agent_header(self._orchestrator_name),
            "Content-Type": "application/json",
        }
        
        connection = MCPServerConnection(
            name=name,
            url=url,
            headers=headers,
        )
        
        try:
            # Fetch available tools from the server
            tools = await self._list_server_tools(url, headers, name)
            connection.tools = tools
            connection.connected = True
            return connection
            
        except Exception as e:
            self._logger.error(f"Failed to connect to MCP server {name} at {url}: {e}")
            return None

    async def _list_server_tools(
        self,
        server_url: str,
        headers: Dict[str, str],
        server_name: str,
    ) -> List[MCPToolDefinition]:
        """
        List available tools from an MCP server.
        
        Args:
            server_url: The MCP server URL endpoint.
            headers: HTTP headers including authorization.
            server_name: Server name for tool attribution.
            
        Returns:
            List of tool definitions.
        """
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/list",
            "params": {}
        }
        
        async with aiohttp.ClientSession() as session:
            async with session.post(server_url, headers=headers, json=payload) as response:
                if response.status == 200:
                    result = await response.json()
                    tools_data = result.get("result", {}).get("tools", [])
                    
                    tools = []
                    for tool_data in tools_data:
                        tool = MCPToolDefinition(
                            name=tool_data.get("name", ""),
                            description=tool_data.get("description", ""),
                            input_schema=tool_data.get("inputSchema", {}),
                            server_url=server_url,
                            server_name=server_name,
                        )
                        tools.append(tool)
                    
                    return tools
                else:
                    error_text = await response.text()
                    raise Exception(f"Failed to list tools: {response.status} - {error_text}")

    async def call_tool(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
    ) -> str:
        """
        Execute an MCP tool and return the result.
        
        Args:
            tool_name: Name of the tool to execute.
            arguments: Tool arguments as a dictionary.
            
        Returns:
            The tool result as a string.
            
        Raises:
            ValueError: If the tool is not found or not connected.
        """
        if tool_name not in self._tools_by_name:
            raise ValueError(f"Tool '{tool_name}' not found. Available tools: {list(self._tools_by_name.keys())}")
        
        tool = self._tools_by_name[tool_name]
        
        # Find the connection for this tool
        connection = None
        for conn in self._connected_servers:
            if conn.url == tool.server_url:
                connection = conn
                break
        
        if not connection:
            raise ValueError(f"No connection found for tool '{tool_name}'")
        
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments
            }
        }
        
        self._logger.info(f"Calling MCP tool '{tool_name}' on server '{connection.name}'")
        
        async with aiohttp.ClientSession() as session:
            async with session.post(
                connection.url,
                headers=connection.headers,
                json=payload
            ) as response:
                if response.status == 200:
                    result = await response.json()
                    
                    # Extract content from MCP response
                    content = result.get("result", {}).get("content", [])
                    if content and len(content) > 0:
                        # Handle different content types
                        first_content = content[0]
                        if isinstance(first_content, dict):
                            return first_content.get("text", str(first_content))
                        return str(first_content)
                    
                    return str(result.get("result", ""))
                else:
                    error_text = await response.text()
                    raise Exception(f"MCP tool call failed: {response.status} - {error_text}")

    def get_tools_for_claude(self) -> List[Dict[str, Any]]:
        """
        Get tool definitions in Claude's expected format.
        
        Returns:
            List of tool definitions compatible with Claude's tool use format.
        """
        claude_tools = []
        
        for tool in self._tools_by_name.values():
            claude_tool = {
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.input_schema,
            }
            claude_tools.append(claude_tool)
        
        return claude_tools

    def get_available_tool_names(self) -> List[str]:
        """
        Get list of available MCP tool names.
        
        Returns:
            List of tool names that can be called.
        """
        return list(self._tools_by_name.keys())

    async def cleanup(self):
        """Clean up all connected MCP servers."""
        self._connected_servers = []
        self._tools_by_name = {}
        self._auth_token = None
        self._logger.info("MCP tool registration service cleaned up")
