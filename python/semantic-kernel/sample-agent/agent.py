# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Semantic Kernel Agent with Microsoft 365 Integration

This agent uses the Semantic Kernel SDK and integrates with Microsoft 365 Agents SDK
for enterprise hosting, authentication, and observability.

Features:
- Semantic Kernel with ChatCompletionAgent
- Dual LLM support: Azure OpenAI or OpenAI via API key
- MCP (Model Context Protocol) tool integration
- Microsoft 365 Agents SDK hosting and authentication
- Complete observability with BaggageBuilder
- Conversation continuity across turns via ChatHistory
- Comprehensive error handling and cleanup
"""

import json
import logging
import os
import uuid

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

# Semantic Kernel SDK
from semantic_kernel import Kernel
from semantic_kernel.agents import ChatCompletionAgent, ChatHistoryAgentThread
from semantic_kernel.connectors.ai.open_ai import (
    AzureChatCompletion,
    OpenAIChatCompletion,
)
from semantic_kernel.connectors.ai.function_choice_behavior import FunctionChoiceBehavior
from semantic_kernel.connectors.ai.open_ai.prompt_execution_settings.open_ai_prompt_execution_settings import (
    OpenAIChatPromptExecutionSettings,
)
from semantic_kernel.contents.chat_history import ChatHistory
from semantic_kernel.functions.kernel_arguments import KernelArguments

# Agent Interface
from agent_interface import AgentInterface

# Microsoft Agents SDK
from local_authentication_options import LocalAuthenticationOptions
from microsoft_agents.hosting.core import Authorization, TurnContext

# Observability Components
from microsoft_agents_a365.observability.core import (
    InvokeAgentScope,
    InferenceScope,
    InferenceCallDetails,
    InferenceOperationType,
    ExecuteToolScope,
    ToolCallDetails,
)
from microsoft_agents_a365.observability.core.middleware.baggage_builder import BaggageBuilder

# Observability configuration (must be imported early)
from observability_config import is_observability_configured

# Shared turn context utilities
from turn_context_utils import (
    extract_turn_context_details,
    create_agent_details,
    create_invoke_agent_details,
    create_caller_details,
    create_request,
    build_baggage_builder,
)

# MCP Tooling Services
from mcp_tool_registration_service import McpToolRegistrationService

# Notifications
from microsoft_agents_a365.notifications.agent_notification import NotificationTypes

# </DependencyImports>


class SemanticKernelAgent(AgentInterface):
    """Semantic Kernel Agent integrated with Microsoft 365 Agents SDK"""

    # =========================================================================
    # INITIALIZATION
    # =========================================================================
    # <Initialization>

    def __init__(self):
        """Initialize the Semantic Kernel agent."""
        self.logger = logging.getLogger(self.__class__.__name__)

        # Observability is already configured at module level
        # No need to configure again here

        # Initialize authentication options
        self.auth_options = LocalAuthenticationOptions.from_environment()

        # Determine LLM provider
        self.use_azure_openai = os.getenv("USE_AZURE_OPENAI", "true").lower() == "true"

        # Create the Semantic Kernel and configure LLM
        self._create_kernel()

        # Initialize MCP services
        self._initialize_mcp_services()

        # Per-conversation chat history (keyed by conversation_id)
        self._chat_histories: dict[str, ChatHistory] = {}

        logger.info("Semantic Kernel Agent initialized with %s",
                     "Azure OpenAI" if self.use_azure_openai else "OpenAI")

    # </Initialization>

    # =========================================================================
    # KERNEL AND LLM SETUP
    # =========================================================================
    # <KernelSetup>

    def _create_kernel(self):
        """Create the Semantic Kernel and register the LLM service."""
        self.kernel = Kernel()

        if self.use_azure_openai:
            self._configure_azure_openai()
        else:
            self._configure_openai()

        # Store model info for observability
        if self.use_azure_openai:
            self.model_name = os.getenv("AZURE_OPENAI_DEPLOYMENT_NAME", "gpt-4o")
            self.provider_name = "Azure OpenAI"
        else:
            self.model_name = os.getenv("OPENAI_MODEL_ID", "gpt-4o")
            self.provider_name = "OpenAI"

        logger.info(f"✅ Semantic Kernel configured with {self.provider_name}, model: {self.model_name}")

    def _configure_azure_openai(self):
        """Configure Azure OpenAI as the chat completion service."""
        deployment_name = os.getenv("AZURE_OPENAI_DEPLOYMENT_NAME")
        endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
        api_key = os.getenv("AZURE_OPENAI_API_KEY")

        if not deployment_name or not endpoint or not api_key:
            raise EnvironmentError(
                "Missing Azure OpenAI configuration. Please set "
                "AZURE_OPENAI_DEPLOYMENT_NAME, AZURE_OPENAI_ENDPOINT, "
                "and AZURE_OPENAI_API_KEY environment variables."
            )

        service = AzureChatCompletion(
            deployment_name=deployment_name,
            endpoint=endpoint,
            api_key=api_key,
        )
        self.kernel.add_service(service)
        logger.info(f"✅ Azure OpenAI configured: deployment={deployment_name}, endpoint={endpoint}")

    def _configure_openai(self):
        """Configure OpenAI as the chat completion service."""
        model_id = os.getenv("OPENAI_MODEL_ID", "gpt-4o")
        api_key = os.getenv("OPENAI_API_KEY")

        if not api_key:
            raise EnvironmentError(
                "Missing OpenAI configuration. Please set "
                "OPENAI_API_KEY environment variable."
            )

        service = OpenAIChatCompletion(
            ai_model_id=model_id,
            api_key=api_key,
        )
        self.kernel.add_service(service)
        logger.info(f"✅ OpenAI configured: model={model_id}")

    # </KernelSetup>

    # =========================================================================
    # SYSTEM PROMPT
    # =========================================================================
    # <SystemPrompt>

    SYSTEM_PROMPT = """You are a friendly assistant that helps office workers with their daily tasks.
