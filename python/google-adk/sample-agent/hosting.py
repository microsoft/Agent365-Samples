# --- Imports ---
import os

# Import our agent interface
from agent_interface import AgentInterface

# Agents SDK Activity and config imports
from microsoft_agents.activity import load_configuration_from_env, Activity
from microsoft_agents.activity.activity_types import ActivityTypes

# Agents SDK Hosting and Authorization imports
from microsoft_agents.authentication.msal import MsalConnectionManager
from microsoft_agents.hosting.aiohttp import (
    CloudAdapter,
)
from microsoft_agents.hosting.core import (
    AgentApplication,
    Authorization,
    ApplicationOptions,
    MemoryStorage,
    TurnContext,
    TurnState,
)

# # Agents SDK Notifications imports
# from microsoft_agents_a365.notifications.agent_notification import (
#     AgentNotification,
#     AgentNotificationActivity,
#     ChannelId,
# )
# from microsoft_agents_a365.notifications import (
#     EmailResponse,
# )

class MyAgent(AgentApplication):
    """Sample Agent Application using Agent 365 SDK."""

    def __init__(self, agent: AgentInterface):
        """
        Initialize the generic host with an agent class and its initialization parameters.

        Args:
            agent: The agent (must implement AgentInterface)
            *agent_args: Positional arguments to pass to the agent constructor
            **agent_kwargs: Keyword arguments to pass to the agent constructor
        """
        agents_sdk_config = load_configuration_from_env(os.environ)

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
                **agents_sdk_config
            ),
            **agents_sdk_config,
        )

        self.agent = agent
        self.auth_handlers = ["AGENTIC"]

        self._setup_handlers()

    def _setup_handlers(self):
        """Set up activity handlers for the agent."""

        @self.conversation_update("membersAdded")
        async def help_handler(context: TurnContext, _: TurnState):
            """Handle help activities."""
            help_message = (
                "Welcome to the Agent 365 SDK Sample Agent!\n\n"
                "You can ask me to perform various tasks or provide information."
            )
            await context.send_activity(Activity(type=ActivityTypes.message, text=help_message))

        @self.activity("message", auth_handlers=self.auth_handlers, rank=2)
        async def message_handler(context: TurnContext, _: TurnState):
            """Handle message activities."""
            user_message = context.activity.text
            if not user_message.strip():
                await context.send_activity("Please send me a message and I'll help you!")
                return

            response = await self.agent.invoke_agent(
                message=user_message,
                auth=self.auth,
                auth_handler_name="AGENTIC",
                context=context
            )

            await context.send_activity(Activity(type=ActivityTypes.message, text=response))