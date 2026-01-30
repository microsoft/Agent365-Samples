# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Token Cache for Observability

Uses SDK's AgenticTokenCache for token generation components, plus a sync cache
for already-exchanged tokens. This is needed because configure_observability()
requires a sync token_resolver, but the SDK's get_observability_token() is async.

Pattern:
1. Register observability via SDK's AgenticTokenCache (stores Authorization + TurnContext)
2. Exchange token asynchronously and cache the resulting string
3. token_resolver retrieves the cached string synchronously
"""

import logging
from threading import Lock

from microsoft_agents_a365.observability.hosting.token_cache_helpers.agent_token_cache import (
    AgenticTokenCache,
    AgenticTokenStruct,
)

logger = logging.getLogger(__name__)

# SDK's token cache for observability registration
_sdk_token_cache = AgenticTokenCache()

# Sync cache for already-exchanged token strings
# Key format: "agent_id:tenant_id" (matching SDK's format)
_exchanged_tokens: dict[str, str] = {}
_lock = Lock()


def register_observability(
    agent_id: str,
    tenant_id: str,
    token_generator: AgenticTokenStruct,
    observability_scopes: list[str],
) -> None:
    """
    Register observability using SDK's AgenticTokenCache.
    
    Args:
        agent_id: Agent identifier
        tenant_id: Tenant identifier
        token_generator: AgenticTokenStruct with Authorization and TurnContext
        observability_scopes: Scopes for token exchange
    """
    _sdk_token_cache.register_observability(
        agent_id=agent_id,
        tenant_id=tenant_id,
        token_generator=token_generator,
        observability_scopes=observability_scopes,
    )


async def get_and_cache_observability_token(agent_id: str, tenant_id: str) -> str | None:
    """
    Get observability token from SDK cache and cache the result for sync access.
    
    This is the bridge between async token exchange and sync token_resolver.
    
    Args:
        agent_id: Agent identifier
        tenant_id: Tenant identifier
        
    Returns:
        Token if available, None otherwise
    """
    # Try SDK's async token exchange
    token = await _sdk_token_cache.get_observability_token(agent_id, tenant_id)
    
    if token:
        # Cache for sync access by token_resolver
        cache_key = f"{agent_id}:{tenant_id}"
        with _lock:
            _exchanged_tokens[cache_key] = token
        logger.debug(f"Cached exchanged token for {cache_key}")
    
    return token


def cache_agentic_token(tenant_id: str, agent_id: str, token: str) -> None:
    """
    Cache an already-exchanged agentic token for sync access.
    
    Use this when you have the token from external exchange (e.g., BEARER_TOKEN env var).

    Args:
        tenant_id: Tenant identifier
        agent_id: Agent identifier
        token: Already-exchanged agentic authentication token
    """
    cache_key = f"{agent_id}:{tenant_id}"
    with _lock:
        _exchanged_tokens[cache_key] = token
    logger.debug(f"Cached agentic token for {cache_key}")


def get_cached_agentic_token(tenant_id: str, agent_id: str) -> str | None:
    """
    Retrieve a cached agentic token synchronously.
    
    This is called by token_resolver in configure_observability().

    Args:
        tenant_id: Tenant identifier
        agent_id: Agent identifier

    Returns:
        Cached token if found, None otherwise
    """
    cache_key = f"{agent_id}:{tenant_id}"
    with _lock:
        token = _exchanged_tokens.get(cache_key)

    if token:
        logger.debug(f"Retrieved cached token for {cache_key}")
    else:
        logger.debug(f"No cached token found for {cache_key}")

    return token


def clear_token_cache() -> None:
    """Clear all cached tokens."""
    with _lock:
        _exchanged_tokens.clear()
    logger.debug("Token cache cleared")
