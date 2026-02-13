# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Generic Agent Host Server for CrewAI wrapper.

Features:
- Microsoft 365 Agents SDK hosting
- Observability with BaggageBuilder and InvokeAgentScope
- Notification handling (Email, Word @mentions, etc.)
- MCP tooling support
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
from microsoft_agents_a365.observability.core.config import configure as configure_observability
from microsoft_agents_a365.runtime.environment_utils import (
    get_observability_authentication_scope,
)

# Notifications imports
from microsoft_agents_a365.notifications.agent_notification import (
    AgentNotification,
    AgentNotificationActivity,
    ChannelId,
)
from microsoft_agents_a365.notifications import EmailResponse, NotificationTypes

from turn_context_utils import (
    extract_turn_context_details,
    create_invoke_agent_details,
    create_caller_details,
    create_tenant_details,
    create_request,
)
from token_cache import cache_agentic_token, get_cached_agentic_token
from constants import DEFAULT_SERVICE_NAME, DEFAULT_SERVICE_NAMESPACE

# Configure logging
logging.basicConfig(level=logging.INFO)

ms_agents_logger = logging.getLogger("microsoft_agents")
ms_agents_logger.addHandler(logging.StreamHandler())
ms_agents_logger.setLevel(logging.INFO)

# Enable observability SDK logging to see exporter warnings
observability_logger = logging.getLogger("microsoft_agents_a365.observability")
observability_logger.setLevel(logging.INFO)

logger = logging.getLogger(__name__)

# Load configuration
load_dotenv()
agents_sdk_config = load_configuration_from_env(environ)


