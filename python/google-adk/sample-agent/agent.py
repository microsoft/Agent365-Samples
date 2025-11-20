# Copyright (c) Microsoft. All rights reserved.

import asyncio
import os
from google.adk.agents import Agent
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

from mcp_tool_registration_service import McpToolRegistrationService

from microsoft_agents_a365.observability.core.config import configure
from microsoft_agents_a365.observability.core.middleware.baggage_builder import (
    BaggageBuilder,
)

from google.adk.runners import Runner
from google.adk.sessions.in_memory_session_service import InMemorySessionService

from microsoft_agents.activity import load_configuration_from_env, Activity, ChannelAccount, ActivityTypes
from microsoft_agents.hosting.core import Authorization, MemoryStorage, TurnContext, ClaimsIdentity, AuthenticationConstants
from microsoft_agents.hosting.aiohttp import CloudAdapter
from microsoft_agents.authentication.msal import MsalConnectionManager

agents_sdk_config = load_configuration_from_env(os.environ)

async def main():
    # Google ADK expects root_agent to be defined at module level
    # Create the base agent synchronously
    my_agent = Agent(
        name="my_agent",
        model="gemini-2.0-flash",
        description=(
            "Agent to test Mcp tools."
        ),
        instruction=(
            "You are a helpful agent who can use tools. If you encounter any errors, please provide the exact error message you encounter."
        ),
    )

    auth = Authorization(
        storage=MemoryStorage(),
        connection_manager=MsalConnectionManager(**agents_sdk_config),
        **agents_sdk_config
    )

    turnContext = TurnContext(
        adapter_or_context=CloudAdapter(),
        request=Activity(
            type=ActivityTypes.message,
            text="",
            from_property=ChannelAccount(
                id='user1',
                name='User One'
            ),
            recipient=ChannelAccount(
                id=os.getenv("AGENTIC_UPN", ""),
                name=os.getenv("AGENTIC_NAME", ""),
                agentic_user_id=os.getenv("AGENTIC_USER_ID", ""),
                agentic_app_id=os.getenv("AGENTIC_APP_ID", ""),
                tenant_id=os.getenv("AGENTIC_TENANT_ID", ""),
                role="agenticUser"
            )
        ),
        identity=ClaimsIdentity(
            {
                AuthenticationConstants.AUDIENCE_CLAIM: "anonymous",
                AuthenticationConstants.APP_ID_CLAIM: "anonymous-app",
            },
            False,
            "Anonymous",
        )
    )

    if not (await auth._start_or_continue_sign_in(turnContext, None, 'AGENTIC')).sign_in_complete():
        print("Sign-in required. Exiting.")
        return

    tool_service = McpToolRegistrationService()

    my_agent = await tool_service.add_tool_servers_to_agent(
            agent=my_agent,
            agentic_app_id=os.getenv("AGENTIC_APP_ID", "agent123"),
            auth=auth,
            context=turnContext,
            auth_token=os.getenv("BEARER_TOKEN", ""),
    )

    # Create runner
    runner = Runner(
        app_name="agents",
        agent=my_agent,
        session_service=InMemorySessionService(),
    )

    # Run agent
    try:
        user_message = input("Enter your message to the agent: ")
        with BaggageBuilder().tenant_id("your-tenant-id").agent_id("agent123").build():
            _ = await runner.run_debug(
                    user_messages=[user_message]
                )
    finally:
        agent_tools = my_agent.tools
        for tool in agent_tools:
            if hasattr(tool, "close"):
                await tool.close()

if __name__ == "__main__":
    configure(
        service_name="GoogleADKSampleAgent",
        service_namespace="GoogleADKTesting",
    )

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nShutting down gracefully...")
    except Exception as e:
        # Ignore cleanup errors during shutdown
        if "cancel scope" not in str(e) and "RuntimeError" not in type(e).__name__:
            raise