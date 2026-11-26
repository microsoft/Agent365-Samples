# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

# A365 Observability — best-effort instrumentation (verify against official sample)
"""Bounded app-only export-token cache using the hosting blueprint credential.

Prefetch waits at most ten seconds; socket operations use three-second timeouts.
Outstanding workers are capped even when DNS or an OS transport outlives that
deadline. Service Fabric managed identity is deliberately unsupported because
MSAL replaces the supplied transport there, losing its timeout policy.
"""

import asyncio
import base64
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import msal
import requests
from microsoft_agents.authentication.msal import MsalAuth, MsalConnectionManager
from microsoft_agents.hosting.core import AuthTypes

OBSERVABILITY_SCOPE = "api://9b975845-388f-4429-889e-eab1ef63949c/.default"
OBSERVABILITY_AUDIENCES = {
    "api://9b975845-388f-4429-889e-eab1ef63949c",
    "9b975845-388f-4429-889e-eab1ef63949c",
}
logger = logging.getLogger(__name__)

CACHE_CAPACITY = 256
FAILURE_BACKOFF_SECONDS = 60
PREFETCH_TIMEOUT_SECONDS = 10
HTTP_TIMEOUT_SECONDS = 3
# A timed-out coroutine cannot kill a requests worker (including DNS resolution).
# Keep its slot until the worker actually exits; never queue unlimited workers.
_WORKERS = threading.BoundedSemaphore(4)
_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="observability-token")


class AppTokenResolver:
    """Keep synchronous exporter reads separate from asynchronous token acquisition."""

    def __init__(self) -> None:
        self._tokens: dict[tuple[str, str], tuple[str, float]] = {}
        self._failures: dict[tuple[str, str], float] = {}
        self._lock = threading.Lock()
        self._generation = 0

    def _prune(self, now: float) -> None:
        """Called under the lock, including for unrelated identity lookups."""
        for key, (_, expires_at) in list(self._tokens.items()):
            if expires_at <= now + 60:
                del self._tokens[key]
        for key, retry_after in list(self._failures.items()):
            if retry_after <= now:
                del self._failures[key]

    @staticmethod
    def _put(mapping: dict, key: tuple[str, str], value: object) -> None:
        mapping.pop(key, None)
        if len(mapping) >= CACHE_CAPACITY:
            del mapping[next(iter(mapping))]
        mapping[key] = value

    def resolve(self, agent_id: str, tenant_id: str) -> str | None:
        token = self._cached(agent_id, tenant_id, 60)
        if not token:
            logger.warning("No unexpired app-only export token cached; this export cannot authenticate")
        return token

    def _cached(self, agent_id: str, tenant_id: str, skew: int) -> str | None:
        with self._lock:
            now = time.time()
            self._prune(now)
            if not agent_id or not tenant_id:
                return None
            cached = self._tokens.get((tenant_id.lower(), agent_id.lower()))
        if cached and now < cached[1] - skew:
            return cached[0]
        return None

    async def prefetch(
        self, connection_manager: MsalConnectionManager, tenant_id: str, agent_id: str
    ) -> None:
        if self._cached(agent_id, tenant_id, 300) or not tenant_id or not agent_id:
            return
        key = (tenant_id.lower(), agent_id.lower())
        with self._lock:
            retry_after = self._failures.get(key)
            generation = self._generation
        if retry_after and time.time() < retry_after:
            return

        try:
            connection = connection_manager.get_default_connection()
            if not _WORKERS.acquire(blocking=False):
                raise RuntimeError("Observability token workers are busy")

            def acquire() -> dict:
                return _acquire_with_hosting(connection, tenant_id, agent_id)

            # Shield the future so timeout/cancellation does not release a live
            # worker's slot or let late results repopulate the cache.
            try:
                pending = _EXECUTOR.submit(acquire)
            except BaseException:
                _WORKERS.release()
                raise
            pending.add_done_callback(lambda _, slots=_WORKERS: slots.release())
            future = asyncio.wrap_future(pending)
            future.add_done_callback(_consume_exception)
            result = await asyncio.wait_for(
                asyncio.shield(future), timeout=PREFETCH_TIMEOUT_SECONDS
            )
            token = result.get("access_token")
            if not token:
                raise RuntimeError("Observability token request failed")
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
                if generation != self._generation:
                    return
                self._prune(time.time())
                self._put(self._tokens, key, (token, expires_at))
                self._failures.pop(key, None)
            logger.info("App-only observability token acquired and validated")
        except (Exception, asyncio.CancelledError):
            with self._lock:
                if generation == self._generation:
                    now = time.time()
                    self._prune(now)
                    self._put(self._failures, key, now + FAILURE_BACKOFF_SECONDS)
            raise

    def clear(self) -> None:
        with self._lock:
            self._tokens.clear()
            self._failures.clear()
            self._generation += 1


