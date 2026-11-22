# Agent 365 observability S2S export

The samples export Agent 365 observability data through the S2S `/observabilityService/.../otlp/...` route with an app-only token for the agent instance. This changes telemetry transport only: keep business MCP, Graph, OBO, bearer-token development flows, and original turn baggage separate.

## Route and token contract

Live validation on September 28, 2026 showed that a registered agent instance using a roleless app-only token (`idtyp=app`, `roles=[]`, no `scp`) received `200` from `/observabilityService/tenants/{tenant}/otlp/agents/{agent}/traces`. The legacy non-`/otlp` S2S route (`/observabilityService/tenants/{tenant}/agents/{agent}/traces`) rejected the same token with `401` (`AuthenticationSchemeNotSupported`). Every sample must use an SDK/exporter configuration that posts to the `/otlp` route.

The sample providers accept app-only tokens that meet one of these contracts:

- `idtyp=app`
- a valid nonempty `roles` array when `idtyp` is absent
- absent `idtyp` with a nonempty `oid` equal to `sub`

Any `scp` claim is rejected, even if it is empty or the token also contains application-looking claims. When present, `roles` must be an array of nonblank strings.

## Sample provider scope

The .NET, Python, and Node.js sample providers are intentionally simple and single-instance: they export for one statically configured tenant and agent instance. Configure the agent instance client ID, not the blueprint ID, service-principal object ID, or agent-user ID.

These sample providers need their own copy of the blueprint credential. The Python and Node.js samples only include a client-secret development flow and have no managed-identity option; the .NET samples can use a managed-identity assertion for the blueprint credential. All providers currently request tokens from `login.microsoftonline.com`, so sovereign clouds need provider changes before use.

For production deployments that can serve multiple hired instances or tenants, implement a per-agent/per-tenant cache and reuse the hosting connection credential for that turn's agent identity. Do not rewrite incoming baggage to fit a static configuration.

## Configuration

Enable export explicitly. Keep the checked-in placeholders for local/Playground runs with export disabled.

### .NET

```json
{
  "EnableAgent365Exporter": true,
  "Agent365Observability": {
    "TenantId": "<<AGENT_HOME_TENANT_ID>>",
    "AgentId": "<<AGENT_INSTANCE_CLIENT_ID>>",
    "BlueprintClientId": "<<BLUEPRINT_CLIENT_ID>>",
    "UseManagedIdentity": true,
    "ManagedIdentityClientId": ""
  }
}
```

For local development with a secret, set `UseManagedIdentity=false` and provide `Agent365Observability:BlueprintClientSecret` through user secrets or `Agent365Observability__BlueprintClientSecret`.

### Python and Node.js

```dotenv
ENABLE_A365_OBSERVABILITY_EXPORTER=true
AGENT365_OBS_TENANT_ID=<<YOUR_TENANT_ID>>
AGENT365_OBS_AGENT_ID=<<YOUR_AGENT_INSTANCE_CLIENT_ID>>
AGENT365_OBS_BLUEPRINT_CLIENT_ID=<<YOUR_BLUEPRINT_CLIENT_ID>>
AGENT365_OBS_BLUEPRINT_CLIENT_SECRET=<<YOUR_BLUEPRINT_CLIENT_SECRET>>
```

The Python `microsoft-opentelemetry` distro gates its A365 HTTP exporter on `ENABLE_A365_OBSERVABILITY_EXPORTER` or `a365_enable_observability_exporter`; when disabled, A365 span enrichment can remain enabled without sending data to A365.

## AI Teammates

AI Teammate S2S export without the `Agent365.Observability.OtelWrite` application-role step has not been validated. For AI Teammates, complete the OtelWrite application-role assignment that `a365 setup all --aiteammate` prints.

## Offline validation

```powershell
python -m pytest tests/observability -q
dotnet test tests/e2e/Agent365.E2E.Tests.csproj --filter FullyQualifiedName~ObservabilityAppTokenTests
```

The Python suite mocks token exchange and exporter uploads. The .NET suite mocks HTTP token exchange and validates the sample-local provider copies.
