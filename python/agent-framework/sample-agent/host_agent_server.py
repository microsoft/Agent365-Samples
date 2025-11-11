# Copyright (c) Microsoft. All rights reserved.

"""Generic Agent Host Server - Hosts agents implementing AgentInterface"""

# --- Imports ---
import logging
import os
from os import environ

# Import our agent base class
from agent_interface import AgentInterface
from dotenv import load_dotenv
from agent_interface import AgentInterface, check_agent_inheritance
from microsoft_agents.activity import load_configuration_from_env
from microsoft_agents.authentication.msal import MsalConnectionManager
from microsoft_agents.hosting.aiohttp import (
    CloudAdapter,
)
from microsoft_agents.hosting.core import (
    AgentApplication,
    Authorization,
    ApplicationOptions,
    MemoryStorage,
    TurnContext,
    TurnState,
)
from microsoft_agents_a365.notifications.agent_notification import (
    AgentNotification,
    AgentNotificationActivity,
    ChannelId,
)
from microsoft_agents_a365.observability.core.config import configure
from microsoft_agents_a365.observability.core.middleware.baggage_builder import (
    BaggageBuilder,
)
from microsoft_agents_a365.runtime.environment_utils import (
    get_observability_authentication_scope,
)


# Observability Components
from agent_framework.observability import setup_observability

# Helper for Observability
from token_cache import cache_agentic_token, get_cached_agentic_token

# --- Configuration ---
ms_agents_logger = logging.getLogger("microsoft_agents")
ms_agents_logger.addHandler(logging.StreamHandler())
ms_agents_logger.setLevel(logging.INFO)

observability_logger = logging.getLogger("microsoft_agents_a365.observability")
observability_logger.setLevel(logging.ERROR)

logger = logging.getLogger(__name__)

load_dotenv()
agents_sdk_config = load_configuration_from_env(environ)


