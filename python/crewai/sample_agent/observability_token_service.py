# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""OBS-only app tokens using the autonomous sample's two-step FMI exchange.

This file is intentionally sample-local so copying/deploying this sample alone
works. Keep the interactive samples' copies identical (covered by offline tests).
Business MCP/Graph/OBO authentication and tracing baggage are not involved.
"""

import base64
import json
import math
import os
import threading
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID

FMI_SCOPE = "api://AzureADTokenExchange/.default"
OBSERVABILITY_RESOURCE = "9b975845-388f-4429-889e-eab1ef63949c"
OBSERVABILITY_SCOPE = f"api://{OBSERVABILITY_RESOURCE}/.default"
ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
REFRESH_SKEW_SECONDS = 60


class ObservabilityConfigurationError(ValueError):
    """Dedicated OBS credentials are missing or inconsistent."""


class ObservabilityTokenError(RuntimeError):
    """No usable app-only OBS token could be acquired."""


def _guid(value, setting):
    try:
        identifier = UUID(value)
        if identifier.int == 0:
            raise ValueError
        return str(identifier)
    except (ValueError, TypeError, AttributeError):
        raise ObservabilityConfigurationError(
            f"{setting} must be a non-placeholder UUID. "
            "Set the dedicated AGENT365_OBS_* settings in .env; "
            "the agent ID must be the actual agent instance client ID."
        ) from None


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward blueprint credentials or assertions to another endpoint.
        return None


class ObservabilityTokenResolver:
    """Thread-safe cache for exactly one configured tenant and agent instance."""

    def __init__(self, tenant_id, agent_id, blueprint_client_id, blueprint_client_secret):
        self.tenant_id = _guid(tenant_id, "AGENT365_OBS_TENANT_ID")
        self.agent_id = _guid(agent_id, "AGENT365_OBS_AGENT_ID")
        self.blueprint_client_id = _guid(
            blueprint_client_id, "AGENT365_OBS_BLUEPRINT_CLIENT_ID"
        )
        if self.agent_id == self.blueprint_client_id:
            raise ObservabilityConfigurationError(
                "AGENT365_OBS_AGENT_ID must differ from AGENT365_OBS_BLUEPRINT_CLIENT_ID; "
                "supply the actual agent instance client ID, not its blueprint."
            )
        secret = blueprint_client_secret
        if (
            not isinstance(secret, str)
            or not secret.strip()
            or any(part in secret.lower() for part in (
                "<<", ">>", "<your", "your_", "your-", "placeholder", "changeme",
                "replace_", "replace-",
            ))
            or secret.lower() in {"secret", "dummy", "example", "***", "...", "<...>"}
        ):
            raise ObservabilityConfigurationError(
                "AGENT365_OBS_BLUEPRINT_CLIENT_SECRET is required and must not be a "
                "placeholder. Supply a blueprint credential (development only); "
                "never a delegated user token or an agent ID."
            )
        self._secret = secret
        self._endpoint = (
            f"https://login.microsoftonline.com/{self.tenant_id}/oauth2/v2.0/token"
        )
        self._opener = build_opener(_NoRedirect())
        self._lock = threading.Lock()
        self._token = None
        self._expires_at = 0

    @classmethod
    def from_environment(cls):
        return cls(
            os.getenv("AGENT365_OBS_TENANT_ID"),
            os.getenv("AGENT365_OBS_AGENT_ID"),
            os.getenv("AGENT365_OBS_BLUEPRINT_CLIENT_ID"),
            os.getenv("AGENT365_OBS_BLUEPRINT_CLIENT_SECRET"),
        )

    def _request_token(self, fields, step):
        request = Request(
            self._endpoint,
            data=urlencode(fields).encode("utf-8"),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        try:
            with self._opener.open(request, timeout=30) as response:
                if response.status != 200:
                    raise ObservabilityTokenError("Unexpected token endpoint status.")
                result = json.load(response)
        except HTTPError as error:
            status = error.code
            error.close()
            raise ObservabilityTokenError(
                f"OBS {step} token request failed (HTTP {status}). Check dedicated "
                "OBS tenant/agent IDs, blueprint credentials and OBS application "
                "role consent for the agent instance; delegated consent is insufficient."
            ) from None
        except Exception:
            # HTTP/JSON exceptions can contain secrets or response bodies.
            raise ObservabilityTokenError(
                f"OBS {step} token request failed. Check connectivity and dedicated "
                "OBS configuration; no delegated-token fallback is permitted."
            ) from None
        if not isinstance(result, dict) or result.get("error"):
            raise ObservabilityTokenError(
                f"OBS {step} token request was rejected. Check blueprint credentials "
                "and OBS application role consent; response bodies are not logged."
            )
        token = result.get("access_token")
        if not isinstance(token, str) or not token.strip():
            raise ObservabilityTokenError(f"OBS {step} response has no access token.")
        token_type = result.get("token_type")
        if not isinstance(token_type, str) or token_type.lower() != "bearer":
            raise ObservabilityTokenError(f"OBS {step} response is not a Bearer token.")
        return result

    def _validate_app_token(self, result, requested_at):
        token = result["access_token"]
        try:
            parts = token.split(".")
            if len(parts) != 3 or not all(parts):
                raise ValueError
            claims = json.loads(base64.urlsafe_b64decode(
                parts[1] + "=" * (-len(parts[1]) % 4)
            ))
            if not isinstance(claims, dict):
                raise ValueError
        except (ValueError, TypeError):
            raise ObservabilityTokenError("OBS response is not a valid JWT.") from None

        # These are routing/type guards, NOT signature verification. Entra's TLS
        # endpoint supplies the token; the receiving OBS service validates it.
        client_ids = [claims[key] for key in ("azp", "appid") if key in claims]
        if (
            "scp" in claims
            or not isinstance(claims.get("roles"), list)
            or not claims["roles"]
            or not all(isinstance(role, str) and role for role in claims["roles"])
            or claims.get("idtyp", "app") != "app"
        ):
            raise ObservabilityTokenError(
                "OBS requires an app-only token with application roles, not scp/user "
                "claims. Verify OBS application role consent for the agent instance."
            )
        try:
            identity_matches = (
                _guid(claims.get("tid"), "OBS token tenant") == self.tenant_id
                and bool(client_ids)
                and all(_guid(value, "OBS token client") == self.agent_id
                        for value in client_ids)
                and claims.get("aud") in (
                    OBSERVABILITY_RESOURCE, f"api://{OBSERVABILITY_RESOURCE}",
                )
            )
        except ObservabilityConfigurationError:
            identity_matches = False
        if not identity_matches:
            raise ObservabilityTokenError(
                "OBS token tenant, agent client ID or audience does not match the "
                "dedicated OBS configuration. No token was cached."
            )

        expiries = []
        for key, offset, source in (
            ("expires_in", requested_at, result), ("exp", 0, claims),
        ):
            if key not in source:
                continue
            try:
                value = float(source[key])
                if isinstance(source[key], bool) or not math.isfinite(value) or value <= 0:
                    raise ValueError
            except (ValueError, TypeError, OverflowError):
                raise ObservabilityTokenError(f"OBS token has invalid {key}.") from None
            expiries.append(offset + value)
        if not expiries or min(expiries) <= time.time() + REFRESH_SKEW_SECONDS:
            raise ObservabilityTokenError(
                "OBS token is expired, near expiry, or lacks expires_in/exp. "
                "Check the token response and system clock."
            )
        return token, min(expiries)

    def __call__(self, agent_id, tenant_id):
        if (
            _guid(agent_id, "OBS export agent ID") != self.agent_id
            or _guid(tenant_id, "OBS export tenant ID") != self.tenant_id
        ):
            raise ObservabilityConfigurationError(
                "OBS export tenant/agent does not match AGENT365_OBS_TENANT_ID/"
                "AGENT365_OBS_AGENT_ID. Preserve the original baggage and configure "
                "the matching agent instance; cross-identity export is forbidden."
            )
        with self._lock:
            if self._token and time.time() < self._expires_at - REFRESH_SKEW_SECONDS:
                return self._token
            self._token = None
            self._expires_at = 0
            t1 = self._request_token({
                "client_id": self.blueprint_client_id,
                "client_secret": self._secret,
                "scope": FMI_SCOPE,
                "grant_type": "client_credentials",
                "fmi_path": self.agent_id,
            }, "blueprint FMI")
            requested_at = time.time()
            result = self._request_token({
                "client_id": self.agent_id,
                "scope": OBSERVABILITY_SCOPE,
                "grant_type": "client_credentials",
                "client_assertion_type": ASSERTION_TYPE,
                "client_assertion": t1["access_token"],
            }, "agent application")
            self._token, self._expires_at = self._validate_app_token(result, requested_at)
            return self._token


def create_observability_token_resolver(*, enabled=None):
    """Validate config at startup; acquire only when the exporter needs a token."""
    if enabled is None:
        enabled = os.getenv("ENABLE_A365_OBSERVABILITY_EXPORTER", "false").lower() in (
            "true", "1", "yes", "on",
        )
    return ObservabilityTokenResolver.from_environment() if enabled else None