def _consume_exception(future: asyncio.Future) -> None:
    if not future.cancelled():
        future.exception()


class _BoundedHttpClient:
    """Finite socket waits for every MSAL request, including managed identity."""

    def __init__(self, deadline: float | None = None) -> None:
        self._session = requests.Session()
        self.deadline = (
            time.monotonic() + PREFETCH_TIMEOUT_SECONDS if deadline is None else deadline
        )

    def get(self, url: str, **kwargs):
        return self._request("GET", url, **kwargs)

    def post(self, url: str, **kwargs):
        return self._request("POST", url, **kwargs)

    def _request(self, method: str, url: str, **kwargs):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise requests.Timeout("Observability token acquisition deadline elapsed")
        kwargs["timeout"] = min(HTTP_TIMEOUT_SECONDS, remaining)
        # No retrying adapter; redirect chains must not extend credential waits.
        kwargs["allow_redirects"] = False
        return self._session.request(method, url, **kwargs)

    def close(self) -> None:
        self._session.close()


class _BoundedHostingAuth(MsalAuth):
    """Reuse SDK FMI semantics without its unbounded, shared client factories.

    The installed SDK uses timeout=None for discovery/FMI and bare Sessions for
    managed identity. Do not patch shared clients: workload auth uses them too.
    """

    def __init__(self, configuration, http_client: _BoundedHttpClient) -> None:
        super().__init__(configuration)
        self._http_client = http_client

    def _create_client_application(self, tenant_id=None):
        config = self.configuration
        if config.AUTH_TYPE == AuthTypes.identity_proxy_manager:
            return self._managed_identity(config.CLIENT_ID)
        if config.AUTH_TYPE == AuthTypes.client_secret:
            credential = config.CLIENT_SECRET
        elif config.AUTH_TYPE == AuthTypes.certificate:
            credential = {"private_key_pfx_path": config.CERT_PFX_FILE}
            if config.SEND_X5C:
                credential["public_certificate"] = True
        elif config.AUTH_TYPE == AuthTypes.federated_credentials:
            identity = self._managed_identity(config.FEDERATED_CLIENT_ID)

            def assertion():
                result = identity.acquire_token_for_client(resource="api://AzureADTokenExchange")
                if not result.get("access_token"):
                    raise RuntimeError("Managed identity assertion acquisition failed")
                return result["access_token"]

            credential = {"client_assertion": assertion}
        elif config.AUTH_TYPE == AuthTypes.workload_identity:
            def assertion():
                with open(config.FEDERATED_TOKEN_FILE, encoding="utf-8") as token_file:
                    return token_file.read().strip()

            credential = {"client_assertion": assertion}
        else:
            raise RuntimeError("Hosting credential type is unsupported for bounded telemetry")
        return msal.ConfidentialClientApplication(
            client_id=config.CLIENT_ID,
            client_credential=credential,
            authority=self._resolve_authority(config, tenant_id),
            azure_region=self._resolve_azure_region(config),
            http_client=self._http_client,
            timeout=HTTP_TIMEOUT_SECONDS,
        )

    def _managed_identity(self, client_id):
        # This proxy intentionally is not a requests.Session: MSAL's Service
        # Fabric path clones Sessions and drops request timeouts. Fail closed
        # there instead of silently constructing an unbounded transport.
        return msal.ManagedIdentityClient(
            msal.UserAssignedManagedIdentity(client_id=client_id),
            http_client=self._http_client,
        )


def _acquire_with_hosting(connection, tenant_id: str, agent_id: str) -> dict:
    http_client = _BoundedHttpClient()
    try:
        if not isinstance(connection, MsalAuth):
            raise RuntimeError("Bounded telemetry requires an MSAL hosting connection")
        hosting = _BoundedHostingAuth(connection.configuration, http_client)
        assertion = asyncio.run(hosting.get_agentic_application_token(tenant_id, agent_id))
        if not assertion:
            raise RuntimeError("The hosting connection returned no FMI assertion")
        return _acquire(tenant_id, agent_id, assertion, deadline=http_client.deadline)
    finally:
        http_client.close()


def _acquire(
    tenant_id: str, agent_id: str, assertion: str, *, deadline: float | None = None
) -> dict:
    http_client = _BoundedHttpClient(deadline)
    try:
        app = msal.ConfidentialClientApplication(
            agent_id,
            client_credential={"client_assertion": lambda: assertion},
            authority=f"https://login.microsoftonline.com/{tenant_id}",
            http_client=http_client,
            timeout=HTTP_TIMEOUT_SECONDS,
        )
        return app.acquire_token_for_client(scopes=[OBSERVABILITY_SCOPE])
    finally:
        http_client.close()


def _claims(token: str) -> dict:
    payload = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
