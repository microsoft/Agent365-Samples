# Multi-Agent Sales Campaign Demo

This sample demonstrates **multi-agent orchestration** with Microsoft Agent 365 telemetry, designed for **local testing**. Four independently hosted agents collaborate through HTTP to execute a sales campaign, producing a clean trace in A365 observability that shows every agent-to-agent call as a distinct span.

All outputs are stubbed so the demo runs deterministically — no LLM API key required. All four agents are Bot Framework agents (`AgentApplication` + `CloudAdapter`) that can later be deployed independently to Microsoft Teams or Copilot Studio. The orchestrator coordinates the sub-agents via direct HTTP calls (`/api/run`) during the pipeline, while each sub-agent also exposes `/api/messages` for standalone Bot Framework interaction.

## What This Sample Demonstrates

- **Multi-agent orchestration**: An orchestrator coordinates three sub-agents (planner, executor, reviewer), each running as a Bot Framework agent on its own port
- **Agent-to-agent (A2A) communication**: The orchestrator calls sub-agents via HTTP POST with `ExecutionType.Agent2Agent`
- **A365 observability spans**: Full parent/child span tree visible in the telemetry viewer
- **W3C trace context propagation**: Uses the SDK's built-in `injectTraceContext()` and `runWithExtractedTraceContext()` to propagate `traceparent`/`tracestate` headers so all spans appear in one trace
- **Copilot Studio ready**: Each sub-agent is a full Bot Framework agent (`AgentApplication` + `CloudAdapter` + `/api/messages`) that can be deployed independently to Teams or Copilot Studio

## Architecture

Each agent exposes two endpoints: `/api/messages` (Bot Framework protocol for Teams/Copilot Studio) and `/api/run` (direct HTTP for pipeline orchestration).

```
                          ┌──────────────────────────────────────────┐
                          │  Orchestrator (port 3978)                │
                          │  /api/messages (Bot Framework)           │
                          │                                          │
                          │  Sequential State Machine:               │
User ──── /api/messages ──│  Step 1: POST /api/run → Planner        │
                          │  Step 2: POST /api/run → Executor       │
                          │  Step 3: POST /api/run → Reviewer       │
                          │  Step 4: POST /api/run → Executor       │
                          │  Step 5: POST /api/run → Reviewer       │
                          └────┬──────────┬──────────┬──────────────┘
                               │          │          │
                    ┌──────────┘    ┌─────┘    ┌─────┘
                    ▼               ▼          ▼
             ┌─────────────┐ ┌───────────┐ ┌───────────┐
             │  Planner    │ │ Executor  │ │ Reviewer  │
             │  (port 4001)│ │ (port 4002)│ │ (port 4003)│
             │  /api/run   │ │ /api/run  │ │ /api/run  │
             │  /api/msgs  │ │ /api/msgs │ │ /api/msgs │
             └─────────────┘ └───────────┘ └───────────┘
```

## Telemetry Span Tree

All spans share a single **trace ID** linked by W3C `traceparent` header propagation across the 4 separate processes. The SDK's `injectTraceContext()` and `runWithExtractedTraceContext()` handle this automatically.

### Expected span tree

```
invoke_agent (root – orchestrator)         [a365.run_id, a365.scenario]
├─ invoke_agent (planner)                  [a365.agent.role=planner, step=1]
│  └─ Chat stubbed-planner                [InferenceScope]
├─ invoke_agent (executor – draft)         [a365.agent.role=executor, step=2]
│  ├─ Chat stubbed-executor               [InferenceScope]
│  │  ├─ execute_tool crm.searchContacts  [ExecuteToolScope]
│  │  └─ execute_tool crm.createCampaign  [ExecuteToolScope]
├─ invoke_agent (reviewer – BLOCK)         [a365.review.status=blocked, step=3]
│  └─ Chat stubbed-reviewer               [InferenceScope]
├─ invoke_agent (executor – fix)           [a365.agent.role=executor, step=4]
│  ├─ Chat stubbed-executor               [InferenceScope]
│  │  └─ execute_tool crm.createActivities [ExecuteToolScope]
└─ invoke_agent (reviewer – APPROVE)       [a365.review.status=approved, step=5]
   └─ Chat stubbed-reviewer               [InferenceScope]
```

### Example trace output (real span IDs)

Below is the actual trace map from a local test run. Every span shares trace ID `4ab50a2cddc126a967e3e9e19d4fba4e`, proving W3C context propagation works across 4 separate processes:

