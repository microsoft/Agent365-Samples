# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Turn Context Utilities

Shared utilities for extracting observability details from TurnContext.
This module encapsulates repeated logic for extracting agent, caller, and
tenant information from the Microsoft Agents SDK TurnContext.
"""

import os
import uuid
from dataclasses import dataclass
from typing import Optional

from microsoft_agents.hosting.core import TurnContext
from microsoft_agents_a365.observability.core import (
    AgentDetails,
    TenantDetails,
    Request,
    ExecutionType,
    InvokeAgentDetails,
)
from microsoft_agents_a365.observability.core.middleware.baggage_builder import BaggageBuilder
from microsoft_agents_a365.observability.core.models.caller_details import CallerDetails
from microsoft_agents_a365.observability.hosting.scope_helpers.populate_baggage import populate


@dataclass
class TurnContextDetails:
    """Extracted details from a TurnContext for observability."""

    # Agent details
    tenant_id: Optional[str]
    agent_id: Optional[str]
    agent_name: Optional[str]
    agent_upn: Optional[str]
    agent_blueprint_id: Optional[str]
    agent_auid: Optional[str]

    # Conversation details
    conversation_id: Optional[str]
    correlation_id: str

    # Caller details
    caller_id: Optional[str]
    caller_name: Optional[str]
    caller_aad_object_id: Optional[str]


def extract_turn_context_details(context: TurnContext) -> TurnContextDetails:
    """
    Extract observability details from a TurnContext.

    Args:
        context: The TurnContext from the Microsoft Agents SDK

    Returns:
        TurnContextDetails with all extracted information
    """
    activity = context.activity
    recipient = activity.recipient if activity.recipient else None

    # Extract agent details from recipient (ChannelAccount)
    tenant_id = recipient.tenant_id if recipient else None
    agent_id = getattr(recipient, "id", None) if recipient else None
    if not agent_id:
        agent_id = os.getenv("AGENT_ID", "crewai-agent")
    agent_name = getattr(recipient, "name", None) if recipient else None
    agent_upn = getattr(recipient, "name", None) if recipient else None
    agent_blueprint_id = getattr(recipient, "agentic_app_id", None) if recipient else None
    agent_auid = getattr(recipient, "agentic_user_id", None) if recipient else None

    # Extract conversation details
    conversation_id = activity.conversation.id if activity.conversation else None
    correlation_id = str(uuid.uuid4())

    # Extract caller details from from_property (ChannelAccount)
    caller = activity.from_property if activity and activity.from_property else None
    caller_id = getattr(caller, "id", None)
    caller_name = getattr(caller, "name", None)
    caller_aad_object_id = getattr(caller, "aad_object_id", None)

    return TurnContextDetails(
        tenant_id=tenant_id or "default-tenant",
        agent_id=agent_id,
        agent_name=agent_name,
        agent_upn=agent_upn,
        agent_blueprint_id=agent_blueprint_id,
        agent_auid=agent_auid,
        conversation_id=conversation_id,
        correlation_id=correlation_id,
        caller_id=caller_id,
        caller_name=caller_name,
        caller_aad_object_id=caller_aad_object_id,
    )


def create_agent_details(details: TurnContextDetails, description: str = "AI agent powered by CrewAI framework") -> AgentDetails:
    """
    Create AgentDetails from extracted TurnContextDetails.

    Args:
        details: The extracted turn context details
        description: Description of the agent

    Returns:
        AgentDetails for observability
    """
    return AgentDetails(
        agent_id=details.agent_id,
        conversation_id=details.conversation_id,
        agent_name=details.agent_name,
        agent_description=description,
        tenant_id=details.tenant_id,
        agent_upn=details.agent_upn,
        agent_blueprint_id=details.agent_blueprint_id,
        agent_auid=details.agent_auid,
    )


def create_caller_details(details: TurnContextDetails) -> CallerDetails:
    """
    Create CallerDetails from extracted TurnContextDetails.

    Args:
        details: The extracted turn context details

    Returns:
        CallerDetails for observability
    """
    return CallerDetails(
        caller_id=details.caller_id or "unknown-caller",
        caller_upn=details.caller_name or "unknown-user",
        caller_user_id=details.caller_aad_object_id or details.caller_id or "unknown-user-id",
        caller_name=details.caller_name,
    )


def create_tenant_details(details: TurnContextDetails) -> TenantDetails:
    """
    Create TenantDetails from extracted TurnContextDetails.

    Args:
        details: The extracted turn context details

    Returns:
        TenantDetails for observability
    """
    return TenantDetails(tenant_id=details.tenant_id)


def create_request(details: TurnContextDetails, message: str) -> Request:
    """
    Create a Request from extracted TurnContextDetails and message.

    Args:
        details: The extracted turn context details
        message: The user message content

    Returns:
        Request for observability
    """
    return Request(
        content=message,
        execution_type=ExecutionType.HUMAN_TO_AGENT,
        session_id=details.conversation_id,
    )


def create_invoke_agent_details(details: TurnContextDetails, description: str = "AI agent powered by CrewAI framework") -> InvokeAgentDetails:
    """
    Create InvokeAgentDetails from extracted TurnContextDetails.

    Args:
        details: The extracted turn context details
        description: Description of the agent

    Returns:
        InvokeAgentDetails for observability
    """
    agent_details = create_agent_details(details, description)
    return InvokeAgentDetails(
        details=agent_details,
        session_id=details.conversation_id,
    )


def build_baggage_builder(context: TurnContext, correlation_id: Optional[str] = None) -> BaggageBuilder:
    """
    Build a BaggageBuilder populated from TurnContext activity.

    Args:
        context: The TurnContext from the Microsoft Agents SDK
        correlation_id: Optional correlation id to add to baggage

    Returns:
        Populated BaggageBuilder instance
    """
    builder = BaggageBuilder()
    populate(builder, context)
    if correlation_id:
        builder.correlation_id(correlation_id)
    return builder
