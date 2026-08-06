# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Entry point for the autonomous GitHub Trending agent.

Initializes the Microsoft OpenTelemetry distro, starts the background token service
and trending digest loop, and runs a minimal aiohttp health check server.
"""

import asyncio
import logging
import os
import re
from datetime import datetime, timezone
from urllib.parse import urlparse

from aiohttp import web
from dotenv import load_dotenv
from openai import AsyncAzureOpenAI, AsyncOpenAI

from microsoft.opentelemetry import use_microsoft_opentelemetry
from microsoft.opentelemetry.a365.core import AgentDetails

import token_cache
from github_trending_service import run_trending_service
from observability_token_service import acquire_initial_token, run_token_service

# Load .env (local dev) — no-op if file doesn't exist
load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ── Configuration ────────────────────────────────────────────────────────────

AZURE_OPENAI_ENDPOINT = os.environ.get("AZURE_OPENAI_ENDPOINT")
if not AZURE_OPENAI_ENDPOINT:
    raise SystemExit("AZURE_OPENAI_ENDPOINT environment variable is required but not set.")

AZURE_OPENAI_API_KEY = os.environ.get("AZURE_OPENAI_API_KEY")
if not AZURE_OPENAI_API_KEY:
    raise SystemExit("AZURE_OPENAI_API_KEY environment variable is required but not set.")
AZURE_OPENAI_DEPLOYMENT = os.environ.get("AZURE_OPENAI_DEPLOYMENT", "gpt-4o")
# Only consumed by the classic AzureOpenAI client. Foundry's /openai/v1 path ignores
# (and in fact rejects) api-version, so this is effectively a default for non-Foundry endpoints.
AZURE_OPENAI_API_VERSION = os.environ.get("AZURE_OPENAI_API_VERSION", "2024-10-21")

# Agent 365 Observability — optional. When these are missing or set to placeholders,
# the agent runs without A365 observability export (spans go to console only).
# Read AGENT365OBSERVABILITY__* (canonical) with legacy AGENT365_* names as fallback
# for backward compatibility with older .env files.
TENANT_ID = os.environ.get("AGENT365OBSERVABILITY__TENANTID") or os.environ.get("AGENT365_TENANT_ID", "")
AGENT_ID = os.environ.get("AGENT365OBSERVABILITY__AGENTID") or os.environ.get("AGENT365_AGENT_ID", "")
BLUEPRINT_ID = os.environ.get("AGENT365OBSERVABILITY__AGENTBLUEPRINTID") or os.environ.get("AGENT365_BLUEPRINT_ID", "")
CLIENT_ID = os.environ.get("AGENT365OBSERVABILITY__CLIENTID") or os.environ.get("AGENT365_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("AGENT365OBSERVABILITY__CLIENTSECRET") or os.environ.get("AGENT365_CLIENT_SECRET", "")
AGENT_NAME = (os.environ.get("AGENT365OBSERVABILITY__AGENTNAME") or os.environ.get("AGENT365_AGENT_NAME", "github-trending")).strip('"')
AGENT_DESCRIPTION = os.environ.get("AGENT365OBSERVABILITY__AGENTDESCRIPTION") or os.environ.get("AGENT365_AGENT_DESCRIPTION", "")
# Default to MSI in production (matches .NET appsettings.json default of true).
# Local dev .env sets this to "false" to use client secret instead.
USE_MANAGED_IDENTITY = os.environ.get("AGENT365_USE_MANAGED_IDENTITY", "true").lower() == "true"

# Observability feature flags (mirrors python/google-adk/sample-agent/main.py pattern).
# ENABLE_A365_OBSERVABILITY        — master switch for the OpenTelemetry pipeline.
# ENABLE_A365_OBSERVABILITY_EXPORTER — when false, spans go to console only
#                                       (no upload to the A365 backend).
ENABLE_A365_OBSERVABILITY = os.environ.get("ENABLE_A365_OBSERVABILITY", "true").lower() == "true"
ENABLE_A365_OBSERVABILITY_EXPORTER = os.environ.get("ENABLE_A365_OBSERVABILITY_EXPORTER", "false").lower() == "true"

def _has_a365_credentials() -> bool:
    """Check whether Agent 365 observability credentials are fully configured."""
    required_values = [TENANT_ID, AGENT_ID, CLIENT_ID]
    if not all(v and not v.startswith("<<") for v in required_values):
        return False

    if USE_MANAGED_IDENTITY:
        return True

    return bool(CLIENT_SECRET) and not CLIENT_SECRET.startswith("<<")

LANGUAGE = os.environ.get("GITHUB_TRENDING_LANGUAGE", "python")
MIN_STARS = int(os.environ.get("GITHUB_TRENDING_MIN_STARS", "5"))
MAX_RESULTS = int(os.environ.get("GITHUB_TRENDING_MAX_RESULTS", "10"))
HEARTBEAT_INTERVAL_MS = int(os.environ.get("HEARTBEAT_INTERVAL_MS", "60000"))
PORT = int(os.environ.get("PORT", "3979"))

# ── Agent Details (shared across all scopes) ─────────────────────────────────

agent_details = AgentDetails(
    agent_id=AGENT_ID or "local-dev",
    agent_name=AGENT_NAME,
    agent_description=AGENT_DESCRIPTION,
    agent_blueprint_id=BLUEPRINT_ID,
    tenant_id=TENANT_ID or "local-dev",
)

A365_ENABLED = _has_a365_credentials()
# Exporter is only active when (a) the master observability flag is on,
# (b) credentials are configured, and (c) the exporter flag is on.
A365_EXPORTER_ENABLED = ENABLE_A365_OBSERVABILITY and A365_ENABLED and ENABLE_A365_OBSERVABILITY_EXPORTER

# ── Microsoft OpenTelemetry Distro ───────────────────────────────────────────
# Equivalent to .NET's builder.UseMicrosoftOpenTelemetry().
# Token resolver reads from the in-memory cache populated by the background token service.
# When A365 credentials are not configured or observability is disabled, the
# A365 exporter is skipped and spans go to the console only.

if ENABLE_A365_OBSERVABILITY:
    use_microsoft_opentelemetry(
        enable_a365=A365_EXPORTER_ENABLED,
        enable_azure_monitor=False,
        a365_use_s2s_endpoint=True,
        a365_token_resolver=lambda agent_id, tenant_id: token_cache.get_cached_token(agent_id, tenant_id) or "",
    )
    logger.info(
        "Observability configured (a365_exporter=%s, credentials_present=%s)",
        A365_EXPORTER_ENABLED,
        A365_ENABLED,
    )
else:
    logger.info("Observability disabled (ENABLE_A365_OBSERVABILITY=false)")


# ── Health check endpoint ────────────────────────────────────────────────────

async def health_handler(request: web.Request) -> web.Response:
    return web.json_response({"status": "healthy", "timestamp": datetime.now(timezone.utc).isoformat()})


# ── Heartbeat ────────────────────────────────────────────────────────────────

async def heartbeat_loop(interval_seconds: float) -> None:
    logger.info("HeartbeatService started. Interval: %ds", interval_seconds)
    while True:
        await asyncio.sleep(interval_seconds)
        logger.info("Agent heartbeat %s", datetime.now(timezone.utc).isoformat())


# ── Main ─────────────────────────────────────────────────────────────────────

async def start_background_tasks(app: web.Application) -> None:
    interval_seconds = HEARTBEAT_INTERVAL_MS / 1000.0

    # Background token service — acquires observability tokens via 3-hop FMI chain.
    # Skipped when Agent 365 credentials are not configured.
    if A365_ENABLED:
        # Acquire first token before starting trending service so the first cycle
        # has valid observability credentials (CRM-005).
        try:
            await acquire_initial_token(
                tenant_id=TENANT_ID,
                agent_id=AGENT_ID,
                blueprint_client_id=CLIENT_ID,
                blueprint_client_secret=CLIENT_SECRET,
                use_managed_identity=USE_MANAGED_IDENTITY,
            )
        except Exception:
            logger.warning("Initial token acquisition failed; continuing with background refresh.", exc_info=True)

        app["token_task"] = asyncio.create_task(
            run_token_service(
                tenant_id=TENANT_ID,
                agent_id=AGENT_ID,
                blueprint_client_id=CLIENT_ID,
                blueprint_client_secret=CLIENT_SECRET,
                use_managed_identity=USE_MANAGED_IDENTITY,
            )
        )
    else:
        logger.warning(
            "Agent365 credentials not configured — skipping token service. "
            "Run 'a365 setup all' to enable A365 observability export."
        )

    # Heartbeat
    app["heartbeat_task"] = asyncio.create_task(heartbeat_loop(interval_seconds))

    # OpenAI client — Foundry resources (services.ai.azure.com / cognitiveservices.azure.com)
    # use the OpenAI-compatible /openai/v1 path which does NOT accept the api-version query.
    # Classic Azure OpenAI resources (.openai.azure.com) use the legacy deployments path.
    # This mirrors the Node.js sample at nodejs/autonomous/github-trending/src/github-trending-service.ts.
    parsed = urlparse(AZURE_OPENAI_ENDPOINT)
    if not parsed.scheme or not parsed.netloc:
        raise SystemExit(
            f"AZURE_OPENAI_ENDPOINT must be an absolute URL with a scheme (e.g. "
            f"https://your-resource.openai.azure.com/ or "
            f"https://your-foundry-account.services.ai.azure.com/). Got: {AZURE_OPENAI_ENDPOINT!r}"
        )
    resource_endpoint = f"{parsed.scheme}://{parsed.netloc}"  # strip any path pasted from the portal
    use_foundry_v1_path = bool(
        re.search(r"services\.ai\.azure\.com|cognitiveservices\.azure\.com", parsed.netloc, re.IGNORECASE)
    )

    if use_foundry_v1_path:
        # Foundry's /openai/v1 path expects authentication via the `api-key` header.
        # The OpenAI SDK requires api_key to be set, so pass a placeholder — the real
        # credential is sent via default_headers and Foundry ignores the placeholder Bearer token.
        client = AsyncOpenAI(
            base_url=f"{resource_endpoint}/openai/v1",
            api_key="placeholder-foundry-uses-api-key-header",
            default_headers={"api-key": AZURE_OPENAI_API_KEY},
        )
        logger.info("Using Foundry OpenAI-compatible client (base_url=%s/openai/v1)", resource_endpoint)
    else:
        client = AsyncAzureOpenAI(
            azure_endpoint=resource_endpoint,
            api_key=AZURE_OPENAI_API_KEY,
            api_version=AZURE_OPENAI_API_VERSION,
        )
        logger.info("Using classic Azure OpenAI client (endpoint=%s, api_version=%s)", resource_endpoint, AZURE_OPENAI_API_VERSION)

    app["openai_client"] = client

    # Trending digest service
    app["trending_task"] = asyncio.create_task(
        run_trending_service(
            client=client,
            deployment=AZURE_OPENAI_DEPLOYMENT,
            agent_details=agent_details,
            endpoint=AZURE_OPENAI_ENDPOINT,
            language=LANGUAGE,
            min_stars=MIN_STARS,
            max_results=MAX_RESULTS,
            interval_seconds=interval_seconds,
        )
    )


async def cleanup_background_tasks(app: web.Application) -> None:
    for key in ("token_task", "heartbeat_task", "trending_task"):
        task = app.get(key)
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass  # Expected during shutdown — task cancellation is the normal cleanup path

    # Close the Azure OpenAI client to release underlying httpx connections
    client = app.get("openai_client")
    if client:
        await client.close()


def main() -> None:
    app = web.Application()
    app.router.add_get("/api/health", health_handler)
    app.router.add_get("/", lambda r: web.Response(text="GitHubTrending — Autonomous agent monitoring trending repositories"))
    app.on_startup.append(start_background_tasks)
    app.on_cleanup.append(cleanup_background_tasks)

    logger.info("Starting GitHub Trending agent on port %d (use_managed_identity=%s)", PORT, USE_MANAGED_IDENTITY)
    web.run_app(app, port=PORT)


if __name__ == "__main__":
    main()
