# W365 PR #10 Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify that the current public W365 branch already contains every
public-safe telemetry behavior without adding duplicate code or non-public tests.

**Architecture:** Treat the task as a public contract comparison rather than a
patch application. Assert each required behavior directly in public source, then
run Release build, package, exclusion, and branch-integrity checks. If any
contract is absent, stop and create a focused implementation plan instead of
editing opportunistically.

**Tech Stack:** .NET 8, Microsoft.OpenTelemetry 1.0.6, Agent 365 semantic
tracing scopes, PowerShell, Git

---

## File Structure

No production or test file should change when verification passes.

| File | Responsibility |
|---|---|
| `docs/superpowers/specs/2026-07-14-port-w365-pr-10-verification-design.md` | Approved telemetry requirement mapping and exclusions |
| `docs/superpowers/plans/2026-07-14-port-w365-pr-10-verification.md` | Exact verification procedure and stop conditions |
| `dotnet/w365-computer-use/sample-agent/Telemetry/A365OtelWrapper.cs` | Existing invoke-agent output and `server.port` behavior to verify |
| `dotnet/w365-computer-use/sample-agent/Telemetry/Agent365TelemetryContext.cs` | Existing invariant string port conversion to verify |
| `dotnet/w365-computer-use/sample-agent/Telemetry/ToolTelemetry.cs` | Existing execute-tool call-ID generation to verify |
| `dotnet/w365-computer-use/sample-agent/Telemetry/ObservabilityServiceCollectionExtensions.cs` | Existing Microsoft distro instrumentation flags to verify |
| `dotnet/w365-computer-use/sample-agent/Agent/MyAgent.cs` | Existing emitted-response return values to verify |

### Task 1: Validate the public contract inventory and sanitization

**Files:**
- Read: `docs/superpowers/specs/2026-07-14-port-w365-pr-10-verification-design.md`
- Read: `docs/superpowers/plans/2026-07-14-port-w365-pr-10-verification.md`

- [ ] **Step 1: Assert the committed public specification has the complete contract inventory**

Run:

```powershell
$specPath = ".\docs\superpowers\specs\2026-07-14-port-w365-pr-10-verification-design.md"
$spec = Get-Content -Raw $specPath
$requiredTerms = @(
  "invoke_agent",
  "Func<Task<string?>>",
  "RecordOutputMessages",
  "server.port",
  "CultureInfo.InvariantCulture",
  "tool-call ID",
  "EnableHttpClientInstrumentation = true",
  "EnableAspNetCoreInstrumentation = true",
  "EnableAgent365Instrumentation = true",
  "non-public tests",
  "test-only accessors"
)

foreach ($term in $requiredTerms) {
    if (-not $spec.Contains($term, [StringComparison]::Ordinal)) {
        throw "The public contract inventory is incomplete: $term"
    }
}

"PASS: public telemetry contract inventory is complete."
```

Expected: `PASS: public telemetry contract inventory is complete.`

- [ ] **Step 2: Assert the public documentation contains no operational provenance**

Run:

```powershell
$publicDocs = @(
  ".\docs\superpowers\specs\2026-07-14-port-w365-pr-10-verification-design.md",
  ".\docs\superpowers\plans\2026-07-14-port-w365-pr-10-verification.md"
)
$environmentPrefix = '$' + 'env:'
$tokenVariable = 'GH' + '_TOKEN'
$privateCommandPattern = '(?i)(gh\s+pr\s+(view|list|checkout)|--repo\s+\S+|' +
  [regex]::Escape($environmentPrefix + $tokenVariable) + ')'
$forbiddenPatterns = [ordered]@{
  "repository URL" = "https?://github\.com/"
  "repository owner/name" = "(?im)^\s*(private\s+)?repository\s*:"
  "account command or label" = "(?i)(gh\s+auth\s+token|authorized\s+account|account\s*:)"
  "branch provenance" = "(?i)(head\s+branch|source\s+branch|branch\s*:)"
  "full SHA inventory" = "(?i)\b[a-f0-9]{40}\b"
  "literal commit range" = "(?i)(?<![a-f0-9])(?:[a-f0-9]{7,40}\.\.\.\S+|\S+\.\.\.[a-f0-9]{7,40})(?![a-f0-9])"
  "local checkout path" = "(?i)[A-Z]:\\repos\\"
  "GitHub private-repository command" = $privateCommandPattern
}

foreach ($entry in $forbiddenPatterns.GetEnumerator()) {
    $matches = @(
      $publicDocs | ForEach-Object {
        Select-String -Path $_ -Pattern $entry.Value
      }
    )
    if ($matches.Count -gt 0) {
        throw "Public documentation contains forbidden $($entry.Key)."
    }
}

"PASS: public documentation contains no operational provenance."
```

