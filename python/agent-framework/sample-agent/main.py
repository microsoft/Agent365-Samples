# Copyright (c) Microsoft. All rights reserved.

# !/usr/bin/env python3
"""
Example: Direct usage of Generic Agent Host with AgentFrameworkAgent
This script demonstrates direct usage without complex imports.
"""

import logging
from os import environ
import sys

from aiohttp.web import Application, Request, Response, json_response, run_app
from microsoft_agents.hosting.aiohttp import (
    CloudAdapter,
    jwt_authorization_middleware,
    start_agent_process,
)

# Microsoft Agents SDK imports
from microsoft_agents.hosting.core import (
    AgentApplication,
    AgentAuthConfiguration,
)

try:
    from agent import AgentFrameworkAgent
    from hosting import create_host, A365Agent
except ImportError as e:
    print(f"Import error: {e}")
    print("Please ensure you're running from the correct directory")
    sys.exit(1)

logger = logging.getLogger(__name__)

def create_auth_configuration() -> AgentAuthConfiguration | None:
    """Create authentication configuration based on available environment variables."""
    client_id = environ.get("CLIENT_ID")
    tenant_id = environ.get("TENANT_ID")
    client_secret = environ.get("CLIENT_SECRET")

    if client_id and tenant_id and client_secret:
        logger.info(
            "Using Client Credentials authentication (CLIENT_ID/TENANT_ID provided)"
        )
        try:
            return AgentAuthConfiguration(
                client_id=client_id,
                tenant_id=tenant_id,
                client_secret=client_secret,
                scopes=["https://api.botframework.com/.default"],
            )
        except Exception as e:
            logger.error(
                f"Failed to create AgentAuthConfiguration, falling back to anonymous: {e}"
            )
            return None

    if environ.get("BEARER_TOKEN"):
        logger.info(
            "BEARER_TOKEN present but incomplete app registration; continuing in anonymous dev mode"
        )
    else:
        logger.warning("No authentication env vars found; running anonymous")

    return None

async def cleanup(agent_app: AgentApplication):
    """Clean up resources"""
    if isinstance(agent_app, A365Agent):
        try:
            await agent_app.cleanup()
            logger.info("Agent cleanup completed")
        except Exception as e:
            logger.error(f"Error during agent cleanup: {e}")

def start_server(agent_app: AgentApplication):
    """Start the server using Microsoft Agents SDK"""

    async def entry_point(req: Request) -> Response:
        agent: AgentApplication = req.app["agent_app"]
        adapter: CloudAdapter = req.app["adapter"]
        return await start_agent_process(req, agent, adapter)

    # Health endpoint
    async def health(_req: Request) -> Response:
        status = {
            "status": "ok",
            "agent_type": agent_app.agent.__class__.__name__,
        }
        return json_response(status)

    # Build middleware list
    middlewares = []
    middlewares.append(jwt_authorization_middleware)
    app = Application(middlewares=middlewares)

    # Routes
    app.router.add_post("/api/messages", entry_point)
    app.router.add_get("/api/messages", lambda _: Response(status=200))
    app.router.add_get("/api/health", health)
    app.router.add_get("/", lambda _: Response(status=200, text="Agent is running"))

    # Context
    app["agent_configuration"] = create_auth_configuration()
    app["agent_app"] = agent_app
    app["adapter"] = agent_app.adapter

    # Port configuration
    port = int(environ.get("PORT", 3978))

    print("=" * 80)
    print(f"Generic Agent Host -")
    print("=" * 80)
    print("Using Microsoft Agents SDK patterns")
    print("Compatible with Agents Playground")
    print(f"\nStarting server on localhost:{port}")
    print(f"Bot Framework endpoint: http://localhost:{port}/api/messages")
    print(f"Health: http://localhost:{port}/api/health")
    print("Ready for testing!\n")

    # Register cleanup on app shutdown
    async def cleanup_on_shutdown(app):
        """Cleanup handler for graceful shutdown"""
        logger.info("Shutting down gracefully...")
        await cleanup(agent_app)

    app.on_shutdown.append(cleanup_on_shutdown)

    try:
        run_app(app, host="localhost", port=port, handle_signals=True)
    except KeyboardInterrupt:
        print("\nServer stopped")
    except Exception as error:
        logger.error(f"Server error: {error}")
        raise error

def main():
    """Main entry point - start the generic host with AgentFrameworkAgent"""
    try:
        print("Starting Generic Agent Host with AgentFrameworkAgent...")
        print()

        # Use the convenience function to start hosting
        host = create_host(AgentFrameworkAgent)

        start_server(host)

    except Exception as e:
        print(f"Failed to start server: {e}")
        import traceback

        traceback.print_exc()
        return 1

    return 0

if __name__ == "__main__":
    exit(main())