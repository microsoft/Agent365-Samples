# E2E Integration Tests

This directory contains end-to-end integration tests for Agent365 samples.

## Test Project

- **Framework**: .NET 8.0
- **Test Framework**: xUnit 2.9.0
- **Assertions**: FluentAssertions 6.12.0

## Test Classes

### HttpIntegrationTests

HTTP-based tests that verify agent connectivity and message processing.

| Test | Description |
|------|-------------|
| `TestAgentHealth` | Verifies agent is running and accessible |
| `TestAgentHttpEndpoint` | Tests basic message sending and response |
| `TestMultipleMessages` | Tests sequential multi-turn conversations |
| `TestMcpEmailTools` | Verifies MCP email tools are configured |
| `TestEmptyPayload` | Ensures graceful handling of empty messages |

All HTTP tests are tagged with `[Trait("Category", "HTTP")]`.

### MockBotFrameworkServer

A lightweight HTTP server that simulates the Bot Framework Connector API. This allows tests to capture agent responses without requiring a real Bot Framework connection.

- Runs on port 3980 by default
- Captures POST requests to `/v3/conversations/{id}/activities`
- Stores responses by conversation ID for test validation

### TestResultsCollector

Collects test results and saves them to a JSON file for reporting.

- Output path: `TEST_RESULTS_DIR` environment variable or `./TestResults`
- Records single and multi-turn conversations
- Tracks pass/fail status and error messages

## Running Tests Locally

```bash
# Set environment variables
$env:AGENT_URL = "http://localhost:3979"
$env:TEST_RESULTS_DIR = "./TestResults"

# Run all HTTP tests
dotnet test --filter "Category=HTTP"

# Run a specific test
dotnet test --filter "FullyQualifiedName~TestAgentHealth"
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_URL` | URL of the running agent | `http://localhost:3978` |
| `AGENT_PORT` | Port of the running agent | `3978` |
| `TEST_RESULTS_DIR` | Directory for test result files | `./TestResults` |

## Architecture

```
┌─────────────┐     POST /api/messages      ┌─────────────┐
│   Test      │ ──────────────────────────► │   Agent     │
│   Client    │   (serviceUrl=mock:3980)    │             │
└─────────────┘                             └──────┬──────┘
       ▲                                           │
       │                                           │ POST /v3/conversations/{id}/activities
       │                                           ▼
       │         WaitForResponsesAsync()    ┌─────────────┐
       └─────────────────────────────────── │ Mock Server │
                                            │ (port 3980) │
                                            └─────────────┘
```

1. Test sends message to agent with `serviceUrl` pointing to mock server
2. Agent processes message and calls mock server to send response
3. Mock server captures response
4. Test retrieves response and validates

## CI/CD Integration

These tests are run automatically by the GitHub Actions workflow:
- Workflow: `.github/workflows/e2e-agent-samples.yml`
- Filter: `--filter "Category=HTTP"`
- Results uploaded as artifacts
