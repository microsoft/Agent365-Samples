# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Egress diagnostic probe for the Agent 365 Observability ingestion endpoint.

Purpose
-------
The agent emits correctly-shaped, identity-stamped spans, but the A365 span
exporter's HTTPS POST to ``agent365.svc.cloud.microsoft`` was observed failing
with ``SSL: UNEXPECTED_EOF_WHILE_READING`` (a TLS-handshake reset). Every prior
handshake test was run from the corp network or against a *different* host
(``login.microsoftonline.com``) — never a raw handshake from inside the
Cloud Run container to the ingestion host itself.

This module reproduces the export network path from the **exact** runtime and
egress of the live agent. It is mounted as ``GET /debug/otlp-probe`` and runs,
in order:

1. **DNS** — what the container resolves ``agent365.svc.cloud.microsoft`` to.
2. **Raw TLS handshake** — a bare ``socket`` + ``ssl`` connection (default
   context, then TLS 1.2 forced) to ``host:443`` with SNI, reporting the
   negotiated protocol/cipher and the peer-certificate subject. This isolates
   the handshake from any HTTP/auth concerns.
3. **HTTPS POST** — a minimal single-span OTLP/HTTP+JSON request via the same
   ``requests`` library the SDK exporter uses, to the same URL the SDK builds.
   If a cached observability token exists (from a prior authenticated turn) it
   is attached; otherwise the POST runs token-less (a ``401``/``403`` still
   proves TLS + HTTP reachability — the opposite of a handshake reset).

Interpreting results
---------------------
* Any **HTTP status code** at step 3 (even 401/403/400) ⇒ TLS and the network
  path from Cloud Run are healthy; the "Microsoft blocks GCP at TLS" theory is
  disproven and the original failure was transient or exporter-level.
* A reproduced **``UNEXPECTED_EOF`` / handshake error** at step 2 or 3 ⇒ the
  network hypothesis is confirmed *from the real egress path*, giving hard
  evidence for an egress-IP allowlist or relay decision.

