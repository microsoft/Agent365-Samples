# Copyright (c) Microsoft. All rights reserved.

"""
Generic Agent Host Server
A generic hosting server that can host any agent class that implements the required interface.
"""

import logging
import os
from os import environ

# Import our agent base class
from agent_interface import AgentInterface, check_agent_inheritance
from dotenv import load_dotenv
from microsoft_agents.activity import load_configuration_from_env
from microsoft_agents.authentication.msal import MsalConnectionManager
from microsoft_agents.hosting.aiohttp import (
    CloudAdapter,
)

# Microsoft Agents SDK imports
from microsoft_agents.hosting.core import (
    AgentApplication,
    Authorization,
    ApplicationOptions,
    MemoryStorage,
    TurnContext,
    TurnState,
)
from microsoft_agents_a365.observability.core.config import configure
from microsoft_agents_a365.observability.core.middleware.baggage_builder import (
    BaggageBuilder,
)
from microsoft_agents_a365.runtime.environment_utils import (
    get_observability_authentication_scope,
)
from token_cache import cache_agentic_token

# Configure logging
ms_agents_logger = logging.getLogger("microsoft_agents")
ms_agents_logger.addHandler(logging.StreamHandler())
ms_agents_logger.setLevel(logging.INFO)

logger = logging.getLogger(__name__)

# Load configuration
load_dotenv()
agents_sdk_config = load_configuration_from_env(environ)


class A365Agent(AgentApplication):
    """Generic host that can host any agent implementing the AgentInterface"""

    def __init__(self, agent: AgentInterface):
        """
        Initialize the generic host with an agent class and its initialization parameters.

        Args:
            agent_class: The agent class to instantiate (must implement AgentInterface)
            *agent_args: Positional arguments to pass to the agent constructor
            **agent_kwargs: Keyword arguments to pass to the agent constructor
        """
        connection_manager = MsalConnectionManager(**agents_sdk_config)
        storage = MemoryStorage()
        super().__init__(
            options = ApplicationOptions(
                storage= storage,
                adapter= CloudAdapter(
                    connection_manager= connection_manager
                ),
            ),
            connection_manager= connection_manager,
            authorization= Authorization(
                storage,
                connection_manager,
                **agents_sdk_config),
            **agents_sdk_config,
        )

        self.agent = agent

        self._setup_handlers()

    def _setup_handlers(self):
        """Setup the Microsoft Agents SDK message handlers"""

        async def help_handler(context: TurnContext, _: TurnState):
            """Handle help requests and member additions"""
            welcome_message = (
                "👋 **Welcome to Generic Agent Host!**\n\n"
                f"I'm powered by: **{self.agent_class.__name__}**\n\n"
                "Ask me anything and I'll do my best to help!\n"
                "Type '/help' for this message."
            )
            await context.send_activity(welcome_message)
            logger.info("📨 Sent help/welcome message")

        # Register handlers
        self.conversation_update("membersAdded")(help_handler)
        self.message("/help")(help_handler)

        use_agentic_auth = os.getenv("USE_AGENTIC_AUTH", "false").lower() == "true"
        handler = ["AGENTIC"] if use_agentic_auth else None

        @self.activity("message", auth_handlers=handler)
        async def on_message(context: TurnContext, _: TurnState):
            """Handle all messages with the hosted agent"""
            try:
                tenant_id = context.activity.recipient.tenant_id
                agent_id = context.activity.recipient.agentic_app_id
                with BaggageBuilder().tenant_id(tenant_id).agent_id(agent_id).build():
                    exaau_token = await self.auth.exchange_token(
                        context,
                        scopes=get_observability_authentication_scope(),
                        auth_handler_id="AGENTIC",
                    )

                    # Cache the agentic token for observability export
                    cache_agentic_token(tenant_id, agent_id, exaau_token.token)

                    user_message = context.activity.text or ""
                    logger.info(f"📨 Processing message: '{user_message}'")

                    # Skip empty messages
                    if not user_message.strip():
                        return

                    # Skip messages that are handled by other decorators (like /help)
                    if user_message.strip() == "/help":
                        return

                    # Process with the hosted agent
                    logger.info(f"🤖 Processing with {self.agent_class.__name__}...")
                    response = await self.agent.process_user_message(
                        user_message, self.auth, context
                    )

                    # Send response back
                    logger.info(
                        f"📤 Sending response: '{response[:100] if len(response) > 100 else response}'"
                    )
                    await context.send_activity(response)

            except Exception as e:
                error_msg = f"Sorry, I encountered an error: {str(e)}"
                logger.error(f"❌ Error processing message: {str(e)}")
                await context.send_activity(error_msg)

    async def cleanup(self):
        """Clean up resources"""
        if not self.agent:
            return

        try:
            await self.agent.cleanup()
        except Exception as e:
            logger.error(f"Error during agent cleanup: {e}")


def create_host(agent_class: type[AgentInterface], *agent_args, **agent_kwargs) -> A365Agent:
    """
    Convenience function to create and run a generic agent host.

    Args:
        agent_class: The agent class to host (must implement AgentInterface)
        *agent_args: Positional arguments to pass to the agent constructor
        **agent_kwargs: Keyword arguments to pass to the agent constructor
    """
    try:
        # Check that the agent inherits from AgentInterface
        if not check_agent_inheritance(agent_class):
            raise TypeError(
                f"Agent class {agent_class.__name__} must inherit from AgentInterface"
            )

        configure(
            service_name="AgentFrameworkTracingWithAzureOpenAI",
            service_namespace="AgentFrameworkTesting",
        )

        # Create the host
        return A365Agent(agent_class(*agent_args, **agent_kwargs))


    except Exception as error:
        logger.error(f"Failed to start generic agent host: {error}")
        raise error


if __name__ == "__main__":
    print(
        "Generic Agent Host - Use create_and_run_host() function to start with your agent class"
    )
    print("Example:")
    print("  from common.host_agent_server import create_and_run_host")
    print("  from my_agent import MyAgent")
    print("  create_and_run_host(MyAgent, api_key='your_key')")
