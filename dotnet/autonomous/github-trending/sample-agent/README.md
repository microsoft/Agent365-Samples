# Autonomous Agent — .NET Sample

This sample demonstrates a **purely autonomous agent** built for Microsoft Agent 365 with the Microsoft OpenTelemetry distribution for .NET.

Every 60 seconds, the agent prompts Azure OpenAI to fetch trending GitHub repositories using a registered tool. The model calls the `GetTrendingRepositories` tool, which queries the GitHub Search API, then summarizes the results into a readable digest that is logged to the console. All operations are **manually instrumented** with Agent 365 observability using the tracing scopes (`InvokeAgentScope`, `InferenceScope`, `ExecuteToolScope`), making this a useful reference for instrumenting any non-interactive or custom agent loop.

For comprehensive documentation, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## What This Sample Demonstrates

| Pattern | Where |
|---------|-------|
| Autonomous background service with LLM tool calling | `GitHubTrendingService.cs` |
| AI function tool registered as a model plugin | `Tools/GitHubTrendingTool.cs` |
| IChatClient with function invocation | `Program.cs` |
| A365 observability with manual tracing scopes | `GitHubTrendingService.cs`, `Tools/GitHubTrendingTool.cs` |
| Microsoft OpenTelemetry distro with S2S exporter | `Program.cs` |
| 3-hop FMI/FIC token flow for observability export | `Observability/ObservabilityTokenService.cs` |
| Periodic heartbeat service | `HeartbeatService.cs` |

## Prerequisites

