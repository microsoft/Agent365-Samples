# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Notification Handler Module

Handles agent notification activities (email, Word mentions, etc.) for the CrewAI agent.
This module separates notification handling logic from the main agent for better readability.
"""

import logging
from typing import TYPE_CHECKING, Any

from microsoft_agents.hosting.core import Authorization, TurnContext
from microsoft_agents_a365.notifications import NotificationTypes

if TYPE_CHECKING:
    from agent import CrewAIAgent

logger = logging.getLogger(__name__)


async def handle_notification(
    agent: "CrewAIAgent",
    notification_activity: Any,
    auth: Authorization,
    context: TurnContext,
    auth_handler_name: str | None = None,
) -> str:
    """
    Handle agent notification activities (email, Word mentions, etc.)

    Args:
        agent: The CrewAI agent instance to process messages
        notification_activity: The notification activity from Agent365
        auth: Authorization for token exchange
        context: Turn context from M365 SDK
        auth_handler_name: Optional auth handler name for token exchange

    Returns:
        Response string to send back
    """
    try:
        notification_type = notification_activity.notification_type
        logger.info(f"📬 Processing notification: {notification_type}")

        # Handle Email Notifications
        if notification_type == NotificationTypes.EMAIL_NOTIFICATION:
            return await _handle_email_notification(
                agent, notification_activity, auth, context, auth_handler_name
            )

        # Handle Word Comment Notifications
        elif notification_type == NotificationTypes.WPX_COMMENT:
            return await _handle_word_notification(
                agent, notification_activity, auth, context, auth_handler_name
            )

        # Generic notification handling
        else:
            return await _handle_generic_notification(
                agent, notification_activity, auth, context, auth_handler_name
            )

    except Exception as e:
        logger.error(f"Error processing notification: {e}")
        logger.exception("Full error details:")
        return f"Sorry, I encountered an error processing the notification: {str(e)}"


async def _handle_email_notification(
    agent: "CrewAIAgent",
    notification_activity: Any,
    auth: Authorization,
    context: TurnContext,
    auth_handler_name: str | None,
) -> str:
    """Handle email notification activities."""
    if not hasattr(notification_activity, "email") or not notification_activity.email:
        return "I could not find the email notification details."

    email = notification_activity.email
    email_body = getattr(email, "html_body", "") or getattr(email, "body", "")

    message = f"You have received the following email. Please follow any instructions in it.\n\n{email_body}"
    logger.info("📧 Processing email notification")

    response = await agent.process_user_message(message, auth, auth_handler_name, context)
    return response or "Email notification processed."


async def _handle_word_notification(
    agent: "CrewAIAgent",
    notification_activity: Any,
    auth: Authorization,
    context: TurnContext,
    auth_handler_name: str | None,
) -> str:
    """Handle Word document comment notification activities."""
    if not hasattr(notification_activity, "wpx_comment") or not notification_activity.wpx_comment:
        return "I could not find the Word notification details."

    wpx = notification_activity.wpx_comment
    doc_id = getattr(wpx, "document_id", "")
    comment_text = notification_activity.text or ""

    logger.info(f"📄 Processing Word comment notification for doc {doc_id}")

    message = (
        f"You have been mentioned in a Word document comment.\n"
        f"Document ID: {doc_id}\n"
        f"Comment: {comment_text}\n\n"
        f"Please respond to this comment appropriately."
    )

    response = await agent.process_user_message(message, auth, auth_handler_name, context)
    return response or "Word notification processed."


async def _handle_generic_notification(
    agent: "CrewAIAgent",
    notification_activity: Any,
    auth: Authorization,
    context: TurnContext,
    auth_handler_name: str | None,
) -> str:
    """Handle generic notification activities."""
    logger.info("🔍 Full notification activity structure:")
    logger.info(f"   Type: {notification_activity.activity.type}")
    logger.info(f"   Name: {notification_activity.activity.name}")
    logger.info(f"   Text: {getattr(notification_activity.activity, 'text', 'N/A')}")
    logger.info(f"   Value: {getattr(notification_activity.activity, 'value', 'N/A')}")
    logger.info(f"   Entities: {notification_activity.activity.entities}")
    logger.info(f"   Channel ID: {notification_activity.activity.channel_id}")

    notification_message = (
        getattr(notification_activity.activity, 'text', None) or
        str(getattr(notification_activity.activity, 'value', None)) or
        f"Notification received: {notification_activity.notification_type}"
    )
    logger.info(f"📨 Processing generic notification: {notification_activity.notification_type}")

    response = await agent.process_user_message(notification_message, auth, auth_handler_name, context)
    return response or "Notification processed successfully."
