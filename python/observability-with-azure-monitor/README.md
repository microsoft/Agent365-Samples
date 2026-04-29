# Observability — Agent 365 SDK alongside Azure Monitor

This sample shows how to add the [Microsoft Agent 365 Python SDK](https://github.com/microsoft/Agent365-python) to an app that **already** uses [Azure Monitor / Application Insights OpenTelemetry](https://learn.microsoft.com/azure/azure-monitor/app/opentelemetry-overview). After running this, both Azure Monitor and the Agent 365 backend receive your agent's spans.

> This is **not** a from-scratch tracing setup. For a full agent host with Microsoft 365 Agents SDK, see the [`python/openai/sample-agent`](../openai/sample-agent) sample.

## Demonstrates

- The recommended init order: existing OTel → Agent 365 `configure()` → OpenAI Agents SDK instrumentor.
- Auto-instrumentation via `microsoft-agents-a365-observability-extensions-openai` — no manual span code in the agent body.
- Both Azure Monitor and the Agent 365 backend receive every span produced by the agent.

## Prerequisites

- Python 3.11+
- An OpenAI or Azure OpenAI key
- An Application Insights resource (connection string)

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

Expected stdout: a one-line weather answer for Seattle.

## What to look for

In Azure Portal → your Application Insights resource → **Transaction search**, look for spans with the custom-dimension attribute `gen_ai.operation.name`. You should see three operation types across one turn:

- `invoke_agent` — the agent invocation (root span; display name `invoke_agent WeatherAgent`)
- `Chat` — one or more LLM call spans (display name e.g. `Chat gpt-4o-mini`; the value comes from the configured `InferenceOperationType` — Auto-instrumentation defaults to `Chat`)
- `execute_tool` — the `get_weather` tool span (display name `execute_tool get_weather`)

If you see those three operation types, the integration is working. The Agent 365 backend receives the same spans (configured via the stub token resolver — replace with a real one for production).

## Where the integration happens

`main.py` is organized into the following sections (Step 2b is a sub-step that must run after Step 2):

1. **Step 1 — Azure Monitor.** `configure_azure_monitor(...)` installs an OTel TracerProvider and the Azure Monitor exporter. This is the part of the file you'd already have in your real app.
2. **Step 2 — Agent 365 `configure()`.** Detects the TracerProvider set by Step 1 and adds its processors to it. Both backends now receive spans. Replace `_stub_token_resolver` with your production token resolver.
3. **Step 2b — `OpenAIAgentsTraceInstrumentor`.** Must run after `configure()`; the instrumentor raises `RuntimeError` otherwise. After this call, OpenAI Agents SDK spans flow through Agent 365's scope classes automatically.
4. **Step 3 — Build the agent.** Standard OpenAI Agents SDK code; no observability code needed (the instrumentor handles it).
5. **Step 4 — Run + flush.** `force_flush()` is critical — without it, batched spans may not export before the process exits.

To diff against your own app: copy Steps 1, 2, and 2b into the file where your app currently initializes Azure Monitor.

## Going further

- Integration patterns and pitfalls: [Integrating with existing OpenTelemetry](https://github.com/microsoft/Agent365-python/blob/main/docs/integrating-with-existing-opentelemetry.md) (in the SDK repo)
- Manual instrumentation example (no agent framework): [`python/observability-with-otlp`](../observability-with-otlp)

## Troubleshooting

- **`SystemExit: APPLICATIONINSIGHTS_CONNECTION_STRING is not set`** — set the env var via `.env`. The connection string is on your App Insights resource → **Overview** → **Connection String**.
- **No spans visible in App Insights** — wait 1–2 minutes for ingestion; confirm the connection string targets the right resource. If the agent ran successfully but spans never appear, temporarily add a `ConsoleSpanExporter` (see [the integration guide's verify recipe](https://github.com/microsoft/Agent365-python/blob/main/docs/integrating-with-existing-opentelemetry.md#verifying-the-integration)) to prove the SDK is producing them.
- **`SystemExit: Agent 365 observability configuration failed`** — check logs for the failing step (most often a missing or unreachable token resolver in production; the sample uses a stub).
- **OpenAI auth errors** — verify `OPENAI_API_KEY` (or `AZURE_OPENAI_*` variables) in `.env`. The OpenAI Agents SDK reads these directly.
