# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Pytest configuration: mock Microsoft SDK imports that may not be installed
in the test environment so unit tests can import the service modules directly.
"""

import sys
from unittest.mock import MagicMock


def _mock_sdk():
    mocks = {
        "microsoft_agents": MagicMock(),
        "microsoft_agents.hosting": MagicMock(),
        "microsoft_agents.hosting.core": MagicMock(),
        "microsoft_agents_a365": MagicMock(),
        "microsoft_agents_a365.tooling": MagicMock(),
        "microsoft_agents_a365.tooling.utils": MagicMock(),
        "microsoft_agents_a365.tooling.utils.constants": MagicMock(),
        "microsoft_agents_a365.tooling.utils.utility": MagicMock(),
        "microsoft_agents_a365.tooling.services": MagicMock(),
        "microsoft_agents_a365.tooling.services.mcp_tool_server_configuration_service": MagicMock(),
    }

    headers_mock = MagicMock()
    headers_mock.AUTHORIZATION = "Authorization"
    headers_mock.BEARER_PREFIX = "Bearer"
    mocks["microsoft_agents_a365.tooling.utils.constants"].Constants.Headers = headers_mock

    mocks["microsoft_agents_a365.tooling.utils.utility"].get_mcp_platform_authentication_scope = (
        lambda: ["https://api.powerplatform.com/.default"]
    )

    for name, mock in mocks.items():
        if name not in sys.modules:
            sys.modules[name] = mock


_mock_sdk()
