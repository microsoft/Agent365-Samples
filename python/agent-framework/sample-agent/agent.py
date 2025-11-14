# Copyright (c) Microsoft. All rights reserved.

"""
AgentFramework Agent with MCP Server Integration and Observability

This agent uses the AgentFramework SDK and connects to MCP servers for extended functionality,
with integrated observability using Microsoft Agent 365.

Features:
- AgentFramework SDK with Azure OpenAI integration
- MCP server integration for dynamic tool registration
- Simplified observability setup following reference examples pattern
- Two-step configuration: configure() + instrument()
- Automatic AgentFramework instrumentation
- Token-based authentication for Agent 365 Observability
- Custom spans with detailed attributes
- Comprehensive error handling and cleanup
"""

import logging
import os

from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# =============================================================================
# DEPENDENCY IMPORTS
# =============================================================================
# <DependencyImports>

# AgentFramework SDK
from agent_framework import ChatAgent
from agent_framework.azure import AzureOpenAIChatClient

# Agent Interface
from agent_interface import AgentInterface
from azure.identity import AzureCliCredential

# Microsoft Agents SDK
from microsoft_agents.hosting.core import Authorization, TurnContext

# Notifications
from microsoft_agents_a365.notifications.agent_notification import NotificationTypes

# Observability Components
from microsoft_agents_a365.observability.extensions.agentframework.trace_instrumentor import (
    AgentFrameworkInstrumentor,
)

# MCP Tooling
from microsoft_agents_a365.tooling.extensions.agentframework.services.mcp_tool_registration_service import (
    McpToolRegistrationService,
)

# </DependencyImports>

class LocalAuthenticationOptions():
    bearer_token: str

