import asyncio
import os
from google.adk.agents import Agent
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

from mcp_tool_registration_service import McpToolRegistrationService

from google.adk.runners import Runner
from google.adk.sessions.in_memory_session_service import InMemorySessionService


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

    toolService = McpToolRegistrationService()

    my_agent = await toolService.add_tool_servers_to_agent(
            agent=my_agent,
            agentic_app_id=os.getenv("AGENTIC_APP_ID", "agent123"),
            auth=None,
            context=None,
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
        _ = await runner.run_debug(
                user_messages=["Send alias@example.com an email with a dad joke."]
            )
    finally:
        agentTools = my_agent.tools
        for tool in agentTools:
            if hasattr(tool, "close"):
                await tool.close()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nShutting down gracefully...")
    except Exception as e:
        # Ignore cleanup errors during shutdown
        if "cancel scope" not in str(e) and "RuntimeError" not in type(e).__name__:
            raise