# Windows 365 Computer Use Agent — .NET Sample

This interactive .NET 8 agent uses the Microsoft 365 Agents SDK, the Azure OpenAI Responses API, and the Windows 365 Computer Use MCP server to complete natural-language tasks on a Cloud PC. It is a reference for explicit W365 session management, computer-use orchestration, agentic user authentication, and Agent 365 semantic observability.

For comprehensive documentation, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## What This Sample Demonstrates

| Pattern | Where |
|---------|-------|
| Interactive agent hosted at `/api/messages` | `Program.cs`, `Agent/MyAgent.cs` |
| Azure OpenAI Responses API integration for computer-use models | `ComputerUse/AzureOpenAIModelProvider.cs` |
| Explicit W365 MCP session startup, reuse, recovery, and cleanup | `ComputerUse/ComputerUseOrchestrator.cs`, `ComputerUse/W365McpSessionClient.cs` |
| Agentic user authorization with a development bearer-token fallback | `Agent/MyAgent.cs`, `appsettings.json` |
| Microsoft OpenTelemetry distro with Agent 365 export | `Telemetry/ObservabilityServiceCollectionExtensions.cs` |
| Agent turn, inference, and tool semantic spans | `Telemetry/A365OtelWrapper.cs`, `Telemetry/InferenceTelemetry.cs`, `Telemetry/ToolTelemetry.cs` |
| Shared Agent 365 baggage and activity context | `Telemetry/Agent365TelemetryContext.cs` |
| Telemetry-only redaction of text and image data | `Telemetry/InferenceTelemetry.cs`, `Telemetry/ToolTelemetry.cs` |

## Prerequisites

- [.NET 8.0 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) or later
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
- [Agent 365 CLI](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/agent-365-cli) (install: `dotnet tool install --global Microsoft.Agents.A365.DevTools.Cli --prerelease`)
- An Azure OpenAI resource with a deployed `computer-use-preview`, `gpt-5.4`, or `gpt-5.4-mini` model
- An Entra tenant with at minimum the **Agent ID Developer** role
- Access to the Windows 365 Computer Use MCP server through the Agent 365 MCP Platform
- A token with the Windows 365 for Agents `Tools.ListInvoke.All` permission
- Optional: Microsoft Graph `Files.ReadWrite` permission for OneDrive screenshot uploads

## Authentication + Identity

| Aspect | Model |
|--------|-------|
| **Authentication** | Agent user |
| **Identity** | Agent user with own identity |

Production requests use the `agentic` and `w365` `AgenticUserAuthorization` handlers configured in `appsettings.json`; `Agent/MyAgent.cs` exchanges the current turn token for the required downstream resource. Local development can instead use `BEARER_TOKEN`, but that fallback does not provide the agentic turn token needed for Agent 365 export.

## Environment Configuration

### Agent 365 Setup

1. Log in to Azure:

   ```bash
   az login
   ```

2. Provision the blueprint, agent identity, and local settings:

   ```bash
   cd dotnet/w365-computer-use/sample-agent
   a365 setup all --agent-name <your-agent-name>
   ```

3. If required, have a Global Administrator grant admin consent for Agent 365 observability:

   ```bash
   a365 setup permissions custom --agent-name <your-agent-name> --resource-app-id 9b975845-388f-4429-889e-eab1ef63949c --scopes Agent365.Observability.OtelWrite
   ```

   Also grant the agent the Windows 365 for Agents `Tools.ListInvoke.All` permission required by the `w365` authorization handler.

4. Configure the Azure OpenAI values manually. The Agent 365 CLI does not provision the model deployment or API key. Store secrets in environment variables, .NET user secrets, or an uncommitted `appsettings.Development.json`:

   ```powershell
   $env:AIServices__AzureOpenAI__Endpoint = "https://your-resource.openai.azure.com"
   $env:AIServices__AzureOpenAI__ApiKey = "<your-api-key>"
   $env:AIServices__AzureOpenAI__ModelName = "gpt-5.4-mini"
   ```

### Configuration

For local development, create `appsettings.Development.json`:

```json
{
  "AIServices": {
    "Provider": "AzureOpenAI",
    "AzureOpenAI": {
      "ModelName": "gpt-5.4-mini",
      "Endpoint": "https://your-resource.openai.azure.com",
      "ApiKey": "<<YOUR_API_KEY>>"
    }
  },
  "McpServer": {
    "Url": "http://localhost:52857/mcp/environments/Default-<<YOUR_TENANT_ID>>/servers/mcp_W365ComputerUse"
  }
}
```

For `computer-use-preview`, set `DeploymentName` to `computer-use-preview` instead of `ModelName`. `DeploymentName` is retained as a model identifier fallback; requests use the v1 Responses endpoint (`/openai/v1/responses`).

The following optional settings provide fallback telemetry metadata when the incoming activity does not contain it:

