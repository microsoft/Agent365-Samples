# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Simple in-memory token cache for observability tokens."""

import threading
from datetime import datetime, timedelta, timezone

_lock = threading.Lock()
_cache: dict[str, tuple[str, datetime]] = {}

# Tokens are considered valid if they expire more than 5 minutes from now.
_EXPIRY_BUFFER = timedelta(minutes=5)


def cache_token(agent_id: str, tenant_id: str, token: str, expires_in: timedelta = timedelta(hours=1)) -> None:
    """Cache an observability token for a specific agent/tenant pair."""
    key = f"{agent_id}:{tenant_id}"
    expires_at = datetime.now(timezone.utc) + expires_in
    with _lock:
        _cache[key] = (token, expires_at)


def get_cached_token(agent_id: str, tenant_id: str) -> str | None:
    """Retrieve a cached token if it exists and hasn't expired."""
    key = f"{agent_id}:{tenant_id}"
    with _lock:
        entry = _cache.get(key)
        if entry is None:
            return None
        token, expires_at = entry
        if datetime.now(timezone.utc) + _EXPIRY_BUFFER >= expires_at:
            del _cache[key]
            return None
        return token
