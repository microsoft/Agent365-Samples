# Design — Native Apex Agent 365 Observability

This document describes the architecture of the Salesforce Apex observability sample: how Apex emits
its own Agent 365 OTLP spans, the token model, the OTLP wire shape, and the module dependency graph.

## Goal

Make the Salesforce **Apex** layer a first-class Agent 365 telemetry emitter. When an agent turn
calls into Salesforce, Apex emits its **own** span correlated — by a shared W3C trace id — to the
agent turn that invoked it, rather than being visible only through the agent's `execute_tool` span.

## Two flows, one trace id

1. **Boundary emission (reuse the inbound trace).** `A365ToolRest` (REST) and `A365Callout`
   (outbound) read the inbound `traceparent`, reply/act, then emit a span that **reuses** the inbound
   `traceId` and nests under the agent's `execute_tool` span via `parentSpanId`. With no inbound
   `traceparent`, no span is emitted — a trace is **never** fabricated on this path.

2. **Origination (create the trace).** `A365AgentforceTool` runs inside an Agentforce turn where
   there is no inbound `traceparent`. It derives a deterministic `traceId` and root span id from the
   session id (`A365Trace.traceIdFromSeed` / `spanIdFromSeed`), so every span of a conversation
   shares one trace and nests under one reconstructable `invoke_agent` root — even across independent
   Apex transactions. The root is deduped (per-transaction static + Platform Cache).

## Components

```
A365ToolRest ─┐                         ┌─ A365ObsConfig (CMDT reader; non-secret config)
A365Callout  ─┼─▶ A365Telemetry ──────▶ ┼─ A365Trace    (W3C helpers + deterministic seeds)
A365Agentforce┘   (façade: gate,        └─ A365ObsSpan   (pure OTLP body builder)
Tool              fail-open, async)
                        │
                        ▼
                 A365TelemetryQueueable ──▶ A365ObsToken (FMI 3-hop, agent-bound, cached)
                 (async worker, callouts)──▶ callout:A365_Obs_Ingest (OTLP POST)
```

Dependency direction (no cycles):
`A365ToolRest`/`A365Callout`/`A365AgentforceTool` → `A365Telemetry` → (`A365ObsConfig`, `A365Trace`,
`A365ObsSpan`); `A365TelemetryQueueable` → (`A365ObsToken`, `A365ObsSpan`).

## Design rules

- **Fail-open** — every public emit path is wrapped so any error is swallowed (debug-logged only) and
  never affects the business response.
- **Async** — the span POST runs in a `Queueable` after the synchronous reply. Span data is captured
  in the worker's constructor because the async context loses the REST request.
- **Config-gated** — `A365_Observability_Config__mdt.Enabled__c` (boundary) and `OriginateEnabled__c`
  (origination) are independent kill switches; absent config fails safe (disabled).
- **Secret-free metadata** — the only secret (the blueprint client secret) lives in the
  `A365_Obs_Entra` External Credential, entered in Setup. No secret appears in Apex or git.

## Token model (FMI 3-hop, agent-bound)

> **Background:** this uses Microsoft Entra **Agent ID** — an agent identity blueprint plus Federated
> Managed Identity (FMI) and the `jwt-bearer` grant. For the identity model and OAuth grant types, see
> [Microsoft Entra Agent ID — Agent OAuth flows](https://learn.microsoft.com/en-us/entra/agent-id/agent-on-behalf-of-oauth-flow).
> The steps below show only what the Apex sample sends on the wire.

MSAL is unavailable in Apex, so each hop is a raw `application/x-www-form-urlencoded` POST. The ingest
enforces `{agentId}`-in-URL == token `azp`/`appid` plus the app-role claim, so a plain dedicated-app
token is rejected (403). The sample therefore mints an **agent-bound** token:

1. **Hop 1/2** — as the blueprint app: `client_credentials` + `scope=api://AzureADTokenExchange/.default` +
   `fmi_path=<agentId>`, client auth = `Basic` (from the External Credential). Yields a T1 FMI
   assertion. (`A365_Obs_Token` Named Credential.)
2. **Hop 3** — as the agent id: `client_credentials` + `client_id=<agentId>` +
   `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` +
   `client_assertion=T1` + `scope=<obs>/.default`. Yields the agent-bound token (`azp=agentId`,
   `roles=[Agent365.Observability.OtelWrite]`). (`A365_Obs_TokenJwt` Named Credential.)
3. **Ingest** — `POST {ingestBase}/observabilityService/tenants/{tenantId}/otlp/agents/{agentId}/traces?api-version=1`
   with `Authorization: Bearer <token>`. (`A365_Obs_Ingest` Named Credential.)

The token is cached (per-transaction static + Platform Cache `A365Obs` partition; TTL from the JWT
`exp` minus a safety skew) so a high-frequency emit path does not repeat the hops per span.

## OTLP wire shape

`A365ObsSpan` mirrors the live Agent 365 exporter rather than hand-rolling standard OTLP:

- `attributes` is a flat object **map** (not an array of key/value).
- `kind` and `status.code` are enum **strings**; `*UnixNano` are **numbers**.
- resource key `microsoft.tenant.id`; request header `x-ms-tenant-id`.
- correlation keys: `traceId` (reused or seeded), `parentSpanId` (the agent's `execute_tool` span on
  the boundary path), and `gen_ai.operation.name = execute_tool`.

Because `A365ObsSpan` performs no callouts, it is unit-tested directly for body shape, attribute
flattening, trace reuse, and parent linkage.

## Configuration surface

`A365_Observability_Config__mdt.Default` carries non-secret runtime config (enable flags, tenant/agent
ids, endpoints, scopes, service names). `A365ObsConfig` reads it with safe built-in defaults so a
fresh org degrades gracefully. The record is seeded at runtime (`scripts/create-obs-config.apex`)
because CustomMetadata *records* can fail to deploy via the CLI on some orgs.