```json
{
  "EnableOpenTelemetryConsoleExporter": false,
  "Agent365Observability": {
    "AgentId": "<<YOUR_AGENT_ID>>",
    "AgentName": "<<YOUR_AGENT_NAME>>",
    "AgentDescription": "<<YOUR_AGENT_DESCRIPTION>>",
    "TenantId": "<<YOUR_TENANT_ID>>",
    "AgentBlueprintId": "<<YOUR_AGENT_BLUEPRINT_ID>>",
    "ClientId": "<<YOUR_CLIENT_ID>>",
    "AgenticUserId": "",
    "AgenticUserEmail": "",
    "MessagingEndpoint": "<<YOUR_MESSAGING_ENDPOINT>>",
    "DefaultChannelName": "msteams",
    "OperationSource": "W365ComputerUseSample"
  },
  "Logging": {
    "LogLevel": {
      "OpenTelemetry": "Information",
      "Microsoft.Agents.A365.Observability": "Information"
    }
  }
}
```

| Section | Key | Set by | Default | Description |
|---------|-----|--------|---------|-------------|
| `AgentApplication` | `AgenticAuthHandlerName` | Repo/Manual | `agentic` | Agentic user handler used for Graph and observability token exchange |
| | `W365AuthHandlerName` | Repo/Manual | `w365` | Agentic user handler used for the W365 MCP token |
| `AIServices` | `Provider` | Manual | `AzureOpenAI` | Model provider |
| `AIServices:AzureOpenAI` | `Endpoint` | Manual | — | Azure OpenAI resource endpoint |
| | `ApiKey` | Manual | — | Azure OpenAI API key; do not commit it |
| | `ModelName` | Manual | — | Model identifier such as `gpt-5.4-mini` |
| | `DeploymentName` | Manual | `computer-use-preview` | Backward-compatible model identifier fallback |
| `McpServer` | `Url` | Manual | — | Local MCP Platform URL; omit in production |
| `W365` | `GatewayUrl` | Manual | `https://agent365.svc.cloud.microsoft/agents/servers/mcp_W365ComputerUse` | Production W365 MCP gateway |
| `ComputerUse` | `MaxIterations` | Manual | `30` | Maximum CUA loop iterations |
| | `DisplayWidth` | Manual | `1024` | Display width for `computer_use_preview` |
| | `DisplayHeight` | Manual | `768` | Display height for `computer_use_preview` |
| `Screenshots` | `LocalPath` | Manual | `./Screenshots` | Local screenshot directory |
| | `OneDriveFolder` | Manual | `CUA-Sessions` | OneDrive upload folder |
| | `OneDriveUserId` | Manual | — | Optional target user's UPN/email |
| `Agent365Observability` | `AgentId` | CLI/Manual | Activity value | Agent identity used in traces |
| | `AgentName` | CLI/Manual | — | Agent display name |
| | `AgentDescription` | CLI/Manual | — | Agent description |
| | `TenantId` | CLI/Manual | Activity value | Entra tenant ID |
| | `AgentBlueprintId` | CLI/Manual | — | Agent blueprint application ID |
| | `ClientId` | CLI/Manual | — | Client application ID |
| | `AgenticUserId` | CLI/Manual | Activity value | Agentic user object ID |
| | `AgenticUserEmail` | CLI/Manual | Activity value | Agentic user email |
| | `MessagingEndpoint` | CLI/Manual | Activity service URL | Agent messaging endpoint |
| | `DefaultChannelName` | Manual | `msteams` | Channel fallback for telemetry |
| | `OperationSource` | Manual | `W365ComputerUseSample` | Operation-source baggage value |
| Root | `EnableOpenTelemetryConsoleExporter` | Manual | `false` | Adds console export for local diagnostics; Agent 365 export remains enabled |
| `Logging:LogLevel` | `OpenTelemetry` | Manual | Framework default | OpenTelemetry diagnostics level |
| | `Microsoft.Agents.A365.Observability` | Manual | Framework default | Agent 365 observability diagnostics level |
| Environment | `BEARER_TOKEN` | Manual | — | Local W365 MCP token with `Tools.ListInvoke.All` |
| | `GRAPH_TOKEN` | Manual | — | Optional Graph token with `Files.ReadWrite` |

Supported model behavior:

| Model | Tool type | Configuration | Notes |
|-------|-----------|---------------|-------|
| `computer-use-preview` | `computer_use_preview` | `DeploymentName: "computer-use-preview"` | Uses display width, display height, and environment parameters |
| `gpt-5.4` / `gpt-5.4-mini` | `computer` | `ModelName: "gpt-5.4-mini"` | Uses the built-in computer tool and sends an initial screenshot when a session is already active |

## Running the Agent Locally

### Quick start (Azure OpenAI only)

Azure OpenAI credentials alone are not sufficient to exercise this sample; computer-use operations also require the local MCP Platform and a W365 token. This path omits Agent 365 observability setup and uses the development bearer-token fallback.

1. Restore dependencies and create the `appsettings.Development.json` shown above:

   ```powershell
   cd dotnet\w365-computer-use\sample-agent
   dotnet restore
   ```

