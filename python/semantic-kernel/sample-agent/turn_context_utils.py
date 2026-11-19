# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Turn Context Utilities

Shared utilities for extracting observability details from TurnContext.
This module encapsulates repeated logic for extracting agent, caller, and
tenant information from the Microsoft Agents SDK TurnContext.
"""

import os
import logging
import uuid
from urllib.parse import urlsplit
from dataclasses import dataclass
from typing import Optional

from microsoft_agents.hosting.core import TurnContext
from microsoft.opentelemetry.a365.core import (
    AgentDetails,
    Channel,
    InvokeAgentScopeDetails,
    Request,
)
from microsoft.opentelemetry.a365.core.models.service_endpoint import ServiceEndpoint
from microsoft.opentelemetry.a365.core.middleware.baggage_builder import BaggageBuilder
from microsoft.opentelemetry.a365.core.models.caller_details import CallerDetails
from microsoft.opentelemetry.a365.core.models.user_details import UserDetails
from microsoft.opentelemetry.a365.hosting.scope_helpers.populate_baggage import populate

logger = logging.getLogger(__name__)

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
    channel_name: Optional[str]

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
    tenant_id = (
        getattr(activity.conversation, "tenant_id", None)
        or getattr(recipient, "tenant_id", None)
        or os.getenv("CONNECTIONS__SERVICE_CONNECTION__SETTINGS__TENANTID")
    )
    # Use get_agentic_instance_id() (recipient.agentic_app_id) for agent_id
    agent_id = activity.get_agentic_instance_id()
    if not agent_id:
        agent_id = os.getenv("AGENT_ID") or None
    agent_blueprint_id = (
        os.getenv("AGENT_BLUEPRINT_ID")
        or os.getenv("CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID")
        or None
    )
    try:
        agent_uuid = uuid.UUID(agent_id) if agent_id else None
        tenant_uuid = uuid.UUID(tenant_id) if tenant_id else None
        agent_id = str(agent_uuid) if agent_uuid and agent_uuid.int else None
        tenant_id = str(tenant_uuid) if tenant_uuid and tenant_uuid.int else None
    except ValueError:
        logger.warning("Skipping A365 scopes: invalid agent or tenant identifier")
        agent_id = None
        tenant_id = None
    if agent_id and agent_blueprint_id and agent_id.lower() == agent_blueprint_id.lower():
        agent_id = None
    agent_name = os.getenv("AGENT_NAME") or "Semantic-Kernel"
    agent_upn = getattr(recipient, "agentic_user_id", None) if recipient else None
    agent_auid = getattr(recipient, "aad_object_id", None) if recipient else None

    # Extract conversation details
    conversation_id = (
        activity.conversation.id if activity.conversation else None
    ) or getattr(activity, "id", None) or str(uuid.uuid4())
    correlation_id = str(uuid.uuid4())

    # Extract caller details from from_property (ChannelAccount)
    caller = activity.from_property if activity and activity.from_property else None
    caller_id = getattr(caller, "id", None)
    caller_name = getattr(caller, "name", None)
    caller_aad_object_id = getattr(caller, "aad_object_id", None)

    return TurnContextDetails(
        tenant_id=tenant_id,
        agent_id=agent_id,
        agent_name=agent_name,
        agent_upn=agent_upn,
        agent_blueprint_id=agent_blueprint_id,
        agent_auid=agent_auid,
        conversation_id=conversation_id,
        correlation_id=correlation_id,
        channel_name=activity.channel_id,
        caller_id=caller_id,
        caller_name=caller_name,
        caller_aad_object_id=caller_aad_object_id,
    )


def create_agent_details(details: TurnContextDetails, description: str = "AI agent powered by Semantic Kernel") -> AgentDetails:
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
        agent_name=details.agent_name,
        agent_description=description,
        tenant_id=details.tenant_id,
        agentic_user_id=details.agent_auid,
        agentic_user_email=details.agent_upn,
        agent_blueprint_id=details.agent_blueprint_id,
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
        user_details=UserDetails(
            user_id=details.caller_aad_object_id,
            user_name=details.caller_name,
        ),
    )


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
        session_id=details.conversation_id,
        conversation_id=details.conversation_id,
        channel=Channel(name=details.channel_name),
    )


def create_invoke_agent_details(details: TurnContextDetails) -> InvokeAgentScopeDetails:
    """
    Create InvokeAgentScopeDetails from extracted TurnContextDetails.

    Args:
        details: The extracted turn context details

    Returns:
        InvokeAgentScopeDetails for observability
    """
    return InvokeAgentScopeDetails(endpoint=ServiceEndpoint(
        hostname=os.getenv("HOST") or "localhost",
        port=int(os.getenv("PORT", "3978")),
    ))


def create_model_endpoint() -> ServiceEndpoint:
    endpoint = (
        os.getenv("AZURE_OPENAI_ENDPOINT", "")
        if os.getenv("USE_AZURE_OPENAI", "true").lower() == "true"
        else "https://api.openai.com"
    )
    parsed = urlsplit(endpoint)
    return ServiceEndpoint(
        hostname=parsed.hostname or "localhost",
        port=parsed.port or (443 if parsed.scheme == "https" else 80),
    )


def build_baggage_builder(context: TurnContext, details: TurnContextDetails) -> BaggageBuilder:
    """
    Build a BaggageBuilder populated from TurnContext activity.

    Args:
        context: The TurnContext from the Microsoft Agents SDK

    Returns:
        Populated BaggageBuilder instance
    """
    builder = BaggageBuilder()
    populate(builder, context)
    if details.agent_id and details.tenant_id:
        builder.agent_id(details.agent_id).tenant_id(details.tenant_id)
    builder.agent_name(details.agent_name)
    builder.agent_blueprint_id(details.agent_blueprint_id)
    builder.agentic_user_id(details.agent_auid)
    builder.agentic_user_email(details.agent_upn)
    builder.user_id(details.caller_aad_object_id)
    builder.conversation_id(details.conversation_id)
    builder.session_id(details.conversation_id)
    builder.channel_name(details.channel_name or "web")
    # The channel doesn't expose the human's IP; do not use the proxy's address.
    builder.user_client_ip("0.0.0.0")
    return builder
