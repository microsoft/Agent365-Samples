# Copyright (c) Microsoft. All rights reserved.

"""
Local Authentication Options for the AgentFramework Agent.

This module provides configuration options for authentication when running
the AgentFramework agent locally or in development scenarios.
"""

import os
from dataclasses import dataclass

from dotenv import load_dotenv


@dataclass
class LocalAuthenticationOptions:
    """
    Configuration options for local authentication.

    This class providesthe necessary authentication details
    for MCP tool server access.
    """

    env_id: str = ""
    bearer_token: str = ""

    def __post_init__(self):
        """Validate the authentication options after initialization."""
        if not isinstance(self.env_id, str):
            self.env_id = str(self.env_id) if self.env_id else ""
        if not isinstance(self.bearer_token, str):
            self.bearer_token = str(self.bearer_token) if self.bearer_token else ""

    @property
    def is_valid(self) -> bool:
        """Check if the authentication options are valid."""
        return bool(self.env_id and self.bearer_token)

    def validate(self) -> None:
        """
        Validate that required authentication parameters are provided.

        Raises:
            ValueError: If required authentication parameters are missing.
        """
        if not self.env_id:
            raise ValueError("env_id is required for authentication")
        if not self.bearer_token:
            raise ValueError("bearer_token is required for authentication")

    @classmethod
    def from_environment(
        cls, env_id_var: str = "ENV_ID", token_var: str = "BEARER_TOKEN"
    ) -> "LocalAuthenticationOptions":
        """
        Create authentication options from environment variables.

        Args:
            env_id_var: Environment variable name for the environment ID.
            token_var: Environment variable name for the bearer token.

        Returns:
            LocalAuthenticationOptions instance with values from environment.
        """
        # Load .env file (automatically searches current and parent directories)
        load_dotenv()

        env_id = os.getenv(env_id_var, "")
        bearer_token = os.getenv(token_var, "")

        print(f"🔧 Environment ID: {env_id[:20]}{'...' if len(env_id) > 20 else ''}")
        print(f"🔧 Bearer Token: {'***' if bearer_token else 'NOT SET'}")

        return cls(env_id=env_id, bearer_token=bearer_token)

    def to_dict(self) -> dict:
        """Convert to dictionary for serialization."""
        return {"env_id": self.env_id, "bearer_token": self.bearer_token}
