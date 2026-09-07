# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

from __future__ import annotations

import uuid

from microsoft_agents_a365.runtime import (
    Connection,
    ConnectionRequest,
    DiscoveredAgent,
    DiscoveryPage,
    ImportedAgent,
    TelemetrySyncResult,
    ThirdPartyConnectRuntime,
)


class DemoState:
    def __init__(self) -> None:
        self.connections: dict[str, Connection] = {}
        self.agents: dict[tuple[str, str], ImportedAgent] = {}
        self.telemetry_records: dict[str, int] = {}


class DemoConnectionClient:
    def __init__(self, state: DemoState) -> None:
        self._state = state

    async def create(self, request: ConnectionRequest) -> Connection:
        connection_id = str(
            uuid.uuid5(uuid.NAMESPACE_URL, f"a365:{request.provider}:{request.name}")
        )
        connection = Connection(connection_id, request.provider)
        self._state.connections[connection_id] = connection
        return connection


class DemoAwsRuntime:
    async def discover_agents(
        self, connection: Connection, continuation_token: str | None
    ) -> DiscoveryPage:
        if continuation_token is None:
            return DiscoveryPage(
                (
                    DiscoveredAgent("aws-agent-001", "Customer Support"),
                    DiscoveredAgent("aws-agent-002", "Order Research"),
                ),
                "aws-page-2",
            )
        if continuation_token == "aws-page-2":
            return DiscoveryPage(
                (
                    DiscoveredAgent("aws-agent-003", "Incident Triage"),
                    DiscoveredAgent("aws-agent-004", "Knowledge Assistant"),
                )
            )
        raise ValueError("Unknown AWS discovery continuation token")

    async def sync_telemetry(
        self, connection: Connection, agents: tuple[ImportedAgent, ...]
    ) -> TelemetrySyncResult:
        records = len(agents) * 3
        return TelemetrySyncResult(records, records, "aws-demo-checkpoint-1")


class DemoRegistryClient:
    def __init__(self, state: DemoState) -> None:
        self._state = state

    async def import_agents(
        self, connection: Connection, agents: tuple[DiscoveredAgent, ...]
    ) -> tuple[ImportedAgent, ...]:
        imported: list[ImportedAgent] = []
        for agent in agents:
            key = (connection.connection_id, agent.provider_agent_id)
            existing = self._state.agents.get(key)
            if existing is None:
                existing = ImportedAgent(
                    agent.provider_agent_id,
                    str(uuid.uuid5(uuid.NAMESPACE_URL, f"a365-agent:{key[0]}:{key[1]}")),
                )
                self._state.agents[key] = existing
            imported.append(existing)
        return tuple(imported)


def create_demo_runtime(state: DemoState) -> ThirdPartyConnectRuntime:
    return ThirdPartyConnectRuntime(
        DemoConnectionClient(state),
        {"aws": DemoAwsRuntime()},
        DemoRegistryClient(state),
    )