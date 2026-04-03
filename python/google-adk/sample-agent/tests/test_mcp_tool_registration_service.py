# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Unit tests for Google ADK MCP Tool Registration Service.

Covers V2 MCP changes:
- authorization_context passed to list_tool_servers
- Per-server header merging: {**base_headers, **server_config.headers}
- Server URL resolved from server_config.url (V2) over mcp_server_unique_name (V1)
"""

import os
import sys
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Patch McpToolset and StreamableHTTPConnectionParams before importing the module
import sys
from unittest.mock import MagicMock

McpToolsetMock = MagicMock
StreamableHTTPConnectionParamsMock = MagicMock

import mcp_tool_registration_service as svc_module
svc_module.McpToolset = McpToolsetMock
svc_module.StreamableHTTPConnectionParams = StreamableHTTPConnectionParamsMock

from mcp_tool_registration_service import McpToolRegistrationService


class TestAddToolServersToAgent:
    def setup_method(self):
        self.service = McpToolRegistrationService()

    def _make_agent(self, tools=None):
        agent = MagicMock()
        agent.name = "test-agent"
        agent.model = "gemini-pro"
        agent.description = "Test agent"
        agent.tools = tools or []
        return agent

    def _make_server_config(self, name="mcp_Test", url=None, headers=None):
        cfg = MagicMock()
        cfg.mcp_server_unique_name = name
        cfg.url = url
        cfg.headers = headers or {}
        return cfg

    @pytest.mark.asyncio
    async def test_passes_authorization_context_to_sdk(self):
        mock_auth = MagicMock()
        mock_context = MagicMock()
        token_result = MagicMock()
        token_result.token = "exchange-token"
        mock_auth.exchange_token = AsyncMock(return_value=token_result)
        captured = {}

        async def mock_list(**kwargs):
            captured.update(kwargs)
            return []

        with patch.object(self.service.config_service, "list_tool_servers", side_effect=mock_list):
            await self.service.add_tool_servers_to_agent(
                agent=self._make_agent(),
                agentic_app_id="test-app",
                auth=mock_auth,
                auth_handler_name="AGENTIC",
                context=mock_context,
            )

        assert "authorization_context" in captured
        ctx = captured["authorization_context"]
        assert ctx["auth"] is mock_auth
        assert ctx["auth_handler_name"] == "AGENTIC"
        assert ctx["context"] is mock_context

    @pytest.mark.asyncio
    async def test_per_server_headers_override_base_headers(self):
        mock_auth = MagicMock()
        mock_context = MagicMock()
        token_result = MagicMock()
        token_result.token = "base-token"
        mock_auth.exchange_token = AsyncMock(return_value=token_result)

        cfg = self._make_server_config(
            url="https://example.com/servers/mcp_Test",
            headers={"Authorization": "Bearer per-audience-token", "X-Custom": "val"},
        )

        async def mock_list(**kwargs):
            return [cfg]

        captured_params = []

        def mock_toolset(connection_params):
            captured_params.append(connection_params)
            return MagicMock()

        with patch.object(self.service.config_service, "list_tool_servers", side_effect=mock_list):
            with patch.object(svc_module, "McpToolset", side_effect=lambda connection_params: MagicMock()):
                # Capture StreamableHTTPConnectionParams calls
                param_calls = []

                def mock_params(url, headers):
                    param_calls.append({"url": url, "headers": headers})
                    return MagicMock()

                with patch.object(svc_module, "StreamableHTTPConnectionParams", side_effect=mock_params):
                    await self.service.add_tool_servers_to_agent(
                        agent=self._make_agent(),
                        agentic_app_id="test-app",
                        auth=mock_auth,
                        auth_handler_name="AGENTIC",
                        context=mock_context,
                    )

        assert len(param_calls) == 1
        headers = param_calls[0]["headers"]
        # Per-audience token overrides base token
        assert headers["Authorization"] == "Bearer per-audience-token"
        assert headers["X-Custom"] == "val"

    @pytest.mark.asyncio
    async def test_base_token_used_when_no_server_headers(self):
        mock_auth = MagicMock()
        mock_context = MagicMock()
        token_result = MagicMock()
        token_result.token = "base-token"
        mock_auth.exchange_token = AsyncMock(return_value=token_result)

        cfg = self._make_server_config(url="https://example.com/servers/mcp_Test", headers={})

        async def mock_list(**kwargs):
            return [cfg]

        param_calls = []

        def mock_params(url, headers):
            param_calls.append({"url": url, "headers": headers})
            return MagicMock()

        with patch.object(self.service.config_service, "list_tool_servers", side_effect=mock_list):
            with patch.object(svc_module, "McpToolset", side_effect=lambda connection_params: MagicMock()):
                with patch.object(svc_module, "StreamableHTTPConnectionParams", side_effect=mock_params):
                    await self.service.add_tool_servers_to_agent(
                        agent=self._make_agent(),
                        agentic_app_id="test-app",
                        auth=mock_auth,
                        auth_handler_name="AGENTIC",
                        context=mock_context,
                    )

        assert "Bearer base-token" in param_calls[0]["headers"]["Authorization"]

    @pytest.mark.asyncio
    async def test_uses_server_config_url_over_unique_name(self):
        """V2: server_config.url takes priority over mcp_server_unique_name."""
        mock_auth = MagicMock()
        mock_context = MagicMock()
        token_result = MagicMock()
        token_result.token = "tok"
        mock_auth.exchange_token = AsyncMock(return_value=token_result)

        cfg = self._make_server_config(
            name="mcp_Test",
            url="https://full-v2-url.example.com/servers/mcp_Test",
        )

        async def mock_list(**kwargs):
            return [cfg]

        param_calls = []

        def mock_params(url, headers):
            param_calls.append({"url": url})
            return MagicMock()

        with patch.object(self.service.config_service, "list_tool_servers", side_effect=mock_list):
            with patch.object(svc_module, "McpToolset", side_effect=lambda connection_params: MagicMock()):
                with patch.object(svc_module, "StreamableHTTPConnectionParams", side_effect=mock_params):
                    await self.service.add_tool_servers_to_agent(
                        agent=self._make_agent(),
                        agentic_app_id="test-app",
                        auth=mock_auth,
                        auth_handler_name="AGENTIC",
                        context=mock_context,
                    )

        assert param_calls[0]["url"] == "https://full-v2-url.example.com/servers/mcp_Test"

    @pytest.mark.asyncio
    async def test_skips_token_exchange_when_auth_token_provided(self):
        mock_auth = MagicMock()
        mock_context = MagicMock()
        mock_auth.exchange_token = AsyncMock()

        async def mock_list(**kwargs):
            return []

        with patch.object(self.service.config_service, "list_tool_servers", side_effect=mock_list):
            await self.service.add_tool_servers_to_agent(
                agent=self._make_agent(),
                agentic_app_id="test-app",
                auth=mock_auth,
                auth_handler_name="AGENTIC",
                context=mock_context,
                auth_token="pre-provided",
            )

        mock_auth.exchange_token.assert_not_called()

    @pytest.mark.asyncio
    async def test_returns_agent_with_mcp_tools_appended(self):
        mock_auth = MagicMock()
        mock_context = MagicMock()
        token_result = MagicMock()
        token_result.token = "tok"
        mock_auth.exchange_token = AsyncMock(return_value=token_result)

        cfgs = [
            self._make_server_config(name="mcp_A", url="https://example.com/A"),
            self._make_server_config(name="mcp_B", url="https://example.com/B"),
        ]

        async def mock_list(**kwargs):
            return cfgs

        fake_tool = MagicMock()
        existing_tool = MagicMock()
        agent = self._make_agent(tools=[existing_tool])

        agent_ctor_calls = []

        def mock_agent_ctor(**kwargs):
            agent_ctor_calls.append(kwargs)
            return MagicMock()

        with patch.object(self.service.config_service, "list_tool_servers", side_effect=mock_list):
            with patch.object(svc_module, "McpToolset", return_value=fake_tool):
                with patch.object(svc_module, "StreamableHTTPConnectionParams", return_value=MagicMock()):
                    with patch.object(svc_module, "Agent", side_effect=mock_agent_ctor):
                        await self.service.add_tool_servers_to_agent(
                            agent=agent,
                            agentic_app_id="test-app",
                            auth=mock_auth,
                            auth_handler_name="AGENTIC",
                            context=mock_context,
                        )

        # Agent constructor called with original tool + 2 MCP toolsets
        assert len(agent_ctor_calls) == 1
        tools_passed = agent_ctor_calls[0]["tools"]
        assert len(tools_passed) == 3  # 1 existing + 2 MCP