class AgentFrameworkAgent(AgentInterface):
    """AgentFramework Agent integrated with MCP servers and Observability"""

    AGENT_PROMPT = "You are a helpful assistant with access to tools."

    # =========================================================================
    # INITIALIZATION
    # =========================================================================
    # <Initialization>

    def __init__(self):
        """Initialize the AgentFramework agent."""
        self.logger = logging.getLogger(self.__class__.__name__)

        # Initialize Agent 365 Observability Wrapper for AgentFramework SDK
        AgentFrameworkInstrumentor().instrument()

        # Initialize authentication options
        self.auth_options = LocalAuthenticationOptions()
        self.auth_options.bearer_token = os.getenv("BEARER_TOKEN", "")

        # Initialize MCP services
        self.tool_service = McpToolRegistrationService()

        # Create Azure OpenAI chat client
        self._create_chat_client()

    # </Initialization>

    # =========================================================================
    # CLIENT AND AGENT CREATION
    # =========================================================================
    # <ClientCreation>

    def _create_chat_client(self):
        """Create the Azure OpenAI chat client"""
        endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
        deployment = os.getenv("AZURE_OPENAI_DEPLOYMENT")
        api_version = os.getenv("AZURE_OPENAI_API_VERSION")

        if not endpoint:
            raise ValueError("AZURE_OPENAI_ENDPOINT environment variable is required")
        if not deployment:
            raise ValueError("AZURE_OPENAI_DEPLOYMENT environment variable is required")
        if not api_version:
            raise ValueError(
                "AZURE_OPENAI_API_VERSION environment variable is required"
            )

        self.chat_client = AzureOpenAIChatClient(
            endpoint=endpoint,
            credential=AzureCliCredential(),
            deployment_name=deployment,
            api_version=api_version,
        )

        logger.info("AzureOpenAIChatClient created successfully")

    def _create_agent(self):
        """Create the AgentFramework agent with initial configuration"""
        try:
            self.agent = ChatAgent(
                chat_client=self.chat_client,
                instructions=self.AGENT_PROMPT,
                tools=[],
            )
        except Exception as e:
            logger.error(f"Failed to create agent: {e}")
            raise

    # </ClientCreation>

    # =========================================================================
    # MCP SERVER SETUP
    # =========================================================================
    # <McpServerSetup>

    async def _create_agent_with_mcp(self, auth: Authorization, context: TurnContext):
        """Set up MCP server connections"""
        try:
            logger.info("Starting MCP server setup...")

            agent_user_id = os.getenv("AGENT_ID", "user123")
            use_agentic_auth = os.getenv("USE_AGENTIC_AUTH", "false").lower() == "true"

            if use_agentic_auth:
                scope = os.getenv("AGENTIC_AUTH_SCOPE")
                if not scope:
                    logger.warning(
                        "AGENTIC_AUTH_SCOPE environment variable is not set when USE_AGENTIC_AUTH=true"
                    )
                    return
                scopes = [scope]
                authToken = await auth.exchange_token(context, scopes, "AGENTIC")
                auth_token = authToken.token
                self.agent = await self.tool_service.add_tool_servers_to_agent(
                    chat_client=self.chat_client,
                    agent_instructions=self.AGENT_PROMPT,
                    initial_tools=[],
                    agentic_app_id=agent_user_id,
                    auth=auth,
                    turn_context=context,
                    auth_token=auth_token,
                )
            else:
                self.agent = await self.tool_service.add_tool_servers_to_agent(
                    chat_client=self.chat_client,
                    agent_instructions=self.AGENT_PROMPT,
                    initial_tools=[],
                    agentic_app_id=agent_user_id,
                    auth=auth,
                    auth_token=self.auth_options.bearer_token,
                    turn_context=context,
                )
        except Exception as e:
            logger.error(f"MCP setup error: {e}")

        if not self.agent:
            logger.warning("Agent MCP setup returned None, returning agent without servers.")
            self._create_agent()

    # </McpServerSetup>

    # =========================================================================
    # MESSAGE PROCESSING
    # =========================================================================
    # <MessageProcessing>

    async def process_user_message(
        self, message: str, auth: Authorization, context: TurnContext
    ) -> str:
        """Process user message using the AgentFramework SDK"""
        try:
            # Setup MCP servers
            await self._create_agent_with_mcp(auth, context)

            # Run the agent with the user message
            result = await self.agent.run(message)
            return self._extract_result(result) or "I couldn't process your request at this time."
        except Exception as e:
            logger.error(f"Error processing message: {e}")
            return f"Sorry, I encountered an error: {str(e)}"

    # </MessageProcessing>

    # =========================================================================
    # NOTIFICATION HANDLING
    # =========================================================================
    # <NotificationHandling>

    async def handle_agent_notification_activity(
        self, notification_activity, auth: Authorization, context: TurnContext
    ) -> str:
        """Handle agent notification activities (email, Word mentions, etc.)"""
        try:
            notification_type = notification_activity.notification_type
            logger.info(f"Processing notification: {notification_type}")

            # Setup MCP servers on first call
            await self._create_agent_with_mcp(auth, context)

            # Handle Email Notifications
            if notification_type == NotificationTypes.EMAIL_NOTIFICATION:
                if not hasattr(notification_activity, "email") or not notification_activity.email:
                    return "I could not find the email notification details."

                email = notification_activity.email
                email_body = getattr(email, "html_body", "") or getattr(email, "body", "")
                email_id = getattr(email, "id", "")
                message = f"You have received an email with id {email_id}. The following is the content of the email, please follow any instructions in it: {email_body}"

                result = await self.agent.run(message)
                return self._extract_result(result) or "Email notification processed."

            # Handle Word Comment Notifications
            elif notification_type == NotificationTypes.WPX_COMMENT:
                if not hasattr(notification_activity, "wpx_comment") or not notification_activity.wpx_comment:
                    return "I could not find the Word notification details."

                wpx = notification_activity.wpx_comment
                doc_id = getattr(wpx, "document_id", "")
                comment_id = getattr(wpx, "initiating_comment_id", "")
                drive_id = "default"

                # Get Word document content
                doc_message = f"You have a new comment on the Word document with id '{doc_id}', comment id '{comment_id}', drive id '{drive_id}'. Please retrieve the Word document as well as the comments and return it in text format."
                doc_result = await self.agent.run(doc_message)
                word_content = self._extract_result(doc_result)

                # Process the comment with document context
                comment_text = notification_activity.text or ""
                response_message = f"You have received the following Word document content and comments. Please refer to these when responding to comment '{comment_text}'. {word_content}"
                result = await self.agent.run(response_message)
                return self._extract_result(result) or "Word notification processed."

            # Generic notification handling
            else:
                notification_message = notification_activity.text or f"Notification received: {notification_type}"
                result = await self.agent.run(notification_message)
                return self._extract_result(result) or "Notification processed successfully."

        except Exception as e:
            logger.error(f"Error processing notification: {e}")
            return f"Sorry, I encountered an error processing the notification: {str(e)}"

    def _extract_result(self, result) -> str:
        """Extract text content from agent result"""
        if not result:
            return ""
        if hasattr(result, "contents"):
            return str(result.contents)
        elif hasattr(result, "text"):
            return str(result.text)
        elif hasattr(result, "content"):
            return str(result.content)
        else:
            return str(result)

    # </NotificationHandling>

    # =========================================================================
    # CLEANUP
    # =========================================================================
    # <Cleanup>

    async def cleanup(self) -> None:
        """Clean up agent resources"""
        try:
            if hasattr(self, "tool_service") and self.tool_service:
                await self.tool_service.cleanup()
            logger.info("Agent cleanup completed")
        except Exception as e:
            logger.error(f"Cleanup error: {e}")

    # </Cleanup>
