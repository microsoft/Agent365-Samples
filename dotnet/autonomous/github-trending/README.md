# Autonomous GitHub Trending Agent — Agent Framework Sample

## Overview

This sample demonstrates a **purely autonomous agent** built with the Microsoft Agent 365 SDK. Unlike the interactive agent samples, this agent has **no chat functionality** — it runs entirely as a background service.

Every 60 seconds, the agent:

1. Prompts Azure OpenAI to fetch trending GitHub repositories using a registered tool
2. The model calls the `GetTrendingRepositories` tool, which queries the GitHub Search API
3. The model summarizes the results into a readable digest
4. The digest is logged to the console

All operations are **manually instrumented** with Agent 365 observability using the A365 Observability SDK tracing scopes (`InvokeAgentScope`, `InferenceScope`, `ExecuteToolScope`). Unlike interactive agents that get auto-instrumented by the Microsoft OpenTelemetry distro via the Agent Framework pipeline, this autonomous agent has no `AgentApplication` or turn handler — so each background cycle and tool call is explicitly wrapped with the appropriate scope. This makes it a useful reference for instrumenting any non-interactive or custom agent loop.

For comprehensive documentation, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## What This Sample Demonstrates

| Pattern | Where |
|---------|-------|
| Autonomous background service with LLM tool calling | `GitHubTrendingService.cs` |
| AI function tool registered as a model plugin | `Tools/GitHubTrendingTool.cs` |
| IChatClient with function invocation | `Program.cs` |
| A365 observability with manual tracing scopes | `GitHubTrendingService.cs`, `Tools/GitHubTrendingTool.cs` |
| Microsoft OpenTelemetry distro integration | `Program.cs` |
| 3-hop FMI/FIC token flow for observability export | `Observability/ObservabilityTokenService.cs` |
| Periodic heartbeat service | `HeartbeatService.cs` |

## Prerequisites

- [.NET 8.0 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) or higher
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
- [Agent 365 CLI](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/agent-365-cli)
- An Azure OpenAI resource with a deployed model (e.g., `gpt-4o`)
- An Entra tenant with at minimum the **Agent ID Developer** role

## Agent 365 Setup

### 1. Install the Agent 365 CLI

```bash
dotnet tool install --global Microsoft.Agents.A365.DevTools.Cli --prerelease
```

### 2. Log in to Azure

```bash
az login
```

### 3. Provision the agent

```bash
cd dotnet/agent-framework/autonomous/github-trending
a365 setup all --agent-name <your-agent-name>
```

This command:
- Creates the **blueprint** app registration in Entra ID
- Creates the **agent identity** service principal
- Configures **inheritable permissions** for the Observability API (`Agent365.Observability.OtelWrite`) and Power Platform API
- Grants **admin consent** (requires Global Admin, or use `a365 setup admin` separately)
- Writes all provisioned values into `appsettings.json`

### 4. Admin consent (if required)

If the signed-in user does not have Global Admin, the setup output will include a permission grants action item. Have a Global Admin run:

```bash
a365 setup admin --blueprint-id <blueprint-id>
```

### 5. Configure Azure OpenAI

The CLI does not configure Azure OpenAI settings. Set these manually in `appsettings.json` or via environment variables:

```bash
export AzureOpenAI__Endpoint="https://your-resource.openai.azure.com/"
export AzureOpenAI__ApiKey="your-api-key"
export AzureOpenAI__Deployment="gpt-4o"
```

## Configuration Reference

### appsettings.json (production defaults)

All `<<PLACEHOLDER>>` values are written by `a365 setup all`. The `AzureOpenAI` section must be set manually.

