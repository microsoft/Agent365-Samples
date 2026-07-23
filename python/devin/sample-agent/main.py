# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Devin Sample Agent – Server Entry Point

Hosts :class:`MyAgent` using the Microsoft 365 Agents SDK (aiohttp adapter)
with Agent 365 Observability, Notification handling, and JWT authentication.
"""

# It is important to load environment variables before importing other modules.
import asyncio
import logging
import os
import socket
from os import environ

from aiohttp.web import Application, Request, Response, json_response, run_app
from aiohttp.web_middlewares import middleware as web_middleware
from dotenv import load_dotenv

load_dotenv()

from microsoft_agents.activity import (  # noqa: E402
    load_configuration_from_env,
    Activity,
    ActivityTypes,
)
from microsoft_agents.authentication.msal import MsalConnectionManager  # noqa: E402
from microsoft_agents.hosting.aiohttp import (  # noqa: E402
    CloudAdapter,
    jwt_authorization_middleware,
    start_agent_process,
)
from microsoft_agents.hosting.core import (  # noqa: E402
    AgentApplication,
    AgentAuthConfiguration,
    ApplicationOptions,
    AuthenticationConstants,
    Authorization,
    ClaimsIdentity,
    MemoryStorage,
    TurnContext,
    TurnState,
)
from microsoft_agents_a365.notifications.agent_notification import (  # noqa: E402
    AgentNotification,
    NotificationTypes,
    AgentNotificationActivity,
    ChannelId,
)
from microsoft_agents_a365.notifications import EmailResponse  # noqa: E402
from microsoft.opentelemetry import use_microsoft_opentelemetry  # noqa: E402
from microsoft.opentelemetry.a365.core import BaggageBuilder  # noqa: E402

from agent import MyAgent  # noqa: E402


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log_level = getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO)
logging.basicConfig(level=log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

agents_sdk_config = load_configuration_from_env(environ)


# ---------------------------------------------------------------------------
# Agent host
# ---------------------------------------------------------------------------


class DevinAgentHost:
    """Hosts the Devin sample agent."""

    # -- init ---------------------------------------------------------------

    def __init__(self) -> None:
        # Auth handler name — defaults to empty (no auth handler)
        # Set AUTH_HANDLER_NAME=agentic for production agentic auth
        self.auth_handler_name: str | None = os.getenv("AUTH_HANDLER_NAME", "") or None
        if self.auth_handler_name:
            logger.info("Using auth handler: %s", self.auth_handler_name)
        else:
            logger.info("No auth handler configured (AUTH_HANDLER_NAME not set)")

        self.agent_instance: MyAgent | None = None

        self.storage = MemoryStorage()
        self.connection_manager = MsalConnectionManager(**agents_sdk_config)
        self.adapter = CloudAdapter(connection_manager=self.connection_manager)
        self.authorization = Authorization(
            self.storage, self.connection_manager, **agents_sdk_config
        )
        self.agent_app: AgentApplication[TurnState] = AgentApplication[TurnState](
            options=ApplicationOptions(
                storage=self.storage,
                adapter=self.adapter,
            ),
            connection_manager=self.connection_manager,
            authorization=self.authorization,
            **agents_sdk_config,
        )
        self.agent_notification = AgentNotification(self.agent_app)
        self._setup_handlers()
        logger.info("Notification handlers registered successfully")

    # -- observability context ------------------------------------------------

    async def _validate_agent_and_setup_context(self, context: TurnContext):
        """Validate agent availability and extract observability identity."""
        # Playground sends a minimal recipient (id + name only).
        # Fall back to env vars so observability baggage is still populated.
        recipient = context.activity.recipient
        tenant_id = (
            getattr(recipient, "tenant_id", None)
            or os.getenv("AGENTIC_TENANT_ID", "")
        )
        agent_id = (
            getattr(recipient, "agentic_app_id", None)
            or os.getenv("AGENTIC_APP_ID", "")
        )
        logger.info(
            "Observability identity — agent_id: '%s', tenant_id: '%s', source: %s",
            agent_id,
            tenant_id,
            "activity.recipient"
            if getattr(recipient, "agentic_app_id", None)
            else "env",
        )

        if not self.agent_instance:
            logger.error("Agent not available")
            await context.send_activity("Sorry, the agent is not available.")
            return None

        return tenant_id, agent_id

    # -- handler registration -----------------------------------------------

    def _setup_handlers(self) -> None:
        handler_config = (
            {"auth_handlers": [self.auth_handler_name]}
            if self.auth_handler_name
            else {}
        )

        # --- Installation Update (hire / remove) ---
        @self.agent_app.activity("installationUpdate")
        async def on_installation_update(context: TurnContext, _: TurnState) -> None:
            action = context.activity.action
            from_prop = context.activity.from_property
            logger.info(
                "InstallationUpdate — Action: '%s', DisplayName: '%s', UserId: '%s'",
                action or "(none)",
                getattr(from_prop, "name", "(unknown)") if from_prop else "(unknown)",
                getattr(from_prop, "id", "(unknown)") if from_prop else "(unknown)",
            )
            if action == "add":
                await context.send_activity(
                    "Thank you for hiring me! Looking forward to assisting you "
                    "in your professional journey!"
                )
            elif action == "remove":
                await context.send_activity(
                    "Thank you for your time, I enjoyed working with you."
                )

        # --- Direct messages ---
        @self.agent_app.activity("message", **handler_config)
        async def on_message(context: TurnContext, _: TurnState) -> None:
            try:
                result = await self._validate_agent_and_setup_context(context)
                if result is None:
                    return
                tenant_id, agent_id = result

                with BaggageBuilder().tenant_id(tenant_id).agent_id(agent_id).build():
                    user_message = context.activity.text or ""
                    if not user_message.strip():
                        await context.send_activity(
                            "Please send me a message and I'll help you!"
                        )
                        return

                    # Multiple messages pattern: immediate ack
                    await context.send_activity("Got it — working on it…")
                    await context.send_activity(Activity(type="typing"))

                    # Typing indicator loop — refreshes the "..." animation
                    # every ~4 s (it times out after ~5 s). Only visible in
                    # 1:1 and small group chats.
                    async def _typing_loop() -> None:
                        try:
                            while True:
                                await asyncio.sleep(4)
                                await context.send_activity(Activity(type="typing"))
                        except asyncio.CancelledError:
                            pass  # Expected on cancel.

                    typing_task = asyncio.create_task(_typing_loop())
                    try:
                        response = await self.agent_instance.process_user_message(
                            user_message,
                            self.agent_app.auth,
                            self.auth_handler_name,
                            context,
                        )
                        await context.send_activity(response)
                    finally:
                        typing_task.cancel()
                        try:
                            await typing_task
                        except asyncio.CancelledError:
                            pass

            except Exception:
                # Log the traceback for diagnostics; reply with a generic
                # message so we don't expose internal details to the user.
                logger.exception("Error handling message")
                await context.send_activity(
                    "Sorry, I encountered an error handling your message."
                )

        # --- Agent notifications (email, Teams, etc.) ---
        @self.agent_notification.on_agent_notification(
            channel_id=ChannelId(channel="agents", sub_channel="*"),
            **handler_config,
        )
        async def on_notification(
            context: TurnContext,
            state: TurnState,
            notification_activity: AgentNotificationActivity,
        ) -> None:
            try:
                result = await self._validate_agent_and_setup_context(context)
                if result is None:
                    return
                tenant_id, agent_id = result

                with BaggageBuilder().tenant_id(tenant_id).agent_id(agent_id).build():
                    logger.info(
                        "Notification: %s", notification_activity.notification_type
                    )

                    response = (
                        await self.agent_instance.handle_agent_notification_activity(
                            notification_activity,
                            self.agent_app.auth,
                            self.auth_handler_name,
                            context,
                        )
                    )

                    if (
                        notification_activity.notification_type
                        == NotificationTypes.EMAIL_NOTIFICATION
                    ):
                        response_activity = (
                            EmailResponse.create_email_response_activity(response)
                        )
                        await context.send_activity(response_activity)
                        return

                    await context.send_activity(response)

            except Exception:
                # Log the traceback for diagnostics; reply with a generic
                # message so we don't expose internal details to the user.
                logger.exception("Notification error")
                await context.send_activity(
                    "Sorry, I encountered an error processing the notification."
                )

    # -- agent lifecycle ----------------------------------------------------

    async def initialize_agent(self) -> None:
        if self.agent_instance is None:
            logger.info("Initializing MyAgent...")
            self.agent_instance = MyAgent()
            await self.agent_instance.initialize()

    async def cleanup(self) -> None:
        if self.agent_instance:
            try:
                await self.agent_instance.cleanup()
            except Exception as exc:
                logger.error("Cleanup error: %s", exc)

    # -- auth config --------------------------------------------------------

    def create_auth_configuration(self) -> AgentAuthConfiguration | None:
        client_id = environ.get("CLIENT_ID")
        tenant_id = environ.get("TENANT_ID")
        client_secret = environ.get("CLIENT_SECRET")

        if client_id and tenant_id and client_secret:
            logger.info("Using Client Credentials authentication")
            return AgentAuthConfiguration(
                client_id=client_id,
                tenant_id=tenant_id,
                client_secret=client_secret,
                scopes=["5a807f24-c9de-44ee-a3a7-329e88a00ffc/.default"],
            )

        if environ.get("BEARER_TOKEN"):
            logger.info("Anonymous dev mode")
        else:
            logger.warning("No auth env vars; running anonymous")
        return None

    # -- HTTP server --------------------------------------------------------

    def start_server(
        self, auth_configuration: AgentAuthConfiguration | None = None
    ) -> None:
        async def entry_point(req: Request) -> Response:
            return await start_agent_process(
                req, req.app["agent_app"], req.app["adapter"]
            )

        async def health(_req: Request) -> Response:
            from datetime import datetime, timezone
            return json_response(
                {
                    "status": "healthy",
                    "agent_type": "DevinAgent",
                    "agent_initialized": self.agent_instance is not None,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
            )

        middlewares: list = []
        if auth_configuration:

            @web_middleware
            async def jwt_with_health_bypass(request, handler):
                # Skip JWT for health endpoint so container orchestrators
                # (Azure Container Apps, Kubernetes, App Service) can probe.
                if request.path == "/api/health":
                    return await handler(request)
                return await jwt_authorization_middleware(request, handler)

            middlewares.append(jwt_with_health_bypass)

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
        app.router.add_post("/api/messages", entry_point)
        app.router.add_get("/api/messages", lambda _: Response(status=200))
        app.router.add_get("/api/health", health)

        app["agent_configuration"] = auth_configuration
        app["agent_app"] = self.agent_app
        app["adapter"] = self.agent_app.adapter

        app.on_startup.append(lambda _app: self.initialize_agent())
        app.on_shutdown.append(lambda _app: self.cleanup())

        is_production = (
            environ.get("WEBSITE_SITE_NAME") is not None  # Azure App Service
            or environ.get("K_SERVICE") is not None  # GCP Cloud Run
            or environ.get("ENVIRONMENT", "").lower() == "production"
        )
        host = "0.0.0.0" if is_production else "localhost"

        port_str = environ.get("PORT")
        if port_str:
            try:
                port = int(port_str)
                logger.info("Using PORT from environment: %d", port)
            except ValueError:
                logger.warning(
                    "Invalid PORT value '%s', using default 3978", port_str
                )
                port = 3978
        else:
            port = 3978
            # Simple port availability check (only for local dev)
            if not is_production:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.settimeout(0.5)
                    if s.connect_ex(("127.0.0.1", port)) == 0:
                        port += 1

        print("=" * 80)
        print("Devin Sample Agent (Python)")
        print("=" * 80)
        print(f"Auth: {'Enabled' if auth_configuration else 'Anonymous'}")
        print(f"Server: {host}:{port}")
        print(f"Endpoint: http://{host}:{port}/api/messages")
        print(f"Health:   http://{host}:{port}/api/health")
        print()

        try:
            run_app(app, host=host, port=port, handle_signals=True)
        except KeyboardInterrupt:
            print("\nServer stopped")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    # Configure observability from .env
    # ENABLE_OBSERVABILITY=true/false controls whether tracing is set up.
    if environ.get("ENABLE_OBSERVABILITY", "true").lower() == "true":
        # Use the Microsoft OpenTelemetry Distro with built-in FIC token resolver.
        # The distro reads CONNECTIONS__SERVICE_CONNECTION__SETTINGS__* env vars
        # and AGENT365OBSERVABILITY__* for telemetry export configuration.
        use_microsoft_opentelemetry(
            enable_a365=True,
            enable_azure_monitor=False,
        )
        logger.info(
            "Observability configured via Microsoft OpenTelemetry Distro "
            "(enable_a365=True, a365_exporter=%s)",
            environ.get("ENABLE_A365_OBSERVABILITY_EXPORTER", "false"),
        )
    else:
        logger.info("Observability disabled (ENABLE_OBSERVABILITY=false)")

    host = DevinAgentHost()
    auth_config = host.create_auth_configuration()
    host.start_server(auth_config)


if __name__ == "__main__":
    main()
