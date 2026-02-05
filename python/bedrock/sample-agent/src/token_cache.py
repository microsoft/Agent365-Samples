# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""
Token caching utilities for Agent 365 Observability exporter authentication.
"""

import logging

logger = logging.getLogger(__name__)

# Global token cache for Agent 365 Observability exporter
_agentic_token_cache = {}


def cache_agentic_token(tenant_id: str, agent_id: str, token: str) -> None:
    """Cache the agentic token for use by Agent 365 Observability exporter."""
    key = f"{tenant_id}:{agent_id}"
    _agentic_token_cache[key] = token
    logger.debug(f"Cached agentic token for {key}")


def get_cached_agentic_token(tenant_id: str, agent_id: str) -> str | None:
    """Retrieve cached agentic token for Agent 365 Observability exporter."""
    key = f"{tenant_id}:{agent_id}"
    token = _agentic_token_cache.get(key)
    if token:
        logger.debug(f"Retrieved cached agentic token for {key}")
    else:
        logger.debug(f"No cached token found for {key}")
    return token

def token_resolver(agent_id: str, tenant_id: str) -> str | None:
    """Token resolver for Agent 365 Observability"""
    try:
        cached_token = get_cached_agentic_token(tenant_id, agent_id)
        if not cached_token:
            logger.warning(f"No cached token for agent {agent_id}")
        return cached_token
    except Exception as e:
        logger.error(f"Error resolving token: {e}")
        return None