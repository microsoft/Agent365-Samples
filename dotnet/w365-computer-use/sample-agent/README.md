# W365 Computer Use — .NET Sample

This interactive .NET 8 `AgentApplication` uses the Microsoft 365 Agents SDK, Agent 365 tooling, and the Azure OpenAI Responses API to control a Windows 365 Cloud PC through computer use. It is a useful reference for combining W365 MCP tools, agentic user authorization, and screensharing in an `/api/messages` agent.

For comprehensive documentation, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## What This Sample Demonstrates

| Pattern | Where |
|---------|-------|
| Interactive Microsoft 365 agent endpoint at `/api/messages` | `Program.cs` |
| W365 MCP/CUA session startup, tool discovery, and session-aware tool calls | `Agent/MyAgent.cs`, `ComputerUse/W365McpSessionClient.cs` |
| Azure OpenAI Responses API model selection and CUA requests | `ComputerUse/AzureOpenAIModelProvider.cs`, `ComputerUse/AzureOpenAIModelProviderOptions.cs` |
| Agentic authorization handlers with the local `BEARER_TOKEN` fallback | `appsettings.json`, `Agent/MyAgent.cs` |
| ARI token handoff and screenshare viewer protection | `Agent/MyAgent.cs`, `ScreenShare/HandoffStore.cs`, `ScreenShare/ScreenShareOptions.cs`, `Program.cs` |
| `InvokeAgentScope`, `InferenceScope`, and `ExecuteToolScope` telemetry | `Telemetry/A365OtelWrapper.cs`, `Telemetry/InferenceTelemetry.cs`, `Telemetry/ToolTelemetry.cs` |
| Telemetry-only privacy redaction for screenshots, images, text, URLs, and handoff codes | `Telemetry/TelemetryContentPolicy.cs` |

## Prerequisites

- [.NET 8.0 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) or later
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
- [Agent 365 CLI](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/agent-365-cli) (install: `dotnet tool install --global Microsoft.Agents.A365.DevTools.Cli --prerelease`)
- An Azure OpenAI resource with a CUA-capable deployment: `computer-use-preview`, `gpt-5.4`, or `gpt-5.4-mini`
- An Entra tenant with at minimum the **Agent ID Developer** role
- Access to the W365 Computer Use MCP server with `Tools.ListInvoke.All`
- For screenshare, a W365 session that returns a `screenShareUrl` and a valid ARI token; local screenshare also requires HTTPS and `ARI_BEARER_TOKEN`

## Authentication + Identity

| Aspect | Model |
|--------|-------|
| **Authentication** | Agent user |
| **Identity** | Agent identity |

`AgentApplication` uses the configured `AgenticUserAuthorization` handlers for Graph, W365, and ARI tokens. For local development, `Agent/MyAgent.cs` accepts `BEARER_TOKEN`; `scripts/Get-CuaAgentUserToken.ps1` obtains that agent-user token through the blueprint and agent-identity user-FIC flow.

## Environment Configuration

### Agent 365 Setup

From `dotnet/w365-computer-use/sample-agent`, sign in with Azure CLI and run:

```powershell
az login
dotnet tool install --global Microsoft.Agents.A365.DevTools.Cli --prerelease
a365 setup all
```

Complete the required tenant admin consent for the provisioned Agent 365 blueprint and agent identity. Configure Azure OpenAI credentials, W365 MCP access, and screenshare values manually in user secrets or an uncommitted `appsettings.Development.json`; do not place secrets, tokens, client secrets, or real IDs in `appsettings.json`.

### Configuration

