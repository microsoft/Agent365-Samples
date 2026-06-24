# Salesforce Apex — Native Agent 365 Observability

This sample shows how **Salesforce Apex** can participate in [Microsoft Agent 365](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
observability as a **first-class telemetry emitter**. When an Agent 365 agent calls into Salesforce
(or an Agentforce agent runs a Salesforce action), the Apex code emits its **own** Agent 365 OTLP
spans — correlated to the agent turn by a shared W3C trace id — so Salesforce proves it ran from
*its own* telemetry, not just the agent's `execute_tool` span.

Because MSAL is unavailable in Apex, the sample hand-rolls the **S2S OAuth FMI 3-hop** that mints an
**agent-bound** Observability token directly in Apex, then POSTs spans to the Agent 365 OTLP ingest.
All emission is **fail-open**, **async**, and **config-gated**, so telemetry never affects the
business response.

For comprehensive documentation, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## What This Sample Demonstrates

| Pattern | Where |
|---------|-------|
| Apex exposed as an Agent 365 tool surface (REST) | `classes/A365ToolRest.cls` |
| Apex `@InvocableMethod` action for the Agentforce path | `classes/A365AgentforceTool.cls` |
| Outbound Apex → Agent 365 callout (correlated CLIENT span) | `classes/A365Callout.cls` |
| Native Apex OTLP span emission (fail-open, async, config-gated) | `classes/A365Telemetry.cls`, `classes/A365TelemetryQueueable.cls` |
| Hand-rolled FMI 3-hop **agent-bound** token in Apex (no MSAL) | `classes/A365ObsToken.cls` |
| OTLP body builder mirroring the Agent 365 exporter wire shape | `classes/A365ObsSpan.cls` |
| Salesforce **originating** a trace (Agentforce-native) | `classes/A365Telemetry.cls` (`originate*`), `classes/A365Trace.cls` |
| Secret-free credential metadata (External / Named Credentials) | `externalCredentials/`, `namedCredentials/` |
| Non-secret runtime config via Custom Metadata | `objects/A365_Observability_Config__mdt/`, `customMetadata/` |

## How It Works

Two complementary flows, one shared trace id:

```
Agent turn ──POST /services/apexrest/a365tool, traceparent: 00-T-S-01──▶ A365ToolRest.doPost
                                                              ├─ reply synchronously (fast, unchanged)
                                                              └─ A365Telemetry.emitToolSpan(...)   (fail-open)
                                                                    └─ enqueue A365TelemetryQueueable (async)
                                                                          ├─ A365ObsToken.getToken()  → FMI 3-hop, agent-bound token
                                                                          ├─ A365ObsSpan.buildBody(...) → OTLP body (traceId=T, parent=S)
                                                                          └─ POST callout:A365_Obs_Ingest → ingest 200
```

Design rules (all enforced in code):

- **Fail-open** — telemetry never breaks the business response. Any error is swallowed (debug-logged only).
- **Async** — the span POST runs in a `Queueable` *after* the synchronous reply, so latency is unchanged.
- **Config-gated** — `A365_Observability_Config__mdt.Enabled__c = false` is a no-op kill switch.
- **Never fabricate a trace** — no inbound `traceparent` ⇒ no span. The Apex span reuses the agent
  turn's `traceId` and nests under its `execute_tool` span (`parentSpanId`). (The Agentforce
  *origination* path is the deliberate exception — it derives a deterministic trace id from the
  session id; see [`agent/README.md`](agent/README.md).)

## Classes

