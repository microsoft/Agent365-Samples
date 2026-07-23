# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

# Internal imports
import os
from hosting import MyAgent
from agent import PerplexityAgent

# Server imports
from aiohttp.web import Application, Request, Response, run_app
from aiohttp.web_middlewares import middleware as web_middleware

# Microsoft Agents SDK imports
from microsoft_agents.hosting.core import AgentApplication, ClaimsIdentity, AuthenticationConstants
from microsoft_agents.hosting.core.authorization import AgentAuthConfiguration
from microsoft_agents.hosting.aiohttp import start_agent_process, jwt_authorization_middleware

# Microsoft Agent 365 Observability Imports
from microsoft_agents_a365.observability.core.config import configure
from token_cache import get_cached_agentic_token

# Load environment variables from .env file
from dotenv import load_dotenv
load_dotenv()

# Logging — respect LOG_LEVEL from .env
import logging
log_level = getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO)
logging.basicConfig(level=log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# SDK-specific loggers
ms_agents_logger = logging.getLogger("microsoft_agents")
ms_agents_logger.addHandler(logging.StreamHandler())
ms_agents_logger.setLevel(logging.INFO)

observability_logger = logging.getLogger("microsoft_agents_a365.observability")
observability_logger.setLevel(logging.ERROR)

logger = logging.getLogger(__name__)


def start_server(agent_app: AgentApplication, on_shutdown=None):
    """Start the agent application server."""
    isProduction = (
        os.getenv("WEBSITE_SITE_NAME") is not None       # Azure App Service
        or os.getenv("K_SERVICE") is not None            # GCP Cloud Run
        or os.getenv("ENVIRONMENT", "").lower() == "production"  # Explicit flag
    )

    async def entry_point(req: Request) -> Response:
        return await start_agent_process(req, agent_app, agent_app.adapter)

    # Build auth configuration
    def _env(name: str) -> str | None:
        """Read an env var, returning None for empty strings and <<…>> placeholders."""
        v = os.getenv(name)
        if not v or v.startswith("<<"):
            return None
        return v

    agent_auth_config = None
    client_id = (
        _env("CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID")
        or _env("CLIENT_ID")
    )
    tenant_id = (
        _env("CONNECTIONS__SERVICE_CONNECTION__SETTINGS__TENANTID")
        or _env("TENANT_ID")
    )
    client_secret = (
        _env("CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTSECRET")
        or _env("CLIENT_SECRET")
    )
    scopes = _env("CONNECTIONS__SERVICE_CONNECTION__SETTINGS__SCOPES") or "5a807f24-c9de-44ee-a3a7-329e88a00ffc/.default"
    if client_id and tenant_id and client_secret:
        try:
            agent_auth_config = AgentAuthConfiguration(
                client_id=client_id,
                tenant_id=tenant_id,
                client_secret=client_secret,
                scopes=[scopes],
            )
            logger.info("JWT auth configured (client_id=%s)", client_id)
        except Exception as e:
            logger.warning("Failed to build AgentAuthConfiguration, running anonymous: %s", e)
    else:
        logger.info("No auth credentials found — running in anonymous mode")

    # Configure middlewares
    # Anonymous claims — applied when auth is not configured OR when running
    # locally (not in production) so the Playground can work without JWT.
    @web_middleware
    async def anonymous_claims(request, handler):
        if not agent_auth_config or not isProduction:
            request['claims_identity'] = ClaimsIdentity(
                {
                    AuthenticationConstants.AUDIENCE_CLAIM: "anonymous",
                    AuthenticationConstants.APP_ID_CLAIM: "anonymous-app",
                },
                False,
                "Anonymous",
            )
        return await handler(request)

    # JWT auth — excludes health/readiness endpoints.
    @web_middleware
    async def auth_with_exclusions(request, handler):
        path = request.path.lower()
        if path in ["/", "/robots933456.txt", "/api/health"]:
            return await handler(request)
        return await jwt_authorization_middleware(request, handler)

    middlewares = []
    if agent_auth_config and isProduction:
        middlewares.append(auth_with_exclusions)
        logger.info("JWT authorization middleware enabled")
    elif agent_auth_config:
        logger.info("Auth credentials present but NOT in production — JWT middleware skipped (Playground/local dev)")
    middlewares.append(anonymous_claims)

    # Health / readiness endpoints
    async def health_check(req: Request) -> Response:
        import json as _json
        from datetime import datetime, timezone
        body = _json.dumps({"status": "healthy", "timestamp": datetime.now(timezone.utc).isoformat()})
        return Response(text=body, status=200, content_type="application/json")

    # Configure App
    app = Application(middlewares=middlewares)
    app.router.add_get("/", health_check)
    app.router.add_get("/robots933456.txt", health_check)
    app.router.add_get("/api/health", health_check)
    app.router.add_post("/api/messages", entry_point)
    app["agent_configuration"] = agent_auth_config

    if on_shutdown:
        app.on_shutdown.append(on_shutdown)

    try:
        host = "0.0.0.0" if isProduction else "localhost"

        port_str = os.getenv("PORT")
        if port_str:
            try:
                port = int(port_str)
                logger.info("Using PORT from environment: %d", port)
            except ValueError:
                logger.warning("Invalid PORT value '%s', using default 3978", port_str)
                port = 3978
        else:
            port = 3978
            logger.info("PORT not set, using default: %d", port)

        logger.info("Listening on %s:%d/api/messages", host, port)
        run_app(app, host=host, port=port, handle_signals=True)
    except KeyboardInterrupt:
        logger.info("\nShutting down server gracefully...")


def main():
    """Main function to run the sample agent application."""
    if os.getenv("ENABLE_OBSERVABILITY", "true").lower() == "true":
        def token_resolver(agent_id: str, tenant_id: str) -> str | None:
            """Resolve cached agentic token for the A365 observability exporter."""
            return get_cached_agentic_token(tenant_id, agent_id)

        status = configure(
            service_name=os.getenv("OBSERVABILITY_SERVICE_NAME", "PerplexitySampleAgent"),
            service_namespace=os.getenv("OBSERVABILITY_SERVICE_NAMESPACE", "PerplexityTesting"),
            token_resolver=token_resolver,
            cluster_category=os.getenv("PYTHON_ENVIRONMENT", "development"),
        )
        if status:
            logger.info(
                "Observability configured (service=%s, a365_exporter=%s)",
                os.getenv("OBSERVABILITY_SERVICE_NAME", "PerplexitySampleAgent"),
                os.getenv("ENABLE_A365_OBSERVABILITY_EXPORTER", "false"),
            )
        else:
            logger.warning("Observability configuration failed")
    else:
        logger.info("Observability disabled (ENABLE_OBSERVABILITY=false)")

    agent_application = MyAgent(PerplexityAgent())

    # Close MCP sessions cleanly when the server shuts down
    async def _on_shutdown(app):
        logger.info("Closing MCP sessions…")
        await agent_application.agent.tool_service.close()

    start_server(agent_application, on_shutdown=_on_shutdown)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        logger.info("\nShutting down gracefully...")
    except Exception as e:
        logger.error("Application error: %s", e)
        raise
