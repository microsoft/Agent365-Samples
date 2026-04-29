# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Sample: Agent 365 SDK alongside a manual OTel SDK setup, with manual span scopes.

This sample demonstrates two things at once:

1. The recommended init order: existing OTel first, then Agent 365 `configure()`.
2. Manual instrumentation using `InvokeAgentScope` / `InferenceScope` /
   `ExecuteToolScope` — useful when you don't use an agent framework, or when
   you want explicit control over which calls produce which spans.

The default exporter is `ConsoleSpanExporter` so you can run this with zero
external setup. To export to a real OTLP endpoint, swap it for
`OTLPSpanExporter` (commented block below).

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
# To export to a real OTLP collector / Jaeger / Honeycomb / etc., uncomment
# the OTLP block and comment out the Console block.
# ---------------------------------------------------------------------------
from opentelemetry import trace
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter

# from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
# exporter = OTLPSpanExporter(endpoint=os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"])

exporter = ConsoleSpanExporter()
provider = TracerProvider(
    resource=Resource.create(
        {SERVICE_NAME: os.environ.get("OTEL_SERVICE_NAME", "sample-agent-otlp")}
    )
)
provider.add_span_processor(BatchSpanProcessor(exporter))
trace.set_tracer_provider(provider)

# ---------------------------------------------------------------------------
# Step 2 — Agent 365 SDK `configure()`.
# Detects the TracerProvider set in Step 1 and adds its processors to it.
# ---------------------------------------------------------------------------
from microsoft_agents_a365.observability.core import (
    AgentDetails,
    ExecuteToolScope,
    InferenceCallDetails,
    InferenceOperationType,
    InferenceScope,
    InvokeAgentScope,
    InvokeAgentScopeDetails,
    Request,
    ToolCallDetails,
    configure,
)


def _stub_token_resolver(agent_id: str, tenant_id: str) -> str | None:
    # In a real app, return a bearer token for the Agent 365 backend.
    return "stub-token"


_configure_ok = configure(
    service_name=os.environ.get("AGENT_SERVICE_NAME", "sample-agent-otlp"),
    service_namespace="agent365-samples",
    token_resolver=_stub_token_resolver,
)
if not _configure_ok:
    raise SystemExit(
        "Agent 365 observability configuration failed. See logs for details."
    )

# ---------------------------------------------------------------------------
# Step 3 — Agent setup: raw OpenAI client + a fake tool.
# No agent framework — we drive the loop manually so each SDK call is wrapped
# in the corresponding Agent 365 scope.
# ---------------------------------------------------------------------------
from openai import OpenAI

client = OpenAI()
MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")


def get_weather(city: str) -> str:
    """Return the current weather for ``city`` as a JSON string."""
    return json.dumps({"city": city, "temperature_f": 72, "conditions": "sunny"})


WEATHER_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get current weather for a city.",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}

AGENT = AgentDetails(agent_id="sample-agent", agent_name="WeatherAgent")


# ---------------------------------------------------------------------------
# Step 4 — Run one turn manually, wrapping each SDK call in a scope.
# ---------------------------------------------------------------------------
def run_one_turn(user_message: str) -> str:
    with InvokeAgentScope.start(
        request=Request(content=[user_message]),
        scope_details=InvokeAgentScopeDetails(endpoint=None),
        agent_details=AGENT,
    ) as invoke_scope:
        messages = [
            {
                "role": "system",
                "content": "You answer weather questions using the get_weather tool.",
            },
            {"role": "user", "content": user_message},
        ]

        # First inference: model decides to call the tool.
        with InferenceScope.start(
            request=Request(content=[user_message]),
            details=InferenceCallDetails(
                operationName=InferenceOperationType.CHAT,
                model=MODEL,
                providerName="openai",
            ),
            agent_details=AGENT,
        ) as inf_scope:
            first = client.chat.completions.create(
                model=MODEL,
                messages=messages,
                tools=[WEATHER_TOOL_SCHEMA],
            )
            assistant_msg = first.choices[0].message
            inf_scope.record_response(assistant_msg.content or "<tool_call>")

        # If the model answered without calling the tool, return its text.
        if not assistant_msg.tool_calls:
            final = assistant_msg.content or ""
            invoke_scope.record_response(final)
            return final

        tool_call = assistant_msg.tool_calls[0]
        args = json.loads(tool_call.function.arguments)

        # Tool execution.
        with ExecuteToolScope.start(
            request=Request(content=[tool_call.function.arguments]),
            details=ToolCallDetails(
                tool_name=tool_call.function.name,
                arguments=args,
            ),
            agent_details=AGENT,
        ) as tool_scope:
            tool_result = get_weather(**args)
            tool_scope.record_response(tool_result)

        # Build messages for the follow-up call.
        messages.append(
            {
                "role": "assistant",
                "content": assistant_msg.content,
                "tool_calls": [
                    {
                        "id": tool_call.id,
                        "type": "function",
                        "function": {
                            "name": tool_call.function.name,
                            "arguments": tool_call.function.arguments,
                        },
                    }
                ],
            }
        )
        messages.append(
            {"role": "tool", "tool_call_id": tool_call.id, "content": tool_result}
        )

        # Second inference: model summarizes the tool result.
        with InferenceScope.start(
            request=Request(content=[tool_result]),
            details=InferenceCallDetails(
                operationName=InferenceOperationType.CHAT,
                model=MODEL,
                providerName="openai",
            ),
            agent_details=AGENT,
        ) as inf_scope:
            second = client.chat.completions.create(model=MODEL, messages=messages)
            final = second.choices[0].message.content or ""
            inf_scope.record_response(final)

        invoke_scope.record_response(final)
        return final


def main() -> None:
    print(run_one_turn("What's the weather in Seattle?"))
    trace.get_tracer_provider().force_flush()


if __name__ == "__main__":
    main()
