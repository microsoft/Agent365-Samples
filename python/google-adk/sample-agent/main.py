# Internal imports
import json
import os
from hosting import MyAgent
from agent import GoogleADKAgentWrapper

# Server imports
from aiohttp.web import Application, Request, Response, run_app
from aiohttp.web_middlewares import middleware as web_middleware

# Microsoft Agents SDK imports
from microsoft_agents.hosting.core import AgentApplication, ClaimsIdentity, AuthenticationConstants
from microsoft_agents.hosting.aiohttp import start_agent_process, jwt_authorization_middleware
from microsoft_agents.activity import load_configuration_from_env

# Microsoft Agent 365 Observability Imports
from microsoft_agents_a365.observability.core.config import configure

# Load environment variables from .env file
from dotenv import load_dotenv
load_dotenv()

# Logging
import logging
logger = logging.getLogger(__name__)

async def playground_auth_workaround(req: Request) -> Request:
    """Workaround to set recipient field since agentsplayground does not set it."""
    body = await req.text()
    body = json.loads(body)

    body['recipient'] = {
        "id": os.getenv("AGENTIC_UPN", ""),
        "name": os.getenv("AGENTIC_NAME", ""),
        "agenticUserId": os.getenv("AGENTIC_USER_ID", ""),
        "agenticAppId": os.getenv("AGENTIC_APP_ID", ""),
        "tenantId": os.getenv("AGENTIC_TENANT_ID", ""),
        "role": "agenticUser"
    }

    async def text():
        return json.dumps(body).encode("utf-8")

    req.text = text

    return req

def start_server(agent_app: AgentApplication):
    """Start the agent application server."""
    isProduction = os.getenv("WEBSITE_SITE_NAME") is not None

    async def entry_point(req: Request) -> Response:
        # Workaround for Agents Playground missing recipient field
        req = await playground_auth_workaround(req)
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

    middlewares = [anonymous_claims]
    auth_config = load_configuration_from_env(os.environ)
    if (auth_config and isProduction):
        middlewares.append(jwt_authorization_middleware)

    # Configure App
    app = Application(middlewares=middlewares)
    app.router.add_post("/api/messages", entry_point)
    app["agent_configuration"] = auth_config

    try:
        host = "0.0.0.0" if isProduction else "localhost"
        run_app(app, host=host, port=int(3978), handle_signals=True)
    except KeyboardInterrupt:
        logger.info("\nShutting down server gracefully...")
    except Exception as e:
        logger.error(f"Server error: {e}")
        raise e

def main():
    """Main function to run the sample agent application."""
    # Configure observability
    configure(
        service_name="GoogleADKSampleAgent",
        service_namespace="GoogleADKTesting",
    )

    agent_application = MyAgent(GoogleADKAgentWrapper())
    start_server(agent_application)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        logger.info("\nShutting down gracefully...")
    except Exception as e:
        logger.error(f"Application error: {e}")
        raise e