# Standalone Copilot SDK Agent - TypeScript Sample

An **experimental**, local-first, single-invocation console agent using the released GitHub Copilot SDK. It demonstrates deterministic custom tools and application-side Agent 365 observability without changing the standalone runtime into a Teams host, AI Teammate, or Digital Worker. This is a development sample, not a production-ready service.

For comprehensive documentation, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## What This Sample Demonstrates

| Pattern | Where |
|---------|-------|
| Pinned SDK and bundled runtime; no global Copilot install | `package.json`, `src/config.ts` |
| Standalone session with only two custom tools; ambient discovery disabled | `src/agent.ts` |
| Deterministic `add_numbers` and intentional `fail_deliberately` | `src/tools.ts` |
| Correlated invocation/session/tool events, explicit identity, cleanup | `src/telemetry.ts` |
| Blueprint-to-agent S2S token resolver with expiry-aware caching | `src/auth.ts` |
| Network-free smoke and unit tests, including failure paths | `src/smoke.ts`, `test/sample.test.ts` |

## Prerequisites

- [Node.js](https://nodejs.org/) **22.12+** and [npm](https://docs.npmjs.com/).
- Released [`@github/copilot-sdk` **1.0.14**](https://github.com/github/copilot-sdk/releases/tag/v1.0.14). Its exact optional platform package **1.0.14** bundles Copilot runtime **1.0.85**. Keep optional dependencies enabled; do not set `COPILOT_CLI_PATH`.
- [`@microsoft/opentelemetry`](https://github.com/microsoft/opentelemetry-distro-javascript) **1.4.0** and `@azure/msal-node` **7.0.0**; all direct dependencies are exact pins.
- Only for actual model calls: an eligible GitHub Copilot account/token or existing CLI login, plus model access. Azure OpenAI credentials are not used.
- Only for A365 export: an existing Entra agent identity blueprint, its agent identity, a development blueprint credential, admin-approved application `Agent365.Observability.OtelWrite`, and a tenant eligible for ingestion.
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) and [Agent 365 CLI](https://learn.microsoft.com/microsoft-agent-365/developer/agent-365-cli) are optional provisioning tools, **not runtime dependencies**. Provisioning requires appropriate tenant roles; smoke needs none.

## Authentication + Identity

| Aspect | Model |
|--------|-------|
| **Authentication** | App-based |
| **Identity** | Agent identity |

GitHub authentication and A365 authentication are independent. Copilot uses `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` (in that order), or the existing CLI login; it never logs in or changes saved credentials.

For explicit A365 export, `src/auth.ts` implements the [documented autonomous agent flow](https://learn.microsoft.com/entra/agent-id/autonomous-agent-authentication-authorization-flow): MSAL requests a blueprint token for `api://AzureADTokenExchange/.default` with typed `fmiPath = agent identity client ID`, then uses that token as the agent application's `clientAssertion` to request `api://9b975845-388f-4429-889e-eab1ef63949c/.default`. The resolver validates agent/tenant/scope, caches to actual expiry minus five minutes, coalesces concurrent refreshes, and fails rather than returning empty or stale tokens.

No interactive administrator token, OBO, agent user, or generic app-only token is substituted. The blueprint secret is **development-only**, never passed to the Copilot subprocess, and never included in telemetry.

## Environment Configuration

### Agent 365 Setup

Provisioning is outside this sample. Obtain the tenant ID, blueprint **client ID**, agent identity **client ID** (not object ID), and a securely supplied blueprint credential from the tenant owner. The agent identity must have the Observability API application permission and tenant eligibility.

Use the [autonomous agent authentication guide](https://learn.microsoft.com/entra/agent-id/autonomous-agent-authentication-authorization-flow) for identity and consent prerequisites. The standalone route does **not** require `a365 setup all`, bot registration, agent users, Teams manifests, or endpoints.

Creating an Entra agent identity and registering an agent in the Agent 365 registry are distinct operations. Neither a configured identity nor successful telemetry delivery proves registry registration. This sample does not perform either operation.

### Configuration

Copy `.env.example` to `.env` or inject environment variables securely. Both `npm start` and `npm run runtime:check` load `.env` when present; process environment values take precedence.

`.env` variants, the default `.copilot-local/` runtime directory, `.copilot-traces/`, and `telemetry*.json` are ignored by Git. For custom `COPILOT_SAMPLE_HOME` or `COPILOT_TRACE_FILE` values, prefer **absolute paths outside the repository**: arbitrary custom paths are not automatically ignored. Traces omit prompt content but can contain tenant/agent attribution, and runtime state can contain conversation data. Do not commit either, credentials, or captured console output.

| Variable | Default / meaning | Set by |
|----------|-------------------|--------|
| `ENABLE_A365_OBSERVABILITY` | `true`; application tracing | Manual |
| `ENABLE_A365_OBSERVABILITY_EXPORTER` | **`false`**; explicitly set `true` to contact A365 | Manual |
| `OTEL_LOG_LEVEL` | `ERROR` in example; no verbose payload diagnostics | Manual |
| `A365_OBSERVABILITY_LOG_LEVEL` | `error` in example | Manual |
| `COPILOT_MODEL` | `gpt-5-mini`; requires account access | Manual |
| `COPILOT_TIMEOUT_MS` | `120000`; integer 1000-600000 | Manual |
| `COPILOT_GITHUB_TOKEN` | Optional; otherwise `GH_TOKEN`, `GITHUB_TOKEN`, existing login | Secure injection |
| `COPILOT_SAMPLE_HOME` | `.copilot-local`; isolated runtime state for token-based runs | Manual |
| `COPILOT_TRACE_FILE` | Optional new trace file; prefer an absolute path outside the repo; parent directory must exist; refuses overwrite | Manual |
| `AGENT365_AGENT_NAME` | `copilot-sdk-standalone` | Manual |
| `AGENT365_TENANT_ID` | Required GUID for live export | Tenant owner |
| `AGENT365_BLUEPRINT_CLIENT_ID` | Required blueprint application client ID | Tenant owner |
| `AGENT365_AGENT_ID` | Required **agent identity** application client ID, distinct from blueprint | Tenant owner |
| `AGENT365_CLIENT_SECRET` | Blueprint development credential; never commit | Secure injection |

Missing or invalid live-export configuration is a hard error, not a silent console fallback. Offline telemetry uses clearly labelled `local-copilot-sdk` / `local-only` identifiers, not invented cloud IDs.

## Running the Agent Locally

### Quick start (Copilot; no A365)

PowerShell, from this directory:

```powershell
npm install
npm run build
npm test
npm run smoke
```

Use your organization's approved npm configuration. Following repository convention, generated `package-lock.json` stays local and ignored; it is not committed with this sample. Direct dependency versions are exact, but transitive resolutions can vary between fresh installations. Once `npm install` has generated a local lockfile, subsequent `npm ci` runs can reproduce that local resolution. A fresh checkout must use `npm install`, not `npm ci`.

Smoke ignores **all** ambient export flags/credentials, does not launch Copilot, and makes no network calls. It exercises actual custom handlers and OTel scopes with **synthetic SDK events**, asserting `19 + 23 = 42`, an expected tool failure, three correlated spans, and an error status. It is not a live Copilot or ingestion test.

For an actual model call using your existing GitHub credentials:

```powershell
npm run runtime:check
npm start -- --prompt "Call add_numbers with a=19 and b=23, then report the result."
npm start -- --prompt "Call fail_deliberately once and report the failure honestly."
```

`runtime:check` starts the bundled runtime and reports version, protocol and authentication boolean, never the token or account name; it does not call a model or export A365 telemetry. The standalone session uses `mode: 'empty'`, allows only the two custom tools, and denies other permission requests. Config discovery, file hooks, host Git operations, shared session store, skills, MCP and remote-session export are disabled. With an environment token, its runtime home is isolated; existing-login fallback uses the existing home without modifying authentication settings.

Model tool selection is not deterministic. Inspect the JSON evidence for `execute_tool add_numbers` or `execute_tool fail_deliberately`; an assistant answer alone does not prove a tool ran. The intentionally failing tool may be handled by the model, so a successful invocation can legitimately contain an ERROR tool span.

### Local development (with A365 observability)

Only after the tenant owner has supplied configuration and approved export:

```powershell
Copy-Item .env.example .env
# Securely supply the four AGENT365 identity/credential values in .env or the process environment.
# Set ENABLE_A365_OBSERVABILITY_EXPORTER=true explicitly.
$env:COPILOT_TRACE_FILE = Join-Path ([System.IO.Path]::GetTempPath()) ("copilot-trace-" + [guid]::NewGuid() + ".json")
npm start -- --prompt "Call add_numbers with a=19 and b=23, then report the result."
```

Token acquisition is awaited before inference. Export uses the **S2S endpoint** and explicit token resolver. Flush and runtime cleanup failures return a nonzero exit code.

No Playground, WebChat, Teams, dev tunnel, HTTP server, or Microsoft 365 Agents SDK host is required or supported in this standalone sample.

### Troubleshooting

| Symptom | Action |
|---------|--------|
| Missing runtime / version mismatch | Run `npm install` with optional dependencies enabled (`npm ci` only if a local lockfile already exists); unset `COPILOT_CLI_PATH`. Do not substitute an arbitrary CLI build. |
| `isAuthenticated: false` | Supply an eligible token or authenticate separately using the supported CLI workflow. This sample never opens a browser or initiates login. |
| Model access/timeout failure | Check account/model eligibility and `COPILOT_MODEL`; inspect the redacted trace. No response is replaced with fake success. |
| Missing `AGENT365_*` / authentication error | Use real agent and blueprint client IDs and a valid blueprint credential; confirm FMI relationship and application consent with the tenant owner. |
| Missing tool completion / correlation error | Invocation fails and pending spans close as ERROR. Check the pinned SDK/runtime rather than inventing timing boundaries. |
| Trace file already exists | Choose a new `COPILOT_TRACE_FILE`; existing evidence is not overwritten. |
| HTTP 200 but no portal telemetry | Inspect actual service sink results/tenant eligibility; transport acceptance is not ingestion proof. |

## Deploying the Agent

Deployment is deliberately out of scope. This sample does not publish, create resources, configure an endpoint, or install a Teams manifest. Production adoption needs a separately reviewed certificate or managed-identity/FIC credential provider replacing the development secret acquirer, lifecycle/termination handling, and operational export monitoring. Those production credential paths are **not implemented or claimed** here.

## Observability

`createTelemetry(config, tokenResolver?)` in `src/telemetry.ts` returns `invoke(sessionId, callback)`, `snapshot()` and `shutdown()`. Wrap session creation and `sendAndWait` with `invoke`; register `events.onEvent` before session creation and wrap deterministic tool handlers with `events.executeTool`. Always await shutdown. This helper source is shipped with the sample, not as a new package.

The recommended Microsoft package supplies `InvokeAgentScope`, `ExecuteToolScope` and `Agent365Exporter`. An explicit standard `NodeTracerProvider` avoids unrelated distro auto-instrumentation. Each scope receives agent identity, blueprint and tenant directly; tool scopes carry an explicit invocation parent. SDK session/turn/tool/usage events are correlated onto the invocation, with duplicate-event protection and cleanup for incomplete calls. No `TurnContext` or hosting baggage helper is necessary.

Prompts, tool arguments/results, reasoning, raw SDK errors, opaque API call IDs, and exception stacks are omitted from telemetry. The assistant's answer is printed separately to the console. Trace JSON includes only application-observed spans/events and numeric usage fields.

**Limits:** timings cover the application invocation and observed tool lifecycle, not complete model inference. `assistant.usage` is post-hoc reporting, stored as an event; its duration is never used to reconstruct an inference span. Dynamic subagent visibility is incomplete and flattened under the root; a runtime subagent label is not an Entra agent identity. This is a one-prompt session, not a resumable server or durable trace pipeline.

**Platform scope:** the local instructions use PowerShell. The SDK selects its platform-specific runtime during installation, but package availability does not establish a tested OS/architecture matrix. Validate the sample on your target platform; Node.js 22.12+ is a dependency requirement, not a claim that every supported Node release has been tested.

**Delivery evidence:** exporter errors are surfaced, but the pinned exporter does not expose full service sink results through its public callback. `a365IngestionVerified` therefore remains **false** even when export completes. HTTP 200 and `partialSuccess.rejectedSpans=0` are insufficient if service sinks reject delivery. A tenant owner must separately verify ingestion and portal visibility; the sample does not perform eligibility/provisioning calls or supply a service-response observer.

See the [Agent observability guide](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability) and [Microsoft OTel migration guide](https://github.com/microsoft/opentelemetry-distro-javascript/blob/main/MIGRATION_A365.md).

## Support

For issues, questions, or feedback:

- **Issues**: [GitHub Issues](https://github.com/microsoft/Agent365-Samples/issues)
- **Documentation**: [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: [SECURITY.md](../../SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- [Agent observability guide](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability)
- [Copilot SDK repository](https://github.com/github/copilot-sdk)
- [Microsoft OpenTelemetry JavaScript distribution](https://github.com/microsoft/opentelemetry-distro-javascript)
- [Autonomous agent authentication](https://learn.microsoft.com/entra/agent-id/autonomous-agent-authentication-authorization-flow)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see [LICENSE.md](../../LICENSE.md).
