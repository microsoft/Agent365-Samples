# Copyright (c) Microsoft. All rights reserved.

import asyncio
import os
from typing import Optional
from google.adk.agents import Agent
from dotenv import load_dotenv

from mcp_tool_registration_service import McpToolRegistrationService

from microsoft_agents_a365.observability.core.config import configure
from microsoft_agents_a365.observability.core.middleware.baggage_builder import (
    BaggageBuilder,
)

from google.adk.runners import Runner
from google.adk.sessions.in_memory_session_service import InMemorySessionService

from microsoft_agents.hosting.core import Authorization, TurnContext

class GoogleADKAgent:
    """Wrapper class for Google ADK Agent with Microsoft Agent 365 integration."""

    def __init__(
        self,
        agent_name: str = "my_agent",
        model: str = "gemini-2.0-flash",
        description: str = "Agent to test Mcp tools.",
        instruction: str = "You are a helpful agent who can use tools. If you encounter any errors, please provide the exact error message you encounter.",
    ):
        """
        Initialize the Google ADK Agent Wrapper.

        Args:
            agent_name: Name of the agent
            model: Google ADK model to use
            description: Agent description
            instruction: Agent instruction/prompt
        """
        self.agent_name = agent_name
        self.model = model
        self.description = description
        self.instruction = instruction
        self.agent: Optional[Agent] = None

        self.agent = Agent(
            name=self.agent_name,
            model=self.model,
            description=self.description,
            instruction=self.instruction,
        )

    async def invoke_agent(
        self,
        message: str,
        auth: Authorization,
        auth_handler_name: str,
        context: TurnContext
    ) -> str:
        """
        Invoke the agent with a user message.

        Args:
            message: The message from the user

        Returns:
            List of response messages from the agent
        """
        agent = await self._initialize_agent(auth, auth_handler_name, context)

        # Create the runner
        runner = Runner(
            app_name="agents",
            agent=agent,
            session_service=InMemorySessionService(),
        )

        responses = []
        result = await runner.run_debug(
            user_messages=[message]
        )

        # Extract text responses from the result
        if not hasattr(result, '__iter__'):
            return responses

        for event in result:
            if not (hasattr(event, 'content') and event.content):
                continue

            if not hasattr(event.content, 'parts'):
                continue

            for part in event.content.parts:
                if hasattr(part, 'text') and part.text:
                    responses.append(part.text)

        await self._cleanup_agent(agent)

        return responses[-1] if responses else "I couldn't get a response from the agent. :("

    async def invoke_agent_with_scope(
            self,
            message: str,
            auth: Authorization,
            auth_handler_name: str,
            context: TurnContext
    ) -> str:
        """
        Invoke the agent with a user message within an observability scope.

        Args:
            message: The message from the user

        Returns:
            List of response messages from the agent
        """
        tenant_id = context.activity.recipient.tenant_id
        agent_id = context.activity.recipient.agentic_user_id
        with BaggageBuilder().tenant_id(tenant_id).agent_id(agent_id).build():
            return await self.invoke_agent(message=message, auth=auth, auth_handler_name=auth_handler_name, context=context)

    async def _cleanup_agent(self, agent: Agent):
        """Clean up agent resources."""
        if agent and hasattr(agent, 'tools'):
            for tool in agent.tools:
                if hasattr(tool, "close"):
                    await tool.close()

    async def _initialize_agent(self, auth, auth_handler_name, turn_context):
        """Initialize the agent with MCP tools and authentication."""
        try:
            # Perform sign-in
            if not (await auth._start_or_continue_sign_in(turn_context, None, auth_handler_name)).sign_in_complete():
                raise RuntimeError("Sign-in required but not completed")

            # Add MCP tools to the agent
            tool_service = McpToolRegistrationService()
            return await tool_service.add_tool_servers_to_agent(
                agent=self.agent,
                agentic_app_id=os.getenv("AGENTIC_APP_ID", "agent123"),
                auth=auth,
                context=turn_context,
                auth_token=os.getenv("BEARER_TOKEN", ""),
            )
        except Exception as e:
            print(f"Error during agent initialization: {e}")