| Setting | Description | Set by |
|---------|-------------|--------|
| `EnableOpenTelemetryConsoleExporter` | Adds the console exporter alongside the Agent 365 exporter when `true`; default is `false`. | Manual |
| `Agent365Observability:AgentId` | Optional Agent 365 agent ID metadata. | CLI or Manual |
| `Agent365Observability:AgentName` | Telemetry agent name; defaults to `W365 Computer Use Sample`. | Manual |
| `Agent365Observability:AgentDescription` | Optional telemetry description. | Manual |
| `Agent365Observability:TenantId` | Optional tenant metadata. | CLI or Manual |
| `Agent365Observability:AgentBlueprintId` | Optional Agent 365 blueprint metadata. | CLI or Manual |
| `Agent365Observability:ClientId` | Optional client ID metadata. | CLI or Manual |
| `Agent365Observability:AgenticUserId` | Optional agentic-user metadata. | CLI or Manual |
| `Agent365Observability:AgenticUserEmail` | Optional agentic-user email metadata. | CLI or Manual |
| `Agent365Observability:MessagingEndpoint` | Optional messaging endpoint metadata. | CLI or Manual |
| `Agent365Observability:DefaultChannelName` | Default telemetry channel name (`msteams`). | Manual |
| `Agent365Observability:OperationSource` | Telemetry operation source (`W365ComputerUseSample`). | Manual |
| `Logging:LogLevel:OpenTelemetry` | OpenTelemetry log level; default is `Information`. | Manual |
| `Logging:LogLevel:Microsoft.Agents.A365.Observability` | Agent 365 observability log level; default is `Information`. | Manual |
| `AIServices:AzureOpenAI:Endpoint` and `AIServices:AzureOpenAI:ApiKey` | Azure OpenAI endpoint and API key. | Manual |
| `AIServices:AzureOpenAI:ModelName` | Preferred Responses API `model`, for example `gpt-5.4-mini`. | Manual |
| `AIServices:AzureOpenAI:DeploymentName` | Backward-compatible model fallback; used when `ModelName` is empty. | Manual |
| `McpServer:Url` or `McpServers` | Local MCP Platform URL(s), including the W365 server path; required for W365 CUA development. | Manual |
| `W365:GatewayUrl` | Production W365 gateway; defaults to `https://agent365.svc.cloud.microsoft/agents/servers/mcp_W365ComputerUse`. | Manual |
| `ComputerUse:MaxIterations`, `DisplayWidth`, and `DisplayHeight` | Limits and display dimensions for the CUA loop. | Manual |
| `Screenshots:LocalPath`, `OneDriveFolder`, and `OneDriveUserId` | Local and optional OneDrive screenshot storage settings. | Manual |
| `BEARER_TOKEN` | Development W365 MCP token with `Tools.ListInvoke.All`; never store it in configuration. | Manual |
| `GRAPH_TOKEN` | Optional development Graph token with `Files.ReadWrite` for OneDrive screenshot upload. | Manual |
| `ScreenShare:AuthMode` | Use `DevBypass` only in Development or Playground; use `EasyAuth` in production. | Manual |
| `ScreenShare:PageBaseUrl` | Public base URL for `screenshare.html`; otherwise the app uses `WEBSITE_HOSTNAME`. | Manual |
| `ScreenShare:SdkVersion`, `CdnOrigin`, and `AllowedFrameAncestors` | Screenshare SDK source and embedding policy. | Manual |
| `ARI_BEARER_TOKEN` | Local-development ARI token override, read before the configured ARI handler; do not set it in production. | Manual |

The provider sends every request to `<Endpoint>/openai/v1/responses`; the body uses `ModelName` when supplied, otherwise `DeploymentName`, and finally `computer-use-preview`. `computer-use-preview` uses the computer-use-preview tool shape, while `gpt-5.4` and `gpt-5.4-mini` use the `computer` tool shape. If `McpServer:Url` is missing in Development, W365 tool loading fails; if the model returns a 400 response, verify the selected model and tool shape.

## Running the Agent Locally

### Quick start (Azure OpenAI only)

Set `AIServices:AzureOpenAI:Endpoint`, `ApiKey`, and either `ModelName` or `DeploymentName` through user secrets or `appsettings.Development.json`, then run:

```powershell
$env:ASPNETCORE_ENVIRONMENT = "Development"
dotnet run
```

This starts the local agent and validates the Azure OpenAI Responses API path without exporter identity metadata. It does not enable Windows 365 computer use: CUA requires W365 MCP access, a development bearer token, and a local MCP URL.

### Local development (with A365 observability)

Create an Agent 365 blueprint and agent identity, then obtain a W365 CUA agent-user token. The helper assigns the final token to the current PowerShell process:

