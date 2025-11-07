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

# AgentFramework SDK
from agent_framework import ChatAgent
from agent_framework.azure import AzureOpenAIChatClient
from agent_framework.observability import setup_observability

# Agent Interface
from agent_interface import AgentInterface
from azure.identity import AzureCliCredential

# Microsoft Agents SDK
from microsoft_agents.hosting.core import Authorization, TurnContext

# Observability Components
from microsoft_agents_a365.observability.extensions.agentframework.trace_instrumentor import (
    AgentFrameworkInstrumentor,
)

# MCP Tooling
from microsoft_agents_a365.tooling.extensions.agentframework.services.mcp_tool_registration_service import (
    McpToolRegistrationService,
)
from token_cache import get_cached_agentic_token

# </DependencyImports>

class LocalAuthenticationOptions():
    bearer_token: str

class AgentFrameworkAgent(AgentInterface):
    """AgentFramework Agent integrated with MCP servers and Observability"""

    # =========================================================================
    # INITIALIZATION
    # =========================================================================
    # <Initialization>

    def __init__(self):
        """Initialize the AgentFramework agent."""
        self.logger = logging.getLogger(self.__class__.__name__)

        # Initialize auto instrumentation with Agent365 observability SDK
        self._initialize_observability()

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

        logger.info(f"Creating AzureOpenAIChatClient with endpoint: {endpoint}")
        logger.info(f"Deployment: {deployment}")
        logger.info(f"API Version: {api_version}")

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
                instructions="You are a helpful assistant with access to tools.",
                tools=[],  # Tools will be added dynamically by MCP setup
            )

        except Exception as e:
            logger.error(f"Failed to create agent: {e}")
            raise

    # </ClientCreation>

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
            # Use cached agentic token from agent authentication
            cached_token = get_cached_agentic_token(tenant_id, agent_id)
            if cached_token:
                return cached_token
            else:
                logger.warning(
                    f"No cached agentic token found for agent_id: {agent_id}, tenant_id: {tenant_id}"
                )
                return None

        except Exception as e:
            logger.error(
                f"Error resolving token for agent {agent_id}, tenant {tenant_id}: {e}"
            )
            return None

    def _initialize_observability(self):
        """Enable AgentFramework instrumentation for automatic tracing"""
        try:
            # Start up Observability
            setup_observability()

            # Initialize Agent 365 Observability Wrapper for AgentFramework SDK
            AgentFrameworkInstrumentor().instrument()
        except Exception as e:
            logger.warning(f"Could not enable AgentFramework instrumentation: {e}")

    # </ObservabilityConfiguration>

    # =========================================================================
    # MCP SERVER SETUP
    # =========================================================================
    # <McpServerSetup>

    async def _create_agent_with_mcp(self, auth: Authorization, context: TurnContext):
        """Set up MCP server connections"""
        try:
            if not self.tool_service:
                logger.warning(
                    "MCP tool service not available -  skipping MCP server setup"
                )
                return

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
                    agent_instructions="You are a helpful assistant with access to tools.",
                    initial_tools=[],
                    agentic_app_id=agent_user_id,
                    environment_id="",
                    auth=auth,
                    turn_context=context,
                    auth_token=auth_token,
                )
            else:
                self.agent = await self.tool_service.add_tool_servers_to_agent(
                    chat_client=self.chat_client,
                    agent_instructions="You are a helpful assistant with access to tools.",
                    initial_tools=[],
                    agentic_app_id=agent_user_id,
                    environment_id="",
                    auth=auth,
                    auth_token=self.auth_options.bearer_token,
                    turn_context=context,
                )
        except Exception as e:
            logger.error(f"Error setting up MCP servers: {e}")
            logger.exception("Full error details:")

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

            # Extract the response from the result
            if result:
                if hasattr(result, "contents"):
                    return str(result.contents)
                elif hasattr(result, "text"):
                    return str(result.text)
                elif hasattr(result, "content"):
                    return str(result.content)
                else:
                    return str(result)
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
            # Cleanup MCP tool service if it exists
            if hasattr(self, "tool_service") and self.tool_service:
                try:
                    await self.tool_service.cleanup()
                except Exception as cleanup_ex:
                    logger.warning(f"Error cleaning up MCP tool service: {cleanup_ex}")
        except Exception as e:
            logger.error(f"Error during cleanup: {e}")

    # </Cleanup>


# =============================================================================
# MAIN ENTRY POINT
# =============================================================================
# <MainEntryPoint>


async def main():
    """Main function to run the AgentFramework Agent with MCP servers"""
    try:
        # Create and initialize the agent
        agent = AgentFrameworkAgent()
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
