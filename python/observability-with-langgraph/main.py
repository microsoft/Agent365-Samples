# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Sample: Agent 365 SDK alongside an existing OTel SDK + a LangGraph ReAct agent.

Mirrors the pattern from Google Cloud's "LangGraph + OpenTelemetry" reference
sample (https://docs.cloud.google.com/stackdriver/docs/instrumentation/ai-agent-langgraph),
adapted for the Agent 365 Python SDK:

  1. Initialize your existing OTel stack first (vendor-neutral here, with a
     commented OTLP/gRPC swap that matches the Google Cloud reference).
  2. Then call Agent 365 ``configure()`` — it detects the existing
     TracerProvider and adds its processors to it. Both backends receive spans.
  3. Then install ``CustomLangChainInstrumentor`` — auto-instruments LangChain
     LLM and tool callbacks. Like Google's guide, the agent invocation itself
     is wrapped in a manual top-level span (``InvokeAgentScope`` here, which
     mirrors Google's ``tracer.start_as_current_span("invoke agent")``).

The default exporter is ``ConsoleSpanExporter`` so you can run this with zero
external setup. To export to a real backend (including Google Cloud Trace, per
the reference guide), uncomment the OTLP block.

Run with: ``python main.py``
"""

import json
import os

from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Step 1 — Existing OTel setup (manual, vendor-neutral).
#
# Default: ConsoleSpanExporter. Spans print to stdout — no extra setup needed.
#
# To export to a real backend (Google Cloud Trace, an OTLP collector, Jaeger,
# Honeycomb, etc.), uncomment the OTLP/gRPC block and comment out the Console
# block. The gRPC exporter mirrors the Google Cloud LangGraph reference.
# ---------------------------------------------------------------------------
from opentelemetry import trace
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter

# from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
# exporter = OTLPSpanExporter(endpoint=os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"])

exporter = ConsoleSpanExporter()
provider = TracerProvider(
    resource=Resource.create(
        {SERVICE_NAME: os.environ.get("OTEL_SERVICE_NAME", "sample-agent-langgraph")}
    )
)
provider.add_span_processor(BatchSpanProcessor(exporter))
trace.set_tracer_provider(provider)

# ---------------------------------------------------------------------------
# Step 2 — Agent 365 SDK `configure()`.
# Detects the TracerProvider set in Step 1 and adds its processors to it.
# Both your existing exporter and the Agent 365 exporter now receive spans.
# ---------------------------------------------------------------------------
from microsoft_agents_a365.observability.core import (
    AgentDetails,
    ExecutionType,
    InvokeAgentDetails,
    InvokeAgentScope,
    Request,
    TenantDetails,
    configure,
)


def _stub_token_resolver(agent_id: str, tenant_id: str) -> str | None:
    # In a real app, return a bearer token for the Agent 365 backend.
    return "stub-token"


_configure_ok = configure(
    service_name=os.environ.get("AGENT_SERVICE_NAME", "sample-agent-langgraph"),
    service_namespace="agent365-samples",
    token_resolver=_stub_token_resolver,
)
if not _configure_ok:
    raise SystemExit(
        "Agent 365 observability configuration failed. See logs for details."
    )

# ---------------------------------------------------------------------------
# Step 2b — Install the LangChain instrumentor.
# Must run AFTER `configure()` — the instrumentor raises RuntimeError otherwise.
# Construction auto-calls ``.instrument()``; after this, every LangChain run
# (LLM call, tool call, chain) emits an OpenTelemetry span via Agent 365's
# tracer.
# ---------------------------------------------------------------------------
from microsoft_agents_a365.observability.extensions.langchain import (
    CustomLangChainInstrumentor,
)

CustomLangChainInstrumentor()

# ---------------------------------------------------------------------------
# Step 3 — Build the LangGraph prebuilt ReAct agent (auto-instrumented).
# ---------------------------------------------------------------------------
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent


@tool
def get_weather(city: str) -> str:
    """Return the current weather for ``city`` as a JSON string."""
    return json.dumps({"city": city, "temperature_f": 72, "conditions": "sunny"})


MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
llm = ChatOpenAI(model=MODEL)
agent = create_react_agent(model=llm, tools=[get_weather])

AGENT = AgentDetails(agent_id="sample-agent", agent_name="WeatherAgent")
TENANT = TenantDetails(tenant_id=os.environ.get("TENANT_ID", "sample-tenant"))

# ---------------------------------------------------------------------------
# Step 4 — Run a single turn, wrapping the LangGraph invocation in a manual
# `InvokeAgentScope`. Google's reference guide does the equivalent with a
# generic `tracer.start_as_current_span("invoke agent")`; using the Agent 365
# scope gives the standard `invoke_agent <agent_name>` span name and request /
# response attributes for free.
# ---------------------------------------------------------------------------
def main() -> None:
    user_message = "What's the weather in Seattle?"

    with InvokeAgentScope.start(
        invoke_agent_details=InvokeAgentDetails(details=AGENT),
        tenant_details=TENANT,
        request=Request(
            content=user_message,
            execution_type=ExecutionType.HUMAN_TO_AGENT,
        ),
    ) as invoke_scope:
        result = agent.invoke(
            {"messages": [{"role": "user", "content": user_message}]}
        )
        final = result["messages"][-1].content
        invoke_scope.record_response(final)
        print(final)

    # Force span flush so both your existing exporter and the Agent 365
    # exporter drain before the process exits.
    trace.get_tracer_provider().force_flush()


if __name__ == "__main__":
    main()