class GenericAgentHost:
    """Generic host that can host any agent implementing the AgentInterface."""

    def __init__(self, agent_class: type[AgentInterface], *agent_args, **agent_kwargs):
        if not check_agent_inheritance(agent_class):
            raise TypeError(f"Agent class {agent_class.__name__} must inherit from AgentInterface")

        # Auth handler name can be configured via environment
        # Defaults to empty (no auth handler) - set AUTH_HANDLER_NAME=AGENTIC for production agentic auth
        self.auth_handler_name = (
            os.getenv("AUTH_HANDLER_NAME")
            or os.getenv("AGENT_AUTH_HANDLER_NAME", "")
            or None
        )
        if self.auth_handler_name:
            logger.info(f"🔐 Using auth handler: {self.auth_handler_name}")
        else:
            logger.info("🔓 No auth handler configured (AUTH_HANDLER_NAME not set)")

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

        # Initialize notification support
        self.agent_notification = AgentNotification(self.agent_app)
        logger.info("✅ Notification support initialized (handlers will be registered)")

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

        # Only use auth handlers when authentication is configured
        handler_config = (
            {"auth_handlers": [self.auth_handler_name]}
            if self.auth_configured and self.auth_handler_name
            else {}
        )

        # Register handlers
        self.agent_app.conversation_update("membersAdded", **handler_config)(help_handler)
        self.agent_app.message("/help", **handler_config)(help_handler)

        @self.agent_app.activity("message", **handler_config)
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

                    # Only perform token registration when authentication is configured
                    if self.auth_configured:
                        # Exchange token and cache for sync token_resolver access
                        try:
                            exchange_kwargs = {}
                            if self.auth_handler_name:
                                exchange_kwargs["auth_handler_id"] = self.auth_handler_name

                            exaau_token = await self.agent_app.auth.exchange_token(
                                context,
                                scopes=get_observability_authentication_scope(),
                                **exchange_kwargs,
                            )
                            cache_agentic_token(
                                ctx_details.tenant_id,
                                ctx_details.agent_id,
                                exaau_token.token,
                            )
                        except Exception as e:
                            logger.debug(f"Token exchange skipped: {e}")
                    else:
                        logger.debug("Skipping token registration in anonymous mode")

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

                with BaggageBuilder().tenant_id(tenant_id).agent_id(agent_id).build():
                    await self._handle_notification_with_agent(
                        context, notification_activity
                    )

            except Exception as e:
                logger.error(f"❌ Notification error: {e}")
                await context.send_activity(
                    f"Sorry, I encountered an error processing the notification: {str(e)}"
                )

        # Register a single handler for both 'agents' (production) and 'msteams' (testing) channels
        # by applying the on_agent_notification decorator twice to the same function. This avoids
        # duplicated handler implementations while still explicitly registering per channel.
        @self.agent_notification.on_agent_notification(
            channel_id=ChannelId(channel="agents", sub_channel="*"),
            **handler_config,
        )
        @self.agent_notification.on_agent_notification(
            channel_id=ChannelId(channel="msteams", sub_channel="*"),
            **handler_config,
        )
        async def on_notification_agents_and_msteams(
            context: TurnContext,
            state: TurnState,
            notification_activity: AgentNotificationActivity,
        ):
            """Handle notifications from both 'agents' (production) and 'msteams' (testing) channels"""
            await handle_notification_common(context, state, notification_activity)

        logger.info("✅ Notification handler registered for 'agents' and 'msteams' channels")

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
        if not self.auth_configured:
            return

        try:
            # Exchange token and cache for sync token_resolver access
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
            # Wrap the JWT middleware to skip auth for health/robots endpoints
            @web_middleware
            async def auth_with_exclusions(request, handler):
                # Skip auth for health checks and robots.txt
                path = request.path.lower()
                if path in ["/api/health", "/robots933456.txt", "/"]:
                    return await handler(request)
                # Apply JWT auth for all other routes
                return await jwt_authorization_middleware(request, handler)

            middlewares.append(auth_with_exclusions)

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
                        "Port %s already in use. Attempting %s.",
                        desired_port,
                        desired_port + 1,
                    )
                    port = desired_port + 1

        print("=" * 80)
        print(f"Generic Agent Host - {self.agent_class.__name__}")
        print("=" * 80)
        print(f"\nAuthentication: {'Enabled' if auth_configuration else 'Anonymous'}")
        print("Using Microsoft Agents SDK patterns")
        if port != desired_port:
            print(f"Requested port {desired_port} busy; using fallback {port}")
        print(f"\nStarting server on {host}:{port}")
        print(f"Bot Framework endpoint: http://{host}:{port}/api/messages")
        print(f"Health: http://{host}:{port}/api/health")
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

    # Configure observability if not already configured (e.g., by start_with_generic_host.py)
    # Note: Early configuration in start_with_generic_host.py is preferred to avoid
    # CrewAI's TracerProvider being set up before ours
    enable_observability = os.getenv("ENABLE_OBSERVABILITY", "true").lower() in ("true", "1", "yes")
    if enable_observability:
        from opentelemetry import trace as otel_trace
        existing_provider = otel_trace.get_tracer_provider()
        provider_type = type(existing_provider).__name__
        
        # Check if observability was already configured with our service name
        is_already_configured = False
        if hasattr(existing_provider, 'resource'):
            resource_attrs = dict(existing_provider.resource.attributes)
            service_name = resource_attrs.get('service.name', '')
            # If service name contains our identifier, skip reconfiguration
            if DEFAULT_SERVICE_NAME.split('-')[0] in service_name.lower() or 'agent365' in service_name.lower():
                is_already_configured = True
                logger.info(f"✅ Observability already configured: {service_name}")
        
        if not is_already_configured:
            service_name = os.getenv("OBSERVABILITY_SERVICE_NAME", DEFAULT_SERVICE_NAME)
            service_namespace = os.getenv("OBSERVABILITY_SERVICE_NAMESPACE", DEFAULT_SERVICE_NAMESPACE)
            
            # Token resolver for observability exporter (must be sync)
            def token_resolver(agent_id: str, tenant_id: str) -> str | None:
                """Resolve authentication token for observability exporter"""
                token = get_cached_agentic_token(tenant_id, agent_id)
                if token:
                    logger.debug(f"Token resolver: found cached token for {agent_id}:{tenant_id}")
                else:
                    logger.debug(f"Token resolver: no cached token for {agent_id}:{tenant_id}")
                return token
            
            try:
                logger.info(f"🔍 Existing TracerProvider: {provider_type}")
                if hasattr(existing_provider, 'resource'):
                    logger.info(f"🔍 Existing resource: {existing_provider.resource.attributes}")
                
                configure_observability(
                    service_name=service_name,
                    service_namespace=service_namespace,
                    token_resolver=token_resolver,
                    cluster_category=os.getenv("PYTHON_ENVIRONMENT", "development"),
                )
                print("✅ Observability configured")
                logger.info(f"✅ Observability configured: {service_name} ({service_namespace})")
            except Exception as e:
                print(f"⚠️ Failed to configure observability: {e}")
                logger.warning(f"⚠️ Failed to configure observability: {e}")
    else:
        print("ℹ️ Observability disabled (ENABLE_OBSERVABILITY=false)")
        logger.info("ℹ️ Observability disabled (ENABLE_OBSERVABILITY=false)")

    host = GenericAgentHost(agent_class, *agent_args, **agent_kwargs)
    auth_config = host.create_auth_configuration()
    host.start_server(auth_config)


if __name__ == "__main__":
    print("Generic Agent Host - Use create_and_run_host() to start with your agent class")
