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
from contextlib import nullcontext

from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Step 1 — Existing OTel setup (Azure Monitor / Application Insights).
# This is what an app already has in production today.
# ---------------------------------------------------------------------------
from azure.monitor.opentelemetry import configure_azure_monitor

_app_insights_conn = os.environ.get("APPLICATIONINSIGHTS_CONNECTION_STRING")
if not _app_insights_conn:
    raise SystemExit(
        "APPLICATIONINSIGHTS_CONNECTION_STRING is not set. "
        "Copy .env.template to .env and fill in your Application Insights "
        "connection string. See README.md for setup steps."
    )
configure_azure_monitor(connection_string=_app_insights_conn)

# ---------------------------------------------------------------------------
# Step 2 — Agent 365 SDK `configure()`.
# Detects the TracerProvider set in Step 1 and adds its processors to it.
# Both Azure Monitor and the Agent 365 exporter now receive spans.
# ---------------------------------------------------------------------------
from microsoft_agents_a365.observability.core import configure
from microsoft_agents_a365.observability.core.exporters.agent365_exporter_options import Agent365ExporterOptions
from microsoft_agents_a365.observability.core.middleware.baggage_builder import BaggageBuilder
from observability_token_service import create_observability_token_resolver


token_resolver = create_observability_token_resolver()


_configure_ok = configure(
    service_name=os.environ.get("AGENT_SERVICE_NAME", "sample-agent-azure-monitor"),
    service_namespace="agent365-samples",
    exporter_options=Agent365ExporterOptions(
        use_s2s_endpoint=True,
        token_resolver=token_resolver,
    ),
)
if not _configure_ok:
    raise SystemExit(
        "Agent 365 observability configuration failed. See logs for details."
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
    # This standalone demo has no incoming turn carrying an agent/tenant identity.
    context = (
        BaggageBuilder().tenant_id(token_resolver.tenant_id).agent_id(token_resolver.agent_id).build()
        if token_resolver else nullcontext()
    )
    with context:
        result = Runner.run_sync(agent, "What's the weather in Seattle?")
    print(result.final_output)
    # Force span flush so both Azure Monitor and Agent 365 exporters drain
    # before the process exits.
    trace.get_tracer_provider().force_flush()


if __name__ == "__main__":
    main()
