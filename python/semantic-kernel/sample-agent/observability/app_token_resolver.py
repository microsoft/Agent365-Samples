# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

# A365 Observability — best-effort instrumentation (verify against official sample)
"""Cache app-only export tokens acquired with the hosting blueprint connection."""

import asyncio
import base64
import json
import logging
import threading
import time

import msal
from microsoft_agents.authentication.msal import MsalConnectionManager

OBSERVABILITY_SCOPE = "api://9b975845-388f-4429-889e-eab1ef63949c/.default"
OBSERVABILITY_AUDIENCES = {
    "api://9b975845-388f-4429-889e-eab1ef63949c",
    "9b975845-388f-4429-889e-eab1ef63949c",
}
logger = logging.getLogger(__name__)


class AppTokenResolver:
    """Keep synchronous exporter reads separate from asynchronous token acquisition."""

    def __init__(self) -> None:
        self._tokens: dict[tuple[str, str], tuple[str, float]] = {}
        self._failures: dict[tuple[str, str], float] = {}
        self._lock = threading.Lock()

    def resolve(self, agent_id: str, tenant_id: str) -> str | None:
        token = self._cached(agent_id, tenant_id, 60)
        if not token:
            logger.warning("No unexpired app-only export token cached; this export cannot authenticate")
        return token

    def _cached(self, agent_id: str, tenant_id: str, skew: int) -> str | None:
        if not agent_id or not tenant_id:
            return None
        with self._lock:
            cached = self._tokens.get((tenant_id.lower(), agent_id.lower()))
        if cached and time.time() < cached[1] - skew:
            return cached[0]
        return None

    async def prefetch(
        self, connection_manager: MsalConnectionManager, tenant_id: str, agent_id: str
    ) -> None:
        if not tenant_id or not agent_id or self._cached(agent_id, tenant_id, 300):
            return
        key = (tenant_id.lower(), agent_id.lower())
        with self._lock:
            retry_after = self._failures.get(key)
        if retry_after and time.time() < retry_after:
            return

        try:
            connection = connection_manager.get_default_connection()
            assertion = await connection.get_agentic_application_token(tenant_id, agent_id)
            if not assertion:
                raise RuntimeError("The hosting connection returned no FMI assertion")
            result = await asyncio.to_thread(_acquire, tenant_id, agent_id, assertion)
            token = result.get("access_token")
            if not token:
                raise RuntimeError(f"Observability token request failed: {result.get('error')}")
            claims = _claims(token)
            if "scp" in claims:
                raise RuntimeError("Delegated tokens cannot be used for S2S telemetry")
            client_id = str(claims.get("azp") or claims.get("appid") or "").lower()
            if client_id != agent_id.lower() or str(claims.get("tid", "")).lower() != tenant_id.lower():
                raise RuntimeError("Observability token identity does not match the exporting agent")
            if claims.get("aud") not in OBSERVABILITY_AUDIENCES:
                raise RuntimeError("Observability token has the wrong audience")
            expires_at = float(claims.get("exp", 0))
            if expires_at <= time.time() + 60:
                raise RuntimeError("Observability token is expired or too close to expiry")
            with self._lock:
                self._tokens[key] = (token, expires_at)
                self._failures.pop(key, None)
            logger.info("App-only observability token acquired and validated")
        except Exception:
            with self._lock:
                self._failures[key] = time.time() + 60
            raise

    def clear(self) -> None:
        with self._lock:
            self._tokens.clear()
            self._failures.clear()


def _acquire(tenant_id: str, agent_id: str, assertion: str) -> dict:
    app = msal.ConfidentialClientApplication(
        agent_id,
        client_credential={"client_assertion": lambda: assertion},
        authority=f"https://login.microsoftonline.com/{tenant_id}",
    )
    return app.acquire_token_for_client(scopes=[OBSERVABILITY_SCOPE])


def _claims(token: str) -> dict:
    payload = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