class A365Agent(AgentApplication):
    """Generic host that can host any agent implementing the AgentInterface"""

    def __init__(self, agent: AgentInterface):
        """
        Initialize the generic host with an agent class and its initialization parameters.

        Args:
            agent: The agent (must implement AgentInterface)
            *agent_args: Positional arguments to pass to the agent constructor
            **agent_kwargs: Keyword arguments to pass to the agent constructor
        """
        connection_manager = MsalConnectionManager(**agents_sdk_config)
        storage = MemoryStorage()
        super().__init__(
            options = ApplicationOptions(
                storage= storage,
                adapter= CloudAdapter(
                    connection_manager= connection_manager
                ),
            ),
            connection_manager= connection_manager,
            authorization= Authorization(
                storage,
                connection_manager,
                **agents_sdk_config),
            **agents_sdk_config,
        )

        self.agent = agent
        self.agent_notifications = AgentNotification(self)

        self._setup_handlers()

    # --- Observability ---
    async def _setup_observability_token(
        self, context: TurnContext, tenant_id: str, agent_id: str
    ):
        tenant_id = context.activity.recipient.tenant_id
        agent_id = context.activity.recipient.agentic_app_id

        try:
            exaau_token = await self.auth.exchange_token(
                context,
                scopes=get_observability_authentication_scope(),
                auth_handler_id="AGENTIC",
            )
            cache_agentic_token(tenant_id, agent_id, exaau_token.token)
        except Exception as e:
            logger.warning(f"⚠️ Failed to cache observability token: {e}")

        return tenant_id, agent_id

    # --- Handlers (Messages & Notifications) ---
    def _setup_handlers(self):
        """Setup message and notification handlers"""
        use_agentic_auth = os.getenv("USE_AGENTIC_AUTH", "false").lower() == "true"
        handler = ["AGENTIC"] if use_agentic_auth else None

        async def help_handler(context: TurnContext, _: TurnState):
            await context.send_activity(
                f"👋 **Hi there!** I'm **{self.agent_class.__name__}**, your AI assistant.\n\n"
                "How can I help you today?"
            )

        self.conversation_update("membersAdded")(help_handler)
        self.message("/help")(help_handler)

        @self.activity("message", auth_handlers=handler)
        async def on_message(context: TurnContext, _: TurnState):
            try:
                result = await self._setup_observability_token(context)
                if result is None:
                    return
                tenant_id, agent_id = result

                with BaggageBuilder().tenant_id(tenant_id).agent_id(agent_id).build():
                    user_message = context.activity.text or ""
                    if not user_message.strip() or user_message.strip() == "/help":
                        return

                    logger.info(f"📨 {user_message}")
                    response = await self.agent.process_user_message(
                        user_message, self.auth, context
                    )
                    await context.send_activity(response)

            except Exception as e:
                logger.error(f"❌ Error: {e}")
                await context.send_activity(f"Sorry, I encountered an error: {str(e)}")

        @self.agent_notification.on_agent_notification(
            channel_id=ChannelId(channel="agents", sub_channel="*"),
            auth_handlers=handler,
        )
        async def on_notification(
            context: TurnContext,
            state: TurnState,
            notification_activity: AgentNotificationActivity,
        ):
            try:
                result = await self._setup_observability_token(context)
                if result is None:
                    return
                tenant_id, agent_id = result

                with BaggageBuilder().tenant_id(tenant_id).agent_id(agent_id).build():
                    logger.info(f"📬 {notification_activity.notification_type}")

                    if not hasattr(
                        self.agent, "handle_agent_notification_activity"
                    ):
                        logger.warning("⚠️ Agent doesn't support notifications")
                        await context.send_activity(
                            "This agent doesn't support notification handling yet."
                        )
                        return

                    response = (
                        await self.agent.handle_agent_notification_activity(
                            notification_activity, self.auth, context
                        )
                    )
                    await context.send_activity(response)

            except Exception as e:
                logger.error(f"❌ Notification error: {e}")
                await context.send_activity(
                    f"Sorry, I encountered an error processing the notification: {str(e)}"
                )

    # --- Cleanup ---
    async def cleanup(self):
        try:
            await self.agent.cleanup()
        except Exception as e:
            logger.error(f"Error during agent cleanup: {e}")

def token_resolver( agent_id: str, tenant_id: str) -> str | None:
    """
    Token resolver function for Agent 365 Observability exporter.

    Uses the cached agentic token obtained from AGENT_APP.auth.get_token(context, "AGENTIC").
    This is the only valid authentication method for this context.
    """

    try:
        # Use cached agentic token from agent authentication
        cached_token = get_cached_agentic_token(tenant_id, agent_id)
        if cached_token:
            return cached_token
        else:
            logger.warning(
                f"No cached agentic token found for agent_id: {agent_id}, tenant_id: {tenant_id}"
            )
            return None

    except Exception as e:
        logger.error(
            f"Error resolving token for agent {agent_id}, tenant {tenant_id}: {e}"
        )
        return None

def create_host(agent_class: type[AgentInterface], *agent_args, **agent_kwargs) -> A365Agent:
    """
    Convenience function to create and run a generic agent host.

    Args:
        agent_class: The agent class to host (must implement AgentInterface)
        *agent_args: Positional arguments to pass to the agent constructor
        **agent_kwargs: Keyword arguments to pass to the agent constructor
    """
    try:
        # Check that the agent inherits from AgentInterface
        if not issubclass(agent_class, AgentInterface):
            raise TypeError(
                f"Agent class {agent_class.__name__} must inherit from AgentInterface"
            )

        # Configure Observability
        configure(
            service_name="AgentFrameworkTracingWithAzureOpenAI",
            service_namespace="AgentFrameworkTesting",
            token_resolver=token_resolver,
        )

        # Start up Observability
        setup_observability()

        # Create the host
        return A365Agent(agent_class(*agent_args, **agent_kwargs))


    except Exception as error:
        logger.error(f"Failed to start generic agent host: {error}")
        raise error
