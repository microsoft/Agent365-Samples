# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Unit tests for Claude MCP Tool Registration Service.

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

    def test_full_https_url_returned_unchanged(self):
        url = "https://agent365.svc.cloud.microsoft/agents/servers/mcp_Test"
        assert self.service._build_full_url(url) == url

    def test_full_http_url_returned_unchanged(self):
        url = "http://localhost:8080/mcp"
        assert self.service._build_full_url(url) == url

    def test_relative_agents_path_prepends_endpoint(self):
        with patch.dict(os.environ, {"MCP_PLATFORM_ENDPOINT": "https://my.endpoint.com"}):
            result = self.service._build_full_url("agents/servers/mcp_Test")
        assert result == "https://my.endpoint.com/agents/servers/mcp_Test"

    def test_bare_server_name_becomes_agents_servers_path(self):
        with patch.dict(os.environ, {"MCP_PLATFORM_ENDPOINT": "https://my.endpoint.com"}):
            result = self.service._build_full_url("mcp_Test")
        assert result == "https://my.endpoint.com/agents/servers/mcp_Test"

    def test_leading_slash_stripped(self):
        with patch.dict(os.environ, {"MCP_PLATFORM_ENDPOINT": "https://my.endpoint.com"}):
            result = self.service._build_full_url("/agents/servers/mcp_Test")
        assert result == "https://my.endpoint.com/agents/servers/mcp_Test"

    def test_empty_string_returns_empty(self):
        assert self.service._build_full_url("") == ""


# ---------------------------------------------------------------------------
# _load_manifest_servers_fallback
# ---------------------------------------------------------------------------

class TestLoadManifestServersFallback:
    def setup_method(self):
        self.service = McpToolRegistrationService()

    def test_loads_all_v2_fields(self, tmp_path):
        manifest = {
            "mcpServers": [{
                "mcpServerName": "mcp_Test",
                "mcpServerUniqueName": "mcp_Test",
                "url": "https://agent365.svc.cloud.microsoft/agents/servers/mcp_Test",
                "scope": "McpServers.Test.All",
                "audience": "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1",
                "publisher": "Microsoft",
                "headers": {"X-Custom": "value"},
            }]
        }
        (tmp_path / "ToolingManifest.json").write_text(json.dumps(manifest))

        with patch("os.getcwd", return_value=str(tmp_path)):
            servers = self.service._load_manifest_servers_fallback()

        assert len(servers) == 1
        s = servers[0]
        assert s["name"] == "mcp_Test"
        assert s["scope"] == "McpServers.Test.All"
        assert s["audience"] == "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1"
        assert s["publisher"] == "Microsoft"
        assert s["headers"] == {"X-Custom": "value"}

    def test_skips_servers_without_url(self, tmp_path):
        manifest = {"mcpServers": [{"mcpServerName": "mcp_NoUrl"}]}
        (tmp_path / "ToolingManifest.json").write_text(json.dumps(manifest))

        with patch("os.getcwd", return_value=str(tmp_path)):
            servers = self.service._load_manifest_servers_fallback()

        assert servers == []

    def test_defaults_publisher_and_headers_when_absent(self, tmp_path):
        manifest = {"mcpServers": [{
            "mcpServerName": "mcp_Min",
            "url": "https://example.com/mcp_Min",
        }]}
        (tmp_path / "ToolingManifest.json").write_text(json.dumps(manifest))

        with patch("os.getcwd", return_value=str(tmp_path)):
            servers = self.service._load_manifest_servers_fallback()

        assert servers[0]["publisher"] == ""
        assert servers[0]["headers"] == {}

    def test_returns_empty_when_manifest_missing(self, tmp_path):
        with patch("os.getcwd", return_value=str(tmp_path)):
            servers = self.service._load_manifest_servers_fallback()
        assert servers == []

    def test_multiple_servers_loaded(self, tmp_path):
        manifest = {"mcpServers": [
            {"mcpServerName": "mcp_A", "url": "https://example.com/A"},
            {"mcpServerName": "mcp_B", "url": "https://example.com/B"},
        ]}
        (tmp_path / "ToolingManifest.json").write_text(json.dumps(manifest))

        with patch("os.getcwd", return_value=str(tmp_path)):
            servers = self.service._load_manifest_servers_fallback()

        assert len(servers) == 2