```
Trace: 4ab50a2cddc126a967e3e9e19d4fba4e    Run: run-1772582956532

[orch] invoke_agent "Sales Campaign Orchestrator"  (root span)
│
├─[orch] invoke_agent planner  (spanId: 948988dc3d719c69)
│  └─[plan] Chat stubbed-planner  (id: 0fbdf6d70bb489de, parent: 948988dc3d719c69, remote: true)
│           gen_ai.agent.id=planner-agent  a365.step=1  tokens: 120→85
│
├─[orch] invoke_agent executor-draft  (spanId: 98d7ee62f2d8a6ae)
│  └─[exec] Chat stubbed-executor  (id: 1fa20b51edf4a01e, parent: 98d7ee62f2d8a6ae, remote: true)
│     │     gen_ai.agent.id=executor-agent  a365.step=2  tokens: 200→150
│     ├─[exec] execute_tool crm.searchContacts  (id: ed64543e20487a41, parent: 1fa20b51edf4a01e)
│     │        50 contacts returned
│     └─[exec] execute_tool crm.createCampaign  (id: 1c4cf7a2d8e385c9, parent: 1fa20b51edf4a01e)
│              campaign: cmp-demo-001
│
├─[orch] invoke_agent reviewer-BLOCK  (spanId: 34127cbc6e1f2f51)
│  └─[rev] Chat stubbed-reviewer  (id: d38121f2866c5f37, parent: 34127cbc6e1f2f51, remote: true)
│          a365.review.status=blocked  a365.step=3  tokens: 250→90
│          reason: "Missing GDPR opt-out link"
│
├─[orch] invoke_agent executor-fix  (spanId: 7222f050af92d767)
│  └─[exec] Chat stubbed-executor  (id: 7cf90b708a331a5c, parent: 7222f050af92d767, remote: true)
│     │     gen_ai.agent.id=executor-agent  a365.step=4  tokens: 180→120
│     └─[exec] execute_tool crm.createActivities  (id: c8dc4e7cd99dc736, parent: 7cf90b708a331a5c)
│              150 activities created
│
└─[orch] invoke_agent reviewer-APPROVE  (spanId: b393aadc2cdc4661)
   └─[rev] Chat stubbed-reviewer  (id: f633f7473b619296, parent: b393aadc2cdc4661, remote: true)
           a365.review.status=approved  a365.step=5  tokens: 250→90
           reason: "All GDPR compliance requirements met"
```

Key observations from the trace:
- **Single trace ID** (`4ab50a2c...`) — all 7 sub-agent spans + orchestrator spans share one trace
- **`remote: true`** on parent context — confirms spans crossed HTTP service boundaries via `traceparent` header
- **Parent-child linkage** — each `Chat` span's parent matches the orchestrator's `invoke_agent` span ID
- **Tool spans nest under inference** — `execute_tool` spans are children of their `Chat` span, not siblings
- **4 separate PIDs** — spans come from 4 independent Node.js processes (orchestrator, planner, executor, reviewer)

### Example span object (console exporter)

Each span printed to console looks like this (planner example):

```json
{
  "instrumentationScope": { "name": "Agent365Sdk" },
  "traceId": "4ab50a2cddc126a967e3e9e19d4fba4e",
  "parentSpanContext": {
    "traceId": "4ab50a2cddc126a967e3e9e19d4fba4e",
    "spanId": "948988dc3d719c69",
    "traceFlags": 1,
    "isRemote": true
  },
  "name": "Chat stubbed-planner",
  "id": "0fbdf6d70bb489de",
  "kind": 2,
  "attributes": {
    "gen_ai.system": "az.ai.agent365",
    "gen_ai.operation.name": "Chat",
    "gen_ai.agent.id": "planner-agent",
    "gen_ai.agent.name": "Planner Agent",
    "gen_ai.request.model": "stubbed-planner",
    "gen_ai.conversation.id": "run-1772582956532",
    "tenant.id": "demo-tenant",
    "correlation.id": "corr-1772582956304",
    "session.description": "Multi-agent sales campaign pipeline",
    "a365.agent.role": "planner",
    "a365.step": 1,
    "a365.run_id": "run-1772582956532",
    "gen_ai.usage.input_tokens": "120",
    "gen_ai.usage.output_tokens": "85",
    "gen_ai.response.finish_reasons": "stop",
    "gen_ai.input.messages": "[\"...\"]",
    "gen_ai.output.messages": "[\"...\"]"
  },
  "resource": {
    "attributes": {
      "service.name": "Multi-Agent Planner-1.0.0",
      "host.name": "pefan4-0",
      "process.pid": 88752
    }
  }
}
```

