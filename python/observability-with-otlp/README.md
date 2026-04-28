# Observability — Agent 365 SDK with manual OTel + manual instrumentation

This sample shows two patterns at once:

1. Adding the [Microsoft Agent 365 Python SDK](https://github.com/microsoft/Agent365-python) to an app with an **already-configured OpenTelemetry SDK** (vendor-neutral / OTLP).
2. **Manual instrumentation** using `InvokeAgentScope`, `InferenceScope`, and `ExecuteToolScope` — useful when you don't use an agent framework, or when you want explicit control over which calls produce spans.

> This is **not** a from-scratch tracing setup. For a full agent host with Microsoft 365 Agents SDK, see the [`python/openai/sample-agent`](../openai/sample-agent) sample.

## Prerequisites

- Python 3.11+
- An OpenAI or Azure OpenAI key

No collector or external service is required — the sample defaults to `ConsoleSpanExporter` so spans print to stdout.

## Setup

1. Copy the env template and fill in your values:

   ```bash
   cp .env.template .env
   ```

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
- Multiple JSON span dumps printed by `ConsoleSpanExporter`. Look for spans named `invoke_agent`, `inference`, and `execute_tool`.

## Swap to a real OTLP endpoint

In `main.py`, comment out the `ConsoleSpanExporter` lines and uncomment the `OTLPSpanExporter` block. Set `OTEL_EXPORTER_OTLP_ENDPOINT` in `.env` (e.g. `http://localhost:4318/v1/traces` for a local collector, or your vendor's endpoint).

## What to look for

The console output (or your OTLP backend) should contain a span tree:

- `invoke_agent WeatherAgent` (the outer span — one per user turn)
  - `inference` (first LLM call: the model decides to call the tool)
  - `execute_tool get_weather` (the tool runs)
  - `inference` (second LLM call: the model summarizes the tool result)

If those four spans show up, the integration is working.

## Where the integration happens

`main.py` is organized into the following sections:

1. **Step 1 — OTel SDK setup.** Build a `TracerProvider`, attach a `BatchSpanProcessor` with the exporter, call `trace.set_tracer_provider(...)`. This is the part of the file you'd already have in your real app.
2. **Step 2 — Agent 365 `configure()`.** Detects the TracerProvider set by Step 1 and adds its processors to it. Both your existing exporter and the Agent 365 exporter receive spans.
3. **Step 3 — Agent setup.** Raw OpenAI client and a `get_weather` Python function. No framework — the loop is in `run_one_turn`.
4. **Step 4 — `run_one_turn`.** Wraps each SDK call:
   - The whole turn → `InvokeAgentScope`.
   - Each `client.chat.completions.create(...)` call → `InferenceScope`.
   - The `get_weather` invocation → `ExecuteToolScope`.

   `record_response(...)` on each scope records the output as a span attribute.

To diff against your own app: copy Step 1 (replace with whatever exporter / resource you use) and Step 2 into your bootstrapping. Apply the Step 4 wrapping pattern around your own SDK calls.

## Going further

- Integration patterns and pitfalls: [Integrating with existing OpenTelemetry](https://github.com/microsoft/Agent365-python/blob/main/docs/integrating-with-existing-opentelemetry.md) (in the SDK repo)
- Auto-instrumented OpenAI Agents SDK example: [`python/observability-with-azure-monitor`](../observability-with-azure-monitor)