| Section | Key | Set by | Description |
|---------|-----|--------|-------------|
| `Agent365Observability` | `TenantId` | CLI | Entra tenant ID |
| | `AgentBlueprintId` | CLI | Blueprint app registration ID |
| | `AgentId` | CLI | Agent identity ID (separate from blueprint) |
| | `ClientId` | CLI | Blueprint app ID (same as `AgentBlueprintId`) |
| | `ClientSecret` | CLI | Blueprint client secret |
| | `AgentName` | CLI | Display name shown in traces |
| | `AgentDescription` | CLI | Agent description shown in traces |
| | `UseManagedIdentity` | Manual | `true` for production (MSI), `false` for local dev (client secret) |
| `Connections:ServiceConnection` | `ClientId` | CLI | Blueprint app ID |
| | `ClientSecret` | CLI | Blueprint client secret |
| | `AuthorityEndpoint` | CLI | `https://login.microsoftonline.com/<tenant-id>` |
| `AzureOpenAI` | `Endpoint` | Manual | Azure OpenAI resource endpoint |
| | `ApiKey` | Manual | Azure OpenAI API key |
| | `Deployment` | Manual | Model deployment name |

### appsettings.Development.json (local dev overrides)

This file overrides production defaults for local development:

```json
{
  "Agent365Observability": {
    "UseManagedIdentity": false
  },
  "Logging": {
    "LogLevel": {
      "Microsoft.Agents.A365.Observability": "Debug",
      "OpenTelemetry": "Debug"
    }
  }
}
```

| Override | Production | Local Dev |
|----------|-----------|-----------|
| `UseManagedIdentity` | `true` — MSI authenticates the blueprint | `false` — client secret authenticates the blueprint |
| Observability logging | `Information` | `Debug` — shows span export details |
| Console exporter | Off | On — spans printed to console (set in `Program.cs`) |
| A365 exporter | On | On — traces also exported to A365 service |

## Running the Agent

### Quick start (Azure OpenAI only)

You can run the agent with **just Azure OpenAI credentials** — no Agent 365 setup required. The agent will skip the observability token service and log a warning:

```
Agent365Observability credentials not configured — skipping token service.
Run 'a365 setup all' to enable A365 observability export.
```

Set the Azure OpenAI values in `appsettings.json` (or via environment variables), then:

```bash
cd dotnet/autonomous/github-trending
ASPNETCORE_ENVIRONMENT=Development dotnet run
```

