# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Amazon Bedrock Agent with Microsoft Agent 365 SDK Integration

This module implements the BedrockAgent class that handles:
- Message routing via AgentApplication
- Notification handling (including email notifications)
- Observability token management
- Integration with the Bedrock client for LLM calls
"""

import logging
import os
from typing import Optional

from aiohttp.web import Application

from client import get_client, setup_observability
from token_cache import create_agentic_token_cache_key, set_cached_token

# Microsoft Agents SDK imports
from microsoft_agents.activity import load_configuration_from_env
from microsoft_agents.authentication.msal import MsalConnectionManager
from microsoft_agents.hosting.aiohttp import CloudAdapter
from microsoft_agents.hosting.core import (
    AgentApplication,
    Authorization,
    MemoryStorage,
    TurnContext,
    TurnState,
)

# Agent 365 Observability imports
try:
    from microsoft_agents_a365.observability.core.middleware.baggage_builder import BaggageBuilder

    OBSERVABILITY_AVAILABLE = True
except ImportError:
    OBSERVABILITY_AVAILABLE = False


# Agent 365 Notifications imports
try:
    from microsoft_agents_a365.notifications import (
        AgentNotificationActivity,
        NotificationType,
        create_email_response_activity,
    )

    NOTIFICATIONS_AVAILABLE = True
except ImportError:
    NOTIFICATIONS_AVAILABLE = False

# Agent 365 Runtime imports
try:
    from microsoft_agents_a365.runtime.environment_utils import (
        get_observability_authentication_scope,
    )

    RUNTIME_AVAILABLE = True
except ImportError:
    RUNTIME_AVAILABLE = False


logger = logging.getLogger(__name__)

# Load configuration
agents_sdk_config = load_configuration_from_env(os.environ)


class BedrockAgent(AgentApplication):
    """
    Agent implementation using Amazon Bedrock as the LLM backend.

    Features:
    - Message handling with streaming responses
    - Agent 365 Observability integration
    - Agent 365 Notifications (including email)
    - Configurable authentication and authorization
    """

    AUTH_HANDLER_NAME = "AGENTIC"

    def __init__(self):
        """Initialize the Bedrock Agent with Microsoft Agents SDK components."""
        # Initialize storage and connection management
        storage = MemoryStorage()
        connection_manager = MsalConnectionManager(**agents_sdk_config)
        adapter = CloudAdapter(connection_manager=connection_manager)
        authorization = Authorization(
            storage, connection_manager, **agents_sdk_config
        )

        # Initialize the parent AgentApplication
        super().__init__(
            storage=storage,
            adapter=adapter,
            authorization=authorization,
            start_typing_timer=True,
            **agents_sdk_config,
        )

        # Setup message and notification handlers
        self._setup_handlers()

        # Initialize observability
        setup_observability()

        logger.info("BedrockAgent initialized")

    def _setup_handlers(self):
        """Configure message and notification handlers."""
        # Handler for agent notifications (if available)
        if NOTIFICATIONS_AVAILABLE:
            @self.agent_notification("agents:*")
            async def on_agent_notification(
                context: TurnContext,
                state: TurnState,
                notification: AgentNotificationActivity,
            ):
                await self._handle_agent_notification(context, state, notification)

        # Handler for regular messages
        handler = [self.AUTH_HANDLER_NAME]

        @self.activity("message", auth_handlers=handler)
        async def on_message(context: TurnContext, state: TurnState):
            await self._handle_message(context, state)

        # Welcome handler for new conversations
        @self.conversation_update("membersAdded")
        async def on_members_added(context: TurnContext, state: TurnState):
            await context.send_activity(
                "👋 Hello! I'm the Bedrock Sample Agent powered by Claude on Amazon Bedrock. "
                "How can I help you today?"
            )

    async def _handle_message(self, context: TurnContext, state: TurnState) -> None:
        """
        Handle incoming user messages.

        Args:
            context: The turn context with message details
            state: The conversation state
        """
        user_message = context.activity.text or ""

        if not user_message.strip():
            await context.send_activity("Please send me a message and I'll help you!")
            return

        # Get agent and tenant IDs for observability
        agent_id = context.activity.recipient.agentic_app_id or ""
        tenant_id = context.activity.recipient.tenant_id or ""
        conversation_id = context.activity.conversation.id or ""

        # Preload observability token
        await self._preload_observability_token(context, agent_id, tenant_id)

        try:
            # Create baggage scope for observability context propagation
            if OBSERVABILITY_AVAILABLE:
                baggage_builder = BaggageBuilder()
                baggage_builder.tenant_id(tenant_id)
                baggage_builder.agent_id(agent_id)
                baggage_scope = baggage_builder.build()

                with baggage_scope:
                    response = await self._invoke_bedrock(
                        user_message, agent_id, tenant_id, conversation_id
                    )
                    await context.send_activity(response)
            else:
                response = await self._invoke_bedrock(
                    user_message, agent_id, tenant_id, conversation_id
                )
                await context.send_activity(response)

        except Exception as e:
            logger.error(f"Error processing message: {e}")
            await context.send_activity(f"Sorry, I encountered an error: {str(e)}")

    async def _invoke_bedrock(
        self, message: str, agent_id: str, tenant_id: str, conversation_id: str
    ) -> str:
        """
        Invoke the Bedrock client with observability scope.

        Args:
            message: The user message
            agent_id: Agent ID for observability
            tenant_id: Tenant ID for observability
            conversation_id: Conversation ID for tracking

        Returns:
            The model's response
        """
        client = get_client()
        return await client.invoke_agent_with_scope(
            prompt=message,
            agent_id=agent_id,
            agent_name="Bedrock Sample Agent",
            conversation_id=conversation_id,
            tenant_id=tenant_id,
        )

    async def _preload_observability_token(
        self, context: TurnContext, agent_id: str, tenant_id: str
    ) -> None:
        """
        Preload the observability token for the A365 exporter.

        Args:
            context: The turn context for token exchange
            agent_id: The agent application ID
            tenant_id: The tenant ID
        """
        if not RUNTIME_AVAILABLE:
            return

        try:
            use_custom_resolver = os.getenv("Use_Custom_Resolver", "false").lower() == "true"

            if use_custom_resolver:
                # Exchange token and cache it for the custom resolver
                token_result = await self.auth.exchange_token(
                    context,
                    scopes=get_observability_authentication_scope(),
                    auth_handler_id=self.AUTH_HANDLER_NAME,
                )

                if token_result and token_result.token:
                    cache_key = create_agentic_token_cache_key(agent_id, tenant_id)
                    set_cached_token(cache_key, token_result.token)
                    logger.debug(
                        f"Preloaded observability token for agent={agent_id}, tenant={tenant_id}"
                    )

        except Exception as e:
            logger.warning(f"Failed to preload observability token: {e}")

    async def _handle_agent_notification(
        self,
        context: TurnContext,
        state: TurnState,
        notification: AgentNotificationActivity,
    ) -> None:
        """
        Handle agent notifications (e.g., email notifications).

        Args:
            context: The turn context
            state: The conversation state
            notification: The notification activity
        """
        if not NOTIFICATIONS_AVAILABLE:
            await context.send_activity(f"Received notification: {notification}")
            return

        if notification.notification_type == NotificationType.EmailNotification:
            await self._handle_email_notification(context, state, notification)
        else:
            await context.send_activity(
                f"Received notification of type: {notification.notification_type}"
            )

    async def _handle_email_notification(
        self,
        context: TurnContext,
        state: TurnState,
        notification: AgentNotificationActivity,
    ) -> None:
        """
        Handle email notifications.

        Args:
            context: The turn context
            state: The conversation state
            notification: The email notification activity
        """
        email_notification = notification.email_notification

        if not email_notification:
            error_response = create_email_response_activity(
                "I could not find the email notification details."
            )
            await context.send_activity(error_response)
            return

        try:
            client = get_client()

            # First, retrieve the email content
            email_content = await client.invoke_agent_with_scope(
                f"You have a new email from {context.activity.from_property.name or 'unknown'} "
                f"with id '{email_notification.id}', "
                f"ConversationId '{email_notification.conversation_id}'. "
                "Please retrieve this message and return it in text format."
            )

            # Then process the email
            response = await client.invoke_agent_with_scope(
                f"You have received the following email. Please follow any instructions in it. {email_content}"
            )

            email_response = create_email_response_activity(
                response or "I have processed your email but do not have a response at this time."
            )
            await context.send_activity(email_response)

        except Exception as e:
            logger.error(f"Email notification error: {e}")
            error_response = create_email_response_activity(
                "Unable to process your email at this time."
            )
            await context.send_activity(error_response)

# =============================================================================
# SINGLETON INSTANCE
# =============================================================================

# Create the singleton agent instance
agent_application = BedrockAgent()
