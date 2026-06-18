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

import httpx
import requests

logger = logging.getLogger(__name__)

# Process-wide cache of agentic tokens keyed by "{tenant_id}:{agent_id}".
_agentic_token_cache: dict[str, str] = {}


def _probe_export_transport(agent_id: str, tenant_id: str, token: str) -> None:
    """TEMPORARY DIAGNOSTIC: isolate the intermittent TLS UNEXPECTED_EOF seen on
    the A365 span export. The SDK exporter uses requests/urllib3 and hits the EOF,
    while MCP calls (httpx) to the SAME host succeed. POST a tiny body to the exact
    traces URL with BOTH clients during the turn (instance awake) and log each
    result side-by-side. Any HTTP status (even 400/403/415) proves the transport
    completed; an exception identifies the failing client. Remove once resolved.
    """
    url = (
        f"https://agent365.svc.cloud.microsoft/observability/tenants/{tenant_id}"
        f"/otlp/agents/{agent_id}/traces?api-version=1"
    )
    headers = {"content-type": "application/json", "authorization": f"Bearer {token}"}
    body = b"{}"

    # requests / urllib3 -- same HTTP stack as the A365 exporter.
    try:
        resp = requests.post(url, data=body, headers=headers, timeout=30)
        cid = resp.headers.get("x-ms-correlation-id") or resp.headers.get("request-id") or "N/A"
        logger.warning("TLS_PROBE requests: status=%s correlation=%s", resp.status_code, cid)
    except Exception as exc:  # noqa: BLE001 - diagnostic only
        logger.warning("TLS_PROBE requests: EXC %s: %s", type(exc).__name__, exc)

    # httpx -- same HTTP stack as MCP, which returns 200 to this host.
    try:
        with httpx.Client(timeout=30) as client:
            resp = client.post(url, content=body, headers=headers)
        cid = resp.headers.get("x-ms-correlation-id") or resp.headers.get("request-id") or "N/A"
        logger.warning("TLS_PROBE httpx: status=%s correlation=%s", resp.status_code, cid)
    except Exception as exc:  # noqa: BLE001 - diagnostic only
        logger.warning("TLS_PROBE httpx: EXC %s: %s", type(exc).__name__, exc)


def cache_agentic_token(tenant_id: str, agent_id: str, token: str) -> None:
    """Cache the agentic token for use by the Agent 365 Observability exporter."""
    key = f"{tenant_id}:{agent_id}"
    _agentic_token_cache[key] = token
    logger.debug("Cached agentic token for %s", key)
    _probe_export_transport(agent_id, tenant_id, token)


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
