# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Claude Agent SDK Agent with Microsoft 365 Integration

This agent uses the Claude Agent SDK and integrates with Microsoft 365 Agents SDK
for enterprise hosting, authentication, and observability.

Features:
- Claude Agent SDK with extended thinking capability
- Microsoft 365 Agents SDK hosting and authentication
- Simplified observability setup
- Conversation continuity across turns
- Comprehensive error handling and cleanup
"""

import asyncio
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

# Claude Agent SDK
from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    TextBlock,
    ThinkingBlock,
)

# Agent Interface
from agent_interface import AgentInterface

# Microsoft Agents SDK
from local_authentication_options import LocalAuthenticationOptions
from microsoft_agents.hosting.core import Authorization, TurnContext
from token_cache import get_cached_agentic_token

# Observability Components
from microsoft_agents_a365.observability.core.config import configure

# MCP Tooling (optional - Claude Agent SDK has built-in tools)
try:
    from microsoft_agents_a365.tooling.services.mcp_tool_server_configuration_service import (
        McpToolServerConfigurationService,
    )
    MCP_AVAILABLE = True
except ImportError:
    MCP_AVAILABLE = False
    logger.debug("MCP tooling packages not installed - using Claude built-in tools only")

# Notifications
from microsoft_agents_a365.notifications.agent_notification import NotificationTypes

# </DependencyImports>


class ClaudeAgent(AgentInterface):
    """Claude Agent integrated with Microsoft 365 Agents SDK"""

    # =========================================================================
    # INITIALIZATION
    # =========================================================================
    # <Initialization>

    def __init__(self):
        """Initialize the Claude agent."""
        self.logger = logging.getLogger(self.__class__.__name__)

        # Initialize observability
        self._setup_observability()

        # Initialize authentication options
        self.auth_options = LocalAuthenticationOptions.from_environment()

        # Initialize MCP services if available
        if MCP_AVAILABLE:
            self._initialize_mcp_services()
        else:
            logger.info("MCP tooling not available - using Claude built-in tools")

        # Create Claude client
        self._create_client()

        # Claude client instance (will be set per conversation)
        self.client: ClaudeSDKClient | None = None

    # </Initialization>

    # =========================================================================
    # CLIENT CREATION
    # =========================================================================
    # <ClientCreation>

    def _create_client(self):
        """Create the Claude Agent SDK client options"""
        # Get model from environment or use default
        model = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-20250514")
        
      
        # Get API key
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise EnvironmentError("Missing ANTHROPIC_API_KEY. Please set it before running.")

        # Configure Claude options
        self.claude_options = ClaudeAgentOptions(
            model=model,
            # Enable extended thinking for detailed reasoning
            max_thinking_tokens=1024,
            # Allow web search and basic file operations
            allowed_tools=["WebSearch", "Read", "Write", "WebFetch"],
            # Auto-accept edits for smoother operation
            permission_mode="acceptEdits",
            continue_conversation=True
        )

        logger.info(f"✅ Claude Agent configured with model: {model}")




    # </ClientCreation>

    # =========================================================================
    # OBSERVABILITY CONFIGURATION
    # =========================================================================
    # <ObservabilityConfiguration>

    def token_resolver(self, agent_id: str, tenant_id: str) -> str | None:
        """
        Token resolver function for Agent 365 Observability exporter.

        Uses the cached agentic token obtained from AGENT_APP.auth.get_token(context, auth_handler_name).
        This is the only valid authentication method for this context.
        """

        try:
            logger.info(f"Token resolver called for agent_id: {agent_id}, tenant_id: {tenant_id}")

            # Use cached agentic token from agent authentication
            cached_token = get_cached_agentic_token(tenant_id, agent_id)
            if cached_token:
                logger.info("Using cached agentic token from agent authentication")
                return cached_token
            else:
                logger.warning(
                    f"No cached agentic token found for agent_id: {agent_id}, tenant_id: {tenant_id}"
                )
                return None

        except Exception as e:
            logger.error(f"Error resolving token for agent {agent_id}, tenant {tenant_id}: {e}")
            return None

    def _setup_observability(self):
        """
        Configure Microsoft Agent 365 observability (simplified pattern)

        This follows the same pattern as the reference examples:
        - semantic_kernel: configure() + SemanticKernelInstrumentor().instrument()
        - openai_agents: configure() + OpenAIAgentsTraceInstrumentor().instrument()
        """
        try:
            # Step 1: Configure Agent 365 Observability with service information
            status = configure(
                service_name=os.getenv("OBSERVABILITY_SERVICE_NAME", "claude-sample-agent"),
                service_namespace=os.getenv("OBSERVABILITY_SERVICE_NAMESPACE", "agent365-samples"),
                token_resolver=self.token_resolver,
            )

            if not status:
                logger.warning("⚠️ Agent 365 Observability configuration failed")
                return

            logger.info("✅ Agent 365 Observability configured successfully")

            # Note: Claude Agent SDK doesn't have automatic instrumentation yet
            # Manual scopes will be used in process_user_message

        except Exception as e:
            logger.error(f"❌ Error setting up observability: {e}")

    # </ObservabilityConfiguration>

    # =========================================================================
    # MCP SERVER SETUP (OPTIONAL)
    # =========================================================================
    # <McpServerSetup>

    def _initialize_mcp_services(self):
        """
        Initialize MCP services for tool server configuration.
        
        Note: Claude Agent SDK has built-in tools (WebSearch, Read, Write, WebFetch).
        MCP tooling provides additional enterprise tools for M365 integration.
        """
        try:
            # Create configuration service for MCP tool servers
            self.config_service = McpToolServerConfigurationService()
            logger.info("✅ MCP tool configuration service initialized")
            
            print("MCP AVAILABLE:", MCP_AVAILABLE)
            print("Configured MCP services:", getattr(self, "config_service", None))

            
        except Exception as e:
            logger.warning(f"⚠️ Failed to initialize MCP services: {e}")

    # </McpServerSetup>

    # =========================================================================
    # INITIALIZATION AND MESSAGE PROCESSING
    # =========================================================================
    # <MessageProcessing>

    async def initialize(self):
        """Initialize the agent"""
        logger.info("Initializing Claude Agent...")
        try:
            logger.info("Claude Agent initialized successfully")
        except Exception as e:
            logger.error(f"Failed to initialize agent: {e}")
            raise

    async def process_user_message(
        self, message: str, auth: Authorization, auth_handler_name: str, context: TurnContext
    ) -> str:
        """Process user message using the Claude Agent SDK with observability tracing"""
        
        try:
            logger.info(f"📨 Processing message: {message[:100]}...")

            # Create a new client for this conversation
            # Claude SDK uses async context manager
            async with ClaudeSDKClient(self.claude_options) as client:
                # Send the user message
                await client.query(message)

                # Collect the response
                response_parts = []
                thinking_parts = []
                
                # Receive and process messages
                async for msg in client.receive_response():
                    if isinstance(msg, AssistantMessage):
                        for block in msg.content:
                            # Collect thinking (Claude's reasoning)
                            if isinstance(block, ThinkingBlock):
                                thinking_parts.append(f"💭 {block.thinking}")
                                logger.info(f"💭 Claude thinking: {block.thinking[:100]}...")
                            
                            # Collect actual response text
                            elif isinstance(block, TextBlock):
                                response_parts.append(block.text)
                                logger.info(f"💬 Claude response: {block.text[:100]}...")

                # Combine thinking and response
                full_response = ""
                
                # Add thinking if present (for transparency)
                if thinking_parts:
                    full_response += "**Claude's Thinking:**\n"
                    full_response += "\n".join(thinking_parts)
                    full_response += "\n\n**Response:**\n"
                
                # Add the actual response
                if response_parts:
                    full_response += "".join(response_parts)
                else:
                    full_response += "I couldn't process your request at this time."

                return full_response

        except Exception as e:
            logger.error(f"Error processing message: {e}")
            logger.exception("Full error details:")
            return f"Sorry, I encountered an error: {str(e)}"



    # </MessageProcessing>

    # =========================================================================
    # NOTIFICATION HANDLING
    # =========================================================================
    # <NotificationHandling>

    async def handle_agent_notification_activity(
        self, notification_activity, auth: Authorization, auth_handler_name: str, context: TurnContext
    ) -> str:
        """
        Handle agent notification activities (email, Word mentions, etc.)
        
        Args:
            notification_activity: The notification activity from Agent365
            auth: Authorization for token exchange
            context: Turn context from M365 SDK
            
        Returns:
            Response string to send back
        """
        try:
            notification_type = notification_activity.notification_type
            logger.info(f"📬 Processing notification: {notification_type}")

            # Handle Email Notifications
            if notification_type == NotificationTypes.EMAIL_NOTIFICATION:
                if not hasattr(notification_activity, "email") or not notification_activity.email:
                    return "I could not find the email notification details."
                
                email = notification_activity.email
                email_body = getattr(email, "html_body", "") or getattr(email, "body", "")
                
                # Create message for Claude to process the email
                message = f"You have received the following email. Please follow any instructions in it.\n\n{email_body}"
                
                logger.info(f"📧 Processing email notification")
                
                # Process with Claude
                response = await self.process_user_message(message, auth, auth_handler_name, context)
                return response or "Email notification processed."

            # Handle Word Comment Notifications
            elif notification_type == NotificationTypes.WPX_COMMENT:
                if not hasattr(notification_activity, "wpx_comment") or not notification_activity.wpx_comment:
                    return "I could not find the Word notification details."
                
                wpx = notification_activity.wpx_comment
                doc_id = getattr(wpx, "document_id", "")
                comment_text = notification_activity.text or ""
                
                logger.info(f"📄 Processing Word comment notification for doc {doc_id}")
                
                # Note: Without MCP tools, we can't retrieve the actual Word document
                # So we'll just process the comment text directly
                message = (
                    f"You have been mentioned in a Word document comment.\n"
                    f"Document ID: {doc_id}\n"
                    f"Comment: {comment_text}\n\n"
                    f"Please respond to this comment appropriately."
                )
                
                # Process with Claude
                response = await self.process_user_message(message, auth, auth_handler_name, context)
                return response or "Word notification processed."

            # Generic notification handling
            else:
                # Log full activity structure for debugging
                logger.info(f"🔍 Full notification activity structure:")
                logger.info(f"   Type: {notification_activity.activity.type}")
                logger.info(f"   Name: {notification_activity.activity.name}")
                logger.info(f"   Text: {getattr(notification_activity.activity, 'text', 'N/A')}")
                logger.info(f"   Value: {getattr(notification_activity.activity, 'value', 'N/A')}")
                logger.info(f"   Entities: {notification_activity.activity.entities}")
                logger.info(f"   Channel ID: {notification_activity.activity.channel_id}")
                
                # Try to get message from activity.text or activity.value
                notification_message = (
                    getattr(notification_activity.activity, 'text', None) or 
                    str(getattr(notification_activity.activity, 'value', None)) or 
                    f"Notification received: {notification_type}"
                )
                logger.info(f"📨 Processing generic notification: {notification_type}")
                
                # Process with Claude
                response = await self.process_user_message(notification_message, auth, auth_handler_name, context)
                return response or "Notification processed successfully."

        except Exception as e:
            logger.error(f"Error processing notification: {e}")
            logger.exception("Full error details:")
            return f"Sorry, I encountered an error processing the notification: {str(e)}"

    # </NotificationHandling>

    # =========================================================================
    # CLEANUP
    # =========================================================================
    # <Cleanup>

    async def cleanup(self) -> None:
        """Clean up agent resources"""
        try:
            logger.info("Cleaning up agent resources...")
            
            # Claude SDK client cleanup is handled by context manager
            # No additional cleanup needed
            
            logger.info("Agent cleanup completed")

        except Exception as e:
            logger.error(f"Error during cleanup: {e}")

    # </Cleanup>

