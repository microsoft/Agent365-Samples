# Observability — Agent 365 SDK with LangGraph

This sample shows how to add the [Microsoft Agent 365 Python SDK](https://github.com/microsoft/Agent365-python) to a [LangGraph](https://langchain-ai.github.io/langgraph/) agent that **already** uses OpenTelemetry. After running this, both your existing exporter and the Agent 365 backend receive every span produced by the agent.

The structure mirrors Google Cloud's [LangGraph + OpenTelemetry reference sample](https://docs.cloud.google.com/stackdriver/docs/instrumentation/ai-agent-langgraph): an OTel TracerProvider is set up first, an auto-instrumentor handles the LLM and tool spans, and a manual top-level span wraps `agent.invoke(...)` so the trace tree has a clear "agent run" root.

> This is **not** a from-scratch tracing setup. For a full agent host with Microsoft 365 Agents SDK, see the [`python/openai/sample-agent`](../openai/sample-agent) sample.

## Demonstrates

- The recommended init order: existing OTel → Agent 365 `configure()` → LangChain instrumentor.
- Auto-instrumentation via `microsoft-agents-a365-observability-extensions-langchain` — every LangChain LLM and tool callback emits an OTel span automatically; no per-call wrapping in the agent body.
- A manual `InvokeAgentScope` around `agent.invoke(...)` for the top-level `invoke_agent <agent_name>` span (the Agent 365 equivalent of Google's `tracer.start_as_current_span("invoke agent")`).
- Default `ConsoleSpanExporter` for zero external setup, with a one-line swap to OTLP/gRPC for real backends (including Google Cloud Trace).

## Prerequisites

- Python 3.11+
- An OpenAI or Azure OpenAI key

No collector or external service is required — the sample defaults to `ConsoleSpanExporter` so spans print to stdout.

## Setup

1. Copy the env template and fill in your values:

   ```bash
   cp .env.template .env
   ```

   The template includes `ENABLE_OBSERVABILITY=true` — leave this as-is. Without it, the SDK silently emits zero spans.

2. Create a virtualenv and install:

   ```bash
   python -m venv .venv
   source .venv/bin/activate    # Windows: .venv\Scripts\activate
   pip install -e .
   ```

## Run

```bash
python main.py
```

Expected output (truncated):

- A one-line weather answer for Seattle.
- Multiple JSON span dumps printed by `ConsoleSpanExporter`. Look for spans named `invoke_agent WeatherAgent`, `chat ChatOpenAI` (typically twice — one per ReAct cycle), and `execute_tool get_weather`.

## Swap to a real OTLP endpoint

In `main.py`, comment out the `ConsoleSpanExporter` lines and uncomment the `OTLPSpanExporter` block. Set `OTEL_EXPORTER_OTLP_ENDPOINT` in `.env` (e.g. `http://localhost:4317` for a local OTLP/gRPC collector, or `https://telemetry.googleapis.com:443/v1/traces` for Google Cloud Trace per the [reference guide](https://docs.cloud.google.com/stackdriver/docs/instrumentation/ai-agent-langgraph)).

For Cloud Trace specifically, the reference guide also configures gRPC channel credentials with Google ADC; copy that block into Step 1 if you target Google Cloud.

## What to look for

The console output (or your OTLP backend) should contain a span tree rooted at `invoke_agent WeatherAgent`. Inside it you'll see the LangGraph ReAct loop nested under the `agent` and `tools` graph nodes, with three spans that matter for Agent 365 telemetry:

- `invoke_agent WeatherAgent` (the outer span — one per user turn; emitted by `InvokeAgentScope`)
- `chat ChatOpenAI` — one per LLM call (twice for a tool-using turn); the LangChain instrumentor renames LLM runs to `chat <run_name>` when the underlying response carries a chat-completion id, matching the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/)
- `execute_tool get_weather` — the tool runs (renamed by the same instrumentor; carries `gen_ai.operation.name=execute_tool` and `gen_ai.tool.name=get_weather`)

The instrumentor also emits internal LangGraph spans (`LangGraph`, `agent`, `tools`, `call_model`, `should_continue`, `RunnableSequence`, `Prompt`) — those are normal and reflect the underlying graph execution. The Agent 365 backend receives the same spans (configured via the stub token resolver — replace with a real one for production).

## Where the integration happens

`main.py` is organized into the following sections (Step 2b is a sub-step that must run after Step 2):

1. **Step 1 — OTel SDK setup.** Build a `TracerProvider`, attach a `BatchSpanProcessor` with the exporter, call `trace.set_tracer_provider(...)`. This is the part of the file you'd already have in your real app.
2. **Step 2 — Agent 365 `configure()`.** Detects the TracerProvider set by Step 1 and adds its processors to it. Both your existing exporter and the Agent 365 exporter receive spans. Replace `_stub_token_resolver` with your production token resolver.
3. **Step 2b — `CustomLangChainInstrumentor`.** Must run after `configure()`; the constructor raises `RuntimeError` otherwise. Construction auto-calls `.instrument()`. After this, every LangChain LLM and tool callback flows through Agent 365's tracer.
4. **Step 3 — Build the agent.** Standard `langgraph.prebuilt.create_react_agent(...)` with a `langchain-openai` model and a `@tool`-decorated `get_weather` function. No observability code needed (the instrumentor handles it).
5. **Step 4 — Run + flush.** `InvokeAgentScope` wraps `agent.invoke(...)` so the run gets a top-level `invoke_agent <agent_name>` span; `force_flush()` is critical — without it, batched spans may not export before the process exits.

To diff against your own app: copy Steps 1, 2, and 2b into the file where your app currently initializes its TracerProvider, and apply the Step 4 `InvokeAgentScope` wrapping pattern around your `agent.invoke(...)` calls.

## Going further

- Integration patterns and pitfalls: [Integrating with existing OpenTelemetry](https://github.com/microsoft/Agent365-python/blob/main/docs/integrating-with-existing-opentelemetry.md) (in the SDK repo)
- Manual instrumentation example (no agent framework): [`python/observability-with-otlp`](../observability-with-otlp)
- Auto-instrumented OpenAI Agents SDK example: [`python/observability-with-azure-monitor`](../observability-with-azure-monitor)
- Google Cloud reference this sample mirrors: [LangGraph + OpenTelemetry on Stackdriver](https://docs.cloud.google.com/stackdriver/docs/instrumentation/ai-agent-langgraph)

## Troubleshooting

- **Sample runs without errors but no spans appear** — most commonly `ENABLE_OBSERVABILITY` is not set to a truthy value. The SDK gates span creation behind this env var and produces zero spans silently when it's missing. The sample's `.env.template` includes it; if you assembled `.env` manually, add `ENABLE_OBSERVABILITY=true`.
- **No spans printed to stdout** — `BatchSpanProcessor` may not have flushed; the sample calls `force_flush()` on exit, so make sure the script ran to completion.
- **`KeyError` or auth error from OpenAI** — verify `OPENAI_API_KEY` (or `AZURE_OPENAI_*` variables) in `.env`. `langchain-openai` reads these directly.
- **Spans missing from your OTLP backend (after swap)** — temporarily fall back to `ConsoleSpanExporter` to confirm the SDK is producing spans. If they appear on stdout but not in your backend, the issue is in the exporter / collector / network. See [the integration guide's verify recipe](https://github.com/microsoft/Agent365-python/blob/main/docs/integrating-with-existing-opentelemetry.md#verifying-the-integration).
- **`SystemExit: Agent 365 observability configuration failed`** — check logs for the failing step (most often a missing or unreachable token resolver in production; the sample uses a stub).
- **`RuntimeError: Tracing SDK is not configured`** — `CustomLangChainInstrumentor()` ran before `configure()`. Make sure Step 2 (`configure(...)`) executes successfully before Step 2b.
- **`TypeError: wrap_function_wrapper() got an unexpected keyword argument 'module'`** — the LangChain extension uses `wrapt`'s legacy keyword-argument call style, which `wrapt 2.x` removed. `pyproject.toml` pins `wrapt<2` to keep the extension working; if you assemble dependencies manually, do the same until the SDK ships a fix.
