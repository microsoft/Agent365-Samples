# Salesforce Samples — Design Guidelines

Salesforce samples in this repository demonstrate how **Apex** and **Agentforce** integrate with the
Microsoft Agent 365 platform — primarily **observability** (emitting Agent 365 OTLP telemetry from
Salesforce) and the agent ↔ Salesforce tool boundary.

Unlike the `dotnet/`, `python/`, and `nodejs/` samples (which host an agent process), Salesforce
samples are **SFDX projects** deployed into a Salesforce org. There is no long-running server to host;
the "agent-facing" surface is Apex (REST endpoints and `@InvocableMethod` actions) plus an optional
Agentforce agent built in the org.

## Conventions

- **Project shape** — each sample is a standard SFDX project: `force-app/main/default/...`,
  `sfdx-project.json`, `.forceignore`. Deploy with `sf project deploy start`.
- **Naming** — Apex has no namespaces, so classes use a short `A365` prefix as a de-facto namespace.
- **Copyright headers** — every `.cls` begins with the Microsoft copyright header (`//` comments).
  Metadata XML/JSON files are configuration and are exempt.
- **Secrets** — never in git. Secret values are entered post-deploy on a Salesforce **External
  Credential** (Setup). Non-secret runtime config lives in **Custom Metadata** records, seeded via an
  Execute-Anonymous script when the org cannot deploy CMDT records directly.
- **Telemetry is fail-open** — observability code must never affect the business response; wrap emit
  paths so errors are swallowed (debug-logged) and run the actual export asynchronously (`Queueable`).
- **Auth** — MSAL is unavailable in Apex, so S2S OAuth (including the FMI agent-bound token chain) is
  hand-rolled as raw form-POST callouts via Named Credentials, with the secret injected from the
  External Credential as a merge field.

## Testing

- Use `HttpCalloutMock` to mock the token + ingest hops; assert OTLP body shape, trace correlation,
  the disabled no-op, and fail-open behavior.
- Deploy/test with `sf project deploy start --test-level RunLocalTests` (enforces 75% aggregate org
  coverage). Validate without persisting using `--dry-run`.

## Documentation

Each Salesforce sample includes a `README.md` (what it demonstrates, prerequisites, deploy/secret/
config steps, testing, troubleshooting) and a `docs/design.md` (architecture, token model, wire
shape, dependency graph).

For a specific sample's concrete architecture — token model, OTLP wire shape, dependency graph — see
that sample's `docs/design.md` (e.g. [`apex-observability/docs/design.md`](../apex-observability/docs/design.md)),
which is the single source of truth for implementation detail; this file stays at the cross-sample
convention level.