Expected: `PASS: public documentation contains no operational provenance.`

- [ ] **Step 3: Stop on a contract or sanitization failure**

If either preceding assertion fails, stop and require an access-controlled
provenance review. Do not edit production opportunistically.

### Task 2: Assert every public production contract

**Files:**
- Read: `dotnet/w365-computer-use/sample-agent/Telemetry/A365OtelWrapper.cs`
- Read: `dotnet/w365-computer-use/sample-agent/Telemetry/Agent365TelemetryContext.cs`
- Read: `dotnet/w365-computer-use/sample-agent/Telemetry/ToolTelemetry.cs`
- Read: `dotnet/w365-computer-use/sample-agent/Telemetry/ObservabilityServiceCollectionExtensions.cs`
- Read: `dotnet/w365-computer-use/sample-agent/Agent/MyAgent.cs`

- [ ] **Step 1: Assert invoke-agent output recording**

Run:

```powershell
$root = ".\dotnet\w365-computer-use\sample-agent"
$wrapper = Get-Content -Raw "$root\Telemetry\A365OtelWrapper.cs"
$agent = Get-Content -Raw "$root\Agent\MyAgent.cs"
$invokeOutputFlowPattern = '(?s)outputMessage\s*=\s*await\s+func\(\)\.ConfigureAwait\(false\);\s*\}\)\.ConfigureAwait\(false\);\s*if\s*\(\s*!string\.IsNullOrWhiteSpace\(outputMessage\)\s*\)\s*\{\s*invokeAgentScope\.RecordOutputMessages\(\s*\[\s*outputMessage\s*\]\s*\);'

if ($wrapper -notmatch "Func<Task<string\?>>"
    -or $wrapper -notmatch $invokeOutputFlowPattern
    -or $agent -notmatch "return sentWelcome \? AgentWelcomeMessage : null;"
    -or $agent -notmatch "return directResponse;"
    -or $agent -notmatch "return errorMessage;"
    -or $agent -notmatch "return response;"
    -or $agent -notmatch [regex]::Escape('return AgentHireMessage;')
    -or $agent -notmatch [regex]::Escape('return AgentFarewellMessage;')) {
    throw "The public invoke-agent output contract is incomplete."
}

"PASS: invoke-agent outputs are returned and recorded."
```

Expected: `PASS: invoke-agent outputs are returned and recorded.`

- [ ] **Step 2: Assert invariant string `server.port` propagation**

Run:

```powershell
$root = ".\dotnet\w365-computer-use\sample-agent"
$wrapper = Get-Content -Raw "$root\Telemetry\A365OtelWrapper.cs"
$context = Get-Content -Raw "$root\Telemetry\Agent365TelemetryContext.cs"

if ($context -notmatch 'builder\.Set\("server\.port", ToServerPortAttribute\(\)\)'
    -or $context -notmatch "ToString\(CultureInfo\.InvariantCulture\)"
    -or $wrapper -notmatch 'SetTagMaybe\("server\.port", telemetryContext\.ToServerPortAttribute\(\)\)') {
    throw "The public string server.port contract is incomplete."
}

"PASS: server.port is string-encoded in baggage and invoke-agent telemetry."
```

Expected: `PASS: server.port is string-encoded in baggage and invoke-agent telemetry.`

- [ ] **Step 3: Assert execute-tool call-ID resolution**

Run:

