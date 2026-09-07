# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from microsoft_agents_a365.runtime import ConnectionRequest

from .demo import DemoState, create_demo_runtime


class CreateConnectionBody(BaseModel):
    provider: str = "aws"
    name: str = Field(min_length=1, max_length=100)
    configuration: dict[str, str] = Field(default_factory=dict)


state = DemoState()
runtime = create_demo_runtime(state)
app = FastAPI(title="Agent 365 third-party connect sample")
static_root = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=static_root), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(static_root / "index.html")


@app.get("/api/3p/providers")
async def providers() -> list[dict[str, str]]:
    return [{"id": "aws", "displayName": "AWS Bedrock AgentCore"}]


@app.get("/api/3p/connections")
async def connections() -> list[dict[str, str]]:
    return [asdict(connection) for connection in state.connections.values()]


@app.post("/api/3p/connections")
async def connect(body: CreateConnectionBody) -> dict[str, object]:
    result = await runtime.connect(
        ConnectionRequest(body.provider, body.name, body.configuration)
    )
    state.telemetry_records[result.connection.connection_id] = (
        result.telemetry.records_exported
    )
    return {
        "connection": asdict(result.connection),
        "discoveredAgents": result.discovered_agents,
        "importedAgents": [asdict(agent) for agent in result.imported_agents],
        "telemetry": asdict(result.telemetry),
    }


@app.get("/api/3p/status")
async def status() -> dict[str, object]:
    return {
        "connections": len(state.connections),
        "registryAgents": len(state.agents),
        "telemetryRecords": sum(state.telemetry_records.values()),
    }