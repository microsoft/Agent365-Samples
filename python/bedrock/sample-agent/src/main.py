# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Amazon Bedrock Sample Agent - Main Entry Point

FastAPI server that handles incoming messages and routes them to the Bedrock agent.
"""

# Load environment variables before importing other modules
from dotenv import load_dotenv

load_dotenv()

import logging
import os

import uvicorn
from aiohttp.web import Application, Request, Response, run_app
from aiohttp.web_middlewares import middleware as web_middleware

from agent import agent_application

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Determine if running in production
is_production = bool(os.getenv("WEBSITE_SITE_NAME")) or os.getenv("PYTHON_ENV") == "production"


async def handle_messages(request: Request) -> Response:
    """
    Handle incoming messages from the Microsoft 365 Agents platform.
    Routes messages to the Bedrock agent for processing.
    """
    adapter = agent_application.adapter

    async def process_activity(context):
        await agent_application.run(context)

    return await adapter.process(request, process_activity)


async def health_check(request: Request) -> Response:
    """Health check endpoint for monitoring."""
    from aiohttp.web import json_response

    return json_response({"status": "healthy", "agent": "bedrock-sample"})


def create_app() -> Application:
    """Create and configure the aiohttp application."""
    app = Application()

    # Add routes
    app.router.add_post("/api/messages", handle_messages)
    app.router.add_get("/health", health_check)

    return app


if __name__ == "__main__":
    port = int(os.getenv("PORT", "3978"))
    host = "0.0.0.0" if is_production else "127.0.0.1"

    logger.info(f"\nServer starting on {host}:{port}")
    logger.info(f"Production mode: {is_production}")

    app = create_app()
    run_app(app, host=host, port=port)
