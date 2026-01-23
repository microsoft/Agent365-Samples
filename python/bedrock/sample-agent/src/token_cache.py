# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Token caching utilities for Agent 365 Observability exporter authentication.

Provides a simple in-memory cache for agentic tokens used by the A365 exporter.
In production, consider using a more robust solution like Redis.
"""

import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Global in-memory token cache
_token_cache: dict[str, str] = {}


def create_agentic_token_cache_key(agent_id: str, tenant_id: Optional[str] = None) -> str:
    """
    Create a unique cache key for agentic tokens.

    Args:
        agent_id: The agent application ID
        tenant_id: Optional tenant ID for multi-tenant scenarios

    Returns:
        A unique cache key string
    """
    if tenant_id:
        return f"agentic-token-{agent_id}-{tenant_id}"
    return f"agentic-token-{agent_id}"


def set_cached_token(key: str, token: str) -> None:
    """
    Store a token in the cache.

    Args:
        key: The cache key (use create_agentic_token_cache_key)
        token: The token to cache
    """
    _token_cache[key] = token
    logger.debug(f"🔐 Token cached for key: {key}")


def get_cached_token(key: str) -> Optional[str]:
    """
    Retrieve a token from the cache.

    Args:
        key: The cache key

    Returns:
        The cached token, or None if not found
    """
    token = _token_cache.get(key)
    if token:
        logger.debug(f"🔍 Token cache hit for key: {key}")
    else:
        logger.debug(f"🔍 Token cache miss for key: {key}")
    return token


def token_resolver(agent_id: str, tenant_id: str) -> Optional[str]:
    """
    Token resolver function for Agent 365 Observability exporter.

    This function is called by the observability SDK when it needs tokens
    for exporting telemetry to Agent 365.

    Args:
        agent_id: The agent application ID
        tenant_id: The tenant ID

    Returns:
        The cached token, or None if not available
    """
    try:
        cache_key = create_agentic_token_cache_key(agent_id, tenant_id)
        cached_token = get_cached_token(cache_key)

        if cached_token:
            logger.info(f"Token resolver returning cached token for agent={agent_id}, tenant={tenant_id}")
            return cached_token
        else:
            logger.warning(f"No cached token found for agent={agent_id}, tenant={tenant_id}")
            return None

    except Exception as e:
        logger.error(f"❌ Error resolving token for agent {agent_id}, tenant {tenant_id}: {e}")
        return None
