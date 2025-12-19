# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Observability helper utilities for Claude Agent.
Creates observability objects for tracing agent invocations, tool execution, and inference.
"""

import logging
from os import environ
from typing import Optional

from microsoft_agents.hosting.core import TurnContext
from microsoft_agents_a365.observability.core.agent_details import AgentDetails
from microsoft_agents_a365.observability.core.execution_type import ExecutionType
from microsoft_agents_a365.observability.core.inference_call_details import InferenceCallDetails
from microsoft_agents_a365.observability.core.inference_operation_type import InferenceOperationType
from microsoft_agents_a365.observability.core.request import Request
from microsoft_agents_a365.observability.core.tenant_details import TenantDetails
from microsoft_agents_a365.observability.core.tool_call_details import ToolCallDetails
from microsoft_agents_a365.observability.core.tool_type import ToolType

logger = logging.getLogger(__name__)


def create_agent_details(context: Optional[TurnContext] = None) -> AgentDetails:
    """
    Create agent details for observability.
    
    Args:
        context: Optional TurnContext from M365 SDK
        
    Returns:
        AgentDetails instance with agent information
    """
    agent_id = environ.get("AGENT_ID", "claude-agent")
    conversation_id = None
    
    if context and context.activity:
        # Extract agent ID from recipient if available
        if hasattr(context.activity, "recipient") and hasattr(context.activity.recipient, "agentic_app_id"):
            agent_id = context.activity.recipient.agentic_app_id or agent_id
            
        # Extract conversation ID
        if hasattr(context.activity, "conversation") and context.activity.conversation:
            conversation_id = context.activity.conversation.id
    
    return AgentDetails(
        agent_id=agent_id,
        conversation_id=conversation_id,
        agent_name=environ.get("OBSERVABILITY_SERVICE_NAME", "Claude Agent"),
        agent_description="AI agent powered by Anthropic Claude Agent SDK with extended thinking",
    )


def create_tenant_details(context: Optional[TurnContext] = None) -> TenantDetails:
    """
    Create tenant details for observability.
    
    Args:
        context: Optional TurnContext from M365 SDK
        
    Returns:
        TenantDetails instance with tenant information
    """
    tenant_id = "default-tenant"
    
    if context and context.activity and hasattr(context.activity, "recipient"):
        # Extract tenant ID from activity recipient
        if hasattr(context.activity.recipient, "tenant_id") and context.activity.recipient.tenant_id:
            tenant_id = context.activity.recipient.tenant_id
            logger.debug(f"Extracted tenant from recipient: {tenant_id}")
    
    # Fall back to environment variable
    if tenant_id == "default-tenant":
        tenant_id = environ.get("TENANT_ID", "default-tenant")
        logger.debug(f"Using tenant ID from environment: {tenant_id}")
    
    return TenantDetails(tenant_id=tenant_id)


def create_request_details(
    user_message: str,
    session_id: Optional[str] = None,
    execution_type: ExecutionType = ExecutionType.HUMAN_TO_AGENT
) -> Request:
    """
    Create request details for observability.
    
    Args:
        user_message: The user's input message
        session_id: Optional session/conversation ID
        execution_type: Type of execution (default: HUMAN_TO_AGENT)
        
    Returns:
        Request instance with request information
    """
    return Request(
        content=user_message,
        execution_type=execution_type,
        session_id=session_id,
    )


def create_inference_details(
    model: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    thinking_tokens: int = 0,
    finish_reasons: Optional[list[str]] = None,
    response_id: Optional[str] = None
) -> InferenceCallDetails:
    """
    Create inference call details for observability.
    
    Args:
        model: Claude model name (e.g., "claude-sonnet-4-20250514")
        input_tokens: Number of input tokens
        output_tokens: Number of output tokens
        thinking_tokens: Number of extended thinking tokens (unique to Claude)
        finish_reasons: List of finish reasons (e.g., ["end_turn"])
        response_id: Optional response ID from Claude
        
    Returns:
        InferenceCallDetails instance with inference information
    """
    return InferenceCallDetails(
        operationName=InferenceOperationType.CHAT,
        model=model,
        providerName="anthropic-claude",
        inputTokens=input_tokens,
        outputTokens=output_tokens + thinking_tokens,  # Total output includes thinking
        finishReasons=finish_reasons or ["end_turn"],
        responseId=response_id,
    )


def create_tool_call_details(
    tool_name: str,
    tool_type: ToolType,
    tool_call_id: Optional[str] = None,
    arguments: Optional[str] = None,
    description: Optional[str] = None
) -> ToolCallDetails:
    """
    Create tool call details for observability.
    
    Args:
        tool_name: Name of the tool (e.g., "WebSearch", "Read", "Write")
        tool_type: Type of tool (ToolType.FUNCTION)
        tool_call_id: Optional unique ID for this tool call
        arguments: Optional tool arguments as string
        description: Optional tool description
        
    Returns:
        ToolCallDetails instance with tool information
    """
    return ToolCallDetails(
        tool_name=tool_name,
        tool_type=tool_type,
        tool_call_id=tool_call_id,
        arguments=arguments,
        description=description or f"Execute {tool_name} tool",
    )