```powershell
$root = ".\dotnet\w365-computer-use\sample-agent"
$toolTelemetry = Get-Content -Raw "$root\Telemetry\ToolTelemetry.cs"
$toolCallIdFlowPattern = '(?s)var\s+resolvedToolCallId\s*=\s*ResolveToolCallId\(toolName,\s*toolCallId\);\s*using\s+var\s+scope\s*=\s*ExecuteToolScope\.Start\(\s*request:\s*context\.ToRequest\([\s\S]*?details:\s*new\s+ToolCallDetails\([\s\S]*?toolCallId:\s*resolvedToolCallId'

if ($toolTelemetry -notmatch $toolCallIdFlowPattern
    -or $toolTelemetry -notmatch "!string\.IsNullOrWhiteSpace\(toolCallId\)"
    -or $toolTelemetry -notmatch [regex]::Escape('$"{toolName}-{Guid.NewGuid():N}"')) {
    throw "The public execute-tool call-ID contract is incomplete."
}

"PASS: execute-tool spans preserve or generate call IDs."
```

Expected: `PASS: execute-tool spans preserve or generate call IDs.`

- [ ] **Step 4: Assert Microsoft distro instrumentation flags**

Run:

```powershell
$root = ".\dotnet\w365-computer-use\sample-agent"
$observability = Get-Content -Raw "$root\Telemetry\ObservabilityServiceCollectionExtensions.cs"

foreach ($flag in @(
  "EnableHttpClientInstrumentation = true",
  "EnableAspNetCoreInstrumentation = true",
  "EnableAgent365Instrumentation = true"
)) {
    if (-not $observability.Contains($flag, [StringComparison]::Ordinal)) {
        throw "Missing Microsoft distro instrumentation flag: $flag"
    }
}

"PASS: HTTP client, ASP.NET Core, and Agent365 instrumentation are enabled."
```

Expected: `PASS: HTTP client, ASP.NET Core, and Agent365 instrumentation are enabled.`

- [ ] **Step 5: Stop if any public contract is absent**

If Steps 1-4 fail, do not weaken the assertion or copy non-public source
verbatim. Return to the approved design, identify the smallest missing
public-safe behavior, and create a focused implementation plan with a failing
behavioral check before editing production code.

### Task 3: Verify build, packages, and exclusions

**Files:**
- Read: `dotnet/w365-computer-use/W365ComputerUseSample.sln`
- Read: `dotnet/w365-computer-use/sample-agent/W365ComputerUseSample.csproj`
- Scan: `dotnet/w365-computer-use/sample-agent`

- [ ] **Step 1: Restore and build Release**

Run:

```powershell
dotnet restore .\dotnet\w365-computer-use\W365ComputerUseSample.sln --nologo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

dotnet build .\dotnet\w365-computer-use\W365ComputerUseSample.sln `
  -c Release `
  -warnaserror `
  --no-restore `
  --nologo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

Expected: exit `0`, `Build succeeded.`, zero warnings, and zero errors.

- [ ] **Step 2: Verify package resolution**

Run:

```powershell
$packages = dotnet list `
  .\dotnet\w365-computer-use\sample-agent\W365ComputerUseSample.csproj `
  package `
  --include-transitive

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not ($packages | Select-String '^\s*>\s+Microsoft\.OpenTelemetry\s+1\.0\.6\s+1\.0\.6\s*$')) {
    throw "Microsoft.OpenTelemetry 1.0.6 is not the resolved top-level package."
}

if ($packages | Select-String "Microsoft\.Agents\.A365\.Observability\.Extensions\.AgentFramework") {
    throw "The legacy Agent Framework observability extension is still resolved."
}

"PASS: Microsoft.OpenTelemetry package migration."
```

Expected: `PASS: Microsoft.OpenTelemetry package migration.`

- [ ] **Step 3: Verify non-public tests and additional test-only accessors remain absent**

Run:

