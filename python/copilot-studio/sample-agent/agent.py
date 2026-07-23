# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
MyAgent – Agent 365 sample that integrates with Microsoft Copilot Studio.

This agent demonstrates how to:
- Receive notifications from Agent 365 (email, Teams, etc.)
- Forward messages to a Copilot Studio agent
- Return responses through the Agent 365 SDK
- Integrate with Agent 365 Observability
"""

import logging
from typing import Optional

from microsoft_agents.hosting.core import Authorization, TurnContext
from microsoft_agents_a365.notifications.agent_notification import (
    AgentNotificationActivity,
    NotificationTypes,
)

from client import get_client

logger = logging.getLogger(__name__)


class MyAgent:
    """
    Copilot Studio proxy agent.

    Implements the same interface expected by
    :func:`host_agent_server.create_and_run_host`.
    """

    def __init__(self) -> None:
        self.logger = logging.getLogger(self.__class__.__name__)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def initialize(self) -> None:
        """Called once by the host before the first request."""
        logger.info("Copilot Studio agent initialized")

    async def cleanup(self) -> None:
        """Called on server shutdown."""
        logger.info("Copilot Studio agent cleanup completed")

    # ------------------------------------------------------------------
    # Message handling
    # ------------------------------------------------------------------

    async def process_user_message(
        self,
        message: str,
        auth: Authorization,
        auth_handler_name: Optional[str],
        context: TurnContext,
    ) -> str:
        """
        Forward *message* to the Copilot Studio agent and return its response.
        """
        # Log user identity – populated by the A365 platform on every turn.
        from_prop = context.activity.from_property
        logger.info(
            "Turn received from user — DisplayName: '%s', UserId: '%s', AadObjectId: '%s'",
            getattr(from_prop, "name", None) or "(unknown)",
            getattr(from_prop, "id", None) or "(unknown)",
            getattr(from_prop, "aad_object_id", None) or "(none)",
        )

        try:
            client = await get_client(auth, auth_handler_name, context)
            response = await client.invoke_inference_scope(message, context)
            return response
        except Exception as exc:
            logger.exception("Copilot Studio query error")
            return f"Error communicating with Copilot Studio: {exc}"

    # ------------------------------------------------------------------
    # Notification handling
    # ------------------------------------------------------------------

    async def handle_agent_notification_activity(
        self,
        notification_activity: AgentNotificationActivity,
        auth: Authorization,
        auth_handler_name: Optional[str],
        context: TurnContext,
    ) -> str:
        """
        Route agent notifications to the appropriate handler.
        """
        notification_type = notification_activity.notification_type
        logger.info("Processing notification: %s", notification_type)

        if notification_type == NotificationTypes.EMAIL_NOTIFICATION:
            return await self._handle_email_notification(
                notification_activity, auth, auth_handler_name, context
            )

        # Generic / unsupported notification types
        logger.info("Received notification of type: %s", notification_type)
        return f"Received notification of type: {notification_type}"

    # ------------------------------------------------------------------
    # Email notification
    # ------------------------------------------------------------------

    async def _handle_email_notification(
        self,
        activity: AgentNotificationActivity,
        auth: Authorization,
        auth_handler_name: Optional[str],
        context: TurnContext,
    ) -> str:
        """
        Handle email notifications by forwarding the email content to
        Copilot Studio and returning the response.
        """
        email = getattr(activity, "email", None)
        if not email:
            return "I could not find the email notification details."

        try:
            client = await get_client(auth, auth_handler_name, context)

            # Build a prompt with the email context
            sender_name = (
                getattr(context.activity.from_property, "name", None)
                or "unknown sender"
            )
            email_id = getattr(email, "id", "")
            conversation_id = getattr(email, "conversation_id", "")

            email_prompt = (
                f"You have received an email from {sender_name}. "
                f"Email ID: '{email_id}', "
                f"Conversation ID: '{conversation_id}'. "
                "Please process this email and provide a helpful response."
            )

            response = await client.invoke_inference_scope(email_prompt, context)
            return (
                response
                or "I have processed your email but do not have a response at this time."
            )
        except Exception as exc:
            logger.exception("Email notification error")
            return "Unable to process your email at this time."
