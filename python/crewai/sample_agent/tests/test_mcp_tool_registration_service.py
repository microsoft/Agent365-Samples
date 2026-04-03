# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Unit tests for CrewAI MCP Tool Registration Service.

Covers V2 MCP changes:
- authorization_context passed to list_tool_servers
- publisher and headers extracted from SDK configs and ToolingManifest.json
- Per-server header merging: {**base_headers, **server_headers}
"""

import json
import os
import sys
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from mcp_tool_registration_service import McpToolRegistrationService


# ---------------------------------------------------------------------------
# _build_full_url
# ---------------------------------------------------------------------------

class TestBuildFullUrl:
    def setup_method(self):
        self.service = McpToolRegistrationService()

    def test_full_url_unchanged(self):
        url = "https://agent365.svc.cloud.microsoft/agents/servers/mcp_Test"
        assert self.service._build_full_url(url) == url

    def test_bare_server_name_becomes_agents_servers_path(self):
        with patch.dict(os.environ, {"MCP_PLATFORM_ENDPOINT": "https://ep.com"}):
            assert self.service._build_full_url("mcp_Test") == "https://ep.com/agents/servers/mcp_Test"

    def test_empty_returns_empty(self):
        assert self.service._build_full_url("") == ""


# ---------------------------------------------------------------------------
# _load_manifest_servers_fallback
# ---------------------------------------------------------------------------

class TestLoadManifestServersFallback:
    def setup_method(self):
        self.service = McpToolRegistrationService()

    def test_loads_publisher_and_headers(self, tmp_path):
        manifest = {"mcpServers": [{
            "mcpServerName": "mcp_Test",
            "url": "https://example.com/mcp_Test",
            "scope": "McpServers.Test.All",
            "audience": "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1",
            "publisher": "Microsoft",
            "headers": {"X-Custom": "val"},
        }]}
        (tmp_path / "ToolingManifest.json").write_text(json.dumps(manifest))

        with patch("os.getcwd", return_value=str(tmp_path)):
            servers = self.service._load_manifest_servers_fallback()

        assert servers[0]["publisher"] == "Microsoft"
        assert servers[0]["headers"] == {"X-Custom": "val"}

    def test_skips_servers_without_url(self, tmp_path):
        manifest = {"mcpServers": [{"mcpServerName": "mcp_NoUrl"}]}
        (tmp_path / "ToolingManifest.json").write_text(json.dumps(manifest))
        with patch("os.getcwd", return_value=str(tmp_path)):
            assert self.service._load_manifest_servers_fallback() == []

    def test_returns_empty_when_no_manifest(self, tmp_path):
        with patch("os.getcwd", return_value=str(tmp_path)):
            assert self.service._load_manifest_servers_fallback() == []

    def test_defaults_missing_v2_fields(self, tmp_path):
        manifest = {"mcpServers": [{"mcpServerName": "mcp_Min", "url": "https://example.com/mcp_Min"}]}
        (tmp_path / "ToolingManifest.json").write_text(json.dumps(manifest))
        with patch("os.getcwd", return_value=str(tmp_path)):
            servers = self.service._load_manifest_servers_fallback()
        assert servers[0]["publisher"] == ""
        assert servers[0]["headers"] == {}


# ---------------------------------------------------------------------------
# _connect_to_server
# ---------------------------------------------------------------------------

class TestConnectToServer:
    def setup_method(self):
        self.service = McpToolRegistrationService()

    @pytest.mark.asyncio
    async def test_v2_server_headers_override_base_token(self):
        captured = {}

        async def mock_list(url, headers, name):
            captured["headers"] = dict(headers)
            return []

        with patch.object(self.service, "_list_server_tools", side_effect=mock_list):
            await self.service._connect_to_server(
                name="mcp_Test",
                url="https://example.com/server",
                auth_token="base-token",
                server_headers={"Authorization": "Bearer per-audience-token"},
            )

        assert captured["headers"]["Authorization"] == "Bearer per-audience-token"

    @pytest.mark.asyncio
    async def test_base_token_used_without_server_headers(self):
        captured = {}

        async def mock_list(url, headers, name):
            captured["headers"] = dict(headers)
            return []

        with patch.object(self.service, "_list_server_tools", side_effect=mock_list):
            await self.service._connect_to_server(
                name="mcp_Test",
                url="https://example.com/server",
                auth_token="base-token",
                server_headers={},
            )

        assert "Bearer base-token" in captured["headers"].get("Authorization", "")

    @pytest.mark.asyncio
    async def test_remote_skipped_with_no_auth(self):
        result = await self.service._connect_to_server(
            name="mcp_Test",
            url="https://example.com/server",
            auth_token=None,
            server_headers={},
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_local_server_no_auth_required(self):
        async def mock_list(url, headers, name):
            return []

        with patch.object(self.service, "_list_server_tools", side_effect=mock_list):
            result = await self.service._connect_to_server(
                name="local",
                url="http://127.0.0.1:8080/mcp",
                auth_token=None,
                server_headers={},
            )

        assert result is not None
        assert result.connected is True


# ---------------------------------------------------------------------------
# discover_and_connect_servers
# ---------------------------------------------------------------------------

class TestDiscoverAndConnectServers:
    def setup_method(self):
        self.service = McpToolRegistrationService()

    @pytest.mark.asyncio
    async def test_passes_authorization_context_to_sdk(self):
        mock_auth = MagicMock()
        mock_context = MagicMock()
        captured = {}

        async def mock_list(**kwargs):
            captured.update(kwargs)
            return []

        with patch.object(self.service._config_service, "list_tool_servers", side_effect=mock_list):
            await self.service.discover_and_connect_servers(
                agentic_app_id="test-app",
                auth=mock_auth,
                auth_handler_name="AGENTIC",
                context=mock_context,
                auth_token="tok",
            )

        ctx = captured.get("authorization_context", {})
        assert ctx.get("auth") is mock_auth
        assert ctx.get("auth_handler_name") == "AGENTIC"

    @pytest.mark.asyncio
    async def test_per_server_headers_passed_to_connect(self):
        mock_auth = MagicMock()
        mock_context = MagicMock()

        cfg = MagicMock()
        cfg.url = "https://example.com/servers/mcp_Test"
        cfg.mcp_server_name = "mcp_Test"
        cfg.mcp_server_unique_name = "mcp_Test"
        cfg.audience = "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1"
        cfg.scope = "McpServers.Test.All"
        cfg.publisher = "Microsoft"
        cfg.headers = {"Authorization": "Bearer audience-token"}

        async def mock_list(**kwargs):
            return [cfg]

        calls = []

        async def mock_connect(name, url, auth_token, server_headers=None):
            calls.append(server_headers)
            conn = MagicMock()
            conn.connected = True
            conn.tools = []
            conn.url = url
            return conn

        with patch.object(self.service._config_service, "list_tool_servers", side_effect=mock_list):
            with patch.object(self.service, "_connect_to_server", side_effect=mock_connect):
                await self.service.discover_and_connect_servers(
                    agentic_app_id="test-app",
                    auth=mock_auth,
                    auth_handler_name="AGENTIC",
                    context=mock_context,
                    auth_token="tok",
                )

        assert calls[0] == {"Authorization": "Bearer audience-token"}

    @pytest.mark.asyncio
    async def test_falls_back_to_manifest_when_sdk_fails(self, tmp_path):
        mock_auth = MagicMock()
        mock_context = MagicMock()

        manifest = {"mcpServers": [{
            "mcpServerName": "mcp_Fallback",
            "url": "http://localhost:9999/mcp",
            "scope": "McpServers.Test.All",
            "audience": "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1",
            "publisher": "Microsoft",
        }]}
        (tmp_path / "ToolingManifest.json").write_text(json.dumps(manifest))

        async def sdk_fails(**kwargs):
            raise RuntimeError("SDK unavailable")

        async def mock_connect(name, url, auth_token, server_headers=None):
            conn = MagicMock()
            conn.connected = True
            conn.tools = []
            conn.url = url
            conn.name = name
            conn.headers = {}
            return conn

        with patch.object(self.service._config_service, "list_tool_servers", side_effect=sdk_fails):
            with patch.object(self.service, "_connect_to_server", side_effect=mock_connect):
                with patch("os.getcwd", return_value=str(tmp_path)):
                    await self.service.discover_and_connect_servers(
                        agentic_app_id="test-app",
                        auth=mock_auth,
                        auth_handler_name="AGENTIC",
                        context=mock_context,
                        auth_token="tok",
                    )

        assert len(self.service._connected_servers) == 1
        assert self.service._connected_servers[0].name == "mcp_Fallback"
