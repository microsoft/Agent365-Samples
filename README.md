# Microsoft Agent 365 SDK Samples and Prompts

This repository contains sample agents and prompts for building with the Microsoft Agent 365 SDK. The Microsoft Agent 365 SDK extends the Microsoft 365 Agents SDK with enterprise-grade capabilities for building sophisticated agents. It provides comprehensive tooling for observability, notifications, runtime utilities, and development tools that help developers create production-ready agents for platforms including M365, Teams, Copilot Studio, and Webchat.

- **Sample agents** are available in C# (.NET), Python, Node.js/TypeScript, and Salesforce/Apex
- **Prompts** to help you get started with AI-powered development tools like Cursor IDE

## SDK Versions

### Observability routing

Agent 365 OBS export always uses `/observabilityService`, including autonomous,
AI Teammate, and on-behalf-of (OBO) conversations. `/observability` is not a
fallback for missing tokens, authentication failures, or failed exports.
This changes telemetry transport only: preserve the agent identity, user baggage,
and the existing MCP/Graph authentication flows.

The samples explicitly select S2S using the API supported by their dependencies:

| Sample SDK | Required configuration |
|---|---|
| Node.js `@microsoft/opentelemetry` (1.0.0, 1.0.1, or 1.4.0 in these samples) | `a365: { useS2SEndpoint: true }` (or the distro's `Agent365Exporter` with the same option) |
| Legacy Node.js observability (compatible preview.115 or the sample's existing preview.125 API family) | `Agent365ExporterOptions.useS2SEndpoint = true` via `withExporterOptions`, plus the OBS-only app-token resolver |
| Python `microsoft-opentelemetry` | `a365_use_s2s_endpoint=True` |
| Python observability core 1.0.0 or later | `configure(exporter_options=Agent365ExporterOptions(use_s2s_endpoint=True, token_resolver=...))` |
| .NET `Microsoft.OpenTelemetry` 1.0.1 | `o.Agent365.Exporter.UseS2SEndpoint = true` |
| .NET `Microsoft.OpenTelemetry` 1.0.6 | `options.Agent365.UseS2SEndpoint = true` |
| Salesforce/Apex | Fixed S2S path; deprecated `UseS2SEndpoint__c` values cannot select the legacy route |

When supplying Python `exporter_options`, put the existing token resolver and any
cluster override **inside those options**; `configure` does not populate them on
an options object supplied by the caller.

The samples retain their published, API-compatible SDK families rather than
upgrading solely because a route lacks `/otlp`. Legacy Node.js SDKs use
`/observabilityService/tenants/{tenant}/agents/{agent}/traces`; the distro, Python,
.NET and Apex exporters use `/observabilityService/tenants/{tenant}/otlp/agents/{agent}/traces`.
The inspected service implements both route shapes with the same
`ExportTraceServiceRequest` body type. The legacy service route has distinct
tenant-eligibility/service-principal authorization policies: do not infer general
acceptance or caller-allowlist enforcement from the public OTLP authorization
policy. A successful public OTLP export does not validate legacy-route admission.

Devin, Copilot Studio and Perplexity pin the coherent preview.115 SDK family to
retain their verified scope APIs. OpenAI and Vercel retain their existing
preview.125 dependency family. All five configure their legacy exporter once in
`src/otel.ts` and reject `ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT`: that mode
would bypass the OBS-only resolver and read a context token. There is no need for
an unpublished SDK or a suffix-only payload migration.

LangChain's published distro 1.4.0 configuration disables `a365.durableDelivery`
because that release can otherwise replay historical route choices. Existing
spool data is not deleted. Do not re-enable replay until the installed release
enforces S2S for both live and replayed exports. No sample falls back to `/observability`.

**Authentication and registration:** S2S OBS requires a service-principal/application
token. The public `/otlp/agents/` route can authorize an eligible registered agent
instance without an OBS-specific `Agent365.Observability.OtelWrite` grant, subject
to service policy. Creating an Entra identity alone is not sufficient: complete
Agent 365 registration for the exact runtime instance. Legacy-route admission must
be confirmed separately; selecting `/observabilityService` alone does not establish
permissionless authorization.

The standalone providers accept absent or empty `roles` only when `idtyp=app`.
Valid nonempty application roles remain compatible with older tokens lacking
`idtyp`. When present, `roles` must be an array of nonblank strings. Delegated
AI Teammate/OBO tokens carrying any `scp` claim, including an empty one, are rejected.
Selecting S2S does not convert a delegated token into an application token.
The presence of `scp` makes a token a user principal even if it also has `roles`
or an application-looking `idtyp`; additional permissions do not bypass this gate.

The autonomous/Salesforce examples also acquire application tokens, not user tokens.
Interactive samples now use a **separate OBS-only application-token provider**;
they do not obtain exporter tokens from business MCP/Graph/OBO caches. The provider
uses blueprint credentials plus `fmi_path` for the actual agent instance, then
exchanges that parent assertion through a second `client_credentials` grant for
the OBS audience. There is no `user_fic`, OBO assertion, or delegated-token fallback
in this flow. Business authentication and user context remain independent.

Node.js and Python interactive samples require `AGENT365_OBS_TENANT_ID`,
`AGENT365_OBS_AGENT_ID`, `AGENT365_OBS_BLUEPRINT_CLIENT_ID`, and
`AGENT365_OBS_BLUEPRINT_CLIENT_SECRET` when OBS export is enabled. Their supplied
credential flow is a development example; store secrets securely. .NET uses the
equivalent dedicated `Agent365Observability` configuration and additionally
supports managed-identity assertions. See each sample's template and README.
Providers reject missing/placeholder configuration, blueprint-as-agent IDs,
export identity mismatches, delegated tokens, wrong audiences and expired tokens.
They cache only valid app tokens until their actual expiry and fail explicitly
instead of returning empty or stale tokens. No provisioning or permissions are
changed by the samples.

Use the provisioned runtime Agent Identity, not the Agent Blueprint ID, for agent
attribution and the agent-bound OBS token flow. Incomplete provisioning is not a
valid AI Teammate test setup. A token-acquisition failure such as `AADSTS82001`
must be resolved before ingestion can be tested; changing the exporter URL cannot
repair a rejected token grant.
For a 401/403, check token identity/audience, exact instance registration and the
selected route's service policy. Do not automatically add an OBS grant or switch
routes. Workload MCP/Graph/OBO permissions are separate and unchanged.
Console/OTLP-only examples do not become
authenticated OBS examples merely by enabling the exporter; they also require
the dedicated application credentials and service-side authorization.

**Validation:** Run the offline route/configuration regressions with
`python -m pytest tests/observability` from an environment with pytest and
`microsoft-agents-a365-observability-core>=1.0.0` installed (both are existing
Python sample dependencies). These inspect configuration, mock both token-exchange
requests, and mock HTTP exports for AI Teammate/OBO contexts, including failures,
cache expiry and identity mismatches, without starting agents or contacting services.
Node.js token-flow/route tests run with
`node --test tests/observability/node-app-token.test.cjs` after installing the
Node.js sample dependencies. This also runs the OpenAI agent with a mocked model
response and an in-memory exporter, checking shared runtime identity and both
invocation and inference spans without network access. Business MCP/OBO calls are
checked against reviewed fixtures in `tests/observability/fixtures/business-auth-contracts.json`,
not the commit under test. Mutation controls cover changed handlers, turn contexts,
token sources, scopes and removed calls. .NET tests run with
`dotnet test tests/e2e/Agent365.E2E.Tests.csproj --filter FullyQualifiedName~ObservabilityAppTokenTests`.
Salesforce route/401 regressions extend `A365TelemetryTest` and require an
authorized test org. Live AI Teammate and OBO validation must independently check
the exported request's S2S path, audience, agent/tenant attribution, response,
and unchanged tool authentication; offline checks alone do not establish live
authorization success.
The S2S service also sanitizes `user.id` and its aliases unless the host/agent has
an authorized trusted-host or service exemption. Preserving user baggage in the
client's exported payload therefore does **not** prove that downstream OBO caller
attribution is retained. Validate attribution after ingestion using the approved
service configuration; do not alter identities to bypass this restriction.

The SDK versions used by each sample are displayed in the **E2E test workflow summaries**. Each E2E run installs the latest compatible packages and logs the resolved versions.

📦 **View SDK Versions**: Click any E2E status badge above, then select a workflow run and view the **"Log SDK Versions"** step in the job summary.

Most samples use flexible version constraints (`>=`, `^`, `*-beta.*`) to pick up
compatible SDK releases. Legacy Node.js samples pin their tested SDK family to
preserve compatible tracing APIs and S2S exporter options.

> #### Note:
> Use the information in this README to contribute to this open-source project. To learn about using this SDK in your projects, refer to the [Microsoft Agent 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Survey

Please help improve the Microsoft Agent 365 SDK and CLI by taking our survey: [Agent365 SDK Integration Feedback Survey](https://forms.office.com/r/wj0edu361y)

## Current Repository State

This samples repository is currently in active development and contains:
- **Sample Agents**: Production-ready examples in C#/.NET, Python, Node.js/TypeScript, and Salesforce/Apex demonstrating observability, notifications, tooling, and hosting patterns
- **Prompts**: Guides for using AI-powered development tools (e.g., Cursor IDE) to accelerate agent development

## Documentation

For comprehensive documentation and guides, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

### Microsoft Agent 365 SDK

The sample agents in this repository use the Microsoft Agent 365 SDK, which provides enterprise-grade extensions for observability, notifications, runtime utilities, and developer tools. Explore the SDK repositories below:

- [Microsoft Agent 365 SDK - C# /.NET repository](https://github.com/microsoft/Agent365-dotnet)
- [Microsoft Agent 365 SDK - Python repository](https://github.com/microsoft/Agent365-python)
- [Microsoft Agent 365 SDK - Node.js/TypeScript repository](https://github.com/microsoft/Agent365-nodejs)
- [Microsoft Agent 365 SDK Samples repository](https://github.com/microsoft/Agent365-Samples) - You are here

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the Microsoft Open Source Code of Conduct. For more information see the Code of Conduct FAQ or contact opencode@microsoft.com with any additional questions or comments.

## Useful Links

### Microsoft 365 Agents SDK

The core SDK for building conversational AI agents for Microsoft 365 platforms.

- [Microsoft 365 Agents SDK - C# /.NET repository](https://github.com/Microsoft/Agents-for-net)
- [Microsoft 365 Agents SDK - NodeJS /TypeScript repository](https://github.com/Microsoft/Agents-for-js)
- [Microsoft 365 Agents SDK - Python repository](https://github.com/Microsoft/Agents-for-python)
- [Microsoft 365 Agents documentation](https://learn.microsoft.com/microsoft-365/agents-sdk/)

## Additional Resources

For language-specific documentation and additional resources, explore the following links:

- [.NET documentation](https://learn.microsoft.com/dotnet/api/?view=m365-agents-sdk&preserve-view=true)
- [Node.js documentation](https://learn.microsoft.com/javascript/api/?view=m365-agents-sdk&preserve-view=true)
- [Python documentation](https://learn.microsoft.com/python/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License
Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the LICENSE file for details.
