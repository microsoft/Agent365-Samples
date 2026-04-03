# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Tests for openai ToolingManifest.json structure.
Validates V2 MCP fields are present and correctly formed.
"""

import json
import os
import pytest

MANIFEST_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "ToolingManifest.json",
)

MCP_SERVERS_ALL_PATTERN = "McpServers."
V2_AUDIENCE = "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1"


@pytest.fixture(scope="module")
def manifest():
    with open(MANIFEST_PATH) as f:
        return json.load(f)


@pytest.fixture(scope="module")
def servers(manifest):
    return manifest["mcpServers"]


class TestManifestStructure:
    def test_manifest_has_mcp_servers_key(self, manifest):
        assert "mcpServers" in manifest

    def test_at_least_one_server(self, servers):
        assert len(servers) > 0

    def test_each_server_has_required_fields(self, servers):
        required = {"mcpServerName", "mcpServerUniqueName", "url", "scope", "audience", "publisher"}
        for s in servers:
            missing = required - s.keys()
            assert not missing, f"Server '{s.get('mcpServerName')}' missing fields: {missing}"

    def test_urls_are_https(self, servers):
        for s in servers:
            assert s["url"].startswith("https://"), f"Server '{s['mcpServerName']}' URL must be HTTPS"

    def test_urls_point_to_production_endpoint(self, servers):
        for s in servers:
            assert "agent365.svc.cloud.microsoft" in s["url"], (
                f"Server '{s['mcpServerName']}' should use production endpoint"
            )

    def test_no_null_scopes(self, servers):
        for s in servers:
            assert s["scope"] and s["scope"] != "null", (
                f"Server '{s['mcpServerName']}' has null/empty scope"
            )

    def test_mcp_servers_all_scopes_use_v2_audience(self, servers):
        """Servers with McpServers.*.All scope must use the V2 audience GUID."""
        for s in servers:
            if s["scope"].startswith(MCP_SERVERS_ALL_PATTERN):
                assert s["audience"] == V2_AUDIENCE, (
                    f"Server '{s['mcpServerName']}' with scope '{s['scope']}' "
                    f"must use audience '{V2_AUDIENCE}'"
                )

    def test_publisher_is_set(self, servers):
        for s in servers:
            assert s["publisher"], f"Server '{s['mcpServerName']}' has empty publisher"

    def test_no_duplicate_server_names(self, servers):
        names = [s["mcpServerName"] for s in servers]
        assert len(names) == len(set(names)), "Duplicate mcpServerName entries found"
