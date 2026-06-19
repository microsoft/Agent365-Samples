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

import base64
import binascii
import json
import logging
import threading
import time

logger = logging.getLogger(__name__)

# Fallback lifetime (seconds) used when the token's JWT ``exp`` claim cannot be
# parsed. Kept short so a malformed/opaque token is re-cached every turn rather
# than lingering past its real expiry.
_DEFAULT_TOKEN_TTL_SECONDS = 300

# Process-wide cache of agentic tokens keyed by "{tenant_id}:{agent_id}".
# Values are ``(token, expires_at_epoch_seconds)``. The cache is read by the
# OpenTelemetry BatchSpanProcessor export thread and written on the request/turn
# path, so every access is guarded by ``_cache_lock``.
_cache_lock = threading.Lock()
_agentic_token_cache: dict[str, tuple[str, float]] = {}


def _token_expiry(token: str) -> float:
    """Return the epoch-seconds expiry for ``token`` from its JWT ``exp`` claim.

    Falls back to ``now + _DEFAULT_TOKEN_TTL_SECONDS`` when the token is not a
    decodable JWT. The signature is not verified — this is only used to expire
    the local cache entry, never to authorize anything.
    """
    try:
        payload_b64 = token.split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)  # restore base64url padding
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        exp = float(payload["exp"])
        return exp
    except (IndexError, KeyError, ValueError, TypeError, binascii.Error):
        return time.time() + _DEFAULT_TOKEN_TTL_SECONDS


def cache_agentic_token(tenant_id: str, agent_id: str, token: str) -> None:
    """Cache the agentic token for use by the Agent 365 Observability exporter."""
    key = f"{tenant_id}:{agent_id}"
    expires_at = _token_expiry(token)
    with _cache_lock:
        _agentic_token_cache[key] = (token, expires_at)
    logger.debug("Cached agentic token for %s", key)


def get_cached_agentic_token(tenant_id: str, agent_id: str) -> str | None:
    """Retrieve the cached agentic token for the Agent 365 Observability exporter."""
    key = f"{tenant_id}:{agent_id}"
    now = time.time()
    with _cache_lock:
        entry = _agentic_token_cache.get(key)
        if entry is not None and entry[1] <= now:
            # Expired: drop it so we don't export with a stale token.
            del _agentic_token_cache[key]
            entry = None
        token = entry[0] if entry is not None else None
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
