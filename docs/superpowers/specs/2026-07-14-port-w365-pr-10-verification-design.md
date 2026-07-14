# Verify the W365 PR #10 Public Port

## Summary

The telemetry follow-up established production runtime contracts for the W365
sample. The current public branch already implements every applicable contract,
so this work is verification and documentation rather than a second
implementation.

## Goal

Prove that the public W365 sample implements every telemetry requirement without
duplicating code, reverting later public hardening, or copying non-public tests
and test-only functionality.

## Non-goals

- Reapply upstream commits or reproduce their exact source shape.
- Copy non-public tests into the public repository.
- Add test-only production accessors.
- Add non-public screen-share links, callbacks, handoff state, or related tests.
- Replace public cancellation, privacy, session-correlation, or lifecycle
  improvements with older implementations.
- Create a production commit when all contracts already pass.

## Telemetry Requirement Mapping

| Upstream requirement | Public implementation | Verification |
|---|---|---|
| Record emitted agent responses on `invoke_agent` spans | `Telemetry/A365OtelWrapper.cs` accepts `Func<Task<string?>>` and calls `InvokeAgentScope.RecordOutputMessages`; `Agent/MyAgent.cs` returns the welcome, installation, direct, error, and orchestrator response text that it emits | Source contract and Release build |
| Encode `server.port` as a culture-invariant string in baggage | `Telemetry/Agent365TelemetryContext.cs` sets `server.port` from `ToServerPortAttribute()` using `CultureInfo.InvariantCulture` | Source contract |
| Force the `invoke_agent` span's `server.port` tag to the same string value | `Telemetry/A365OtelWrapper.cs` calls `SetTagMaybe("server.port", telemetryContext.ToServerPortAttribute())` | Source contract |
| Ensure every `execute_tool` span has a tool-call ID | `Telemetry/ToolTelemetry.cs` preserves nonblank IDs and generates a tool-name-prefixed GUID for null, empty, or whitespace values | Source contract |
| Enable Microsoft distro HTTP client, ASP.NET Core, and Agent365 instrumentation | `Telemetry/ObservabilityServiceCollectionExtensions.cs` sets `EnableHttpClientInstrumentation = true`, `EnableAspNetCoreInstrumentation = true`, and `EnableAgent365Instrumentation = true` | Source contract |
| Retain public runtime behavior while excluding test-only additions | The public implementation keeps the runtime contracts and omits non-public telemetry regression tests and telemetry-follow-up-specific test-only accessors or additions | Exclusion scan |

## Public Superset Behavior

The public implementation intentionally goes beyond the telemetry follow-up:

- request cancellation reaches identity resolution, token exchange, model
  calls, and tool calls;
- output and error telemetry use privacy redaction for image and screenshot
  content;
- tool spans carry actual conversation and channel correlation;
- model-requested tool calls preserve model IDs, while automatic lifecycle and
  screenshot calls receive generated IDs;
- W365 session recovery and MCP client ownership are hardened and serialized;
- genuine lifecycle failures remain visible instead of being acknowledged as
  successful operations.

These improvements must remain intact during verification.

## Validation

Run against committed public `HEAD`:

1. `dotnet build .\dotnet\w365-computer-use\W365ComputerUseSample.sln -c Release --nologo`
2. Focused source assertions for every row in the telemetry-requirement table.
3. Confirm no non-public test project or test-only accessor was added.
4. Confirm no non-public screen-share or handoff functionality was added to the
   public sample.
5. Confirm `git diff --check` succeeds and the worktree remains clean.

The verification succeeds only when every production contract is present and
the exclusions remain absent.

## Failure Handling

If a contract is missing, this task stops being verification-only. Create a
focused implementation plan for the missing public-safe behavior, preserve the
existing public hardening, and repeat the full build and exclusion checks.

## Expected Outcome

No production changes are required. The committed artifact is this mapping
specification, which records why PR #10 does not need a duplicate public port.
