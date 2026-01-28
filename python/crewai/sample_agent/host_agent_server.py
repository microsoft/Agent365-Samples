# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
"""
Generic Agent Host Server for CrewAI wrapper.

"""

import logging
import socket
import os
from os import environ

from agent_interface import AgentInterface, check_agent_inheritance
from aiohttp.web import Application, Request as AiohttpRequest, Response, json_response, run_app
from aiohttp.web_middlewares import middleware as web_middleware
from dotenv import load_dotenv
from microsoft_agents.activity import load_configuration_from_env
from microsoft_agents.authentication.msal import MsalConnectionManager
from microsoft_agents.hosting.aiohttp import (
    CloudAdapter,
    jwt_authorization_middleware,
    start_agent_process,
)
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
from microsoft_agents_a365.observability.core import InvokeAgentScope
from microsoft_agents_a365.runtime.environment_utils import (
    get_observability_authentication_scope,
)
from token_cache import cache_agentic_token
from turn_context_utils import (
    extract_turn_context_details,
    create_invoke_agent_details,
    create_caller_details,
    create_tenant_details,
    create_request,
)

# Configure logging
ms_agents_logger = logging.getLogger("microsoft_agents")
ms_agents_logger.addHandler(logging.StreamHandler())
ms_agents_logger.setLevel(logging.INFO)

logger = logging.getLogger(__name__)

# Load configuration
load_dotenv()
agents_sdk_config = load_configuration_from_env(environ)