Security
--------
The route is gated by the ``DEBUG_PROBE_KEY`` env var (passed as ``?key=``).
If the env var is unset the route returns 404 so it can't be probed on a public
URL. The response never includes the bearer token or any cert private material.
This is a temporary diagnostic — remove the route (or unset the key) afterward.
"""

import os
import socket
import ssl
import time
import traceback
import logging

import requests

logger = logging.getLogger(__name__)

# The ingestion host the SDK exporter targets by default. Kept in sync with
# DEFAULT_ENDPOINT_URL in microsoft_agents_a365.observability.core.exporters.
_DEFAULT_HOST = "agent365.svc.cloud.microsoft"
_HTTP_TIMEOUT_SECONDS = 30
_TLS_TIMEOUT_SECONDS = 15


def _resolve_endpoint() -> tuple[str, str, str, str]:
    """Return (host, full_url, tenant_id, agent_id) matching the SDK exporter.

    Uses the SDK's own URL builder and domain-override handling so the probe
    hits the identical URL the exporter would, including the delegated
    ``/observability`` path and ``api-version=1``.
    """
    tenant_id = os.getenv("AGENTIC_TENANT_ID", "")
    agent_id = os.getenv("AGENTIC_USER_ID", "")

    host = _DEFAULT_HOST
    endpoint = f"https://{_DEFAULT_HOST}"
    try:
        from microsoft_agents_a365.observability.core.exporters.utils import (
            build_export_url,
            get_validated_domain_override,
        )

        override = get_validated_domain_override()
        if override:
            endpoint = override if "://" in override else f"https://{override}"
        # use_s2s_endpoint=False mirrors the exporter default (delegated/OBO path).
        full_url = build_export_url(endpoint, agent_id, tenant_id, False)
    except Exception as e:  # pragma: no cover - defensive
        logger.warning("Falling back to manual URL build: %s", e)
        full_url = (
            f"{endpoint}/observability/tenants/{tenant_id}"
            f"/otlp/agents/{agent_id}/traces?api-version=1"
        )

    # Derive the host actually being dialed (honors a domain override).
    try:
        from urllib.parse import urlparse

        host = urlparse(full_url).hostname or _DEFAULT_HOST
    except Exception:
        pass

    return host, full_url, tenant_id, agent_id


def _probe_dns(host: str) -> dict:
    result: dict = {"host": host}
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
        addrs = sorted({info[4][0] for info in infos})
        result["resolved"] = addrs
        result["ok"] = True
    except Exception as e:
        result["ok"] = False
        result["error"] = f"{type(e).__name__}: {e}"
    return result


def _probe_tls(host: str, *, force_tls12: bool) -> dict:
    """Open a raw TLS connection and report the negotiated parameters.

    No HTTP is sent — this isolates the TLS handshake from auth/HTTP so an
    ``UNEXPECTED_EOF`` here is unambiguously a handshake-level failure.
    """
    label = "tls1_2_forced" if force_tls12 else "tls_default"
    out: dict = {"variant": label}
    start = time.monotonic()
    try:
        ctx = ssl.create_default_context()
        if force_tls12:
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
            ctx.maximum_version = ssl.TLSVersion.TLSv1_2
        with socket.create_connection((host, 443), timeout=_TLS_TIMEOUT_SECONDS) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as tls:
                cert = tls.getpeercert() or {}
                subject = dict(x[0] for x in cert.get("subject", []))
                issuer = dict(x[0] for x in cert.get("issuer", []))
                out.update(
                    ok=True,
                    negotiated_protocol=tls.version(),
                    cipher=tls.cipher()[0] if tls.cipher() else None,
                    alpn=tls.selected_alpn_protocol(),
                    peer_cert_cn=subject.get("commonName"),
                    peer_cert_issuer=issuer.get("commonName"),
                    elapsed_ms=round((time.monotonic() - start) * 1000),
                )
    except Exception as e:
        out.update(
            ok=False,
            error_type=type(e).__name__,
            error=str(e),
            elapsed_ms=round((time.monotonic() - start) * 1000),
        )
    return out


def _minimal_otlp_body(tenant_id: str, agent_id: str) -> str:
    """Smallest valid OTLP/HTTP+JSON body: a single ``invoke_agent`` span.

    Mirrors the shape documented in the direct-OTel integration guide so a 200
    response would be a genuine accept (subject to the usual downstream drop
    conditions). Times are Unix-epoch-nanosecond strings.
    """
    import json

    now_ns = time.time_ns()
    span = {
        "traceId": "0af7651916cd43dd8448eb211c80319c",
        "spanId": "b7ad6b7169203331",
        "name": "invoke_agent probe",
        "kind": 1,
        "startTimeUnixNano": str(now_ns - 1_000_000),
        "endTimeUnixNano": str(now_ns),
        "attributes": [
            {"key": "gen_ai.operation.name", "value": {"stringValue": "invoke_agent"}},
            {"key": "microsoft.tenant.id", "value": {"stringValue": tenant_id}},
            {"key": "gen_ai.agent.id", "value": {"stringValue": agent_id}},
        ],
        "status": {"code": 1},
    }
    body = {
        "resourceSpans": [
            {
                "resource": {"attributes": []},
                "scopeSpans": [{"scope": {"name": "debug-probe"}, "spans": [span]}],
            }
        ]
    }
    return json.dumps(body, separators=(",", ":"))


def _probe_https_post(full_url: str, tenant_id: str, agent_id: str) -> dict:
    """POST a minimal span using the same ``requests`` stack as the exporter."""
    out: dict = {"url_path": full_url.split("?")[0]}
    body = _minimal_otlp_body(tenant_id, agent_id)
    headers = {"content-type": "application/json", "connection": "close"}

    token = None
    try:
        from token_cache import get_cached_agentic_token

        token = get_cached_agentic_token(tenant_id, agent_id)
    except Exception as e:
        out["token_lookup_error"] = f"{type(e).__name__}: {e}"
    out["token_attached"] = bool(token)
    if token:
        headers["authorization"] = f"Bearer {token}"

    start = time.monotonic()
    try:
        resp = requests.post(
            full_url,
            data=body.encode("utf-8"),
            headers=headers,
            timeout=_HTTP_TIMEOUT_SECONDS,
        )
        out.update(
            ok=True,
            http_status=resp.status_code,
            elapsed_ms=round((time.monotonic() - start) * 1000),
            correlation_id=(
                resp.headers.get("x-ms-correlation-id")
                or resp.headers.get("request-id")
                or "N/A"
            ),
            # Body is small (partialSuccess JSON or an error page); cap it so we
            # never echo anything large. Never contains the bearer token.
            response_body=resp.text[:2000],
        )
    except Exception as e:
        out.update(
            ok=False,
            error_type=type(e).__name__,
            error=str(e),
            elapsed_ms=round((time.monotonic() - start) * 1000),
            traceback=traceback.format_exc()[-1500:],
        )
    return out


def run_probe() -> dict:
    """Run the full DNS → TLS → HTTPS diagnostic and return a JSON-able dict."""
    host, full_url, tenant_id, agent_id = _resolve_endpoint()
    summary = {
        "target_host": host,
        "tenant_id_present": bool(tenant_id),
        "agent_id_present": bool(agent_id),
        "dns": _probe_dns(host),
        "tls_default": _probe_tls(host, force_tls12=False),
        "tls_1_2_forced": _probe_tls(host, force_tls12=True),
        "https_post": _probe_https_post(full_url, tenant_id, agent_id),
    }

    # One-line verdict to make the log/JSON instantly readable.
    post = summary["https_post"]
    if post.get("ok"):
        summary["verdict"] = (
            f"TLS + HTTP reachable from this egress (HTTP {post.get('http_status')}). "
            "Handshake-reset theory DISPROVEN — investigate exporter/auth/transient."
        )
    elif summary["tls_default"].get("ok"):
        summary["verdict"] = (
            "Raw TLS handshake succeeded but the HTTPS POST failed — "
            "likely HTTP/auth/proxy layer, not a handshake reset."
        )
    else:
        summary["verdict"] = (
            "Raw TLS handshake FAILED from this egress — network hypothesis "
            "CONFIRMED from the real Cloud Run path. Evidence for allowlist/relay."
        )
    return summary