| Class | Role |
| --- | --- |
| **`A365ToolRest`** | Apex REST endpoint `POST /services/apexrest/a365tool`. Reads `traceparent` from the HTTP header, replies, then emits a **SERVER** span (`gen_ai.tool.type = salesforce-apex`). |
| **`A365AgentforceTool`** | `@InvocableMethod` action for the Agentforce path. **Originates** an Agent 365 trace (root `invoke_agent` + `execute_tool`) seeded from the session id. |
| **`A365Callout`** | Outbound Apex → Agent 365 `/callback` callout (optional; set the `A365_Callback` endpoint). Emits a **CLIENT** span correlated to the same trace. |
| **`A365Telemetry`** | Public façade — the only entry point business code calls. Gates on config, requires a traceparent (boundary path), fail-open, enqueues the worker. |
| **`A365TelemetryQueueable`** | Async worker (`Queueable, Database.AllowsCallouts`). Acquires the token, builds the body, POSTs the span. |
| **`A365ObsToken`** | Mints the **agent-bound** Observability token via the FMI 3-hop (see Auth below). Caches it (per-transaction static + Platform Cache). |
| **`A365ObsSpan`** | Pure OTLP-body builder mirroring the Agent 365 exporter wire shape (flat-map attributes, string `kind`/`status`). No callouts → trivially unit-testable. |
| **`A365ObsConfig`** | Thin reader over the `A365_Observability_Config__mdt` `Default` record. **Never** holds secrets. |
| **`A365Trace`** | W3C trace-context helpers: `parseTraceparent(header)`, `newSpanId()`, deterministic `*FromSeed`. |
| `*Test` | Unit tests (`HttpCalloutMock` for token + ingest): body shape, trace reuse, parent linkage, no-op when disabled, fail-open. |

## Authentication + Identity

| Aspect | Model |
|--------|-------|
| **Authentication** | App-based (S2S OAuth to Microsoft Entra, hand-rolled in Apex) |
| **Identity** | Agent identity (token `azp` == agent id) |