Tracing spans are still emitted to the console exporter, but not exported to the A365 service. To enable full A365 observability, complete the [Agent 365 Setup](#agent-365-setup) steps above.

### Local development (with A365 observability)

```bash
cd dotnet/autonomous/github-trending
ASPNETCORE_ENVIRONMENT=Development dotnet run
```

The agent starts on `http://localhost:5000`. Console output shows:
- **Observability token registration** on startup
- **Trending digest** immediately, then every 60 seconds
- **Heartbeat** log every 60 seconds
- **Span export details** (with Debug logging enabled)

The polling interval is controlled by `HeartbeatIntervalMs` in `appsettings.json` (default: 60000 ms).

### Production

Deploy to your hosting provider (Azure App Service, Container Apps, etc.) and ensure:

1. **Managed Identity is enabled** on the hosting resource
2. The MSI has a **Federated Identity Credential (FIC)** configured against the blueprint app — this is set up by `a365 setup all` when deploying to Azure
3. `ASPNETCORE_ENVIRONMENT` is set to `Production` (or omitted — it's the default)
4. The `AzureOpenAI` settings are configured via environment variables or app settings

No client secrets are needed in production — MSI handles authentication.

## Observability Architecture

### Tracing spans

Each autonomous cycle produces three nested spans:

```
InvokeAgentScope                        (root — wraps the entire cycle)
  |-- InferenceScope                    (child — wraps the LLM call)
  |-- ExecuteToolScope                  (child — wraps the GitHub API tool call)
```

These spans are emitted by the [Microsoft OpenTelemetry distro](https://github.com/microsoft/opentelemetry-distro-dotnet) and exported to the Agent 365 observability service.

### Token flow — 3-hop FMI chain

The `ObservabilityTokenService` background service acquires tokens for the A365 observability exporter using a 3-hop Federated Managed Identity (FMI) chain. This is required because Entra's agentic application enforcement (`AADSTS82001`) prevents blueprints from directly requesting app-only tokens for the observability resource.

```
Production (MSI):
  MSI → ManagedIdentityCredential.GetToken("api://AzureADTokenExchange")
      → Blueprint ConfidentialClient + assertion + .WithFmiPath(agentId)
      → T1 token (targeted at Agent Identity)
      → Agent Identity ConfidentialClient + T1 as assertion
      → AcquireTokenForClient("api://9b975845-.../. default")
      → Observability API token

Local dev (client secret):
  Blueprint ConfidentialClient + ClientSecret + .WithFmiPath(agentId)
      → T1 token (targeted at Agent Identity)
      → Agent Identity ConfidentialClient + T1 as assertion
      → AcquireTokenForClient("api://9b975845-.../.default")
      → Observability API token
```

The token is refreshed every 50 minutes and cached in the `ServiceTokenCache`. The A365 exporter's `TokenResolver` reads from this cache when exporting spans.

**Why this flow?**
- The **blueprint** owns the client credentials and the `OtelWrite` app role
- The **agent identity** inherits permissions from the blueprint via **consent inheritance**
- Entra requires app-only tokens for the observability resource to be issued to the **agent identity**, not the blueprint directly
- The FMI path (`WithFmiPath`) bridges the blueprint's credentials to the agent identity without the agent identity needing its own client secret

For more details on the observability SDK and instrumentation patterns, see [Agent observability — Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability).

## How It Works

```
+---------------------------------+
|     GitHubTrendingService       |
|     (BackgroundService)         |
|                                 |
|  1. Timer fires                 |
|  2. InvokeAgentScope started    |
|  3. Send prompt to IChatClient  |
|     with tool registered        |
|                                 |
|  +---------------------------+  |
|  | Azure OpenAI (IChatClient)|  |
|  | InferenceScope started    |  |
|  |                           |  |
|  |  4. Model calls           |  |
|  |     GetTrendingRepositories  |
|  |                           |  |
|  |  +---------------------+  |  |
|  |  | GitHubTrendingTool  |  |  |
|  |  | ExecuteToolScope    |  |  |
|  |  |                     |  |  |
|  |  | 5. GET github.com/  |  |  |
|  |  |    search/repos     |  |  |
|  |  +---------------------+  |  |
|  |                           |  |
|  |  6. Model summarizes      |  |
|  |     results into digest   |  |
|  +---------------------------+  |
|                                 |
|  7. Log digest to console       |
|  8. Spans exported to A365      |
+---------------------------------+
```

## GitHub Trending Configuration

The `GitHubTrending` section in `appsettings.json` controls search parameters:

| Setting | Description | Default |
|---------|-------------|---------|
| `Language` | Programming language filter (e.g., `csharp`, `python`, `typescript`) | `csharp` |
| `MinStars` | Minimum star count for repositories | `5` |
| `MaxResults` | Number of repositories per digest | `10` |

The GitHub Search API is unauthenticated — no API key required (rate limit: 10 requests/minute).

## Project Structure

```
github-trending/
  Program.cs                              # Entry point — DI, distro, services
  GitHubTrendingService.cs                # Autonomous background service (InvokeAgent + Inference spans)
  HeartbeatService.cs                     # Periodic heartbeat logger
  Tools/
    GitHubTrendingTool.cs                 # GitHub Search API tool (ExecuteTool span)
  Observability/
    ObservabilityServiceExtensions.cs     # DI registration for token cache + context
    ObservabilityTokenService.cs          # Background FMI token acquisition service
  appsettings.json                        # Production config (placeholders, MSI enabled)
  appsettings.Development.json            # Local dev overrides (client secret, debug logging)
```

## Support

- **Issues**: [GitHub Issues](https://github.com/microsoft/Agent365-Samples/issues)
- **Documentation**: [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: See [SECURITY.md](../../../../SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA). For details, visit <https://cla.opensource.microsoft.com>.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License — see the [LICENSE](../../../../LICENSE.md) file for details.
