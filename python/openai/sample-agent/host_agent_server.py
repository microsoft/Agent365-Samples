# Copyright (c) Microsoft. All rights reserved.

"""
Generic Agent Host Server
A generic hosting server that can host any agent class that implements the required interface.
"""

import logging
import os
import socket
from os import environ

# Import our agent base class
from agent_interface import AgentInterface, check_agent_inheritance
from aiohttp.web import Application, Request, Response, json_response, run_app
from aiohttp.web_middlewares import middleware as web_middleware
from dotenv import load_dotenv
from microsoft_agents.activity import load_configuration_from_env
from microsoft_agents.authentication.msal import MsalConnectionManager
from microsoft_agents.hosting.aiohttp import (
    CloudAdapter,
    jwt_authorization_middleware,
    start_agent_process,
)

# Microsoft Agents SDK imports
from microsoft_agents.hosting.core import (
    AgentApplication,
    AgentAuthConfiguration,
    AuthenticationConstants,
    Authorization,
    ClaimsIdentity,
    MemoryStorage,
    TurnContext,
    TurnState,
)
from microsoft_agents_a365.observability.core.middleware.baggage_builder import BaggageBuilder
from microsoft_agents_a365.runtime.environment_utils import (
    get_observability_authentication_scope,
)
from token_cache import cache_agentic_token

# Configure logging
ms_agents_logger = logging.getLogger("microsoft_agents")
ms_agents_logger.addHandler(logging.StreamHandler())
ms_agents_logger.setLevel(logging.INFO)

logger = logging.getLogger(__name__)

# Load configuration
load_dotenv()
agents_sdk_config = load_configuration_from_env(environ)


