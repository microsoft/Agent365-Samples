# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.
#
# Agent Base Class for hosted agents.
from abc import ABC, abstractmethod
from microsoft_agents.hosting.core import Authorization, TurnContext


class AgentInterface(ABC):
    """Abstract base class that any hosted agent must implement."""

    @abstractmethod
    async def initialize(self) -> None:
        """Initialize the agent and any required resources."""
        raise NotImplementedError

    @abstractmethod
    async def process_user_message(
        self, message: str, auth: Authorization, auth_handler_name: str, context: TurnContext
    ) -> str:
        """Process a user message and return a response."""
        raise NotImplementedError

    @abstractmethod
    async def cleanup(self) -> None:
        """Clean up any resources used by the agent."""
        raise NotImplementedError


def check_agent_inheritance(agent_class) -> bool:
    """Check that an agent class inherits from AgentInterface."""
    if not issubclass(agent_class, AgentInterface):
        print(f"ERROR Agent {agent_class.__name__} does not inherit from AgentInterface")
        return False
    print(f"OK. Agent {agent_class.__name__} properly inherits from AgentInterface")
    return True
