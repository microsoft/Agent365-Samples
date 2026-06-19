# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Token caching utilities for the Agent 365 Observability exporter.

The A365 span exporter authenticates each export with a Bearer token resolved
via ``token_resolver(agent_id, tenant_id)``. That token is the agentic token the
agent obtains during an authenticated turn (via ``auth.exchange_token`` against
the observability scope). Because span export happens asynchronously on the
batch processor's schedule — after the turn handler returns — we cache the token
per (tenant, agent) during the turn and hand it back from the resolver.
"""

import logging

logger = logging.getLogger(__name__)

# Process-wide cache of agentic tokens keyed by "{tenant_id}:{agent_id}".
_agentic_token_cache: dict[str, str] = {}


def cache_agentic_token(tenant_id: str, agent_id: str, token: str) -> None:
    """Cache the agentic token for use by the Agent 365 Observability exporter."""
    key = f"{tenant_id}:{agent_id}"
    _agentic_token_cache[key] = token
    logger.debug("Cached agentic token for %s", key)


def get_cached_agentic_token(tenant_id: str, agent_id: str) -> str | None:
    """Retrieve the cached agentic token for the Agent 365 Observability exporter."""
    key = f"{tenant_id}:{agent_id}"
    token = _agentic_token_cache.get(key)
    if token:
        logger.debug("Retrieved cached agentic token for %s", key)
    else:
        logger.debug("No cached token found for %s", key)
    return token


def observability_token_resolver(agent_id: str, tenant_id: str) -> str | None:
    """Resolve the export Bearer token for the A365 Observability exporter.

    The exporter calls this with ``(agent_id, tenant_id)``; the cache is keyed
    ``(tenant_id, agent_id)`` — note the argument order swap.
    """
    token = get_cached_agentic_token(tenant_id, agent_id)
    if not token:
        logger.warning(
            "No cached agentic token for agent_id=%s tenant_id=%s; "
            "spans for this identity will not be exported this cycle.",
            agent_id,
            tenant_id,
        )
    return token