2. Obtain a W365 token. The helper sets `BEARER_TOKEN` in the current PowerShell process:

   ```powershell
   $blueprintClientSecret = Read-Host "Agent Blueprint client secret" -AsSecureString
   $blueprintClientSecretPlainText = [System.Net.NetworkCredential]::new("", $blueprintClientSecret).Password

   .\scripts\Get-CuaAgentUserToken.ps1 `
     -TenantId "<tenant-id-or-domain>" `
     -AgentBlueprintClientId "<agent-blueprint-client-id>" `
     -AgentBlueprintClientSecret $blueprintClientSecretPlainText `
     -AgentClientId "<agent-identity-client-id>" `
     -AgentUsername "<agent-upn-from-teams-instance>" `
     -InformationAction Continue
   ```

3. Start the MCP Platform locally on port `52857`, then run the agent:

   ```powershell
   $env:ASPNETCORE_ENVIRONMENT = "Development"
   dotnet run
   ```

4. Open [Microsoft 365 Agents Playground](https://dev.agents.cloud.microsoft/), connect to `http://localhost:3978/api/messages`, and try: `Open Notepad and type Hello World`.

Screenshots are saved under `./Screenshots/<session-id>/`. To upload them to OneDrive, set `GRAPH_TOKEN` to a token with `Files.ReadWrite`; `Screenshots:OneDriveUserId` optionally selects another user's drive.

### Local development (with A365 observability)

Complete [Agent 365 Setup](#agent-365-setup), populate any needed `Agent365Observability` fallbacks, and send an agentic request so `A365OtelWrapper` can exchange the turn token and register it with `ServiceTokenCache`. A bearer-token-only request still creates spans, but it cannot authenticate the Agent 365 exporter.

Set `EnableOpenTelemetryConsoleExporter` to `true` only when you also want local console diagnostics:

```powershell
$env:ASPNETCORE_ENVIRONMENT = "Development"
$env:EnableOpenTelemetryConsoleExporter = "true"
dotnet run
```

Use the [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing) guide for Playground, WebChat, Teams, and Microsoft 365 testing options.

### Troubleshooting

| Issue | Resolution |
|-------|------------|
| `McpServer:Url is required` | Add the local MCP Platform URL to `appsettings.Development.json` |
| `BEARER_TOKEN` not set | Run `Get-CuaAgentUserToken.ps1` in the same PowerShell process before `dotnet run` |
| Azure OpenAI returns HTTP 400 | Confirm the configured model and tool type match the supported-model table |
| Screenshot extraction fails | Confirm the W365 MCP server returned an image content block |
| Agent 365 spans are not exported | Use an agentic request, verify observability consent, and check the Agent 365 observability log category |
| A session remains after a process crash | W365 sessions expire on the backend after approximately 30 minutes |

## Deploying the Agent

Deploy the ASP.NET Core application to Azure App Service, Azure Container Apps, or another HTTPS hosting provider, then configure:

1. A user-assigned managed identity on the hosting resource.
2. A Federated Identity Credential (FIC) between that managed identity and the agent blueprint; `a365 setup all` provisions the required Agent 365 identity resources.
3. `Connections:ServiceConnection` with `AuthType` set to `UserManagedIdentity`, the production tenant authority, and managed identity client ID.
4. Azure OpenAI settings through protected application settings or Key Vault references.
5. `TokenValidation:Enabled` and the production audience for authenticated `/api/messages` traffic.
6. The Azure Bot or channel messaging endpoint as `https://<host>/api/messages`.
7. The W365 gateway permission and `w365` agentic authorization handler. Omit `McpServer:Url` so production uses `W365:GatewayUrl`.
8. The `Agent365Observability` metadata needed when it is not available on incoming activities.

Do not deploy client secrets. Use managed identity and FIC for hosting authentication, then install and validate the corresponding agent in Teams or Microsoft 365 using the [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing) guidance.

## Observability

The sample uses the `Microsoft.OpenTelemetry` distro with the Agent 365 exporter enabled in every environment. `InvokeAgentScope` covers each agent turn, `InferenceScope` covers each Azure OpenAI Responses API call, and `ExecuteToolScope` covers physical MCP and W365 tool calls. `Telemetry/Agent365TelemetryContext.cs` supplies shared tenant, agent, user, conversation, channel, endpoint, and operation-source context.

For agentic requests, `Telemetry/A365OtelWrapper.cs` exchanges the current turn token for the observability scope and registers it in `ServiceTokenCache`; the exporter resolves tokens from that cache. `EnableOpenTelemetryConsoleExporter` adds console export for local diagnostics without disabling Agent 365 export.

Before telemetry is recorded, model image inputs, tool `text` arguments, screenshot results, and embedded image data URLs are redacted. Runtime model and tool callers continue to receive the original values.

For details, see the [Agent observability guide](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability).

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
- [Microsoft 365 Agents SDK for .NET](https://github.com/microsoft/Agents-for-net)
- [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing)
- [Azure OpenAI computer use](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/computer-use)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License — see the [LICENSE](../../../LICENSE.md) file for details.
