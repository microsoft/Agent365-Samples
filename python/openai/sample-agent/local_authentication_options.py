# Copyright (c) Microsoft. All rights reserved.

"""
Local Authentication Options for the Concierge Agent.

This module provides configuration options for authentication when running
the concierge agent locally or in development scenarios.
"""

import os
from dataclasses import dataclass

from dotenv import load_dotenv


@dataclass
class LocalAuthenticationOptions:
    """
    Configuration options for local authentication.

    This class mirrors the .NET LocalAuthenticationOptions and provides
    the necessary authentication details for MCP tool server access.
    """

    bearer_token: str = ""

    def __post_init__(self):
        """Validate the authentication options after initialization."""
        if not isinstance(self.bearer_token, str):
            self.bearer_token = str(self.bearer_token) if self.bearer_token else ""

    @property
    def is_valid(self) -> bool:
        """Check if the authentication options are valid."""
        return bool(self.bearer_token)

    def validate(self) -> None:
        """
        Validate that required authentication parameters are provided.

        Raises:
            ValueError: If required authentication parameters are missing.
        """
        if not self.bearer_token:
            raise ValueError("bearer_token is required for authentication")

    @classmethod
    def from_environment(
        cls, token_var: str = "BEARER_TOKEN"
    ) -> "LocalAuthenticationOptions":
        """
        Create authentication options from environment variables.

        Args:
            token_var: Environment variable name for the bearer token.

        Returns:
            LocalAuthenticationOptions instance with values from environment.
        """
        # Load .env file (automatically searches current and parent directories)
        load_dotenv(override=True)  # Force reload to pick up changes

        bearer_token = os.getenv(token_var, "")

        print(f"🔧 Bearer Token: {'***' if bearer_token else 'NOT SET'}")
        
        # DEBUG: Print token details
        if bearer_token:
            print(f"🔍 DEBUG: Token loaded from env, length: {len(bearer_token)}")
            print(f"🔍 DEBUG: Token first 50 chars: {bearer_token[:50]}...")
        else:
            print(f"⚠️ DEBUG: No BEARER_TOKEN found in environment!")

        return cls(bearer_token=bearer_token)

    def to_dict(self) -> dict:
        """Convert to dictionary for serialization."""
        return {"bearer_token": self.bearer_token}
