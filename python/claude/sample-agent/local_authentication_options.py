# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Local Authentication Options
Loads authentication configuration from environment variables.
"""

import os
from dataclasses import dataclass


@dataclass
class LocalAuthenticationOptions:
    """
    Authentication options loaded from environment variables.
    
    Attributes:
        bearer_token: Bearer token for API authentication
        env_id: Environment ID (dev, test, prod)
    """

    bearer_token: str | None
    env_id: str

    @classmethod
    def from_environment(cls) -> "LocalAuthenticationOptions":
        """
        Load authentication options from environment variables.

        Returns:
            LocalAuthenticationOptions instance with values from environment
        """
        bearer_token = os.getenv("BEARER_TOKEN")
        env_id = os.getenv("ENVIRONMENT_ID", "prod")

        return cls(bearer_token=bearer_token, env_id=env_id)
