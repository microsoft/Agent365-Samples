# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

from httpx import ASGITransport, AsyncClient

from third_party_connect_sample.app import app


async def test_ui_and_cli_share_complete_connection_workflow() -> None:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://sample"
    ) as client:
        response = await client.post(
            "/api/3p/connections", json={"provider": "aws", "name": "E2E AWS"}
        )
        assert response.status_code == 200
        result = response.json()
        assert result["discoveredAgents"] == 4
        assert len(result["importedAgents"]) == 4
        assert result["telemetry"]["records_exported"] == 12

        repeat = await client.post(
            "/api/3p/connections", json={"provider": "aws", "name": "E2E AWS"}
        )
        assert repeat.json()["connection"]["connection_id"] == result["connection"]["connection_id"]
        assert [agent["observability_id"] for agent in repeat.json()["importedAgents"]] == [
            agent["observability_id"] for agent in result["importedAgents"]
        ]

        status = (await client.get("/api/3p/status")).json()
        assert status == {"connections": 1, "registryAgents": 4, "telemetryRecords": 12}