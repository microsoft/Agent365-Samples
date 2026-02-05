# Copyright (c) Microsoft. All rights reserved.

# --- Imports ---
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

# Observability imports
from microsoft_agents_a365.runtime.environment_utils import (
    get_observability_authentication_scope,
)
from microsoft_agents_a365.observability.core.middleware.baggage_builder import (
    BaggageBuilder,
)

# Token caching
from token_cache import cache_agentic_token

import logging
logger = logging.getLogger(__name__)

class AgentHost(AgentApplication):
    """Sample Agent Application using Agent 365 SDK."""

    def __init__(self, agent: AgentInterface):
        """
        Initialize the generic host with an agent class and its initialization parameters.

        Args:
            agent: The agent (must implement AgentInterface)
            *agent_args: Positional arguments to pass to the agent constructor
            **agent_kwargs: Keyword arguments to pass to the agent constructor
        """
        agents_sdk_config = load_configuration_from_env(os.environ)

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
                **agents_sdk_config
            ),
            **agents_sdk_config,
        )

        self.agent = agent
        self.auth_handler_name = "AGENTIC"
        self.agent_notification = AgentNotification(self)

        self._setup_handlers()

    async def _setup_observability_token(self, context: TurnContext) -> None:
        """Exchange and cache token for Agent 365 Observability."""
        try:
            tenant_id = context.activity.recipient.tenant_id
            agent_id = context.activity.recipient.agentic_app_id

            exaau_token = await self.auth.exchange_token(
                context,
                scopes=get_observability_authentication_scope(),
                auth_handler_id=self.auth_handler_name,
            )

            cache_agentic_token(tenant_id, agent_id, exaau_token.token)
        except Exception as e:
            logger.warning(f"⚠️ Failed to cache observability token: {e}")

    def _setup_handlers(self):
        """Set up activity handlers for the agent."""
        auth_handlers = [self.auth_handler_name]

        @self.conversation_update("membersAdded")
        async def help_handler(context: TurnContext, _: TurnState):
            """Handle help activities."""
            help_message = (
                "Welcome to the Agent 365 SDK Sample Agent!\n\n"
                "You can ask me to perform various tasks or provide information."
            )
            await context.send_activity(Activity(type=ActivityTypes.message, text=help_message))

        @self.activity("message", rank=2)
        async def message_handler(context: TurnContext, _: TurnState):
            """Handle message activities."""
            user_message = context.activity.text
            if not user_message or not user_message.strip():
                await context.send_activity("Please send me a message and I'll help you!")
                return

            # Setup observability token before processing message
            await self._setup_observability_token(context)

            # Process message with baggage context
            tenant_id = context.activity.recipient.tenant_id
            agent_id = context.activity.recipient.agentic_app_id

            with BaggageBuilder().tenant_id(tenant_id).agent_id(agent_id).build():
                response = await self.agent.invoke_agent_with_scope(
                    message=user_message,
                    auth=self.auth,
                    auth_handler_name=self.auth_handler_name,
                    context=context
                )

            await context.send_activity(Activity(type=ActivityTypes.message, text=response))

        @self.agent_notification.on_agent_notification(
            channel_id=ChannelId(channel="agents", sub_channel="*"),
            auth_handlers=auth_handlers,
            rank=1
        )
        async def agent_notification_handler(
            context: TurnContext,
            _: TurnState,
            notification_activity: AgentNotificationActivity
        ):
            """Handle agent notifications."""
            notification_type = notification_activity.notification_type
            logger.info(f"Received agent notification of type: {notification_type}")

            # Setup observability token before processing notification
            await self._setup_observability_token(context)

            # Process notification with baggage context
            tenant_id = context.activity.recipient.tenant_id
            agent_id = context.activity.recipient.agentic_app_id

            with BaggageBuilder().tenant_id(tenant_id).agent_id(agent_id).build():
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
                response = "I was unable to process your request. Please try again later."
                if not notification_message:
                    response = f"Notification received: {notification_type}"
                else:
                    response = await self.agent.invoke_agent_with_scope(notification_message, self.auth, self.auth_handler_name, context)

                await context.send_activity(response)

    async def email_notification_handler(self, context: TurnContext, notification_activity: AgentNotificationActivity):
        """Handle email notifications."""
        response = ""
        if not hasattr(notification_activity, "email") or not notification_activity.email:
            response = "I could not find the email notification details."
        else:
            email = notification_activity.email
            email_body = getattr(email, "html_body", "") or getattr(email, "body", "")
            email_id = getattr(email, "id", "")
            message = f"You have received an email with id {email_id}. The following is the content of the email, please follow any instructions in it: {email_body}"

            response = await self.agent.invoke_agent_with_scope(message, self.auth, self.auth_handler_name, context)

        response_activity = Activity(type=ActivityTypes.message, text=response)
        if not response_activity.entities:
            response_activity.entities = []

        response_activity.entities.append(EmailResponse.create_email_response_activity(response))
        await context.send_activity(response_activity)

    async def word_comment_notification_handler(self, context: TurnContext, notification_activity: AgentNotificationActivity):
        """Handle word comment notifications."""
        if not hasattr(notification_activity, "wpx_comment") or not notification_activity.wpx_comment:
            response = "I could not find the Word notification details."
            await context.send_activity(response)
            return

        wpx = notification_activity.wpx_comment
        doc_id = getattr(wpx, "document_id", "")
        comment_id = getattr(wpx, "initiating_comment_id", "")
        drive_id = "default"

        # Get Word document content
        doc_message = f"You have a new comment on the Word document with id '{doc_id}', comment id '{comment_id}', drive id '{drive_id}'. Please retrieve the Word document as well as the comments and return it in text format."
        word_content = await self.agent.invoke_agent_with_scope(doc_message, self.auth, self.auth_handler_name, context)

        # Process the comment with document context
        comment_text = notification_activity.activity.text or ""
        response_message = f"You have received the following Word document content and comments. Please refer to these when responding to comment '{comment_text}'. {word_content}"
        response = await self.agent.invoke_agent_with_scope(response_message, self.auth, self.auth_handler_name, context)

        await context.send_activity(response)