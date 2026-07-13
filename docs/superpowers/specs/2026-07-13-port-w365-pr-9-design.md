# Port W365 PR 9 to the Public Sample

## Goal

Port the production observability changes from private `W365-SampleAgent` PR 9 into
`dotnet/w365-computer-use/sample-agent` while keeping the public sample independent
of private-only screen-share code and private test infrastructure.

## Scope

The public sample will:

- migrate from the legacy Agent 365 observability extension and individually
  referenced OpenTelemetry packages to `Microsoft.OpenTelemetry` 1.0.6;
- emit Agent 365 semantic spans for agent invocation, model inference, and tool
  execution;
- propagate turn, agent, tenant, caller, conversation, and model tool-call
  context into those spans;
- retain the public sample's existing computer-use, screenshot capture, and
  OneDrive screenshot-folder behavior;
- preserve existing return values, errors, cancellation, and session recovery.

The port will not add:

- the private repository's test project or test files;
- the private `CustomEndpointProvider`;
- screen-share page links, handoff storage, screen-share callbacks, screen-share
  URL state, or screen-share-specific session behavior;
- unrelated changes from the private branch.

Screenshot capture remains in scope because it is an existing public computer-use
tool boundary. Screenshot payloads must be redacted from telemetry. It is not the
private screen-share feature.

## Approach

Use a faithful portable adaptation rather than copying the private diff verbatim.
The public code will adopt the private PR's tested semantic behavior while each
change is reconciled with the current public implementation.

A distro-only migration is insufficient because it would omit the manual
`InvokeAgentScope`, `InferenceScope`, and `ExecuteToolScope` spans that are the
purpose of PR 9. Copying the complete private implementation and deleting private
parts afterward is rejected because it creates unnecessary coupling and risks
importing screen-share behavior.

## Architecture

### OpenTelemetry registration

`W365ComputerUseSample.csproj` will reference `Microsoft.OpenTelemetry` 1.0.6 and
remove the legacy Agent Framework observability extension plus direct
OpenTelemetry exporter, hosting, and instrumentation packages.

Startup will use one W365-specific registration helper. The helper will:

- configure the Microsoft OpenTelemetry distro for the Agent 365 exporter;
- optionally enable the console exporter through configuration;
- enable ASP.NET Core, HTTP client, and Agent 365 instrumentation;
- register the agentic and service token caches required by exporter token
  resolution;
- add the existing `AgentMetrics` activity source and meter.

`Program.cs` will bind an optional `Agent365Observability` configuration section
and register Agent 365 baggage/output middleware. The old
`ConfigureOpenTelemetry`, `AddAgenticTracingExporter`, and `AddA365Tracing` setup
will be removed.

### Shared telemetry context

`Agent365TelemetryOptions` will represent optional configured identity and
endpoint metadata.

`Agent365TelemetryContext` will derive one normalized context from the current
turn, OpenTelemetry baggage, and configuration. It will produce:

- baggage values for tenant, agent, caller, channel, conversation, and operation;
- `AgentDetails`, request, caller, and endpoint contracts for semantic scopes;
- normalized server address and a string-encoded `server.port`.

Missing optional metadata will use safe non-secret defaults. Token registration
will only occur when the required auth context is available; registration
failures will be logged without hiding operation failures.

### Agent invocation spans

`A365OtelWrapper` will continue to wrap the existing `AgentMetrics` operation and
will additionally:

1. resolve the turn's telemetry identity;
2. establish the normalized baggage context;
3. register service and agentic exporter token resolution;
4. start an `InvokeAgentScope`;
5. record a non-empty output message returned by the handler;
6. record cancellation or failure before rethrowing.

Welcome, installation-update, and message handlers in `MyAgent` will use this
wrapper. Handler delegates will return the text they send or queue so output
recording does not alter user-visible behavior. No screen-share branches or
callbacks will be introduced.

### Inference spans

`InferenceTelemetry` will wrap the existing Azure OpenAI request delegate with an
`InferenceScope`. It will record:

- sanitized input messages;
- output messages;
- input and output token counts;
- finish reasons and response ID when present;
- cancellation and failures.

Embedded `data:image/...` content will be redacted. The Azure OpenAI provider's
HTTP request, status handling, and response body will remain unchanged inside
the delegate. The private custom endpoint provider is out of scope because no
equivalent public file exists.

### Tool execution spans

`ToolTelemetry` will wrap each physical MCP or `AIFunction` invocation with an
`ExecuteToolScope`. It will:

- use the model's `call_id` where available and generate one otherwise;
- record tool identity, endpoint, server, conversation, channel, arguments, and
  result;
- redact screenshot results, embedded image data, and sensitive free-form text;
- return the original unredacted result to the caller;
- record cancellation and failures before rethrowing.

`ComputerUseOrchestrator` will propagate conversation and channel context through
its per-conversation session. Model tool-call IDs will flow through start,
end, session-detail, exposed W365, recovery, screenshot, and generic tool paths.
Raw invocation helpers will contain the physical calls, while instrumented
helpers will wrap those raw operations exactly once. Session-loss detection,
recovery, and error messages will remain unchanged.

## Error Handling and Privacy

- Existing operation exceptions and cancellation will always be rethrown.
- Telemetry setup will not convert failed operations into successful results.
- Token registration is best effort and logs failures using existing logging
  conventions without logging credentials.
- API keys, bearer tokens, exchanged tokens, full screenshot data, and embedded
  image URLs will never be recorded.
- Screenshot handling will continue returning usable image data to existing
  public code even though the telemetry representation is redacted.

## Documentation and Configuration

The sample README will document the Microsoft OpenTelemetry distro, the three
semantic span types, the optional console-exporter setting, and the
`Agent365Observability` metadata section. Configuration examples will use
placeholders and contain no credentials.

Repository-wide documentation will only change if an existing statement becomes
incorrect for this sample.

## Validation

Because the public repository intentionally has no matching private test project,
the port will not copy private tests. The private tests remain the behavioral
reference for:

- preserving or generating tool-call IDs;
- preserving unredacted tool results for callers;
- recording non-empty invoke-agent output;
- extracting inference metadata;
- rethrowing cancellation and failures;
- preventing duplicate tool spans.

The public implementation will be validated by:

1. restoring and building `W365ComputerUseSample.sln`;
2. checking the resulting package graph for removal of legacy observability
   dependencies;
3. reviewing all physical model and tool calls for exactly one semantic wrapper;
4. checking that no private screen-share or handoff symbols were introduced;
5. running the repository's Agent 365 sample, quality, and security reviewers.

## Success Criteria

- The public W365 sample builds with `Microsoft.OpenTelemetry` 1.0.6.
- Agent turns emit invoke-agent spans, Azure OpenAI calls emit inference spans,
  and MCP/function calls emit execute-tool spans.
- Semantic spans share consistent Agent 365 identity and conversation context.
- Existing public computer-use and screenshot behavior is preserved.
- Sensitive image/token content is excluded from telemetry.
- No private tests, custom endpoint implementation, screen-share implementation,
  or handoff implementation is present in the public diff.
