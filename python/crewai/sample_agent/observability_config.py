# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Observability Configuration Module

Provides observability initialization for Agent 365 SDK.
"""

import logging
import os

from microsoft_agents_a365.observability.core.config import configure
from token_cache import get_cached_agentic_token

logger = logging.getLogger(__name__)


def token_resolver(agent_id: str, tenant_id: str) -> str | None:
    """Token resolver for Agent 365 Observability exporter."""
    try:
        logger.info(f"Token resolver called for agent_id: {agent_id}, tenant_id: {tenant_id}")
        cached_token = get_cached_agentic_token(tenant_id, agent_id)
        if cached_token:
            logger.info("Using cached agentic token from agent authentication")
            return cached_token
        else:
            logger.warning(f"No cached agentic token found for agent_id: {agent_id}, tenant_id: {tenant_id}")
            return None
    except Exception as e:
        logger.error(f"Error resolving token for agent {agent_id}, tenant {tenant_id}: {e}")
        return None


def initialize_observability(
    service_name: str = None,
    service_namespace: str = None,
) -> bool:
    """
    Initialize Agent 365 Observability SDK.

    Args:
        service_name: Name of the service (defaults to OBSERVABILITY_SERVICE_NAME env var)
        service_namespace: Namespace of the service (defaults to OBSERVABILITY_SERVICE_NAMESPACE env var)

    Returns:
        True if configuration succeeded, False otherwise
    """
    try:
        status = configure(
            service_name=service_name or os.getenv("OBSERVABILITY_SERVICE_NAME", "crewai-sample-agent"),
            service_namespace=service_namespace or os.getenv("OBSERVABILITY_SERVICE_NAMESPACE", "agent365-samples"),
            token_resolver=token_resolver,
        )

        if not status:
            logger.warning("Agent 365 Observability configuration failed")
            return False

        logger.info("Agent 365 Observability configured successfully")
        return True

    except Exception as e:
        logger.error(f"Error setting up observability: {e}")
        return False
