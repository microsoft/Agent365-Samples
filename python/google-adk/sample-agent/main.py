# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

# Internal imports
import os
from hosting import MyAgent
from agent import GoogleADKAgent

# Server imports
from aiohttp.web import Application, Request, Response, run_app
from aiohttp.web_middlewares import middleware as web_middleware

# Microsoft Agents SDK imports
from microsoft_agents.hosting.core import AgentApplication, ClaimsIdentity, AuthenticationConstants
from microsoft_agents.hosting.core.authorization import AgentAuthConfiguration
from microsoft_agents.hosting.aiohttp import start_agent_process, jwt_authorization_middleware

# Microsoft Agent 365 Observability Imports
from microsoft_agents_a365.observability.core.config import configure

# Load environment variables from .env file
from dotenv import load_dotenv
load_dotenv()

# Logging — respect LOG_LEVEL from .env
import logging
log_level = getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO)
logging.basicConfig(level=log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

def start_server(agent_app: AgentApplication):
    """Start the agent application server."""
    isProduction = (
        os.getenv("WEBSITE_SITE_NAME") is not None       # Azure App Service
        or os.getenv("K_SERVICE") is not None            # GCP Cloud Run
        or os.getenv("ENVIRONMENT", "").lower() == "production"  # Explicit flag
    )

    async def entry_point(req: Request) -> Response:
        return await start_agent_process(req, agent_app, agent_app.adapter)

    # Configure middlewares
    @web_middleware
    async def anonymous_claims(request, handler):
        request['claims_identity'] = ClaimsIdentity(
            {
                AuthenticationConstants.AUDIENCE_CLAIM: "anonymous",
                AuthenticationConstants.APP_ID_CLAIM: "anonymous-app",
            },
            False,
            "Anonymous",
        )
        return await handler(request)

    # Build AgentAuthConfiguration — the JWT middleware requires an object with
    # attribute access (.TENANT_ID, .ANONYMOUS_ALLOWED), not a plain dict.
    # Read from CONNECTIONS__SERVICE_CONNECTION__SETTINGS__* (A365 format) or
    # direct CLIENT_ID / TENANT_ID / CLIENT_SECRET vars as fallback.
    # IMPORTANT: client_id for JWT validation must be the blueprint/app-registration ID
    # (CLIENTID), NOT the AGENTIC_APP_ID. Bot Framework tokens have aud=blueprint ID.
    agent_auth_config = None
    client_id = (
        os.getenv("CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID")
        or os.getenv("CLIENT_ID")
        or os.getenv("AGENTIC_APP_ID")
    )
    tenant_id = (
        os.getenv("AGENTIC_TENANT_ID")
        or os.getenv("CONNECTIONS__SERVICE_CONNECTION__SETTINGS__TENANTID")
        or os.getenv("TENANT_ID")
    )
    client_secret = (
        os.getenv("CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTSECRET")
        or os.getenv("CLIENT_SECRET")
    )
    if client_id and tenant_id and client_secret:
        try:
            agent_auth_config = AgentAuthConfiguration(
                client_id=client_id,
                tenant_id=tenant_id,
                client_secret=client_secret,
            )
            logger.info("JWT auth configured (client_id=%s)", client_id)
        except Exception as e:
            logger.warning("Failed to build AgentAuthConfiguration, running anonymous: %s", e)
    else:
        logger.info("No auth credentials found — running in anonymous mode")

    # Wrap JWT middleware so it only applies to POST /api/messages.
    # Azure App Service sends health probes (GET /robots933456.txt, GET /)
    # that must return 200 without authentication.
    @web_middleware
    async def selective_jwt_auth(request, handler):
        if request.method == "POST" and request.path == "/api/messages":
            return await jwt_authorization_middleware(request, handler)
        return await handler(request)

    middlewares = [anonymous_claims]
    if agent_auth_config and isProduction:
        middlewares.append(selective_jwt_auth)
        logger.info("JWT authorization middleware enabled (POST /api/messages only)")

    # Health / readiness endpoint — returns 200 for Azure App Service probes.
    async def health_check(req: Request) -> Response:
        return Response(text="OK", status=200)

    # Configure App
    app = Application(middlewares=middlewares)
    app.router.add_get("/", health_check)
    app.router.add_get("/robots933456.txt", health_check)
    app.router.add_post("/api/messages", entry_point)
    app["agent_configuration"] = agent_auth_config

    try:
        host = "0.0.0.0" if isProduction else "localhost"
        port = int(os.getenv("PORT", 3978))
        logger.info("Listening on %s:%d/api/messages", host, port)
        run_app(app, host=host, port=port, handle_signals=True)
    except KeyboardInterrupt:
        logger.info("\nShutting down server gracefully...")

def main():
    """Main function to run the sample agent application."""
    # Configure observability from .env
    # ENABLE_OBSERVABILITY=true/false controls whether tracing is set up.
    # ENABLE_A365_OBSERVABILITY_EXPORTER=true sends traces to the A365 backend;
    # false falls back to the console exporter (expected in local/dev).
    if os.getenv("ENABLE_OBSERVABILITY", "true").lower() == "true":
        configure(
            service_name=os.getenv("OBSERVABILITY_SERVICE_NAME", "GoogleADKSampleAgent"),
            service_namespace=os.getenv("OBSERVABILITY_SERVICE_NAMESPACE", "GoogleADKTesting"),
        )
        logger.info(
            "Observability configured (service=%s, a365_exporter=%s)",
            os.getenv("OBSERVABILITY_SERVICE_NAME", "GoogleADKSampleAgent"),
            os.getenv("ENABLE_A365_OBSERVABILITY_EXPORTER", "false"),
        )
    else:
        logger.info("Observability disabled (ENABLE_OBSERVABILITY=false)")

    agent_application = MyAgent(GoogleADKAgent())
    start_server(agent_application)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        logger.info("\nShutting down gracefully...")
    except Exception as e:
        logger.error(f"Application error: {e}")
        raise e