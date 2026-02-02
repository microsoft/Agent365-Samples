# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
MCP Observable Tools Module

Creates CrewAI-compatible tool wrappers for MCP tools with ExecuteToolScope observability.
This module separates the MCP tool wrapper logic from the main agent for better readability.
"""

import asyncio
import json
import logging
import uuid
from typing import TYPE_CHECKING, Any, Type
from urllib.parse import urlparse

from crewai.tools import BaseTool
from pydantic import BaseModel, Field, create_model

from microsoft_agents_a365.observability.core import ExecuteToolScope, ToolCallDetails
from mcp_tool_registration_service import MCPToolDefinition

if TYPE_CHECKING:
    from mcp_tool_registration_service import McpToolRegistrationService

logger = logging.getLogger(__name__)


class MCPToolExecutor:
    """
    Handles MCP tool execution with observability tracing.
    
    This class encapsulates the logic for calling MCP tools with proper
    ExecuteToolScope observability, separated from the main agent class.
    """

    def __init__(self, mcp_service: "McpToolRegistrationService"):
        """
        Initialize the MCP tool executor.
        
        Args:
            mcp_service: The MCP tool registration service for executing tools
        """
        self.mcp_service = mcp_service

    async def call_tool(
        self,
        tool_name: str,
        arguments: dict,
        agent_details: Any,
        tenant_details: Any,
    ) -> str:
        """
        Call an MCP tool by name with ExecuteToolScope observability.
        
        Args:
            tool_name: Name of the tool to call
            arguments: Tool arguments as a dictionary
            agent_details: AgentDetails for observability
            tenant_details: TenantDetails for observability
            
        Returns:
            The tool result as a string
        """
        tool = self.mcp_service.get_tool_by_name(tool_name)
        tool_call_id = str(uuid.uuid4())
        
        # Serialize arguments for observability
        try:
            args_str = json.dumps(arguments) if arguments else ""
        except (TypeError, ValueError):
            args_str = str(arguments) if arguments else ""
        
        # Determine endpoint URL
        endpoint_url = tool.server_url if tool else ""
        endpoint = urlparse(endpoint_url) if endpoint_url else None
        
        # Create ToolCallDetails for observability
        tool_call_details = ToolCallDetails(
            tool_name=tool_name,
            arguments=args_str,
            tool_call_id=tool_call_id,
            description=f"Executing MCP tool: {tool_name}",
            tool_type="mcp_extension",
            endpoint=endpoint,
        )
        
        # Execute with ExecuteToolScope for observability
        with ExecuteToolScope.start(
            details=tool_call_details,
            agent_details=agent_details,
            tenant_details=tenant_details,
        ) as tool_scope:
            try:
                logger.info(f"🔧 Calling MCP tool: {tool_name}")
                result = await self.mcp_service.call_tool(tool_name, arguments)
                
                # Record the response
                if hasattr(tool_scope, 'record_response'):
                    tool_scope.record_response(str(result) if result else "")
                
                logger.info(f"✅ MCP tool '{tool_name}' executed successfully")
                return result
                
            except Exception as e:
                logger.error(f"❌ MCP tool '{tool_name}' failed: {e}")
                raise


def create_observable_mcp_tools(
    mcp_tools: list[MCPToolDefinition],
    tool_executor: MCPToolExecutor,
    get_agent_details: callable,
    get_tenant_details: callable,
) -> list[BaseTool]:
    """
    Create CrewAI-compatible tool wrappers for MCP tools with ExecuteToolScope observability.
    
    Instead of using CrewAI's native `mcps` parameter (which handles tool execution internally
    without observability hooks), this function creates custom CrewAI tools that wrap MCP calls
    with ExecuteToolScope for proper tracing.
    
    Args:
        mcp_tools: List of MCP tool definitions from the registration service
        tool_executor: MCPToolExecutor instance for executing tools with observability
        get_agent_details: Callable that returns current agent details for observability
        get_tenant_details: Callable that returns current tenant details for observability
    
    Returns:
        List of CrewAI BaseTool instances that wrap MCP tools with observability
    """
    observable_tools = []
    
    for mcp_tool in mcp_tools:
        # Create dynamic input schema from MCP tool's input schema
        input_fields = _build_input_fields(mcp_tool)
        
        # Create dynamic Pydantic model for input schema
        InputModel = create_model(f"{mcp_tool.name}Input", **input_fields)
        
        # Create a closure to capture the tool definition and executor reference
        tool_class = _create_tool_class(
            mcp_tool, InputModel, tool_executor, get_agent_details, get_tenant_details
        )
        
        observable_tools.append(tool_class)
        logger.info(f"📊 Created observable wrapper for MCP tool: {mcp_tool.name}")
    
    return observable_tools


def _build_input_fields(mcp_tool: MCPToolDefinition) -> dict:
    """
    Build Pydantic field definitions from MCP tool input schema.
    
    Args:
        mcp_tool: The MCP tool definition
        
    Returns:
        Dictionary of field name to (type, Field) tuples for Pydantic model creation
    """
    input_fields = {}
    
    if mcp_tool.input_schema and "properties" in mcp_tool.input_schema:
        for prop_name, prop_def in mcp_tool.input_schema.get("properties", {}).items():
            field_type = _get_python_type(prop_def.get("type"))
            description = prop_def.get("description", f"Parameter {prop_name}")
            required = prop_name in mcp_tool.input_schema.get("required", [])
            
            if required:
                input_fields[prop_name] = (field_type, Field(..., description=description))
            else:
                input_fields[prop_name] = (field_type, Field(default=None, description=description))
    
    # If no input schema, create a generic one
    if not input_fields:
        input_fields["input"] = (str, Field(default="", description="Input for the tool"))
    
    return input_fields


def _get_python_type(json_type: str | None) -> type:
    """
    Convert JSON schema type to Python type.
    
    Args:
        json_type: JSON schema type string
        
    Returns:
        Corresponding Python type
    """
    type_mapping = {
        "integer": int,
        "number": float,
        "boolean": bool,
        "array": list,
        "object": dict,
    }
    return type_mapping.get(json_type, str)


def _create_tool_class(
    tool_def: MCPToolDefinition,
    input_model: Type[BaseModel],
    tool_executor: MCPToolExecutor,
    get_agent_details: callable,
    get_tenant_details: callable,
) -> BaseTool:
    """
    Create a CrewAI BaseTool class for an MCP tool with observability.
    
    Args:
        tool_def: The MCP tool definition
        input_model: Pydantic model for input validation
        tool_executor: MCPToolExecutor for executing the tool
        get_agent_details: Callable to get current agent details
        get_tenant_details: Callable to get current tenant details
        
    Returns:
        Instance of the created tool class
    """
    class ObservableMCPTool(BaseTool):
        name: str = tool_def.name
        description: str = tool_def.description or f"MCP tool: {tool_def.name}"
        args_schema: Type[BaseModel] = input_model
        
        def _run(self, **kwargs) -> str:
            """Execute MCP tool with ExecuteToolScope observability."""
            # Run async call_tool in sync context
            # Handle both cases: running inside an existing event loop or not
            try:
                # Check if there's already a running event loop (e.g., from CrewAI)
                loop = asyncio.get_running_loop()
                # We're inside an async context - use run_coroutine_threadsafe
                # This shouldn't normally happen with CrewAI's sync tool execution
                import concurrent.futures
                future = asyncio.run_coroutine_threadsafe(
                    tool_executor.call_tool(
                        tool_name=tool_def.name,
                        arguments=kwargs,
                        agent_details=get_agent_details(),
                        tenant_details=get_tenant_details(),
                    ),
                    loop
                )
                result = future.result(timeout=300)  # 5 minute timeout
                return result
            except RuntimeError:
                # No running event loop - use asyncio.run() for clean lifecycle management
                result = asyncio.run(
                    tool_executor.call_tool(
                        tool_name=tool_def.name,
                        arguments=kwargs,
                        agent_details=get_agent_details(),
                        tenant_details=get_tenant_details(),
                    )
                )
                return result
            except Exception as e:
                logger.error(f"❌ MCP tool '{tool_def.name}' error: {e}")
                return f"Error executing {tool_def.name}: {str(e)}"
    
    return ObservableMCPTool()
