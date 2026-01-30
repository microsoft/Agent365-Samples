# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Observability Configuration Module

Handles one-time initialization of Agent 365 Observability SDK.
This module should be imported early in the application lifecycle to ensure
observability is configured before any agents are instantiated.
"""

import logging
import os

from microsoft_agents_a365.observability.core.config import configure
from token_cache import get_cached_agentic_token

logger = logging.getLogger(__name__)

# Flag to track if observability has been configured
_observability_configured = False


def _initialize_observability_once():
    """Initialize observability SDK once at module level before any agent instances are created"""
    global _observability_configured
    
    if _observability_configured:
        logger.debug("Observability already configured, skipping")
        return True
    
    def token_resolver(agent_id: str, tenant_id: str) -> str | None:
        """Token resolver for Agent 365 Observability exporter"""
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
    
    try:
        status = configure(
            service_name=os.getenv("OBSERVABILITY_SERVICE_NAME", "crewai-sample-agent"),
            service_namespace=os.getenv("OBSERVABILITY_SERVICE_NAMESPACE", "agent365-samples"),
            token_resolver=token_resolver,
        )
        
        if not status:
            logger.warning("⚠️ Agent 365 Observability configuration failed")
            return False
        
        _observability_configured = True
        logger.info("✅ Agent 365 Observability configured successfully")
        return True
        
    except Exception as e:
        logger.error(f"❌ Error setting up observability: {e}")
        return False


def is_observability_configured() -> bool:
    """Check if observability has been configured"""
    return _observability_configured


# Initialize observability immediately at module load time
_initialize_observability_once()
