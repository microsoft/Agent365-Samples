# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

# Internal imports
import os
from hosting import MyAgent
from agent import LangChainAgent

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

# SDK-specific loggers
ms_agents_logger = logging.getLogger("microsoft_agents")
ms_agents_logger.addHandler(logging.StreamHandler())
ms_agents_logger.setLevel(logging.INFO)

observability_logger = logging.getLogger("microsoft_agents_a365.observability")
observability_logger.setLevel(logging.ERROR)

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
    @web_middleware
    async def selective_jwt_auth(request, handler):
        if request.method == "POST" and request.path == "/api/messages":
            return await jwt_authorization_middleware(request, handler)
        return await handler(request)

    middlewares = [anonymous_claims]
    if agent_auth_config and isProduction:
        middlewares.append(selective_jwt_auth)
        logger.info("JWT authorization middleware enabled (POST /api/messages only)")

    # Health / readiness endpoint
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
        configure(
            service_name=os.getenv("OBSERVABILITY_SERVICE_NAME", "LangChainSampleAgent"),
            service_namespace=os.getenv("OBSERVABILITY_SERVICE_NAMESPACE", "LangChainTesting"),
        )
        logger.info(
            "Observability configured (service=%s, a365_exporter=%s)",
            os.getenv("OBSERVABILITY_SERVICE_NAME", "LangChainSampleAgent"),
            os.getenv("ENABLE_A365_OBSERVABILITY_EXPORTER", "false"),
        )
    else:
        logger.info("Observability disabled (ENABLE_OBSERVABILITY=false)")

    agent_application = MyAgent(LangChainAgent())
    start_server(agent_application)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        logger.info("\nShutting down gracefully...")
    except Exception as e:
        logger.error("Application error: %s", e)
        raise
