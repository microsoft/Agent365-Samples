# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Generic Agent Host Server
A generic hosting server that can host any agent class that implements the required interface.
"""

import asyncio
import logging
import os
import socket
from os import environ

# A365 Observability — best-effort instrumentation (verify against official sample)
from observability_config import EXPORT_ENABLED, OBS_TOKENS, shutdown_observability

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
from microsoft_agents.activity import load_configuration_from_env, Activity

# Import our agent base class
from agent_interface import AgentInterface, check_agent_inheritance
from turn_context_utils import extract_turn_context_details

# Configure logging
ms_agents_logger = logging.getLogger("microsoft_agents")
ms_agents_logger.setLevel(logging.INFO)

logger = logging.getLogger(__name__)

# Notifications imports
from microsoft_agents_a365.notifications.agent_notification import (
    AgentNotification,
    AgentNotificationActivity,
    ChannelId,
)
from microsoft_agents_a365.notifications import EmailResponse, NotificationTypes

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
        # Baggage is scoped in agent.py; distro middleware uses an incompatible callback.
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

        # Handle agent install / uninstall events (agentInstanceCreated / InstallationUpdate)
        @self.agent_app.activity("installationUpdate")
        async def on_installation_update(context: TurnContext, _: TurnState):
            action = context.activity.action
            from_prop = context.activity.from_property
            logger.info(
                "InstallationUpdate received — Action: '%s', DisplayName: '%s', UserId: '%s'",
                action or "(none)",
                getattr(from_prop, "name", "(unknown)") if from_prop else "(unknown)",
                getattr(from_prop, "id", "(unknown)") if from_prop else "(unknown)",
            )
            if action == "add":
                try:
                    await context.send_activity("Thank you for hiring me! Looking forward to assisting you in your professional journey!")
                except Exception as e:
                    logger.warning("Could not send welcome message: %s", e)
            elif action == "remove":
                try:
                    await context.send_activity("Thank you for your time, I enjoyed working with you.")
                except Exception as e:
                    logger.warning("Could not send remove reply: %s", e)

        @self.agent_app.activity("message", **handler_config)
        async def on_message(context: TurnContext, _: TurnState):
            """Handle all messages with the hosted agent"""
            try:
                result = await self._validate_agent_and_setup_context(context)
                if result is None:
                    return

                user_message = context.activity.text or ""
                logger.info("Processing inbound message (%d characters)", len(user_message))

                # Skip empty messages
                if not user_message.strip():
                    return

                # Skip messages that are handled by other decorators (like /help)
                if user_message.strip() == "/help":
                    return

                # Multiple messages: send an immediate ack before the LLM work begins.
                # Each send_activity call produces a discrete Teams message.
                await context.send_activity("Got it — working on it…")

                # Send typing indicator immediately (awaited so it arrives before the LLM call starts).
                await self._send_typing(context)

                # Background loop refreshes the "..." animation every ~4s (it times out after ~5s).
                # asyncio.create_task is used because all aiohttp handlers share the same event loop.
                async def _typing_loop():
                    while True:
                        try:
                            await asyncio.sleep(4)
                            if not await self._send_typing(context):
                                break
                        except asyncio.CancelledError:
                            break
                        except Exception:
                            logger.warning("Typing refresh failed; continuing the message turn", exc_info=True)
                            break

                typing_task = asyncio.create_task(_typing_loop())
                try:
                    # Process with the hosted agent
                    logger.info(f"🤖 Processing with {self.agent_class.__name__}...")
                    response = await self.agent_instance.process_user_message(
                        user_message, self.agent_app.auth, context, self.auth_handler_name
                    )

                    # Send response back
                    logger.info("Sending response (%d characters)", len(response))
                    await context.send_activity(response)

                    logger.info("✅ Response sent successfully to client")
                finally:
                    typing_task.cancel()
                    try:
                        await typing_task
                    except asyncio.CancelledError:
                        pass  # Expected: task is cancelled when LLM processing completes.

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

                await self._handle_notification_with_agent(context, notification_activity)

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

    @staticmethod
    async def _send_typing(context: TurnContext) -> bool:
        try:
            await context.send_activity(Activity(type="typing"))
            return True
        except Exception:
            logger.warning("Typing indicator failed; continuing the message turn", exc_info=True)
            return False

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
        details = extract_turn_context_details(context)
        tenant_id, agent_id = details.tenant_id, details.agent_id

        # Ensure agent is available
        if not self.agent_instance:
            logger.error("Agent not available")
            await context.send_activity("❌ Sorry, the agent is not available.")
            return None

        # Setup observability token if available
        if EXPORT_ENABLED and tenant_id and agent_id:
            await self._setup_observability_token(context, tenant_id, agent_id)

        return tenant_id, agent_id

    async def _setup_observability_token(
        self, context: TurnContext, tenant_id: str, agent_id: str
    ):
        """
        Prefetch an app-only observability token using the hosting connection.
        
        Args:
            context: Turn context
            tenant_id: Tenant identifier
            agent_id: Agent identifier
        """
        # A365 auth mode: agentic-user — telemetry uses an app-only token on the S2S route.
        try:
            await OBS_TOKENS.prefetch(self.connection_manager, tenant_id, agent_id)
        except Exception as e:
            logger.warning("Failed to acquire app-only observability token: %s", e)

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
        # When no auth handler is configured (AUTH_HANDLER_NAME is empty),
        # skip JWT middleware for Playground / local dev mode.
        # Service-connection credentials stay in .env so the SDK can still use them.
        if not self.auth_handler_name:
            logger.info("🔓 No AUTH_HANDLER_NAME set — skipping JWT auth (Playground mode)")
            return None

        # Read from the CONNECTIONS service-connection settings (canonical source)
        # to avoid duplicating CLIENT_ID / TENANT_ID / CLIENT_SECRET.
        client_id = environ.get("CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID")
        tenant_id = environ.get("CONNECTIONS__SERVICE_CONNECTION__SETTINGS__TENANTID")
        client_secret = environ.get("CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTSECRET")

        if not all(value and value.strip() for value in (client_id, tenant_id, client_secret)):
            raise ValueError(
                "AUTH_HANDLER_NAME requires service connection CLIENTID, TENANTID, and CLIENTSECRET"
            )
        return AgentAuthConfiguration(
            client_id=client_id,
            tenant_id=tenant_id,
            client_secret=client_secret,
            scopes=["https://api.botframework.com/.default"],
        )

    def start_server(self, auth_configuration: AgentAuthConfiguration | None = None):
        """Start the server using Microsoft Agents SDK"""
        if self.auth_handler_name and auth_configuration is None:
            raise ValueError("Authenticated hosting requires a valid authentication configuration")

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

        # Close shared clients only after aiohttp drains active handlers.
        async def shutdown_cleanup(app):
            await self.cleanup()

        app.on_cleanup.append(shutdown_cleanup)

        # Port configuration - Azure sets PORT=8000, locally defaults to 3978
        desired_port = int(environ.get("PORT", 3978))
        port = desired_port
        
        # Host configuration - 0.0.0.0 for Azure, localhost for local dev
        # Azure App Service requires binding to 0.0.0.0 for health probes to work
        if "HOST" in environ:
            host = environ["HOST"]
        elif environ.get("WEBSITE_INSTANCE_ID"):
            host = "0.0.0.0"
        else:
            host = "localhost"

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

        await asyncio.to_thread(shutdown_observability)


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