class GenericAgentHost:
    """Generic host that can host any agent implementing the AgentInterface."""

    def __init__(self, agent_class: type[AgentInterface], *agent_args, **agent_kwargs):
        if not check_agent_inheritance(agent_class):
            raise TypeError(f"Agent class {agent_class.__name__} must inherit from AgentInterface")

        self.auth_handler_name = os.getenv("AGENT_AUTH_HANDLER_NAME", "AGENTIC")

        self.agent_class = agent_class
        self.agent_args = agent_args
        self.agent_kwargs = agent_kwargs
        self.agent_instance = None

        # Determine auth mode early (check if credentials are configured)
        self.auth_configured = self._is_auth_configured()

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

    def _extract_conversation_item_link(self, activity):
        """Extract conversation item link from various activity sources."""
        # 1) Outlook / Word / Loop / SharePoint notifications
        try:
            link = activity.value.get("resource", {}).get("webUrl")
            if link:
                return link
        except Exception:
            pass

        # 2) Teams-based interactions
        try:
            for entity in activity.entities or []:
                link = (
                    entity.get("conversationItemLink") or
                    entity.get("link")
                )
                if link:
                    return link
        except Exception:
            pass

        # 3) Teams channelData
        try:
            return activity.channel_data.get("clientInfo", {}).get("conversationItemLink")
        except Exception:
            pass

        return None

    def _setup_handlers(self):
        """Setup the Microsoft Agents SDK message handlers."""

        async def help_handler(context: TurnContext, _: TurnState):
            """Handle help requests and member additions."""
            welcome_message = (
                "Howdy! I'm a CrewAI-based agent hosted by Generic Agent Host.\n\n"
                f"Powered by: **{self.agent_class.__name__}**\n"
                "Ask me anything or type /help for this message."
            )
            await context.send_activity(welcome_message)
            logger.info("Sent help/welcome message")

        # Register handlers
        self.agent_app.conversation_update("membersAdded")(help_handler)
        self.agent_app.message("/help")(help_handler)

        # Only use auth handlers when authentication is configured
        handler = [self.auth_handler_name] if self.auth_configured else None

        @self.agent_app.activity("message", auth_handlers=handler)
        async def on_message(context: TurnContext, _: TurnState):
            """Handle all messages with the hosted agent."""
            try:
                # Extract context from turn using shared utility
                ctx_details = extract_turn_context_details(context)

                with BaggageBuilder().tenant_id(ctx_details.tenant_id).agent_id(ctx_details.agent_id).correlation_id(ctx_details.correlation_id).build():
                    if not self.agent_instance:
                        error_msg = "ERROR Sorry, the agent is not available."
                        logger.error(error_msg)
                        await context.send_activity(error_msg)
                        return

                    # Only perform token exchange when authentication is configured
                    if self.auth_configured:
                        exaau_token = await self.agent_app.auth.exchange_token(
                            context,
                            scopes=get_observability_authentication_scope(),
                            auth_handler_id=self.auth_handler_name,
                        )

                        cache_agentic_token(
                            ctx_details.tenant_id,
                            ctx_details.agent_id,
                            exaau_token.token,
                        )
                    else:
                        logger.debug("Skipping token exchange in anonymous mode")

                    user_message = context.activity.text or ""
                    logger.info("Processing message: '%s'", user_message)

                    if not user_message.strip() or user_message.strip() == "/help":
                        return

                    # Create observability details using shared utility
                    invoke_details = create_invoke_agent_details(ctx_details, "AI agent powered by CrewAI framework")
                    caller_details = create_caller_details(ctx_details)
                    tenant_details = create_tenant_details(ctx_details)
                    request = create_request(ctx_details, user_message)

                    # Wrap the agent invocation with InvokeAgentScope
                    with InvokeAgentScope.start(
                        invoke_agent_details=invoke_details,
                        tenant_details=tenant_details,
                        request=request,
                        caller_details=caller_details,
                    ) as invoke_scope:
                        if hasattr(invoke_scope, 'record_input_messages'):
                            invoke_scope.record_input_messages([user_message])

                        response = await self.agent_instance.process_user_message(
                            user_message, self.agent_app.auth, self.auth_handler_name, context
                        )

                        if hasattr(invoke_scope, 'record_output_messages'):
                            invoke_scope.record_output_messages([response])

                    logger.info("Sending response: '%s'", response[:100] if len(response) > 100 else response)
                    await context.send_activity(response)

            except Exception as e:
                error_msg = f"Sorry, I encountered an error: {str(e)}"
                logger.error("Error processing message: %s", e)
                await context.send_activity(error_msg)

    async def initialize_agent(self):
        """Initialize the hosted agent instance."""
        if self.agent_instance is None:
            try:
                logger.info("Initializing %s...", self.agent_class.__name__)
                self.agent_instance = self.agent_class(*self.agent_args, **self.agent_kwargs)
                await self.agent_instance.initialize()
                logger.info("%s initialized successfully", self.agent_class.__name__)
            except Exception as e:
                logger.error("Failed to initialize %s: %s", self.agent_class.__name__, e)
                raise

    def create_auth_configuration(self) -> AgentAuthConfiguration | None:
        """Create authentication configuration based on available environment variables."""
        client_id = environ.get("CLIENT_ID")
        tenant_id = environ.get("TENANT_ID")
        client_secret = environ.get("CLIENT_SECRET")

        if client_id and tenant_id and client_secret:
            logger.info("Using Client Credentials authentication (CLIENT_ID/TENANT_ID provided)")
            try:
                return AgentAuthConfiguration(
                    client_id=client_id,
                    tenant_id=tenant_id,
                    client_secret=client_secret,
                    scopes=["https://api.botframework.com/.default"],
                )
            except Exception as e:
                logger.error(
                    "Failed to create AgentAuthConfiguration, falling back to anonymous: %s",
                    e,
                )
                return None

        if environ.get("BEARER_TOKEN"):
            logger.info("BEARER_TOKEN present but incomplete app registration; continuing in anonymous dev mode")
        else:
            logger.warning("No authentication env vars found; running anonymous")

        return None

    def start_server(self, auth_configuration: AgentAuthConfiguration | None = None):
        """Start the server using Microsoft Agents SDK."""

        async def entry_point(req: AiohttpRequest) -> Response:
            agent: AgentApplication = req.app["agent_app"]
            adapter: CloudAdapter = req.app["adapter"]
            return await start_agent_process(req, agent, adapter)

        async def init_app(app):
            await self.initialize_agent()

        async def health(_req: AiohttpRequest) -> Response:
            status = {
                "status": "ok",
                "agent_type": self.agent_class.__name__,
                "agent_initialized": self.agent_instance is not None,
                "auth_mode": "authenticated" if auth_configuration else "anonymous",
            }
            return json_response(status)

        middlewares = []
        if auth_configuration:
            middlewares.append(jwt_authorization_middleware)

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
            "Auth middleware enabled" if auth_configuration else "Anonymous mode (no auth middleware)"
        )

        app.router.add_post("/api/messages", entry_point)
        app.router.add_get("/api/messages", lambda _: Response(status=200))
        app.router.add_get("/api/health", health)

        app["agent_configuration"] = auth_configuration
        app["agent_app"] = self.agent_app
        app["adapter"] = self.agent_app.adapter

        app.on_startup.append(init_app)

        desired_port = int(environ.get("PORT", 3978))
        port = desired_port

        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            if s.connect_ex(("127.0.0.1", desired_port)) == 0:
                logger.warning(
                    "Port %s already in use. Attempting %s.",
                    desired_port,
                    desired_port + 1,
                )
                port = desired_port + 1

        # Detect production environment (Azure App Service sets WEBSITE_SITE_NAME)
        is_production = os.getenv("WEBSITE_SITE_NAME") is not None
        host = "0.0.0.0" if is_production else "localhost"

        print("=" * 80)
        print(f"Generic Agent Host - {self.agent_class.__name__}")
        print("=" * 80)
        print(f"\nAuthentication: {'Enabled' if auth_configuration else 'Anonymous'}")
        print("Using Microsoft Agents SDK patterns")
        if port != desired_port:
            print(f"Requested port {desired_port} busy; using fallback {port}")
        print(f"\nStarting server on {host}:{port}")
        print(f"Bot Framework endpoint: http://localhost:{port}/api/messages")
        print(f"Health: http://localhost:{port}/api/health")
        print("Ready for testing!\n")

        try:
            run_app(app, host=host, port=port)
        except KeyboardInterrupt:
            print("\nServer stopped")
        except Exception as error:
            logger.error("Server error: %s", error)
            raise error

    async def cleanup(self):
        """Clean up resources."""
        if self.agent_instance:
            try:
                await self.agent_instance.cleanup()
                logger.info("Agent cleanup completed")
            except Exception as e:
                logger.error("Error during agent cleanup: %s", e)

    def _is_auth_configured(self) -> bool:
        """Check if authentication environment variables are configured."""
        client_id = environ.get("CLIENT_ID")
        tenant_id = environ.get("TENANT_ID")
        client_secret = environ.get("CLIENT_SECRET")
        return bool(client_id and tenant_id and client_secret)


def create_and_run_host(agent_class: type[AgentInterface], *agent_args, **agent_kwargs):
    """Convenience function to create and run a generic agent host."""
    if not check_agent_inheritance(agent_class):
        raise TypeError(f"Agent class {agent_class.__name__} must inherit from AgentInterface")

    # Initialize observability before starting the host
    from observability_config import initialize_observability
    initialize_observability()

    host = GenericAgentHost(agent_class, *agent_args, **agent_kwargs)
    auth_config = host.create_auth_configuration()
    host.start_server(auth_config)


if __name__ == "__main__":
    print("Generic Agent Host - Use create_and_run_host() to start with your agent class")
