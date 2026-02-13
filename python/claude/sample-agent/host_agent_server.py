# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Generic Agent Host Server
A generic hosting server that can host any agent class that implements the required interface.
"""

import logging
import os
import socket
from os import environ

from aiohttp.web import Application, Request, Response, json_response, run_app
from aiohttp.web_middlewares import middleware as web_middleware
from dotenv import load_dotenv
from microsoft_agents.hosting.aiohttp import (
    CloudAdapter,
    jwt_authorization_middleware,
    start_agent_process,
)

# Microsoft Agents SDK imports
from microsoft_agents.hosting.core import (
    Authorization,
    AgentApplication,
    AgentAuthConfiguration,
    AuthenticationConstants,
    ClaimsIdentity,
    MemoryStorage,
    TurnContext,
    TurnState,
)

from microsoft_agents.authentication.msal import MsalConnectionManager
from microsoft_agents.activity import load_configuration_from_env

# Import our agent base class
from agent_interface import AgentInterface, check_agent_inheritance

# Configure logging
ms_agents_logger = logging.getLogger("microsoft_agents")
ms_agents_logger.addHandler(logging.StreamHandler())
ms_agents_logger.setLevel(logging.INFO)

logger = logging.getLogger(__name__)

# Notifications imports
from microsoft_agents_a365.notifications.agent_notification import (
    AgentNotification,
    AgentNotificationActivity,
    ChannelId,
)
from microsoft_agents_a365.notifications import EmailResponse, NotificationTypes

# Observability imports (optional)
try:
    from microsoft_agents_a365.observability.core.config import configure as configure_observability
    from microsoft_agents_a365.observability.core.middleware.baggage_builder import BaggageBuilder
    from token_cache import get_cached_agentic_token, cache_agentic_token
    OBSERVABILITY_AVAILABLE = True
except ImportError:
    OBSERVABILITY_AVAILABLE = False

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
        
        # Auth handler name can be configured via environment
        # Defaults to empty (no auth handler) - set AUTH_HANDLER_NAME=AGENTIC for production agentic auth
        self.auth_handler_name = os.getenv("AUTH_HANDLER_NAME", "") or None
        if self.auth_handler_name:
            logger.info(f"🔐 Using auth handler: {self.auth_handler_name}")
        else:
            logger.info("🔓 No auth handler configured (AUTH_HANDLER_NAME not set)")


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

        # Initialize notification support
        self.agent_notification = AgentNotification(self.agent_app)
        logger.info("✅ Notification handlers will be registered")

        # Setup message handlers
        self._setup_handlers()

    def _setup_handlers(self):
        """Setup the Microsoft Agents SDK message handlers"""

        
        # Configure auth handlers - only required when auth_handler_name is set
        handler_config = (
            {"auth_handlers": [self.auth_handler_name]} if self.auth_handler_name else {}
        )

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
        self.agent_app.conversation_update("membersAdded", **handler_config)(help_handler)
        self.agent_app.message("/help", **handler_config)(help_handler)

        @self.agent_app.activity("message", **handler_config)
        async def on_message(context: TurnContext, _: TurnState):
            """Handle all messages with the hosted agent"""
            try:
                # Ensure the agent is available
                if not self.agent_instance:
                    error_msg = "❌ Sorry, the agent is not available."
                    logger.error(error_msg)
                    await context.send_activity(error_msg)
                    return

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
                    user_message, self.agent_app.auth, context, self.auth_handler_name
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

        # Register notification handler
        # Shared notification handler logic
        async def handle_notification_common(
            context: TurnContext,
            state: TurnState,
            notification_activity: AgentNotificationActivity,
        ):
            """Common notification handler for both 'agents' and 'msteams' channels"""
            try:
                logger.info(f"🔔 Notification received! Type: {context.activity.type}, Channel: {context.activity.channel_id if hasattr(context.activity, 'channel_id') else 'None'}")
                
                result = await self._validate_agent_and_setup_context(context)
                if result is None:
                    return
                tenant_id, agent_id = result

                if OBSERVABILITY_AVAILABLE:
                    with BaggageBuilder().tenant_id(tenant_id).agent_id(agent_id).build():
                        await self._handle_notification_with_agent(
                            context, notification_activity
                        )
                else:
                    await self._handle_notification_with_agent(
                        context, notification_activity
                    )

            except Exception as e:
                logger.error(f"❌ Notification error: {e}")
                await context.send_activity(
                    f"Sorry, I encountered an error processing the notification: {str(e)}"
                )
        
        # Register for 'agents' channel (production - Outlook, Teams notifications)
        @self.agent_notification.on_agent_notification(
            channel_id=ChannelId(channel="agents", sub_channel="*"),
            **handler_config,
        )
        async def on_notification_agents(
            context: TurnContext,
            state: TurnState,
            notification_activity: AgentNotificationActivity,
        ):
            """Handle notifications from 'agents' channel (production)"""
            await handle_notification_common(context, state, notification_activity)
        
        # Register for 'msteams' channel (testing - Agents Playground)
        @self.agent_notification.on_agent_notification(
            channel_id=ChannelId(channel="msteams", sub_channel="*"),
            **handler_config,
        )
        async def on_notification_msteams(
            context: TurnContext,
            state: TurnState,
            notification_activity: AgentNotificationActivity,
        ):
            """Handle notifications from 'msteams' channel (testing)"""
            await handle_notification_common(context, state, notification_activity)
        
        logger.info("✅ Notification handlers registered for 'agents' and 'msteams' channels")

    async def _handle_notification_with_agent(
        self, context: TurnContext, notification_activity: AgentNotificationActivity
    ):
        """
        Handle notification with the agent instance.
        
        Args:
            context: Turn context
            notification_activity: The notification activity to process
        """
        logger.info(f"📬 {notification_activity.notification_type}")

        # Check if agent supports notifications
        if not hasattr(self.agent_instance, "handle_agent_notification_activity"):
            logger.warning("⚠️ Agent doesn't support notifications")
            await context.send_activity(
                "This agent doesn't support notification handling yet."
            )
            return

        # Process the notification with the agent
        response = await self.agent_instance.handle_agent_notification_activity(
            notification_activity, self.agent_app.auth, context, self.auth_handler_name
        )
        
        # For email notifications, wrap response in EmailResponse entity
        if notification_activity.notification_type == NotificationTypes.EMAIL_NOTIFICATION:
            response_activity = EmailResponse.create_email_response_activity(response)
            await context.send_activity(response_activity)
            return
        
        # Send the response for other notification types
        await context.send_activity(response)

    async def _validate_agent_and_setup_context(self, context: TurnContext):
        """
        Validate agent availability and setup observability context.
        
        Args:
            context: Turn context from M365 SDK
            
        Returns:
            Tuple of (tenant_id, agent_id) if successful, None if validation fails
        """
        # Extract tenant and agent IDs
        tenant_id = context.activity.recipient.tenant_id if context.activity.recipient else None
        agent_id = context.activity.recipient.agentic_app_id if context.activity.recipient else None

        # Ensure agent is available
        if not self.agent_instance:
            logger.error("Agent not available")
            await context.send_activity("❌ Sorry, the agent is not available.")
            return None

        # Setup observability token if available
        if tenant_id and agent_id:
            await self._setup_observability_token(context, tenant_id, agent_id)

        return tenant_id, agent_id

    async def _setup_observability_token(
        self, context: TurnContext, tenant_id: str, agent_id: str
    ):
        """
        Cache observability token for Agent365 exporter.
        
        Args:
            context: Turn context
            tenant_id: Tenant identifier
            agent_id: Agent identifier
        """
        if not OBSERVABILITY_AVAILABLE:
            return
            
        try:
            from microsoft_agents_a365.runtime.environment_utils import (
                get_observability_authentication_scope,
            )

            exchange_kwargs = {}
            if self.auth_handler_name:
                exchange_kwargs["auth_handler_id"] = self.auth_handler_name
            
            exaau_token = await self.agent_app.auth.exchange_token(
                context,
                scopes=get_observability_authentication_scope(),
                **exchange_kwargs,
            )
            cache_agentic_token(tenant_id, agent_id, exaau_token.token)
            logger.debug(f"✅ Cached observability token for {tenant_id}:{agent_id}")
        except Exception as e:
            logger.warning(f"⚠️ Failed to cache observability token: {e}")

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
                    scopes=["https://api.botframework.com/.default"],
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
            # Wrap the JWT middleware to skip auth for health/robots endpoints
            @web_middleware
            async def auth_with_exclusions(request, handler):
                # Skip auth for health checks and robots.txt
                path = request.path.lower()
                if path in ['/api/health', '/robots933456.txt', '/']:
                    return await handler(request)
                # Apply JWT auth for all other routes
                return await jwt_authorization_middleware(request, handler)
            
            middlewares.append(auth_with_exclusions)

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

        # Port configuration - Azure sets PORT=8000, locally defaults to 3978
        desired_port = int(environ.get("PORT", 3978))
        port = desired_port
        
        # Host configuration - 0.0.0.0 for Azure, localhost for local dev
        # Azure App Service requires binding to 0.0.0.0 for health probes to work
        host = environ.get("HOST", "0.0.0.0")

        # Simple port availability check (only for local dev)
        if host == "localhost" or host == "127.0.0.1":
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
        print(f"\n🚀 Starting server on {host}:{port}")
        print(f"📚 Bot Framework endpoint: http://{host}:{port}/api/messages")
        print(f"❤️ Health: http://{host}:{port}/api/health")
        print("🎯 Ready for testing!\n")

        try:
            run_app(app, host=host, port=port)
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

        # Configure observability if available and enabled
        if OBSERVABILITY_AVAILABLE:
            enable_observability = os.getenv("ENABLE_OBSERVABILITY", "false").lower() in ("true", "1", "yes")
            if enable_observability:
                service_name = os.getenv("OBSERVABILITY_SERVICE_NAME", "generic-agent-host")
                service_namespace = os.getenv("OBSERVABILITY_SERVICE_NAMESPACE", "agent365")
                
                # Token resolver for Agent365 exporter (optional)
                def token_resolver(agent_id: str, tenant_id: str) -> str | None:
                    """Resolve authentication token for observability exporter"""
                    try:
                        logger.debug(f"Token resolver called for agent_id: {agent_id}, tenant_id: {tenant_id}")
                        # Use cached agentic token if available
                        cached_token = get_cached_agentic_token(tenant_id, agent_id)
                        if cached_token:
                            logger.debug("Using cached agentic token for observability")
                            return cached_token
                        logger.debug("No cached token available for observability")
                        return None
                    except Exception as e:
                        logger.warning(f"Error resolving token for observability: {e}")
                        return None
                
                try:
                    configure_observability(
                        service_name=service_name,
                        service_namespace=service_namespace,
                        token_resolver=token_resolver,
                        cluster_category=os.getenv("PYTHON_ENVIRONMENT", "development"),
                    )
                    logger.info(f"✅ Observability configured: {service_name} ({service_namespace})")
                except Exception as e:
                    logger.warning(f"⚠️ Failed to configure observability: {e}")
            else:
                logger.info("ℹ️ Observability disabled (ENABLE_OBSERVABILITY=false)")
        else:
            logger.debug("ℹ️ Observability packages not available")

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