class GenericAgentHost:
    """Generic host that can host any agent implementing the AgentInterface"""

    def __init__(self, agent_class: type[AgentInterface], *agent_args, **agent_kwargs):
        """
        Initialize the generic host with an agent class and its initialization parameters.

        Args:
            agent_class: The agent class to instantiate (must implement AgentInterface)
            *agent_args: Positional arguments to pass to the agent constructor
            **agent_kwargs: Keyword arguments to pass to the agent constructor
        """
        # Check that the agent inherits from AgentInterface
        if not check_agent_inheritance(agent_class):
            raise TypeError(f"Agent class {agent_class.__name__} must inherit from AgentInterface")

        # Only use auth handler when agentic auth is enabled
        use_agentic_auth = os.getenv("USE_AGENTIC_AUTH", "false").lower() == "true"
        self.auth_handler_name = "AGENTIC" if use_agentic_auth else None

        self.agent_class = agent_class
        self.agent_args = agent_args
        self.agent_kwargs = agent_kwargs
        self.agent_instance = None

        # Microsoft Agents SDK components
        self.storage = MemoryStorage()
        self.connection_manager = MsalConnectionManager(**agents_sdk_config)
        self.adapter = CloudAdapter(connection_manager=self.connection_manager)
        self.authorization = Authorization(
            self.storage, self.connection_manager, **agents_sdk_config
        )
        self.agent_app = AgentApplication[TurnState](
            storage=self.storage,
            adapter=self.adapter,
            authorization=self.authorization,
            **agents_sdk_config,
        )

        # Setup message handlers
        self._setup_handlers()

    def _setup_handlers(self):
        """Setup the Microsoft Agents SDK message handlers"""

        async def help_handler(context: TurnContext, _: TurnState):
            """Handle help requests and member additions"""
            welcome_message = (
                "👋 **Welcome to Generic Agent Host!**\n\n"
                f"I'm powered by: **{self.agent_class.__name__}**\n\n"
                "Ask me anything and I'll do my best to help!\n"
                "Type '/help' for this message."
            )
            await context.send_activity(welcome_message)
            logger.info("📨 Sent help/welcome message")

        # Register handlers
        self.agent_app.conversation_update("membersAdded")(help_handler)
        self.agent_app.message("/help")(help_handler)

        # Only require auth handlers if agentic auth is enabled
        handler_config = {"auth_handlers": [self.auth_handler_name]} if self.auth_handler_name else {}
        @self.agent_app.activity("message", **handler_config)
        async def on_message(context: TurnContext, _: TurnState):
            """Handle all messages with the hosted agent"""
            try:
                tenant_id = context.activity.recipient.tenant_id
                agent_id = context.activity.recipient.agentic_app_id
                with BaggageBuilder().tenant_id(tenant_id).agent_id(agent_id).build():
                    # Ensure the agent is available
                    if not self.agent_instance:
                        error_msg = "❌ Sorry, the agent is not available."
                        logger.error(error_msg)
                        await context.send_activity(error_msg)
                        return

                    # Only exchange token if agentic auth is enabled
                    if self.auth_handler_name:
                        exaau_token = await self.agent_app.auth.exchange_token(
                            context,
                            scopes=get_observability_authentication_scope(),
                            auth_handler_id=self.auth_handler_name,
                        )

                        # Cache the agentic token for Agent 365 Observability exporter use
                        cache_agentic_token(
                            tenant_id,
                            agent_id,
                            exaau_token.token,
                        )

                    user_message = context.activity.text or ""
                    logger.info(f"📨 Processing message: '{user_message}'")

                    # Skip empty messages
                    if not user_message.strip():
                        return

                    # Skip messages that are handled by other decorators (like /help)
                    if user_message.strip() == "/help":
                        return

                    # Process with the hosted agent
                    logger.info(f"🤖 Processing with {self.agent_class.__name__}...")
                    response = await self.agent_instance.process_user_message(
                        user_message, self.agent_app.auth, self.auth_handler_name, context
                    )

                    # Send response back
                    logger.info(
                        f"📤 Sending response: '{response[:100] if len(response) > 100 else response}'"
                    )
                    await context.send_activity(response)

                    logger.info("✅ Response sent successfully to client")

            except Exception as e:
                error_msg = f"Sorry, I encountered an error: {str(e)}"
                logger.error(f"❌ Error processing message: {e}")
                await context.send_activity(error_msg)

    async def initialize_agent(self):
        """Initialize the hosted agent instance"""
        if self.agent_instance is None:
            try:
                logger.info(f"🤖 Initializing {self.agent_class.__name__}...")

                # Create the agent instance
                self.agent_instance = self.agent_class(*self.agent_args, **self.agent_kwargs)

                # Initialize the agent
                await self.agent_instance.initialize()

                logger.info(f"✅ {self.agent_class.__name__} initialized successfully")
            except Exception as e:
                logger.error(f"❌ Failed to initialize {self.agent_class.__name__}: {e}")
                raise

    def create_auth_configuration(self) -> AgentAuthConfiguration | None:
        """Create authentication configuration based on available environment variables."""
        client_id = environ.get("CLIENT_ID")
        tenant_id = environ.get("TENANT_ID")
        client_secret = environ.get("CLIENT_SECRET")

        if client_id and tenant_id and client_secret:
            logger.info("🔒 Using Client Credentials authentication (CLIENT_ID/TENANT_ID provided)")
            try:
                return AgentAuthConfiguration(
                    client_id=client_id,
                    tenant_id=tenant_id,
                    client_secret=client_secret,
                    scopes=["5a807f24-c9de-44ee-a3a7-329e88a00ffc/.default"],
                )
            except Exception as e:
                logger.error(
                    f"Failed to create AgentAuthConfiguration, falling back to anonymous: {e}"
                )
                return None

        if environ.get("BEARER_TOKEN"):
            logger.info(
                "🔑 BEARER_TOKEN present but incomplete app registration; continuing in anonymous dev mode"
            )
        else:
            logger.warning("⚠️ No authentication env vars found; running anonymous")

        return None

    def start_server(self, auth_configuration: AgentAuthConfiguration | None = None):
        """Start the server using Microsoft Agents SDK"""

        async def entry_point(req: Request) -> Response:
            agent: AgentApplication = req.app["agent_app"]
            adapter: CloudAdapter = req.app["adapter"]
            return await start_agent_process(req, agent, adapter)

        async def init_app(app):
            await self.initialize_agent()

        # Health endpoint
        async def health(_req: Request) -> Response:
            status = {
                "status": "ok",
                "agent_type": self.agent_class.__name__,
                "agent_initialized": self.agent_instance is not None,
                "auth_mode": "authenticated" if auth_configuration else "anonymous",
            }
            return json_response(status)

        # Build middleware list
        middlewares = []
        if auth_configuration:
            middlewares.append(jwt_authorization_middleware)

        # Anonymous claims middleware
        @web_middleware
        async def anonymous_claims(request, handler):
            if not auth_configuration:
                request["claims_identity"] = ClaimsIdentity(
                    {
                        AuthenticationConstants.AUDIENCE_CLAIM: "anonymous",
                        AuthenticationConstants.APP_ID_CLAIM: "anonymous-app",
                    },
                    False,
                    "Anonymous",
                )
            return await handler(request)

        middlewares.append(anonymous_claims)
        app = Application(middlewares=middlewares)

        logger.info(
            "🔒 Auth middleware enabled"
            if auth_configuration
            else "🔧 Anonymous mode (no auth middleware)"
        )

        # Routes
        app.router.add_post("/api/messages", entry_point)
        app.router.add_get("/api/messages", lambda _: Response(status=200))
        app.router.add_get("/api/health", health)

        # Context
        app["agent_configuration"] = auth_configuration
        app["agent_app"] = self.agent_app
        app["adapter"] = self.agent_app.adapter

        app.on_startup.append(init_app)

        # Port configuration
        desired_port = int(environ.get("PORT", 3978))
        port = desired_port

        # Simple port availability check
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            if s.connect_ex(("127.0.0.1", desired_port)) == 0:
                logger.warning(
                    f"⚠️ Port {desired_port} already in use. Attempting {desired_port + 1}."
                )
                port = desired_port + 1

        print("=" * 80)
        print(f"🏢 Generic Agent Host - {self.agent_class.__name__}")
        print("=" * 80)
        print(f"\n🔒 Authentication: {'Enabled' if auth_configuration else 'Anonymous'}")
        print("🤖 Using Microsoft Agents SDK patterns")
        print("🎯 Compatible with Agents Playground")
        if port != desired_port:
            print(f"⚠️ Requested port {desired_port} busy; using fallback {port}")
        print(f"\n🚀 Starting server on localhost:{port}")
        print(f"📚 Bot Framework endpoint: http://localhost:{port}/api/messages")
        print(f"❤️ Health: http://localhost:{port}/api/health")
        print("🎯 Ready for testing!\n")

        try:
            run_app(app, host="localhost", port=port)
        except KeyboardInterrupt:
            print("\n👋 Server stopped")
        except Exception as error:
            logger.error(f"Server error: {error}")
            raise error

    async def cleanup(self):
        """Clean up resources"""
        if self.agent_instance:
            try:
                await self.agent_instance.cleanup()
                logger.info("Agent cleanup completed")
            except Exception as e:
                logger.error(f"Error during agent cleanup: {e}")


def create_and_run_host(agent_class: type[AgentInterface], *agent_args, **agent_kwargs):
    """
    Convenience function to create and run a generic agent host.

    Args:
        agent_class: The agent class to host (must implement AgentInterface)
        *agent_args: Positional arguments to pass to the agent constructor
        **agent_kwargs: Keyword arguments to pass to the agent constructor
    """
    try:
        # Check that the agent inherits from AgentInterface
        if not check_agent_inheritance(agent_class):
            raise TypeError(f"Agent class {agent_class.__name__} must inherit from AgentInterface")

        # Create the host
        host = GenericAgentHost(agent_class, *agent_args, **agent_kwargs)

        # Create authentication configuration
        auth_config = host.create_auth_configuration()

        # Start the server
        host.start_server(auth_config)

    except Exception as error:
        logger.error(f"Failed to start generic agent host: {error}")
        raise error


if __name__ == "__main__":
    print("Generic Agent Host - Use create_and_run_host() function to start with your agent class")
    print("Example:")
    print("  from common.host_agent_server import create_and_run_host")
    print("  from my_agent import MyAgent")
    print("  create_and_run_host(MyAgent, api_key='your_key')")
