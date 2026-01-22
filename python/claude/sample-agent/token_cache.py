# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Token Cache
Caches agentic tokens for observability export.
"""

import logging

logger = logging.getLogger(__name__)

# In-memory cache for agentic tokens
# Key format: "tenant_id:agent_id"
_token_cache: dict[str, str] = {}


def cache_agentic_token(tenant_id: str, agent_id: str, token: str) -> None:
    """
    Cache an agentic token for later use by observability exporter.

    Args:
        tenant_id: Tenant identifier
        agent_id: Agent identifier
        token: Agentic authentication token
    """
    cache_key = f"{tenant_id}:{agent_id}"
    _token_cache[cache_key] = token
    logger.debug(f"Cached agentic token for {cache_key}")


def get_cached_agentic_token(tenant_id: str, agent_id: str) -> str | None:
    """
    Retrieve a cached agentic token.

    Args:
        tenant_id: Tenant identifier
        agent_id: Agent identifier

    Returns:
        Cached token if found, None otherwise
    """
    cache_key = f"{tenant_id}:{agent_id}"
    token = _token_cache.get(cache_key)

    if token:
        logger.debug(f"Retrieved cached token for {cache_key}")
    else:
        logger.debug(f"No cached token found for {cache_key}")

    return token


def clear_token_cache() -> None:
    """Clear all cached tokens."""
    _token_cache.clear()
    logger.debug("Token cache cleared")