- [.NET 9.0 SDK](https://dotnet.microsoft.com/download/dotnet/9.0) or higher
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
- [Agent 365 CLI](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/agent-365-cli) (install: `dotnet tool install --global Microsoft.Agents.A365.DevTools.Cli --prerelease`)
- An Azure OpenAI resource with a deployed model (e.g., `gpt-4o`)
- An Entra tenant with at minimum the **Agent ID Developer** role

## Authentication + Identity

| Aspect | Model |
|--------|-------|
| **Authentication** | App token |
| **Identity** | Agent identity |

The agent authenticates using application credentials with no user context. In `Observability/ObservabilityTokenService.cs`, a 3-hop FMI chain bridges the blueprint's credentials to the agent identity via `.WithFmiPath(agentId)`, allowing the agent identity to acquire tokens for the A365 Observability API.

## Environment Configuration

### Agent 365 Setup

1. Log in to Azure: `az login`
2. Provision the agent:

```bash
cd dotnet/autonomous/github-trending/sample-agent
a365 setup all --agent-name <your-agent-name>
```

This command:
- Creates the **blueprint** app registration in Entra ID
- Creates the **agent identity** service principal
- Configures **inheritable permissions** for the Observability API (`Agent365.Observability.OtelWrite`) and Power Platform API
- Writes all provisioned values into `appsettings.json`

3. If required, have a Global Admin grant admin consent:

```bash
a365 setup permissions custom --agent-name <your-agent-name> --resource-app-id 9b975845-388f-4429-889e-eab1ef63949c --scopes Agent365.Observability.OtelWrite
```

4. Configure Azure OpenAI — the CLI does not configure Azure OpenAI settings. Set these manually in `appsettings.json` or via environment variables:

```bash
export AzureOpenAI__Endpoint="https://your-resource.openai.azure.com/"
export AzureOpenAI__ApiKey="your-api-key"
export AzureOpenAI__Deployment="gpt-4o"
```

### Configuration

All `<<PLACEHOLDER>>` values are written by `a365 setup all`. The `AzureOpenAI` section must be set manually.

| Section | Key | Set by | Default | Description |
|---------|-----|--------|---------|-------------|
| `Agent365Observability` | `TenantId` | CLI | — | Entra tenant ID |
| | `AgentBlueprintId` | CLI | — | Blueprint app registration ID |
| | `AgentId` | CLI | — | Agent identity ID (separate from blueprint) |
| | `ClientId` | CLI | — | Blueprint app ID (same as `AgentBlueprintId`) |
| | `ClientSecret` | CLI | — | Blueprint client secret (local dev only) |
| | `AgentName` | CLI | — | Display name shown in traces |
| | `AgentDescription` | CLI | — | Agent description shown in traces |
| | `UseManagedIdentity` | Manual | `true` | `true` for production (MSI), `false` for local dev (client secret) |
| `AzureOpenAI` | `Endpoint` | Manual | — | Azure OpenAI resource endpoint |
| | `ApiKey` | Manual | — | Azure OpenAI API key (omit to use `DefaultAzureCredential`) |
| | `Deployment` | Manual | `gpt-4o` | Model deployment name |
| `GitHubTrending` | `Language` | Manual | `csharp` | Programming language filter (e.g., `python`, `typescript`) |
| | `MinStars` | Manual | `5` | Minimum star count for repositories |
| | `MaxResults` | Manual | `10` | Number of repositories per digest |
| — | `HeartbeatIntervalMs` | Manual | `60000` | Polling interval in milliseconds |
| `Logging:LogLevel` | `Microsoft.Agents.A365.Observability` | Manual | `Debug` | A365 observability log level |
| | `OpenTelemetry` | Manual | `Debug` | OTel log level |

## Running the Agent Locally

### Quick start (Azure OpenAI only)

You can run the agent with **just Azure OpenAI credentials** — no Agent 365 setup required. The agent will skip the observability token service and log a warning:

```
Agent365Observability credentials not configured — skipping token service.
Run 'a365 setup all' to enable A365 observability export.
```

Set the Azure OpenAI values in `appsettings.json` (or via environment variables), then:

```bash
cd dotnet/autonomous/github-trending/sample-agent
ASPNETCORE_ENVIRONMENT=Development dotnet run
```

Tracing spans are still emitted to the console exporter, but not exported to the A365 service. To enable full A365 observability, complete the [Agent 365 Setup](#agent-365-setup) steps above.

### Local development (with A365 observability)

```bash
cd dotnet/autonomous/github-trending/sample-agent
ASPNETCORE_ENVIRONMENT=Development dotnet run
```

The agent starts on `http://localhost:3979`. Console output shows:
- **Observability token registration** on startup
- **Trending digest** immediately, then every 60 seconds
- **Heartbeat** log every 60 seconds
- **Span export details** (with Debug logging enabled)

The polling interval is controlled by `HeartbeatIntervalMs` in `appsettings.json` (default: 60000 ms).

## Deploying the Agent

Deploy to your hosting provider (Azure App Service, Container Apps, etc.) and ensure:

1. **Managed Identity is enabled** on the hosting resource
2. The MSI has a **Federated Identity Credential (FIC)** configured against the blueprint app — this is set up by `a365 setup all`
3. `ASPNETCORE_ENVIRONMENT` is set to `Production` (or omitted — it's the default)
4. The `AzureOpenAI` settings are configured via environment variables or app settings

No client secrets are needed in production — MSI handles authentication via the FMI chain.

## Observability

Each autonomous cycle produces three nested spans: an `InvokeAgentScope` wrapping the full cycle, an `InferenceScope` wrapping the LLM call (which may include multiple round-trips for function invocation), and an `ExecuteToolScope` wrapping the GitHub API tool call. These are emitted manually in `GitHubTrendingService.cs` and `Tools/GitHubTrendingTool.cs` using the OpenTelemetry distribution scopes.

The `ObservabilityTokenService` acquires tokens for the A365 exporter via a 3-hop FMI chain: the blueprint authenticates (MSI in production, client secret locally), exchanges for a T1 token targeting the agent identity via `.WithFmiPath`, then the agent identity uses T1 as an assertion to acquire an Observability API token. This token is cached in `ServiceTokenCache` and refreshed every 50 minutes. `UseManagedIdentity: true` in `appsettings.json` controls which path is used; it automatically falls back to client secret if MSI is unavailable.

For details on the observability SDK and instrumentation patterns, see the [Agent observability guide](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability).

## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-Samples/issues) section
- **Documentation**: See the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: For security issues, please see [SECURITY.md](../../../../SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- [Agent observability guide](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License — see the [LICENSE](../../../../LICENSE.md) file for details.