## Prerequisites

- **Node.js** 18+ (for built-in `fetch`)
- **npm** or **yarn**

No LLM API key is needed — all agent logic uses deterministic stubs.

## Configuration

Copy the template and adjust if needed:

```bash
cp .env.template .env
```

Default ports:
| Service | Port |
|---|---|
| Orchestrator | 3978 |
| Planner | 4001 |
| Executor | 4002 |
| Reviewer | 4003 |

## How to Run

### Step 1: Install dependencies

```bash
npm install
```

### Step 2: Configure environment

```bash
cp .env.template .env
```

Ensure `.env` has `NODE_ENV=development` (this disables JWT auth for local testing).

### Step 3: Start all services

```bash
npm run dev
```

All four services start simultaneously via `concurrently`. You should see:

```
[orch] [Orchestrator] listening on localhost:3978 for appId undefined
[plan] [Planner] listening on localhost:4001 for appId undefined
[exec] [Executor] listening on localhost:4002 for appId undefined
[rev]  [Reviewer] listening on localhost:4003 for appId undefined
```

The `appId undefined` is expected in development mode (no Azure AD credentials configured).

### Step 4: Send a message via Agents Playground

In a separate terminal (while `npm run dev` is running):

```bash
npm run test-tool
```

This launches the Agents Playground UI in your browser. Set the bot endpoint URL to `http://localhost:3978/api/messages` (or the port set by `ORCHESTRATOR_PORT` in `.env`) and send a message:

> Launch a Q1 EMEA enterprise sales campaign targeting accounts with 500+ employees

The orchestrator runs the 5-step pipeline and returns a formatted result. The console output shows the pipeline progress:

```
[orch] [Orchestrator] Starting pipeline run-1772582956532
[orch] [Orchestrator] Step 1/5: Calling Planner...
[plan] [Planner] Step 1: Generated campaign plan for "Enterprise accounts in EMEA with >500 employees"
[orch] [Orchestrator] Step 2/5: Calling Executor (draft)...
[exec] [Executor] Step 2: Draft — 50 contacts, campaign "cmp-demo-001"
[orch] [Orchestrator] Step 3/5: Calling Reviewer (round 1)...
[rev]  [Reviewer] Step 3: Round 1 — BLOCKED
[orch] [Orchestrator] Step 4/5: Calling Executor (fix)...
[exec] [Executor] Step 4: Fix — created 150 activities
[orch] [Orchestrator] Step 5/5: Calling Reviewer (round 2)...
[rev]  [Reviewer] Step 5: Round 2 — APPROVED
[orch] [Orchestrator] Pipeline run-1772582956532 complete!
```

### Step 5: View telemetry spans

After the pipeline completes, the console exporter prints OTel span objects from each service. These spans contain all the data needed to reconstruct the trace tree in a telemetry viewer.

### Alternative: Test sub-agents directly with curl

```bash
# Health check
curl http://localhost:3978/api/health

# Test a sub-agent directly (bypasses orchestrator)
curl -X POST http://localhost:4001/api/run \
  -H "Content-Type: application/json" \
  -d '{"runId":"test-001","step":1,"payload":{"request":"test campaign"}}'
```

### Build for production

```bash
npm run build
npm start
```

### Stop all services

Press `Ctrl+C` in the terminal running `npm run dev`.

## Scenario Walkthrough

1. **Planner** (Step 1): Receives the campaign brief and returns a plan targeting "Enterprise accounts in EMEA with >500 employees" via email, LinkedIn, and webinar channels.

2. **Executor — Draft** (Step 2): Searches the CRM for 50 matching contacts and creates campaign `cmp-demo-001`.

3. **Reviewer — BLOCK** (Step 3): Reviews the draft and blocks it because the email template is missing a GDPR opt-out link.

4. **Executor — Fix** (Step 4): Applies the required fixes and creates 150 follow-up activities (3 touches per contact) with opt-out links.

5. **Reviewer — APPROVE** (Step 5): Verifies compliance and approves the campaign for launch.

## Deploy to Microsoft Teams / Copilot Studio

> **TBD** — Detailed deployment instructions will be added in a future update. All four agents are Bot Framework agents with `AgentApplication`, `CloudAdapter`, and `/api/messages` — each can be deployed independently to Teams or Copilot Studio with its own Azure AD App Registration. See `.env.template` for auth configuration.

## Deploy to Production

> **TBD** — Production deployment guide (Azure App Service, Container Apps) will be added in a future update.

