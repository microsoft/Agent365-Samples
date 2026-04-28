# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Sample: Agent 365 SDK alongside an existing Azure Monitor OpenTelemetry setup.

Demonstrates the recommended initialization order:

  1. Initialize your existing OTel stack first (Azure Monitor here).
  2. Then call Agent 365 `configure()` — it detects the existing TracerProvider
     and adds its processors to it. Both backends receive spans.
  3. Then install the OpenAI Agents SDK instrumentor (it requires A365 to be
     configured first). It auto-instruments your agent — no manual span code.

Run with: ``python main.py``
"""

import json
import os

from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Step 1 — Existing OTel setup (Azure Monitor / Application Insights).
# This is what an app already has in production today.
# ---------------------------------------------------------------------------
from azure.monitor.opentelemetry import configure_azure_monitor

configure_azure_monitor(
    connection_string=os.environ["APPLICATIONINSIGHTS_CONNECTION_STRING"],
)

# ---------------------------------------------------------------------------
# Step 2 — Agent 365 SDK `configure()`.
# Detects the TracerProvider set in Step 1 and adds its processors to it.
# Both Azure Monitor and the Agent 365 exporter now receive spans.
# ---------------------------------------------------------------------------
from microsoft_agents_a365.observability.core import configure


def _stub_token_resolver(agent_id: str, tenant_id: str) -> str | None:
    # In a real app, return a bearer token for the Agent 365 backend.
    # See the observability-core docs for the production pattern.
    return "stub-token"


configure(
    service_name=os.environ.get("AGENT_SERVICE_NAME", "sample-agent-azure-monitor"),
    service_namespace="agent365-samples",
    token_resolver=_stub_token_resolver,
)

# ---------------------------------------------------------------------------
# Step 2b — Install the OpenAI Agents SDK instrumentor.
# Must run AFTER `configure()` — the instrumentor raises RuntimeError otherwise.
# ---------------------------------------------------------------------------
from microsoft_agents_a365.observability.extensions.openai import (
    OpenAIAgentsTraceInstrumentor,
)

OpenAIAgentsTraceInstrumentor().instrument()

# ---------------------------------------------------------------------------
# Step 3 — Build the tool-calling agent (auto-instrumented).
# ---------------------------------------------------------------------------
from agents import Agent, Runner, function_tool


@function_tool
def get_weather(city: str) -> str:
    """Return the current weather for ``city`` as a JSON string."""
    return json.dumps({"city": city, "temperature_f": 72, "conditions": "sunny"})


agent = Agent(
    name="WeatherAgent",
    instructions=(
        "You are a helpful assistant that answers weather questions "
        "using the get_weather tool."
    ),
    tools=[get_weather],
)

# ---------------------------------------------------------------------------
# Step 4 — Run a single turn and exit, flushing spans on the way out.
# ---------------------------------------------------------------------------
from opentelemetry import trace


def main() -> None:
    result = Runner.run_sync(agent, "What's the weather in Seattle?")
    print(result.final_output)
    # Force span flush so both Azure Monitor and Agent 365 exporters drain
    # before the process exits.
    trace.get_tracer_provider().force_flush()


if __name__ == "__main__":
    main()