# ---------------------------------------------------------------------------
# _connect_to_server
# ---------------------------------------------------------------------------

class TestConnectToServer:
    def setup_method(self):
        self.service = McpToolRegistrationService()

    @pytest.mark.asyncio
    async def test_v2_server_headers_override_base_auth_token(self):
        """Per-audience token in server_headers must override the base auth_token."""
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
    async def test_base_token_used_when_no_server_headers(self):
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
    async def test_additional_server_headers_merged(self):
        """Extra custom headers from server_headers should appear in final headers."""
        captured = {}

        async def mock_list(url, headers, name):
            captured["headers"] = dict(headers)
            return []

        with patch.object(self.service, "_list_server_tools", side_effect=mock_list):
            await self.service._connect_to_server(
                name="mcp_Test",
                url="https://example.com/server",
                auth_token="base-token",
                server_headers={"X-Tenant": "tenant-123"},
            )

        assert captured["headers"]["X-Tenant"] == "tenant-123"
        assert "Bearer base-token" in captured["headers"].get("Authorization", "")

    @pytest.mark.asyncio
    async def test_returns_none_for_remote_with_no_auth(self):
        result = await self.service._connect_to_server(
            name="mcp_Test",
            url="https://example.com/server",
            auth_token=None,
            server_headers={},
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_local_server_connects_without_token(self):
        async def mock_list(url, headers, name):
            return []

        with patch.object(self.service, "_list_server_tools", side_effect=mock_list):
            result = await self.service._connect_to_server(
                name="local",
                url="http://localhost:9999/mcp",
                auth_token=None,
                server_headers={},
            )

        assert result is not None
        assert result.connected is True

    @pytest.mark.asyncio
    async def test_returns_none_when_server_headers_have_auth_but_auth_token_none(self):
        """V2: server_headers with Authorization should allow connection even if auth_token is None."""
        captured = {}

        async def mock_list(url, headers, name):
            captured["headers"] = dict(headers)
            return []

        with patch.object(self.service, "_list_server_tools", side_effect=mock_list):
            result = await self.service._connect_to_server(
                name="mcp_Test",
                url="https://example.com/server",
                auth_token=None,
                server_headers={"Authorization": "Bearer per-audience-token"},
            )

        # Should NOT return None since server_headers provides auth
        assert result is not None
        assert captured["headers"]["Authorization"] == "Bearer per-audience-token"


# ---------------------------------------------------------------------------
# discover_and_connect_servers — authorization_context & V2 field extraction
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

        assert "authorization_context" in captured
        ctx = captured["authorization_context"]
        assert ctx["auth"] is mock_auth
        assert ctx["auth_handler_name"] == "AGENTIC"
        assert ctx["context"] is mock_context

    @pytest.mark.asyncio
    async def test_extracts_v2_fields_from_sdk_configs(self):
        mock_auth = MagicMock()
        mock_context = MagicMock()

        cfg = MagicMock()
        cfg.url = "https://example.com/servers/mcp_Test"
        cfg.mcp_server_name = "mcp_Test"
        cfg.mcp_server_unique_name = "mcp_Test"
        cfg.audience = "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1"
        cfg.scope = "McpServers.Test.All"
        cfg.publisher = "Microsoft"
        cfg.headers = {"Authorization": "Bearer per-audience-token"}

        async def mock_list(**kwargs):
            return [cfg]

        connect_calls = []

        async def mock_connect(name, url, auth_token, server_headers=None):
            connect_calls.append({"name": name, "server_headers": server_headers})
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

        assert len(connect_calls) == 1
        assert connect_calls[0]["server_headers"] == {"Authorization": "Bearer per-audience-token"}

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
            conn.headers = server_headers or {}
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

    @pytest.mark.asyncio
    async def test_agentic_app_id_passed_to_sdk(self):
        mock_auth = MagicMock()
        mock_context = MagicMock()
        captured = {}

        async def mock_list(**kwargs):
            captured.update(kwargs)
            return []

        with patch.object(self.service._config_service, "list_tool_servers", side_effect=mock_list):
            await self.service.discover_and_connect_servers(
                agentic_app_id="my-unique-app-id",
                auth=mock_auth,
                auth_handler_name="AGENTIC",
                context=mock_context,
                auth_token="tok",
            )

        assert captured.get("agentic_app_id") == "my-unique-app-id"
