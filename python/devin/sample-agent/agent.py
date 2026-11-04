# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
MyAgent – Agent 365 sample that integrates with Devin AI.

This agent demonstrates how to:
- Receive messages and forward them to Devin AI
- Handle notifications (email, Teams, etc.)
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
    Devin AI proxy agent.

    Implements the same interface expected by the Agent 365 hosting framework.
    """

    def __init__(self) -> None:
        self.logger = logging.getLogger(self.__class__.__name__)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def initialize(self) -> None:
        """Called once by the host before the first request."""
        logger.info("Devin AI agent initialized")

    async def cleanup(self) -> None:
        """Called on server shutdown."""
        logger.info("Devin AI agent cleanup completed")

    # ------------------------------------------------------------------
    # Message handling
    # ------------------------------------------------------------------
    # NOTE: ``auth`` and ``auth_handler_name`` are accepted to match the
    # interface expected by the host (see other Python samples). The Devin
    # SDK uses its own ``DEVIN_SDK_API_KEY``, so this sample does not exchange
    # an A365 OBO token before calling Devin.

    async def process_user_message(
        self,
        message: str,
        auth: Authorization,
        auth_handler_name: Optional[str],
        context: TurnContext,
    ) -> str:
        """
        Forward *message* to the Devin AI agent and return its response.
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
            client = get_client()
            response = await client.invoke_inference_scope(message, context)
            return response
        except Exception:
            # Log full traceback for debugging; return a generic message so we
            # don't leak internal details (config, identifiers, upstream errors).
            logger.exception("Devin AI query error")
            return "Sorry, I had trouble reaching Devin. Please try again."

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
        Devin AI and returning the response.
        """
        email = getattr(activity, "email", None)
        if not email:
            return "I could not find the email notification details."

        try:
            sender_name = (
                getattr(context.activity.from_property, "name", None)
                or "unknown sender"
            )
            email_id = getattr(email, "id", "")
            conversation_id = getattr(email, "conversation_id", "")

            email_prompt = (
                f"You have a new email from {sender_name} with id '{email_id}', "
                f"ConversationId '{conversation_id}'. "
                "Please process this email and provide a helpful response."
            )

            client = get_client()
            response = await client.invoke_inference_scope(
                email_prompt, context
            )
            return (
                response
                or "I have processed your email but do not have a response at this time."
            )
        except Exception:
            logger.exception("Email notification error")
            return "Unable to process your email at this time."
