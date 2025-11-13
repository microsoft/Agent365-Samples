# Copyright (c) Microsoft. All rights reserved.

"""
OpenAI Agent with MCP Server Integration and Observability

This agent uses the official OpenAI Agents SDK and connects to MCP servers for extended functionality,
with integrated observability using Microsoft Agent 365.

Features:
- Simplified observability setup following reference examples pattern
- Two-step configuration: configure() + instrument()
- Automatic OpenAI Agents instrumentation
- Console trace output for development
- Custom spans with detailed attributes
- Comprehensive error handling and cleanup
"""

import asyncio
import logging
import os

from agent_interface import AgentInterface
from dotenv import load_dotenv
from token_cache import get_cached_agentic_token

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# =============================================================================
# DEPENDENCY IMPORTS
# =============================================================================
# <DependencyImports>

# OpenAI Agents SDK
from agents import Agent, OpenAIChatCompletionsModel, Runner
from agents.model_settings import ModelSettings

# Microsoft Agents SDK
from local_authentication_options import LocalAuthenticationOptions
from microsoft_agents.hosting.core import Authorization, TurnContext

# Observability Components
from microsoft_agents_a365.observability.core.config import configure
from microsoft_agents_a365.observability.extensions.openai import OpenAIAgentsTraceInstrumentor
from microsoft_agents_a365.tooling.extensions.openai import mcp_tool_registration_service

# MCP Tooling
from microsoft_agents_a365.tooling.services.mcp_tool_server_configuration_service import (
    McpToolServerConfigurationService,
)
from openai import AsyncAzureOpenAI, AsyncOpenAI

# Notifications
from microsoft_agents_a365.notifications.agent_notification import NotificationTypes

# </DependencyImports>