```powershell
$tenantId = "<tenant-id-or-domain>"
$blueprintClientId = "<agent-blueprint-client-id>"
$blueprintClientSecret = Read-Host "Agent Blueprint client secret" -AsSecureString
$blueprintClientSecretPlainText = [System.Net.NetworkCredential]::new("", $blueprintClientSecret).Password
$agentClientId = "<agent-identity-client-id>"
$agentUpn = "<agent-upn-from-teams-instance>"

.\scripts\Get-CuaAgentUserToken.ps1 `
  -TenantId $tenantId `
  -AgentBlueprintClientId $blueprintClientId `
  -AgentBlueprintClientSecret $blueprintClientSecretPlainText `
  -AgentClientId $agentClientId `
  -AgentUsername $agentUpn `
  -InformationAction Continue

$env:ASPNETCORE_ENVIRONMENT = "Development"
$env:GRAPH_TOKEN = "<optional-graph-token-for-onedrive-upload>"
dotnet run
```

The helper first obtains a blueprint application token with `fmi_path`, exchanges it for an agent-identity token, and requests the final `user_fic` CUA token. Its default W365 scope is `da81128c-e5b5-4f9e-8d89-50d906f107c5/.default`; pass `-Scope "<scope>"` only when a different audience is required.

For local W365 CUA, configure `McpServer:Url` for the local MCP Platform server (normally port `52857`) and keep the resulting `BEARER_TOKEN` in the same PowerShell process. For local or Playground screenshare, set `ScreenShare:AuthMode` to `DevBypass`, set a valid `ARI_BEARER_TOKEN`, and use the HTTPS listener at `https://localhost:3979`; `DevBypass` is rejected outside Development or Playground. Test the agent through [Microsoft 365 Agents Playground](https://dev.agents.cloud.microsoft/) using `http://localhost:3978/api/messages` and follow the [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing) guide. Screenshots are saved under `./Screenshots/<session-id>/`; a Graph token is only needed for OneDrive upload.

## Deploying the Agent

Deploy the `/api/messages` host to a provider that supports the required Agent 365 identity configuration. Configure the production managed identity (MSI) and its Federated Identity Credential (FIC) against the Agent 365 blueprint, complete required consent, and configure the `agentic`, `w365`, and `ari` authorization handlers. Do not deploy development `BEARER_TOKEN`, `GRAPH_TOKEN`, local `McpServer:Url`, or `ARI_BEARER_TOKEN`.

For W365 production access, omit the local MCP URL so the sample uses `W365:GatewayUrl` and the `w365` agentic handler; the default is `https://agent365.svc.cloud.microsoft/agents/servers/mcp_W365ComputerUse`. The agent starts a W365 session before desktop actions and passes its selected session ID to remote W365 calls.

Enable Azure App Service Authentication (EasyAuth) with Microsoft Entra ID for the screenshare page, keep `ScreenShare:AuthMode=EasyAuth`, and set `ScreenShare:PageBaseUrl` to the public app URL when it differs from `https://$WEBSITE_HOSTNAME`. The screenshare handoff is single-process in this sample; use a distributed store before scaling out. Grant the agent identity the ARI screenshare permissions for the target W365 Cloud PC pool.

## Observability

The sample uses Microsoft.OpenTelemetry 1.0.6 with Agent 365 export and produces `InvokeAgentScope` spans for agent turns, `InferenceScope` spans for Azure OpenAI Responses API calls, and `ExecuteToolScope` spans for MCP tool calls. The agentic and service token caches support the Agent 365 exporter token flow; set `EnableOpenTelemetryConsoleExporter` to `true` to add local console output.

Telemetry-only redaction removes screenshot/image payloads and sensitive text or URLs from model and tool telemetry, and removes screenshare handoff codes from recorded outputs; original model and tool runtime results are unchanged. `Agent365Observability` metadata is optional, and no secrets belong in `appsettings.json`. See the [Agent observability guide](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability) for details.

## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-Samples/issues) section
- **Documentation**: See the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: For security issues, please see [SECURITY.md](../../../SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- [Agent observability guide](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability)
- [Microsoft 365 Agents SDK - .NET repository](https://github.com/Microsoft/Agents-for-net)
- [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing)
- [Azure OpenAI computer use guide](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/computer-use)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License — see the [LICENSE](../../../LICENSE.md) file for details.
