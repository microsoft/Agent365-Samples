# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Bedrock Agent Factory

This module handles the creation and validation of AWS Bedrock agents and aliases.
Separated from agent.py to keep the main agent class focused on Agent 365 SDK integration.
"""

import logging
import os
import uuid
from typing import Optional

logger = logging.getLogger(__name__)


class BedrockAgentFactory:
    """Factory for creating and validating Bedrock agents and aliases."""

    def __init__(self, bedrock_agent_client, model_id: str, system_prompt: str):
        """
        Initialize the factory.

        Args:
            bedrock_agent_client: boto3 bedrock-agent client
            model_id: The Bedrock model ID to use
            system_prompt: The system prompt for the agent
        """
        self.bedrock_agent_client = bedrock_agent_client
        self.model_id = model_id
        self.system_prompt = system_prompt

    async def get_agent(self, agent_id: str) -> str:
        """
        Validate agent exists, optionally create if not found.

        Args:
            agent_id: The agent ID to validate

        Returns:
            str: Valid agent ID

        Raises:
            ValueError: If agent not found and auto_create is False
        """
        try:
            _ = self.bedrock_agent_client.get_agent(agentId=agent_id)
            return agent_id
        except self.bedrock_agent_client.exceptions.ResourceNotFoundException:
            raise ValueError(
                f"Agent {agent_id} not found in AWS Bedrock.\n"
                "Please create agent in AWS Console"
            )
        except Exception as e:
            raise ValueError(f"Error validating agent {agent_id}: {e}")

    async def get_agent_alias(self, agent_id: str, alias_id: str) -> str:
        """
        Validate alias exists, optionally create if not found.

        Args:
            agent_id: The agent ID the alias belongs to
            alias_id: The alias ID to validate

        Returns:
            str: Valid alias ID

        Raises:
            ValueError: If alias not found and auto_create is False
        """
        try:
            self.bedrock_agent_client.get_agent_alias(
                agentId=agent_id,
                agentAliasId=alias_id
            )
            logger.info(f"Found existing alias: {alias_id}")
            return alias_id
        except self.bedrock_agent_client.exceptions.ResourceNotFoundException:
            raise ValueError(
                f"Alias {alias_id} not found for agent {agent_id}.\n"
                "Please create alias in AWS Console"
            )
        except Exception as e:
            raise ValueError(f"Error validating alias {alias_id}: {e}")