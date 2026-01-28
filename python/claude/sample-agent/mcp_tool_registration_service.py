# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
MCP Tool Registration Service for Claude Agent SDK

This service provides MCP (Model Context Protocol) tool integration for Claude agents,
similar to the OpenAI extension but adapted for Claude's tool calling mechanism.

Features:
- Discovers MCP servers from McpToolServerConfigurationService (production) or ToolingManifest.json (dev)
- Connects to MCP servers via Streamable HTTP
- Lists available tools from MCP servers
- Executes MCP tool calls and returns results
- Handles authentication and authorization
"""

from typing import Dict, List, Optional, Any
from dataclasses import dataclass, field
import logging
import os
import aiohttp
import asyncio

from microsoft_agents.hosting.core import Authorization, TurnContext
from microsoft_agents_a365.tooling.utils.constants import Constants
from microsoft_agents_a365.tooling.services.mcp_tool_server_configuration_service import (
    McpToolServerConfigurationService,
)
from microsoft_agents_a365.tooling.utils.utility import (
    get_mcp_platform_authentication_scope,
)

# Default MCP Platform endpoint (can be overridden via MCP_PLATFORM_ENDPOINT env var)
DEFAULT_MCP_PLATFORM_ENDPOINT = "https://agent365.svc.cloud.microsoft"

# Production configuration
MCP_REQUEST_TIMEOUT_SECONDS = 30
MCP_CONNECT_TIMEOUT_SECONDS = 10
MCP_MAX_RETRIES = 2
MCP_RETRY_DELAY_SECONDS = 1


def get_mcp_platform_endpoint() -> str:
    """Get the MCP platform endpoint from environment or use default."""
    endpoint = os.getenv("MCP_PLATFORM_ENDPOINT", "").strip()
    return endpoint if endpoint else DEFAULT_MCP_PLATFORM_ENDPOINT


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


# Claude SDK MCP server config type
McpHttpServerConfig = Dict[str, Any]  # {"type": "http", "url": str, "headers": dict}


class McpToolRegistrationService:
    """
    Service for managing MCP tools and servers for Claude agents.
    
    This service provides equivalent functionality to the OpenAI extension's
    McpToolRegistrationService, but adapted for Claude Agent SDK which doesn't
    have native MCP support.
    
    Discovery modes:
    - Production: Uses McpToolServerConfigurationService to discover servers from Gateway
    - Development: Falls back to ToolingManifest.json if SDK returns no servers
    """
    
    _orchestrator_name: str = "Claude"

    def __init__(self, logger: Optional[logging.Logger] = None):
        """
        Initialize the MCP Tool Registration Service for Claude.
        
        Args:
            logger: Logger instance for logging operations.
        """
        self._logger = logger or logging.getLogger(self.__class__.__name__)
        self._connected_servers: List[MCPServerConnection] = []
        self._tools_by_name: Dict[str, MCPToolDefinition] = {}
        self._auth_token: Optional[str] = None
        self._config_service = McpToolServerConfigurationService(logger=self._logger)

    def _load_manifest_servers_fallback(self) -> List[Dict[str, Any]]:
        """
        Load MCP server configurations directly from ToolingManifest.json.
        
        This is a fallback for local development when McpToolServerConfigurationService
        cannot discover servers (e.g., no Gateway connection).
        
        Returns:
            List of server configurations with name, url, scope, audience.
        """
        import json
        
        servers = []
        manifest_path = os.path.join(os.getcwd(), "ToolingManifest.json")
        
        if not os.path.exists(manifest_path):
            self._logger.debug(f"ToolingManifest.json not found at {manifest_path}")
            return servers
        
        try:
            with open(manifest_path, 'r') as f:
                manifest = json.load(f)
            
            self._logger.info(f"📄 [Fallback] Loaded ToolingManifest.json")
            
            for server in manifest.get("mcpServers", []):
                name = server.get("mcpServerName", server.get("mcpServerUniqueName", "unknown"))
                url = server.get("url", "")
                scope = server.get("scope", "")
                audience = server.get("audience", "")
                
                if url:
                    servers.append({
                        "name": name,
                        "url": url,
                        "scope": scope,
                        "audience": audience,
                    })
                    self._logger.info(f"  📌 [Manifest] Server: {name} -> {url}")
            
        except Exception as e:
            self._logger.error(f"Failed to load ToolingManifest.json: {e}")
        
        return servers

    def _build_full_url(self, server_path: str) -> str:
        """
        Build a full URL from a server path.
        
        If the path is already a full URL (http/https), return as-is.
        Otherwise, prepend the MCP platform endpoint.
        
        Args:
            server_path: The server URL or relative path
            
        Returns:
            Full URL to the MCP server
        """
        if not server_path:
            return ""
        
        # Already a full URL
        if server_path.startswith("http://") or server_path.startswith("https://"):
            return server_path
        
        # Build full URL from relative path
        platform_endpoint = get_mcp_platform_endpoint()
        
        # Handle different path formats:
        # - "/agents/servers/mcp_MailTools" -> prepend endpoint
        # - "agents/servers/mcp_MailTools" -> prepend endpoint with /
        # - "mcp_MailTools" -> assume it's under /agents/servers/
        path = server_path.lstrip("/")
        
        if not path.startswith("agents/"):
            # Just a server name like "mcp_MailTools"
            path = f"agents/servers/{path}"
        
        return f"{platform_endpoint.rstrip('/')}/{path}"

    async def discover_and_connect_servers(
        self,
        agentic_app_id: str,
        auth: Authorization,
        auth_handler_name: str,
        context: TurnContext,
        auth_token: Optional[str] = None,
    ) -> List[MCPToolDefinition]:
        """
        Discover MCP servers using McpToolServerConfigurationService and connect to them.
        
        In production, uses the SDK service to discover servers from Gateway.
        In development, falls back to ToolingManifest.json if SDK returns no servers.
        
        Args:
            agentic_app_id: The agent's application ID for server discovery.
            auth: Authorization handler for token exchange.
            auth_handler_name: Name of the authorization handler.
            context: Turn context for the current operation.
            auth_token: Optional pre-configured authentication token.
            
        Returns:
            List of all available tool definitions from connected servers.
        """
        # Get authentication token if not provided
        if not auth_token:
            try:
                scopes = get_mcp_platform_authentication_scope()
                self._logger.info(f"🔑 Attempting token exchange with scopes: {scopes}")
                auth_result = await auth.exchange_token(context, scopes, auth_handler_name)
                if auth_result and auth_result.token:
                    auth_token = auth_result.token
                    self._logger.info("✅ Token exchange successful for MCP authentication")
                else:
                    self._logger.warning("⚠️ Token exchange returned no token")
            except Exception as e:
                self._logger.warning(f"⚠️ Token exchange failed: {type(e).__name__}: {e}")
        
        # Fallback to static BEARER_TOKEN from environment
        if not auth_token:
            bearer_token = os.getenv("BEARER_TOKEN")
            if bearer_token and bearer_token not in ["your_bearer_token_here", ""]:
                auth_token = bearer_token
                self._logger.info("ℹ️ Using BEARER_TOKEN from environment for MCP authentication")
        
        # For local development, allow connections without auth token
        if not auth_token:
            self._logger.info("ℹ️ No auth token - will attempt connections (localhost may work)")
            auth_token = ""
        
        self._auth_token = auth_token
        
        # Get the MCP platform base URL for reference
        platform_endpoint = get_mcp_platform_endpoint()
        self._logger.info(f"🌐 MCP Platform endpoint: {platform_endpoint}")
        
        # Try to discover servers using McpToolServerConfigurationService (production path)
        mcp_server_configs = []
        try:
            self._logger.info(f"🔍 Discovering MCP servers for agent {agentic_app_id}")
            sdk_configs = await self._config_service.list_tool_servers(
                agentic_app_id=agentic_app_id,
                auth_token=auth_token if auth_token else None,
            )
            
            # Convert SDK config objects to our format
            for config in sdk_configs:
                # Extract URL - try different attribute names the SDK might use
                server_url = getattr(config, "url", None) or \
                             getattr(config, "server_url", None) or \
                             getattr(config, "endpoint", None)
                
                server_name = getattr(config, "mcp_server_name", None) or \
                              getattr(config, "mcp_server_unique_name", None) or \
                              getattr(config, "name", "unknown")
                
                # If URL is not a full URL, it might just be the server name/path
                if not server_url:
                    # Use server name as path if no URL provided
                    server_url = getattr(config, "mcp_server_unique_name", None) or server_name
                
                # Build full URL
                full_url = self._build_full_url(server_url)
                
                if full_url:
                    mcp_server_configs.append({
                        "name": server_name,
                        "url": full_url,
                    })
                    self._logger.info(f"  📌 [SDK] Server: {server_name} -> {full_url}")
            
            self._logger.info(f"📋 SDK discovered {len(mcp_server_configs)} MCP server(s)")
            
        except Exception as e:
            self._logger.warning(f"⚠️ McpToolServerConfigurationService failed: {e}")
        
        # Fallback to ToolingManifest.json if SDK returned no servers (development mode)
        if not mcp_server_configs:
            self._logger.info("📄 Falling back to ToolingManifest.json for server discovery")
            mcp_server_configs = self._load_manifest_servers_fallback()
        
        self._logger.info(f"Found {len(mcp_server_configs)} MCP server configurations total")
        
        # Connect to each server and fetch tools
        all_tools: List[MCPToolDefinition] = []
        
        for server_config in mcp_server_configs:
            try:
                connection = await self._connect_to_server(
                    name=server_config["name"],
                    url=server_config["url"],
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
                    f"Failed to connect to MCP server {server_config['name']}: {e}"
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
        # Check if this is a local server (no auth needed)
        is_local = url.startswith("http://localhost") or url.startswith("http://127.0.0.1")
        
        if is_local:
            headers = {
                "Content-Type": "application/json",
            }
            self._logger.info(f"🏠 Connecting to local MCP server: {url}")
        else:
            if not auth_token:
                self._logger.warning(f"⚠️ Skipping remote server {name} - no auth token")
                return None
            headers = {
                Constants.Headers.AUTHORIZATION: f"{Constants.Headers.BEARER_PREFIX} {auth_token}",
                "User-Agent": f"Claude-Agent-SDK/1.0 ({self._orchestrator_name})",
                "Content-Type": "application/json",
            }
            self._logger.info(f"☁️ Connecting to remote MCP server: {url}")
        
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

    async def _parse_sse_response(self, response) -> Dict[str, Any]:
        """
        Parse Server-Sent Events (SSE) response from MCP server.
        
        Agent 365 MCP servers use Streamable HTTP transport which returns
        responses as SSE with content-type: text/event-stream.
        
        Args:
            response: aiohttp response object
            
        Returns:
            Parsed JSON-RPC result from the SSE stream
        """
        import json
        
        content_type = response.headers.get('Content-Type', '')
        
        # If it's regular JSON, parse directly
        if 'application/json' in content_type:
            return await response.json()
        
        # Handle SSE (text/event-stream)
        result = None
        async for line in response.content:
            line_str = line.decode('utf-8').strip()
            
            # Skip empty lines and comments
            if not line_str or line_str.startswith(':'):
                continue
            
            # Parse SSE data lines
            if line_str.startswith('data:'):
                data_str = line_str[5:].strip()
                if data_str:
                    try:
                        parsed = json.loads(data_str)
                        # Look for the JSON-RPC result
                        if 'result' in parsed or 'error' in parsed:
                            result = parsed
                            break
                        # Some servers send the result directly
                        if 'jsonrpc' in parsed:
                            result = parsed
                            break
                    except json.JSONDecodeError:
                        continue
            # Handle non-prefixed JSON lines (some SSE implementations)
            elif line_str.startswith('{'):
                try:
                    parsed = json.loads(line_str)
                    if 'result' in parsed or 'jsonrpc' in parsed:
                        result = parsed
                        break
                except json.JSONDecodeError:
                    continue
        
        if result is None:
            raise Exception("No valid JSON-RPC response found in SSE stream")
        
        return result

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
        
        # Add Accept header for SSE
        request_headers = {**headers, "Accept": "text/event-stream, application/json"}
        
        # Configure timeout for production
        timeout = aiohttp.ClientTimeout(
            total=MCP_REQUEST_TIMEOUT_SECONDS,
            connect=MCP_CONNECT_TIMEOUT_SECONDS
        )
        
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(server_url, headers=request_headers, json=payload) as response:
                if response.status == 200:
                    result = await self._parse_sse_response(response)
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
                    
                    self._logger.debug(f"Listed {len(tools)} tools from {server_name}")
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
        
        Includes retry logic for transient failures and proper timeout handling.
        
        Args:
            tool_name: Name of the tool to execute.
            arguments: Tool arguments as a dictionary.
            
        Returns:
            The tool result as a string.
            
        Raises:
            ValueError: If the tool is not found or not connected.
            Exception: If the tool call fails after retries.
        """
        if tool_name not in self._tools_by_name:
            available = list(self._tools_by_name.keys())[:10]  # Limit for logging
            raise ValueError(f"Tool '{tool_name}' not found. Available tools: {available}...")
        
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
        self._logger.debug(f"Tool arguments: {arguments}")
        
        # Add Accept header for SSE
        request_headers = {**connection.headers, "Accept": "text/event-stream, application/json"}
        
        # Configure timeout for production
        timeout = aiohttp.ClientTimeout(
            total=MCP_REQUEST_TIMEOUT_SECONDS,
            connect=MCP_CONNECT_TIMEOUT_SECONDS
        )
        
        last_error = None
        for attempt in range(MCP_MAX_RETRIES + 1):
            try:
                async with aiohttp.ClientSession(timeout=timeout) as session:
                    async with session.post(
                        connection.url,
                        headers=request_headers,
                        json=payload
                    ) as response:
                        if response.status == 200:
                            result = await self._parse_sse_response(response)
                            
                            # Extract content from MCP response
                            content = result.get("result", {}).get("content", [])
                            if content and len(content) > 0:
                                # Handle different content types
                                first_content = content[0]
                                if isinstance(first_content, dict):
                                    result_text = first_content.get("text", str(first_content))
                                else:
                                    result_text = str(first_content)
                                
                                self._logger.info(f"MCP tool '{tool_name}' executed successfully")
                                return result_text
                            
                            return str(result.get("result", ""))
                        
                        elif response.status in (502, 503, 504):
                            # Retryable server errors
                            error_text = await response.text()
                            last_error = Exception(f"MCP server error: {response.status} - {error_text}")
                            self._logger.warning(f"Retryable error on attempt {attempt + 1}: {response.status}")
                        else:
                            # Non-retryable error
                            error_text = await response.text()
                            raise Exception(f"MCP tool call failed: {response.status} - {error_text}")
                            
            except asyncio.TimeoutError:
                last_error = Exception(f"MCP tool call timed out after {MCP_REQUEST_TIMEOUT_SECONDS}s")
                self._logger.warning(f"Timeout on attempt {attempt + 1} for tool '{tool_name}'")
            except aiohttp.ClientError as e:
                last_error = e
                self._logger.warning(f"Connection error on attempt {attempt + 1}: {e}")
            
            # Wait before retry (except on last attempt)
            if attempt < MCP_MAX_RETRIES:
                await asyncio.sleep(MCP_RETRY_DELAY_SECONDS)
        
        # All retries exhausted
        self._logger.error(f"MCP tool '{tool_name}' failed after {MCP_MAX_RETRIES + 1} attempts")
        raise last_error or Exception("MCP tool call failed")

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

    def get_mcp_servers_for_claude(self) -> Dict[str, McpHttpServerConfig]:
        """
        Get MCP server configurations in Claude SDK's expected format.
        
        Claude SDK expects mcp_servers as:
        {
            "server_name": {
                "type": "http",
                "url": "https://...",
                "headers": {"Authorization": "Bearer ..."}
            }
        }
        
        Returns:
            Dict mapping server names to McpHttpServerConfig objects.
        """
        mcp_servers: Dict[str, McpHttpServerConfig] = {}
        
        for connection in self._connected_servers:
            mcp_servers[connection.name] = {
                "type": "http",
                "url": connection.url,
                "headers": connection.headers,
            }
        
        return mcp_servers

    def get_allowed_tool_names_for_claude(self) -> List[str]:
        """
        Get tool names in Claude's MCP format: mcp__<server>__<tool>
        
        Returns:
            List of tool names prefixed for Claude MCP usage.
        """
        allowed_tools = []
        
        for tool in self._tools_by_name.values():
            # Claude MCP tool naming convention: mcp__<server_name>__<tool_name>
            prefixed_name = f"mcp__{tool.server_name}__{tool.name}"
            allowed_tools.append(prefixed_name)
        
        return allowed_tools

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