class OpenAIAgentWithMCP(AgentInterface):
    """OpenAI Agent integrated with MCP servers using the official OpenAI Agents SDK with Observability"""

    # =========================================================================
    # INITIALIZATION
    # =========================================================================
    # <Initialization>

    def __init__(self, openai_api_key: str | None = None):
        self.openai_api_key = openai_api_key or os.getenv("OPENAI_API_KEY")
        if not self.openai_api_key and (
            not os.getenv("AZURE_OPENAI_API_KEY") or not os.getenv("AZURE_OPENAI_ENDPOINT")
        ):
            raise ValueError("OpenAI API key or azure credentials are required")

        # Initialize observability
        self._setup_observability()

        endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
        api_key = os.getenv("AZURE_OPENAI_API_KEY")

        if endpoint and api_key:
            self.openai_client = AsyncAzureOpenAI(
                azure_endpoint=endpoint,
                api_key=api_key,
                api_version="2025-01-01-preview",
            )
        else:
            self.openai_client = AsyncOpenAI(api_key=self.openai_api_key)

        self.model = OpenAIChatCompletionsModel(
            model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"), openai_client=self.openai_client
        )

        # Configure model settings (optional parameters)
        self.model_settings = ModelSettings(temperature=0.7)

        # Initialize MCP servers
        self.mcp_servers = []

        # Create the agent
        self.agent = Agent(
            name="MCP Agent",
            model=self.model,
            model_settings=self.model_settings,
            instructions="""
You are a helpful AI assistant with access to external tools through MCP servers.
When a user asks for any action, use the appropriate tools to provide accurate and helpful responses.
Always be friendly and explain your reasoning when using tools.
            """,
            mcp_servers=self.mcp_servers,
        )

        # Setup OpenAI Agents instrumentation (handled in _setup_observability)
        # Instrumentation is automatically configured during observability setup
        pass

    # </Initialization>

    # =========================================================================
    # OBSERVABILITY CONFIGURATION
    # =========================================================================
    # <ObservabilityConfiguration>

    def token_resolver(self, agent_id: str, tenant_id: str) -> str | None:
        """
        Token resolver function for Agent 365 Observability exporter.

        Uses the cached agentic token obtained from AGENT_APP.auth.get_token(context, "AGENTIC").
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
                service_name=os.getenv("OBSERVABILITY_SERVICE_NAME", "openai-sample-agent"),
                service_namespace=os.getenv("OBSERVABILITY_SERVICE_NAMESPACE", "agent365-samples"),
                token_resolver=self.token_resolver,
            )

            if not status:
                logger.warning("⚠️ Agent 365 Observability configuration failed")
                return

            logger.info("✅ Agent 365 Observability configured successfully")

            # Step 2: Enable OpenAI Agents instrumentation
            self._enable_openai_agents_instrumentation()

        except Exception as e:
            logger.error(f"❌ Error setting up observability: {e}")

    def _enable_openai_agents_instrumentation(self):
        """Enable OpenAI Agents instrumentation for automatic tracing"""
        try:
            # Initialize Agent 365 Observability Wrapper for OpenAI Agents SDK
            OpenAIAgentsTraceInstrumentor().instrument()
            logger.info("✅ OpenAI Agents instrumentation enabled")
        except Exception as e:
            logger.warning(f"⚠️ Could not enable OpenAI Agents instrumentation: {e}")

    # </ObservabilityConfiguration>

    # =========================================================================
    # MCP SERVER SETUP AND INITIALIZATION
    # =========================================================================
    # <McpServerSetup>

    def _initialize_services(self):
        """
        Initialize MCP services and authentication options.

        Returns:
            Tuple of (tool_service, auth_options)
        """
        # Create configuration service and tool service with dependency injection
        self.config_service = McpToolServerConfigurationService()
        self.tool_service = mcp_tool_registration_service.McpToolRegistrationService()

        # Create authentication options from environment
        self.auth_options = LocalAuthenticationOptions.from_environment()

        # return tool_service, auth_options

    async def setup_mcp_servers(self, auth: Authorization, context: TurnContext):
        """Set up MCP server connections"""
        try:
            agentic_app_id = os.getenv("AGENT_ID", "user123")

            use_agentic_auth = os.getenv("USE_AGENTIC_AUTH", "false").lower() == "true"
            if use_agentic_auth:
                self.agent = await self.tool_service.add_tool_servers_to_agent(
                    agent=self.agent,
                    agentic_app_id=agentic_app_id,
                    environment_id=self.auth_options.env_id,
                    auth=auth,
                    context=context,
                )
            else:
                self.agent = await self.tool_service.add_tool_servers_to_agent(
                    agent=self.agent,
                    agentic_app_id=agentic_app_id,
                    environment_id=self.auth_options.env_id,
                    auth=auth,
                    context=context,
                    auth_token=self.auth_options.bearer_token,
                )

        except Exception as e:
            logger.error(f"Error setting up MCP servers: {e}")

    async def initialize(self):
        """Initialize the agent and MCP server connections"""
        logger.info("Initializing OpenAI Agent with MCP servers...")

        try:
            # The runner doesn't need explicit initialization
            logger.info("Agent and MCP servers initialized successfully")
            self._initialize_services()

        except Exception as e:
            logger.error(f"Failed to initialize agent: {e}")
            raise

    # </McpServerSetup>

    # =========================================================================
    # NOTIFICATION HANDLING
    # =========================================================================
    # <NotificationHandling>

    async def handle_agent_notification_activity(
        self, notification_activity, _auth: Authorization, _context: TurnContext
    ) -> str:
        """Handle agent notification activities (email, Word mentions, etc.)"""
        notification_type = notification_activity.notification_type
        notification_cid = notification_activity.email.conversation_id
        notification_body = notification_activity.email.html_body
        notification_id = notification_activity.email.id
        return f"Received notification of type: {notification_type},\n\tConversation ID: {notification_cid},\n\t ID: {notification_id},\n\t Body: {notification_body}"

    # </NotificationHandling>

    # =========================================================================
    # MESSAGE PROCESSING WITH OBSERVABILITY
    # =========================================================================
    # <MessageProcessing>

    async def process_user_message(
        self, message: str, auth: Authorization, context: TurnContext
    ) -> str:
        """Process user message using the OpenAI Agents SDK"""
        try:
            # Setup MCP servers
            await self.setup_mcp_servers(auth, context)

            # Run the agent with the user message
            result = await Runner.run(starting_agent=self.agent, input=message, context=context)

            # Extract the response from the result
            if result and hasattr(result, "final_output") and result.final_output:
                return str(result.final_output)
            else:
                return "I couldn't process your request at this time."

        except Exception as e:
            logger.error(f"Error processing message: {e}")
            return f"Sorry, I encountered an error: {str(e)}"

    # </MessageProcessing>

    # =========================================================================
    # CLEANUP
    # =========================================================================
    # <Cleanup>

    async def cleanup(self) -> None:
        """Clean up agent resources and MCP server connections"""
        try:
            logger.info("Cleaning up agent resources...")

            # Close OpenAI client if it exists
            if hasattr(self, "openai_client"):
                await self.openai_client.close()
                logger.info("OpenAI client closed")

            logger.info("Agent cleanup completed")

        except Exception as e:
            logger.error(f"Error during cleanup: {e}")

    # </Cleanup>


# =============================================================================
# MAIN ENTRY POINT
# =============================================================================
# <MainEntryPoint>


async def main():
    """Main function to run the OpenAI Agent with MCP servers"""
    try:
        # Create and initialize the agent
        agent = OpenAIAgentWithMCP()
        await agent.initialize()

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