```powershell
$sampleRoot = ".\dotnet\w365-computer-use"
$verificationBase = git rev-parse HEAD^
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$forbiddenTestPaths = @(
  Get-ChildItem $sampleRoot -Recurse -File
  | Where-Object { $_.FullName -match "sample-agent\.Tests" }
)

$diffLines = @(
  git diff --unified=0 "${verificationBase}...HEAD" -- "$sampleRoot\sample-agent"
)
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$newTestAccessorMatches = @(
  $diffLines | Select-String -Pattern "^\+.*ForTest"
)

if ($forbiddenTestPaths.Count -gt 0 -or $newTestAccessorMatches.Count -gt 0) {
    throw "Non-public tests or additional test-only accessors were added to the public sample."
}

"PASS: non-public tests and additional test-only accessors remain excluded."
```

Expected: `PASS: non-public tests and additional test-only accessors remain excluded.`

- [ ] **Step 4: Verify non-public screen-share and handoff functionality remains absent**

Run:

```powershell
$sampleRoot = ".\dotnet\w365-computer-use"
$sampleSources = @(
  Get-ChildItem "$sampleRoot\sample-agent" -Recurse -File -Filter "*.cs"
  | Where-Object { $_.FullName -notmatch "\\(bin|obj)\\" }
)

$nonPublicFeatureMatches = @(
  $sampleSources | Select-String -Pattern "ScreenShare|Handoff|CustomEndpoint"
)

if ($nonPublicFeatureMatches.Count -gt 0) {
    $nonPublicFeatureMatches | Out-String | Write-Error
    exit 1
}

"PASS: non-public screen-share, handoff, and custom-endpoint functionality remains excluded."
```

Expected: `PASS: non-public screen-share, handoff, and custom-endpoint functionality remains excluded.`

### Task 4: Complete the no-op port

**Files:**
- Verify: `docs/superpowers/specs/2026-07-14-port-w365-pr-10-verification-design.md`
- Verify: `docs/superpowers/plans/2026-07-14-port-w365-pr-10-verification.md`
- Verify: complete verification diff against `HEAD^`

- [ ] **Step 1: Run branch-integrity checks**

Run:

```powershell
$verificationBase = git rev-parse HEAD^
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

git diff --check "${verificationBase}...HEAD"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$status = @(git status --short)
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($status.Count -ne 0) {
    $status | Out-String | Write-Error
    exit 1
}

$expectedPaths = @(
  "docs/superpowers/plans/2026-07-14-port-w365-pr-10-verification.md",
  "docs/superpowers/specs/2026-07-14-port-w365-pr-10-verification-design.md"
) | Sort-Object

$actualPaths = @(
  git diff --name-only "${verificationBase}...HEAD"
)
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$actualPaths = $actualPaths | Sort-Object

$difference = Compare-Object $expectedPaths $actualPaths -SyncWindow 0
if ($difference) {
    $difference | Format-Table | Out-String | Write-Error
    exit 1
}

"PASS: final build, diff, and status verification succeeded."
```

Expected: `PASS: final build, diff, and status verification succeeded.`

- [ ] **Step 2: Request final review**

Invoke `superpowers:requesting-code-review` against `HEAD^...HEAD`.
The reviewer must confirm:

- every telemetry requirement maps to current public code;
- no production code was changed by the follow-up;
- non-public tests, test-only accessors, and non-public functionality remain
  excluded;
- the mapping specification accurately reflects the public implementation.

Resolve only high-confidence findings caused by this follow-up.

- [ ] **Step 3: Run final verification**

Invoke `superpowers:verification-before-completion`, then rerun:

```powershell
$verificationBase = git rev-parse HEAD^
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

dotnet build .\dotnet\w365-computer-use\W365ComputerUseSample.sln `
  -c Release `
  -warnaserror `
  --no-restore `
  --nologo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

git diff --check "${verificationBase}...HEAD"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$status = @(git status --short)
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($status.Count -ne 0) {
    $status | Out-String | Write-Error
    exit 1
}

"PASS: final build, diff, and status verification succeeded."
```

Expected: build exit `0` with zero warnings/errors, diff check exit `0`, and
empty status output, ending with `PASS: final build, diff, and status verification succeeded.`

- [ ] **Step 4: Do not create an empty production commit**

The specification and this plan are the persistent proof of the no-op port. If
all checks pass, report that the telemetry follow-up was already covered by the
existing public implementation and identify the verification commit range
`HEAD^...HEAD`. Do not manufacture a source change or an empty commit.