The Agent 365 ingest requires an **agent-bound** token (`{agentId}` in the URL == token `azp`, plus the
app-role claim), minted via an **FMI 3-hop** (2 token POSTs) sponsored by the agent **blueprint** app —
JWT-bearer client-credentials, not OBO. See [Token model](docs/design.md#token-model-fmi-3-hop-agent-bound)
for the exact per-hop requests and Named Credentials.

## Prerequisites

- [Salesforce CLI (`sf`)](https://developer.salesforce.com/tools/salesforcecli) and a Salesforce org
  (a [scratch org](https://developer.salesforce.com/docs/atlas.en-us.sfdx_dev.meta/sfdx_dev/sfdx_dev_scratch_orgs.htm)
  via a Dev Hub, or a Developer Edition org)
- An Entra tenant onboarded to Agent 365, with at minimum the **Agent ID Developer** role
- An Agent 365 **agent** and its **blueprint** app registration (the blueprint sponsors the FMI chain).
  See the [Agent 365 CLI](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/agent-365-cli)
  (`a365 setup all`) for provisioning the blueprint + agent identity.

## Project Layout

```
apex-observability/
├── force-app/main/default/   # deployable metadata (Apex, config, credentials, permission set)
├── scripts/                  # Execute-Anonymous helpers (seed config, verify a span)
├── agent/                    # OPTIONAL Agentforce agent (reference + per-org build steps)
├── sfdx-project.json
└── .forceignore
```

## Deploy

```bash
cd salesforce/apex-observability
sf project deploy start --source-dir force-app/main/default --target-org <your-org-alias> --test-level RunLocalTests
```

> **Custom Metadata record caveat:** the CMDT *type + fields* deploy normally, but the `Default`
> **record** can fail to deploy via the CLI on some orgs (opaque `UNKNOWN_EXCEPTION`). It is excluded
> by `.forceignore` and seeded at runtime instead (next section).

After deploying:

1. **Seed the config record.** Edit the `<<...>>` placeholders in
   [`scripts/create-obs-config.apex`](scripts/create-obs-config.apex), then:

   ```bash
   sf apex run --file scripts/create-obs-config.apex --target-org <your-org-alias>
   ```

2. **Enter the blueprint secret (Setup only, never git).**
   `Setup → Named Credentials → External Credentials → "A365 Obs Entra" → Principals → BlueprintPrincipal`,
   add a custom Authentication Parameter:

   ```
   Name  = BlueprintBasicAuth
   Value = base64("<your-blueprint-app-id>:<blueprint-client-secret>")
   ```

   Compute the value (strip any trailing CR):

   ```bash
   printf '%s' '<your-blueprint-app-id>:<secret>' | base64 -w0
   ```

3. **Assign the permission set** to the running user (REST integration user and/or Agentforce agent
   running user):

   ```bash
   sf org assign permset --name A365_Observability --target-org <your-org-alias>
   ```

4. **(Optional) Set the callback endpoint** — only needed to exercise the outbound `A365Callout` path
   (CLIENT span). Point the `A365_Callback` Named Credential at a public HTTPS URL that forwards to your
   agent's `/callback` (e.g. a dev tunnel): `Setup → Named Credentials → "A365 Callback" → edit URL`.
   Don't commit your live tunnel URL. The inbound boundary (`A365ToolRest`) and ingest paths work without it.

## Configuration

Non-secret runtime config lives in the `A365_Observability_Config__mdt.Default` record (seeded by the
script above). Secrets are **never** here — only in the External Credential entered in Setup.

| Field | Default | Description |
|-------|---------|-------------|
| `Enabled__c` | `true` | Master kill switch for the boundary emitter (`false` = no-op). |
| `TenantId__c` | `<<TENANT_ID>>` | Entra tenant id. |
| `AgentId__c` | `<<AGENT_ID>>` | Agent 365 agent id (in the ingest URL; token `azp` must match). |
| `IngestBase__c` | `https://agent365.svc.cloud.microsoft` | OTLP ingest host. |
| `ObsScope__c` | `api://9b975845-…/.default` | Observability API scope (public resource). |
| `FmiScope__c` | `api://AzureADTokenExchange/.default` | FMI token-exchange scope. |
| `UseS2SEndpoint__c` | `true` | Use the roles-enforced S2S ingest path. |
| `ServiceName__c` | `salesforce-apex` | `service.name` for boundary spans. |
| `AgentforceServiceName__c` | `salesforce-agentforce` | `service.name` for originated (Agentforce) spans. |
| `OriginateEnabled__c` | `false` | Enable the Agentforce origination path (see `agent/`). |

## Testing

### Unit tests

```bash
sf apex run test --target-org <your-org-alias> --test-level RunLocalTests --wait 10
```

The test suite uses `HttpCalloutMock` for the token + ingest hops and asserts the OTLP body shape,
trace reuse, parent linkage, the disabled no-op, and fail-open behavior.

### Live span smoke test

After deploy + secret entry + permission set:

```bash
sf apex run      --file scripts/verify-span.apex --target-org <your-org-alias>
sf apex tail log --target-org <your-org-alias>
```

The async worker logs the ingest HTTP status. On success, expect an INFO line like
`A365Telemetry ingest 200 spanId=<…> traceId=<…> corr=<…>`. On a non-2xx it logs the
status, `x-ms-correlation-id`, and the response body (which includes `rejectedSpans`).

### End-to-end (with an agent)

Point an Agent 365 agent's Salesforce tool at `POST /services/apexrest/a365tool`. A single agent turn
then produces one trace carrying both the agent's `execute_tool` span and the Apex SERVER span,
correlated by the shared `traceId`.

## Optional: Agentforce origination

To have **Salesforce originate** a trace from an Agentforce turn, build the optional Agentforce agent
that calls the `A365AgentforceTool` action and set `OriginateEnabled__c = true`. The agent is
org-specific, so it ships as a documented **reference** — see [`agent/README.md`](agent/README.md).

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| No span ingested, no error | Telemetry is fail-open — check the debug log (`sf apex tail log`) for a swallowed warning. |
| Token hop returns `401 AADSTS7002134` | `AgentId__c` and the External Credential's blueprint Basic value are not a matched blueprint→agent pair. |
| `You don't have read permissions on the User External Credential object` | The running user is missing the `A365_Observability` permission set (it grants `UserExternalCredential` read + the EC principal). |
| Ingest `403` | The token is not agent-bound (`azp` ≠ `AgentId__c`), or the tenant is not onboarded to Agent 365. |
| Nothing emitted at all | `Enabled__c = false`, or no inbound `traceparent` (the boundary path never fabricates a trace). |

## Observability

The boundary path (`A365ToolRest`, `A365Callout`) **reuses** the inbound agent trace and nests Apex
spans under the agent's `execute_tool` span. The origination path (`A365AgentforceTool`) **creates**
a trace deterministically from the session id, so an Agentforce turn surfaces as a first-class agent
trace. `A365ObsSpan` emits the Agent 365 exporter wire shape exactly — see
[OTLP wire shape](docs/design.md#otlp-wire-shape) for the field-level contract.

For details on the observability SDK and instrumentation patterns, see the
[Agent observability guide](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability).

## Support

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-Samples/issues) section
- **Documentation**: See the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: For security issues, please see [SECURITY.md](../../SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a
CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/)
or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- [Agent observability guide](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability)
- [Design notes](docs/design.md)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License — see the [LICENSE](../../LICENSE.md) file for details.