The user's name is {user_name}. Use their name naturally where appropriate — for example when greeting them or making responses feel personal. Do not overuse it.

Your capabilities:
- Use the MCP tools provided to help users with their tasks
- Answer general questions and provide helpful guidance

Guidelines:
- Always be helpful, professional, and concise
- When the user gives a clear instruction (e.g. "send a mail to X saying Y"), execute it immediately using the available tools. Do NOT ask for confirmation — just do it and report the result.
- Only ask clarifying questions when genuinely required information is missing (e.g. no recipient specified)
- When scheduling meetings, gather: title, attendees, date/time, duration
- Use the MCP tools provided to interact with Microsoft 365 services
- If you cannot complete a task, explain what additional information you need
"""

    # </SystemPrompt>

    # =========================================================================
    # MCP TOOLING INTEGRATION
    # =========================================================================
    # <McpTooling>

    def _initialize_mcp_services(self):
        """Initialize MCP services for tool discovery."""
        self.mcp_service = McpToolRegistrationService(logger=self.logger)
        self._mcp_tools_registered = False
        logger.info("MCP tool registration service initialized")

    async def setup_mcp_tools(
        self, auth: Authorization, auth_handler_name: str, context: TurnContext
    ):
        """
        Discover MCP servers via the SDK and register them as Semantic Kernel plugins.
        Cached after the first successful registration to avoid re-connecting on every turn.

        Args:
            auth: Authorization for token exchange
            auth_handler_name: Name of the auth handler
            context: Turn context from M365 SDK
        """
        if self._mcp_tools_registered:
            logger.debug("MCP tools already registered — skipping re-discovery")
            return

        try:
            # Get auth token for local dev, or let the SDK exchange one
            use_agentic_auth = os.getenv("USE_AGENTIC_AUTH", "true").lower() == "true"
            auth_token = None

            if not use_agentic_auth:
                auth_token = self.auth_options.bearer_token
                logger.info("Using static bearer token for MCP (USE_AGENTIC_AUTH=false)")

            # Discover MCP servers
            await self.mcp_service.discover_servers(
                auth=auth,
                auth_handler_name=auth_handler_name,
                context=context,
                auth_token=auth_token,
            )

            # Register discovered servers as SK plugins
            count = await self.mcp_service.add_tools_to_kernel(self.kernel)
            if count > 0:
                self._mcp_tools_registered = True
                logger.info(
                    "%d MCP server(s) registered as SK plugins: %s",
                    count,
                    self.mcp_service.get_server_names(),
                )
            else:
                logger.info("No MCP servers discovered")

        except Exception as e:
            skip_on_errors = (
                os.getenv("SKIP_TOOLING_ON_ERRORS", "false").lower() == "true"
            )
            if skip_on_errors:
                logger.warning(
                    "MCP tools unavailable — running in bare LLM mode. Error: %s", e
                )
            else:
                raise

    # </McpTooling>

    # =========================================================================
    # INITIALIZATION AND MESSAGE PROCESSING
    # =========================================================================
    # <MessageProcessing>

    async def initialize(self):
        """Initialize the agent and MCP services"""
        logger.info("Initializing Semantic Kernel Agent...")
        logger.info("MCP configuration service ready for tool discovery")
        logger.info("Semantic Kernel Agent initialized successfully")

    def _get_or_create_chat_history(self, conversation_id: str) -> ChatHistory:
        """Get or create a chat history for the given conversation."""
        if conversation_id not in self._chat_histories:
            self._chat_histories[conversation_id] = ChatHistory()
        return self._chat_histories[conversation_id]

    async def process_user_message(
        self,
        message: str,
        auth: Authorization,
        context: TurnContext,
        auth_handler_name: str | None = None,
    ) -> str:
        """Process user message using Semantic Kernel with observability tracing"""

        # Extract context details using shared utility
        ctx_details = extract_turn_context_details(context)

        # Log the user identity from activity.from_property — set by the A365 platform on every message.
        logger.info(
            "Turn received from user — DisplayName: '%s', UserId: '%s', AadObjectId: '%s'",
            ctx_details.caller_name or "(unknown)",
            ctx_details.caller_id or "(unknown)",
            ctx_details.caller_aad_object_id or "(none)",
        )
        display_name = ctx_details.caller_name or "unknown"
        personalized_prompt = self.SYSTEM_PROMPT.replace("{user_name}", display_name)

        try:
            logger.info(f"📨 Processing message: {message[:100]}...")

            # Setup MCP tools for this request
            await self.setup_mcp_tools(auth, auth_handler_name, context)

            # Verify observability is configured before using BaggageBuilder
            if not is_observability_configured():
                logger.warning("⚠️ Observability not configured, spans may not be exported")

            # Use BaggageBuilder to set contextual information that flows through all spans
            with build_baggage_builder(context).build():
                # Create observability details using shared utilities
                agent_details = create_agent_details(ctx_details)
                caller_details = create_caller_details(ctx_details)
                request = create_request(ctx_details, message)
                invoke_details = create_invoke_agent_details(ctx_details)

                # Use context manager pattern per documentation
                with InvokeAgentScope.start(
                    request=request,
                    scope_details=invoke_details,
                    agent_details=agent_details,
                    caller_details=caller_details,
                ) as invoke_scope:
                    # Record input message
                    if hasattr(invoke_scope, "record_input_messages"):
                        invoke_scope.record_input_messages([message])

                    # Create InferenceScope for tracking LLM call
                    inference_details = InferenceCallDetails(
                        operationName=InferenceOperationType.CHAT,
                        model=self.model_name,
                        providerName=self.provider_name,
                    )

                    with InferenceScope.start(
                        request=request,
                        details=inference_details,
                        agent_details=agent_details,
                    ) as inference_scope:
                        # Create the ChatCompletionAgent with current kernel state
                        execution_settings = OpenAIChatPromptExecutionSettings(
                            function_choice_behavior=FunctionChoiceBehavior.Auto(),
                        )

                        agent = ChatCompletionAgent(
                            kernel=self.kernel,
                            name="Agent365Agent",
                            instructions=personalized_prompt,
                            arguments=KernelArguments(settings=execution_settings),
                        )

                        # Get or create chat history for this conversation
                        conversation_id = ctx_details.conversation_id or "default"
                        chat_history = self._get_or_create_chat_history(conversation_id)

                        # Create a thread for this invocation
                        thread = ChatHistoryAgentThread(chat_history=chat_history)

                        # Invoke the agent
                        response_parts = []
                        input_tokens = 0
                        output_tokens = 0

                        async for response in agent.invoke(
                            thread=thread,
                            messages=message,
                        ):
                            content = response.message.content
                            if content:
                                response_parts.append(content)

                            # Track token usage from metadata if available
                            metadata = getattr(response.message, "metadata", None)
                            if metadata:
                                usage = metadata.get("usage", None)
                                if usage:
                                    input_tokens += getattr(usage, "prompt_tokens", 0) or 0
                                    output_tokens += getattr(
                                        usage, "completion_tokens", 0
                                    ) or 0

                            # Track tool calls for observability
                            items = getattr(response.message, "items", [])
                            for item in items:
                                item_type = type(item).__name__
                                if "FunctionCallContent" in item_type:
                                    tool_name = getattr(item, "function_name", None) or getattr(item, "name", "unknown")
                                    tool_args = getattr(item, "arguments", None)
                                    tool_id = getattr(item, "id", str(uuid.uuid4()))

                                    logger.info(f"🔧 Tool call: {tool_name}")

                                    try:
                                        args_str = (
                                            json.dumps(tool_args)
                                            if tool_args
                                            else ""
                                        )
                                    except (TypeError, ValueError):
                                        args_str = str(tool_args) if tool_args else ""

                                    tool_call_details = ToolCallDetails(
                                        tool_name=tool_name,
                                        arguments=args_str,
                                        tool_call_id=tool_id,
                                        description=f"Executing {tool_name} tool",
                                        tool_type="mcp_extension",
                                    )

                                    with ExecuteToolScope.start(
                                        request=request,
                                        details=tool_call_details,
                                        agent_details=agent_details,
                                    ) as tool_scope:
                                        # SK handles tool execution automatically
                                        # We just record the scope for observability
                                        if hasattr(tool_scope, "record_response"):
                                            tool_scope.record_response(
                                                "Tool executed by Semantic Kernel"
                                            )

                        full_response = "".join(response_parts)
                        if not full_response:
                            full_response = "I couldn't process your request at this time."

                        # Clean up the per-turn thread (ChatHistory is retained for conversation continuity)
                        try:
                            await thread.delete()
                        except Exception:
                            pass  # Thread delete is best-effort

                        # Record token usage
                        if input_tokens and hasattr(inference_scope, "record_input_tokens"):
                            inference_scope.record_input_tokens(int(input_tokens))
                        if output_tokens and hasattr(inference_scope, "record_output_tokens"):
                            inference_scope.record_output_tokens(int(output_tokens))
                        if input_tokens or output_tokens:
                            logger.info(f"📊 Tokens: {input_tokens} in, {output_tokens} out")

                        # Record finish reasons
                        if hasattr(inference_scope, "record_finish_reasons"):
                            inference_scope.record_finish_reasons(["stop"])

                        # Record output messages on inference scope
                        if hasattr(inference_scope, "record_output_messages"):
                            inference_scope.record_output_messages([full_response])

                    # Record output message on invoke scope (after inference scope closes)
                    if hasattr(invoke_scope, "record_output_messages"):
                        invoke_scope.record_output_messages([full_response])

            # Note: Scopes are automatically closed by the 'with' context managers
            logger.info("✅ Observability scopes closed successfully")

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
        self,
        notification_activity,
        auth: Authorization,
        context: TurnContext,
        auth_handler_name: str | None = None,
    ) -> str:
        """
        Handle agent notification activities (email, Word mentions, etc.)

        Args:
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
                if (
                    not hasattr(notification_activity, "email")
                    or not notification_activity.email
                ):
                    return "I could not find the email notification details."

                email = notification_activity.email
                email_body = getattr(email, "html_body", "") or getattr(
                    email, "body", ""
                )

                message = f"You have received the following email. Please follow any instructions in it.\n\n{email_body}"
                logger.info("📧 Processing email notification")

                response = await self.process_user_message(
                    message, auth, context, auth_handler_name
                )
                return response or "Email notification processed."

            # Handle Word Comment Notifications
            elif notification_type == NotificationTypes.WPX_COMMENT:
                if (
                    not hasattr(notification_activity, "wpx_comment")
                    or not notification_activity.wpx_comment
                ):
                    return "I could not find the Word notification details."

                wpx = notification_activity.wpx_comment
                doc_id = getattr(wpx, "document_id", "")
                comment_text = notification_activity.text or ""

                logger.info(
                    f"📄 Processing Word comment notification for doc {doc_id}"
                )

                message = (
                    f"You have been mentioned in a Word document comment.\n"
                    f"Document ID: {doc_id}\n"
                    f"Comment: {comment_text}\n\n"
                    f"Please respond to this comment appropriately."
                )

                response = await self.process_user_message(
                    message, auth, context, auth_handler_name
                )
                return response or "Word notification processed."

            # Generic notification handling
            else:
                logger.info(f"🔍 Unhandled notification type: {notification_type}")
                logger.info(
                    f"   Type: {notification_activity.activity.type}"
                )
                logger.info(
                    f"   Name: {notification_activity.activity.name}"
                )
                logger.info(
                    f"   Text: {getattr(notification_activity.activity, 'text', 'N/A')}"
                )

                text = getattr(notification_activity, "text", "") or ""
                if text:
                    response = await self.process_user_message(
                        f"Notification received: {text}",
                        auth,
                        context,
                        auth_handler_name,
                    )
                    return response or "Notification processed."

                return f"Received notification of type '{notification_type}' but no handler is implemented for it."

        except Exception as e:
            logger.error(f"Error handling notification: {e}")
            logger.exception("Full error details:")
            return f"Sorry, I encountered an error processing the notification: {str(e)}"

    # </NotificationHandling>

    # =========================================================================
    # CLEANUP
    # =========================================================================
    # <Cleanup>

    async def cleanup(self) -> None:
        """Clean up resources used by the agent."""
        try:
            # Clean up MCP plugin connections
            await self.mcp_service.cleanup()

            # Close underlying AI service HTTP clients
            if self._kernel:
                for service_id, service in list(
                    self._kernel.services.items()
                ):
                    client = getattr(service, "client", None)
                    if client and hasattr(client, "close"):
                        try:
                            await client.close()
                            logger.info(
                                f"Closed AI service client: {service_id}"
                            )
                        except Exception:
                            pass  # Best-effort close

            # Clear per-conversation chat histories
            self._chat_histories.clear()

            logger.info("Semantic Kernel Agent cleanup completed")
        except Exception as e:
            logger.error(f"Error during cleanup: {e}")

    # </Cleanup>
