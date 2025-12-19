# Agent 365 Integration Test Suite

## Overview

This directory contains PowerShell scripts for integration testing of Agent 365 sample agents. The test suite validates agent functionality including message handling, notifications, and MCP tool integration.

## Test Scripts

| Script | Description |
|--------|-------------|
| [Test-Agent365Integration.ps1](Test-Agent365Integration.ps1) | Main integration test script |

## Quick Start

### Prerequisites

- PowerShell 5.1 or PowerShell Core 7+
- A running Agent 365 sample agent on `http://localhost:3978`
- (Optional) Valid MCP bearer token for MCP tool tests

### Running the Tests

1. **Start your sample agent** in a terminal:

   ```powershell
   # For Python Agent Framework sample
   cd python/agent-framework/sample-agent
   python start_with_generic_host.py

   # For .NET Agent Framework sample
   cd dotnet/agent-framework/sample-agent
   dotnet run

   # For Node.js samples
   cd nodejs/openai/sample-agent
   npm start
   ```

2. **Run the integration tests** in another terminal:

   ```powershell
   cd scripts
   .\Test-Agent365Integration.ps1
   ```

3. **Run with verbose output** for debugging:

   ```powershell
   .\Test-Agent365Integration.ps1 -Verbose
   ```

## Test Categories

### 1. Health Check
Verifies the agent is running and responding at `/api/health`.

### 2. Message Activity Tests
Sends standard message activities to `/api/messages`:
- "Hello, can you help me?"
- "What tools do you have available?"
- "Tell me about yourself"

**Expected Result:** HTTP 202 Accepted

### 3. Email Notification Tests
Sends `agents/notification` invoke activities with `EmailNotification` type.

**Expected Result:** HTTP 202 (if supported) or HTTP 501 (not implemented)

### 4. Teams Message Notification Tests
Sends `agents/notification` invoke activities with `MessageNotification` type.

**Expected Result:** HTTP 202 (if supported) or HTTP 501 (not implemented)

### 5. Installation Update Tests
Sends `installationUpdate` activities with `add` and `remove` actions.

**Expected Result:** HTTP 202 Accepted

### 6. Tools Registration Test
Queries the agent for available tools and validates against the `ToolingManifest.json`.

### 7. MCP Tool Invocation Tests
Tests MCP tool functionality by sending queries that should trigger tool usage:
- Calendar: "What meetings do I have today?"
- Mail: "Do I have any unread emails?"
- Me: "What is my email address?"

**Note:** These tests require valid MCP authentication (bearer token).

## Command-Line Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `-BaseUrl` | string | `http://localhost:3978` | Agent base URL |
| `-Timeout` | int | `30` | Request timeout in seconds |
| `-SkipToolsTest` | switch | `false` | Skip MCP tool tests |
| `-ToolingManifestPath` | string | `""` | Path to ToolingManifest.json |
| `-ExpectedToolCount` | int | `0` | Expected number of tools |
| `-OutputJson` | switch | `false` | Output results as JSON |
| `-OutputFile` | string | `""` | File path for JSON output |
| `-Verbose` | switch | `false` | Enable verbose logging |

## Examples

### Basic Test Run
```powershell
.\Test-Agent365Integration.ps1
```

### Custom Agent URL
```powershell
.\Test-Agent365Integration.ps1 -BaseUrl "http://localhost:5000"
```

### Skip MCP Tool Tests
```powershell
.\Test-Agent365Integration.ps1 -SkipToolsTest
```

### Validate Against ToolingManifest
```powershell
.\Test-Agent365Integration.ps1 -ToolingManifestPath "../python/agent-framework/sample-agent/ToolingManifest.json"
```

### Verbose Debugging
```powershell
.\Test-Agent365Integration.ps1 -Verbose
```

## Understanding Test Results

### Pass Criteria
- **Health Check:** HTTP 200 response
- **Message Activities:** HTTP 202 Accepted
- **Notifications:** HTTP 202 (supported) or HTTP 501 (not implemented)
- **Installation Updates:** HTTP 202 Accepted
- **MCP Tools:** Response contains tool invocation evidence

### Expected Failures

Some tests may fail depending on agent configuration:

| Test | Common Failure Reason | Solution |
|------|----------------------|----------|
| MCP Tool Tests | No bearer token configured | Add valid `BEARER_TOKEN` to `.env` |
| Email Notifications | Agent doesn't support notifications | Expected behavior - passes as "not implemented" |
| Tool Registration | No ToolingManifest.json | Provide `-ToolingManifestPath` parameter |

## Test Output Example

```
============================================================
       Agent 365 Integration Test Script
       Testing: http://localhost:3978
============================================================

============================================================
  TEST: Agent Health Check
============================================================
  [PASS] PASSED: Agent is running
     Agent responded at http://localhost:3978/api/health

============================================================
  TEST: Message Activity Test
============================================================
  [PASS] PASSED: Send message: 'Hello, can you help me?'
     Status: 202
  [PASS] PASSED: Send message: 'What tools do you have available?'
     Status: 202

============================================================
  TEST SUMMARY
============================================================
  Total Tests:   14
  Passed:        11
  Failed:        3
  Skipped:       0
============================================================
```

## Troubleshooting

### Agent Not Responding
```
[FAIL] FAILED: Agent is running
    Unable to connect to http://localhost:3978/api/health
```
**Solution:** Ensure your agent is running on the correct port.

### MCP Tests Failing
```
[FAIL] FAILED: MCP: Calendar - List Events
    Expected tool: mcp_CalendarTools
```
**Solution:** Configure a valid `BEARER_TOKEN` in your agent's `.env` file.

### Import Errors When Starting Agent
```
Import error: No module named 'microsoft_agents_a365.tooling.extensions'
```
**Solution:** Reinstall dependencies:
```powershell
pip install microsoft-agents-a365-tooling --force-reinstall
pip install -e .
```

## Contributing

When adding new tests:
1. Follow the existing test naming convention
2. Use `Write-TestResult` for consistent output
3. Update this README with new test descriptions
4. Ensure tests work with both real and mock servers

## License

Copyright (c) Microsoft Corporation. Licensed under the MIT License.
