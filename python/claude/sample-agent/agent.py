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

# Notifications
try:
    from microsoft_agents_a365.notifications.agent_notification import NotificationTypes
    NOTIFICATIONS_AVAILABLE = True
except ImportError:
    NOTIFICATIONS_AVAILABLE = False
    logger.debug("Notification packages not installed - notification handling disabled")

# Observability (optional - only imported if enabled)
try:
    from microsoft_agents_a365.observability.core import (
        InferenceScope,
        InvokeAgentDetails,
        InvokeAgentScope,
    )
    from microsoft_agents_a365.observability.core.middleware.baggage_builder import BaggageBuilder
    # from microsoft_agents_a365.observability.core.tool_type import ToolType
    from observability_helpers import (
        create_agent_details,
        create_tenant_details,
        create_request_details,
        create_inference_details,
        create_invoke_scope,
        create_baggage_context,
        create_inference_scope,
        # create_tool_call_details,
    )
    OBSERVABILITY_AVAILABLE = True
except ImportError:
    OBSERVABILITY_AVAILABLE = False
    logger.debug("Observability packages not installed - tracing disabled")

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

        # Initialize authentication options
        self.auth_options = LocalAuthenticationOptions.from_environment()

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
        self, message: str, auth: Authorization, context: TurnContext
    ) -> str:
        """Process user message using the Claude Agent SDK with observability tracing"""
        
        # Create observability scopes (will use nullcontext if not available)
        if OBSERVABILITY_AVAILABLE:
            from observability_helpers import create_invoke_scope, create_baggage_context, create_inference_scope
            invoke_scope = create_invoke_scope(context, message)
            baggage_ctx = create_baggage_context(context)
            inference_scope = create_inference_scope(context, self.claude_options.model, message)
        else:
            from contextlib import nullcontext
            invoke_scope = nullcontext()
            baggage_ctx = nullcontext()
            inference_scope = nullcontext()
        
        try:
            with baggage_ctx:
                with invoke_scope:
                    logger.info(f"📨 Processing message: {message[:100]}...")

                    # Track tokens for observability
                    total_input_tokens = 0
                    total_output_tokens = 0
                    total_thinking_tokens = 0
                    
                    with inference_scope:
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
                                            # Track thinking tokens
                                            total_thinking_tokens += len(block.thinking.split())
                                            logger.info(f"💭 Claude thinking: {block.thinking[:100]}...")
                                        
                                        # Collect actual response text
                                        elif isinstance(block, TextBlock):
                                            response_parts.append(block.text)
                                            # Track output tokens
                                            total_output_tokens += len(block.text.split())
                                            logger.info(f"💬 Claude response: {block.text[:100]}...")

                            # Track input tokens (approximate)
                            total_input_tokens = len(message.split())

                            # Log token usage
                            logger.info(f"📊 Tokens - Input: {total_input_tokens}, Output: {total_output_tokens}, Thinking: {total_thinking_tokens}")

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
            
            # Record error in scope if available
            if OBSERVABILITY_AVAILABLE and hasattr(invoke_scope, 'record_error'):
                try:
                    invoke_scope.record_error(e)
                except Exception as cleanup_error:
                    logger.warning(f"Failed to record error in observability: {cleanup_error}")
            
            return f"Sorry, I encountered an error: {str(e)}"

    # </MessageProcessing>

    # =========================================================================
    # NOTIFICATION HANDLING
    # =========================================================================
    # <NotificationHandling>

    async def handle_agent_notification_activity(
        self, notification_activity, auth: Authorization, context: TurnContext
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
        if not NOTIFICATIONS_AVAILABLE:
            logger.warning("Notifications not available - skipping notification handling")
            return "Notification handling is not available in this configuration."
        
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
                response = await self.process_user_message(message, auth, context)
                return response or "Email notification processed."

            # Handle Word Comment Notifications
            elif notification_type == NotificationTypes.WPX_COMMENT:
                if not hasattr(notification_activity, "wpx_comment") or not notification_activity.wpx_comment:
                    return "I could not find the Word notification details."
                
                wpx = notification_activity.wpx_comment
                doc_id = getattr(wpx, "document_id", "")
                # comment_id = getattr(wpx, "initiating_comment_id", "")
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
                response = await self.process_user_message(message, auth, context)
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
                response = await self.process_user_message(notification_message, auth, context)
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


# =============================================================================
# MAIN ENTRY POINT
# =============================================================================
# <MainEntryPoint>


async def main():
    """Main function to run the Claude Agent"""
    try:
        # Create and initialize the agent
        agent = ClaudeAgent()
        await agent.initialize()

        # Test the agent with a simple message
        logger.info("\n" + "=" * 80)
        logger.info("Testing Claude Agent")
        logger.info("=" * 80 + "\n")

        # Dummy auth and context for standalone testing
        class DummyAuth:
            async def exchange_token(self, context, scopes, handler_id):
                return type('obj', (object,), {'token': 'dummy-token'})()

        class DummyContext:
            pass

        response = await agent.process_user_message(
            "What is the capital of France?",
            DummyAuth(),
            DummyContext()
        )

        logger.info("\n" + "=" * 80)
        logger.info("Response:")
        logger.info("=" * 80)
        logger.info(response)
        logger.info("=" * 80 + "\n")

    except Exception as e:
        logger.error(f"Failed to start agent: {e}")
        print(f"Error: {e}")

    finally:
        # Cleanup
        if "agent" in locals():
            await agent.cleanup()


if __name__ == "__main__":
    asyncio.run(main())

# </MainEntryPoint>
