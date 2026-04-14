# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

# --- Imports ---
import asyncio
import os

# Import our agent interface
from agent_interface import AgentInterface

# Agents SDK Activity and config imports
from microsoft_agents.activity import load_configuration_from_env, Activity
from microsoft_agents.activity.activity_types import ActivityTypes

# Agents SDK Hosting and Authorization imports
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

# Agents SDK Notifications imports
from microsoft_agents_a365.notifications.agent_notification import (
    AgentNotification,
    AgentNotificationActivity,
    ChannelId,
    NotificationTypes
)
from microsoft_agents_a365.notifications.models import (
    EmailResponse
)

from microsoft_agents_a365.runtime.environment_utils import (
    get_observability_authentication_scope,
)
from token_cache import cache_agentic_token

import logging
logger = logging.getLogger(__name__)


class MyAgent(AgentApplication):
    """Sample Perplexity Agent Application using Agent 365 SDK."""

    def __init__(self, agent: AgentInterface):
        agents_sdk_config = load_configuration_from_env(os.environ)

        connection_manager = MsalConnectionManager(**agents_sdk_config)
        storage = MemoryStorage()
        super().__init__(
            options=ApplicationOptions(
                storage=storage,
                adapter=CloudAdapter(
                    connection_manager=connection_manager
                ),
            ),
            connection_manager=connection_manager,
            authorization=Authorization(
                storage,
                connection_manager,
                **agents_sdk_config,
            ),
            **agents_sdk_config,
        )

        self.agent = agent
        # Read from AUTH_HANDLER_NAME env var. Set to "AGENTIC" for production
        # agentic auth. Leave empty (default) for local dev and Agents Playground.
        self.auth_handler_name = os.getenv("AUTH_HANDLER_NAME", "") or None
        if self.auth_handler_name:
            logger.info("Auth handler: %s", self.auth_handler_name)
        else:
            logger.info("No auth handler configured — anonymous mode (Playground/local dev)")
        self.agent_notification = AgentNotification(self)

        self._setup_handlers()

    def _setup_handlers(self):
        """Set up activity handlers for the agent."""
        # Only enforce auth when AUTH_HANDLER_NAME is configured.
        handler_config = {"auth_handlers": [self.auth_handler_name]} if self.auth_handler_name else {}

        @self.conversation_update("membersAdded")
        async def help_handler(context: TurnContext, _: TurnState):
            """Handle help activities."""
            help_message = (
                "Welcome to the Agent 365 SDK Sample Agent!\n\n"
                "You can ask me to perform various tasks or provide information."
            )
            await context.send_activity(Activity(type=ActivityTypes.message, text=help_message))

        # Handle agent install / uninstall events
        @self.activity("installationUpdate")
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
                await context.send_activity("Thank you for hiring me! Looking forward to assisting you in your professional journey!")
            elif action == "remove":
                await context.send_activity("Thank you for your time, I enjoyed working with you.")

        @self.activity("message", **handler_config, rank=2)
        async def message_handler(context: TurnContext, _: TurnState):
            """Handle message activities."""
            user_message = context.activity.text
            if not user_message or not user_message.strip():
                await context.send_activity("Please send me a message and I'll help you!")
                return

            # Send an immediate ack before the LLM work begins.
            await context.send_activity("Got it — working on it…")

            # Send typing indicator immediately.
            await context.send_activity(Activity(type="typing"))

            # Background loop refreshes the "..." animation every ~4s.
            async def _typing_loop():
                while True:
                    try:
                        await asyncio.sleep(4)
                        await context.send_activity(Activity(type="typing"))
                    except asyncio.CancelledError:
                        break
                    except Exception as loop_err:
                        logger.debug("Typing indicator send failed: %s", loop_err)
                        break

            typing_task = asyncio.create_task(_typing_loop())
            try:
                # Exchange and cache the agentic token for the observability exporter
                if self.auth_handler_name:
                    try:
                        recipient = context.activity.recipient
                        tenant_id = getattr(recipient, "tenant_id", None) or ""
                        agent_id = getattr(recipient, "agentic_app_id", None) or ""
                        obs_token = await self.auth.exchange_token(
                            context,
                            scopes=get_observability_authentication_scope(),
                            auth_handler_id=self.auth_handler_name,
                        )
                        if obs_token and obs_token.token:
                            cache_agentic_token(tenant_id, agent_id, obs_token.token)
                            logger.info("Agentic token cached for observability exporter")
                    except Exception as token_err:
                        logger.warning("Failed to exchange/cache observability token: %s", token_err)

                response = await self.agent.invoke_agent_with_scope(
                    message=user_message,
                    auth=self.auth,
                    auth_handler_name=self.auth_handler_name,
                    context=context,
                )

                # Retry send once on transient connector errors (e.g. Playground disconnect)
                try:
                    await context.send_activity(Activity(type=ActivityTypes.message, text=response))
                except Exception as send_err:
                    if "disconnected" in str(send_err).lower() or "connection" in type(send_err).__name__.lower():
                        logger.warning("First send attempt failed (%s), retrying…", send_err)
                        await asyncio.sleep(0.3)
                        await context.send_activity(Activity(type=ActivityTypes.message, text=response))
                    else:
                        raise
            except Exception:
                error_id = os.urandom(8).hex()
                logger.exception("Error processing message. error_id=%s", error_id)
                await context.send_activity(
                    f"Sorry, I encountered an internal error while processing your message. "
                    f"Please try again later. Reference ID: {error_id}"
                )
            finally:
                typing_task.cancel()
                try:
                    await typing_task
                except asyncio.CancelledError:
                    pass

        @self.agent_notification.on_agent_notification(
            channel_id=ChannelId(channel="agents", sub_channel="*"),
            **handler_config,
            rank=1,
        )
        async def agent_notification_handler(
            context: TurnContext,
            _: TurnState,
            notification_activity: AgentNotificationActivity,
        ):
            """Handle agent notifications."""
            notification_type = notification_activity.notification_type
            logger.info("Received agent notification of type: %s", notification_type)

            # Handle Email Notifications
            if notification_type == NotificationTypes.EMAIL_NOTIFICATION:
                await self.email_notification_handler(context, notification_activity)
                return

            # Handle Word Comment Notifications
            if notification_type == NotificationTypes.WPX_COMMENT:
                await self.word_comment_notification_handler(context, notification_activity)
                return

            # Generic notification handling
            notification_message = notification_activity.activity.text or ""
            if not notification_message:
                response = f"Notification received: {notification_type}"
            else:
                response = await self.agent.invoke_agent_with_scope(
                    notification_message, self.auth, self.auth_handler_name, context
                )

            await context.send_activity(response)

    async def email_notification_handler(
        self,
        context: TurnContext,
        notification_activity: AgentNotificationActivity,
    ):
        """Handle email notifications."""
        response = ""
        if not hasattr(notification_activity, "email") or not notification_activity.email:
            response = "I could not find the email notification details."
        else:
            try:
                email = notification_activity.email
                email_body = getattr(email, "html_body", "") or getattr(email, "body", "")
                email_id = getattr(email, "id", "")
                message = (
                    f"You have received an email with id {email_id}. "
                    f"The following is the content of the email, please follow any instructions in it: {email_body}"
                )
                response = await self.agent.invoke_agent_with_scope(
                    message, self.auth, self.auth_handler_name, context
                )
            except Exception as e:
                logger.error("Error processing email notification: %s", e)
                response = "Unable to process your email at this time."

        response_activity = Activity(type=ActivityTypes.message, text=response)
        if not response_activity.entities:
            response_activity.entities = []

        response_activity.entities.append(EmailResponse.create_email_response_activity(response))
        await context.send_activity(response_activity)

    async def word_comment_notification_handler(
        self,
        context: TurnContext,
        notification_activity: AgentNotificationActivity,
    ):
        """Handle Word comment notifications."""
        if not hasattr(notification_activity, "wpx_comment") or not notification_activity.wpx_comment:
            await context.send_activity("I could not find the Word notification details.")
            return

        try:
            wpx = notification_activity.wpx_comment
            doc_id = getattr(wpx, "document_id", "")
            comment_id = getattr(wpx, "initiating_comment_id", "")
            drive_id = "default"

            # Get Word document content
            doc_message = (
                f"You have a new comment on the Word document with id '{doc_id}', "
                f"comment id '{comment_id}', drive id '{drive_id}'. "
                "Please retrieve the Word document as well as the comments and return it in text format."
            )
            word_content = await self.agent.invoke_agent_with_scope(
                doc_message, self.auth, self.auth_handler_name, context
            )

            # Process the comment with document context
            comment_text = notification_activity.activity.text or ""
            response_message = (
                f"You have received the following Word document content and comments. "
                f"Please refer to these when responding to comment '{comment_text}'. {word_content}"
            )
            response = await self.agent.invoke_agent_with_scope(
                response_message, self.auth, self.auth_handler_name, context
            )

            await context.send_activity(response)
        except Exception as e:
            logger.error("Error processing Word comment notification: %s", e)
            await context.send_activity("Unable to process the Word comment at this time.")
