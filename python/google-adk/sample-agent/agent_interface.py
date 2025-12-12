# Copyright (c) Microsoft. All rights reserved.

"""
Agent Base Class
Defines the abstract base class that agents must inherit from to work with the generic host.
"""

from abc import ABC, abstractmethod
from microsoft_agents.hosting.core import Authorization, TurnContext


class AgentInterface(ABC):
    """
    Abstract base class that any hosted agent must inherit from.

    This ensures agents implement the required methods at class definition time,
    providing stronger guarantees than a Protocol.
    """
    @abstractmethod
    async def invoke_agent(
        self, message: str, auth: Authorization, auth_handler_name: str, context: TurnContext
    ) -> str:
        """Process a user message and return a response."""
        pass

    @abstractmethod
    async def invoke_agent_with_scope(
        self, message: str, auth: Authorization, auth_handler_name: str, context: TurnContext
    ) -> str:
        """Process a user message within an observability scope and return a response."""
        pass