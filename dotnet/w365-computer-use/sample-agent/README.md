# W365 Computer Use Sample

## Overview

This sample demonstrates how to build an agent that controls a Windows 365 Cloud PC using the OpenAI Responses API and the W365 Computer Use MCP server.

The agent receives a natural language task from the user, provisions a W365 desktop session via MCP tools, then runs a CUA (Computer Use Agent) loop: the model sees screenshots, decides actions (click, type, scroll), and the MCP server executes them on the VM.

It supports two model types:
- **`computer-use-preview`** - The original CUA model on Azure OpenAI
- **`gpt-5.4` / `gpt-5.4-mini`** - Newer GPT models with built-in computer use capability

## Architecture

```
User Message
    |
MyAgent (Agent Framework)
    | connects to MCP server
W365 MCP Tools (QuickStartSession, CaptureScreenshot, Click, Type, etc.)
    | provisions and controls
Windows 365 Cloud PC
    | screenshots fed back to
CUA Model (Azure OpenAI)
    | emits computer_call actions
ComputerUseOrchestrator (translates actions to MCP tool calls)
    | loop until task complete
Response to User
```

**Key components:**

| File | Purpose |
|------|---------|
| `Agent/MyAgent.cs` | Message handler - acquires tokens, connects to MCP, runs orchestrator |
| `ComputerUse/ComputerUseOrchestrator.cs` | CUA loop - sends screenshots to model, maps actions to MCP tools |
| `ComputerUse/ICuaModelProvider.cs` | Abstraction for the CUA model API |
| `ComputerUse/AzureOpenAIModelProvider.cs` | Azure OpenAI Responses API provider |

## Prerequisites

- [.NET 8.0 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) or later
- Azure OpenAI resource with a CUA-capable model deployment:
  - `computer-use-preview` or `gpt-5.4` / `gpt-5.4-mini`
  - [Request access to gpt-5.4](https://aka.ms/OAI/gpt54access) if needed
- Access to the W365 Computer Use MCP server (via [Agent 365 MCP Platform](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/))
- A bearer token with `Tools.ListInvoke.All` scope

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/microsoft/Agent365-Samples.git
cd Agent365-Samples/dotnet/w365-computer-use/sample-agent
```

### 2. Restore dependencies

```bash
dotnet restore
```

### 3. Create your local configuration

Create `appsettings.Development.json` (this file is gitignored):

**For `computer-use-preview` model:**
```json
{
  "AIServices": {
    "Provider": "AzureOpenAI",
    "AzureOpenAI": {
      "DeploymentName": "computer-use-preview",
      "Endpoint": "https://your-resource.openai.azure.com",
      "ApiKey": "your-api-key"
    }
  },
  "McpServer": {
    "Url": "http://localhost:52857/mcp/environments/Default-{your-tenant-id}/servers/mcp_W365ComputerUse"
  }
}
```

`DeploymentName` is treated as the model identifier fallback for compatibility with existing local settings. Azure OpenAI requests are sent to the v1 Responses endpoint (`/openai/v1/responses`), not the legacy deployment-style Responses URL. The selected `ModelName` or fallback `DeploymentName` is sent as the request body `model`.


**For `gpt-5.4-mini` model:**
```json
{
  "AIServices": {
    "Provider": "AzureOpenAI",
    "AzureOpenAI": {
      "ModelName": "gpt-5.4-mini",
      "Endpoint": "https://your-resource.openai.azure.com",
      "ApiKey": "your-api-key"
    }
  },
  "McpServer": {
    "Url": "http://localhost:52857/mcp/environments/Default-{your-tenant-id}/servers/mcp_W365ComputerUse"
  }
}
```

### 4. Obtain a bearer token

> **Note:** Running locally requires an agent identity. Create an Agent Blueprint with an Agent Identity for local development, then use that identity's client ID and the Agent Blueprint client credentials in the commands below.

#### Get the Windows 365 for Agents MCP token

Use the helper script to get a CUA user token for the MCP server, then set it as `BEARER_TOKEN`:

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
   ```

   The script assigns the generated token to `$env:BEARER_TOKEN` for the current PowerShell process and writes an informational message. To use a different token audience, pass `-Scope "<scope>"`; by default the script requests `da81128c-e5b5-4f9e-8d89-50d906f107c5/.default`.

The script requests scopes for the Windows 365 for Agents MCP server. For this sample, use the `Tools.ListInvoke.All` scope.

#### Optional: Get a Microsoft Graph token for OneDrive screenshots

This token is optional and is only needed when you want the sample to upload screenshots to OneDrive.

```powershell
Install-Module MSAL.PS -Scope CurrentUser

$token = Get-MsalToken `
  -ClientId "<your-app-registration-client-id>" `
  -TenantId "organizations" `
  -Scopes "https://graph.microsoft.com/Files.ReadWrite" `
  -Interactive

$env:GRAPH_TOKEN = $token.AccessToken
```

### 5. Start the MCP Platform server

Ensure the MCP Platform is running locally on port 52857, or update the `McpServer:Url` in your config.

### 6. Run the agent

```powershell
cd sample-agent
$env:ASPNETCORE_ENVIRONMENT = "Development"
$env:GRAPH_TOKEN = "<optional-graph-token-for-onedrive-upload>"
dotnet run
```

### 7. Test with Agent Builder

1. Open [Microsoft 365 Agents Playground](https://dev.agents.cloud.microsoft/)
2. Connect to `http://localhost:3978/api/messages`
3. Send a message like: *"Open Notepad and type Hello World"*
4. Screenshots are saved under `./Screenshots/<session-id>/` automatically

## Authentication to the W365 Computer Use MCP server

The W365 Computer Use MCP server is a standard **MCP-over-HTTP** endpoint (Streamable HTTP / SSE). Every request is authenticated with an OAuth 2.0 **bearer token for the calling agent's identity**; the agent's identity is carried by the token, so no separate identity header is required. The sample also sends optional `x-ms-*` correlation headers (see below).

### Endpoint

| Environment | URL |
|-------------|-----|
| Production (gateway) | `https://agent365.svc.cloud.microsoft/agents/servers/mcp_W365ComputerUse` |
| Local development | Your local MCP Platform URL (`McpServer:Url`) |

### Token

The bearer token must be issued for the **Windows 365 for Agents MCP** resource:

| Field | Value |
|-------|-------|
| Resource / audience (app ID) | `da81128c-e5b5-4f9e-8d89-50d906f107c5` |
| Scope string | `da81128c-e5b5-4f9e-8d89-50d906f107c5/.default` |
| Delegated scope | `Tools.ListInvoke.All` |
| Token type | Agent-identity ("agentic") token — the agent acts as itself, not the end user |

- **Production:** the Microsoft Agents (A365) SDK acquires and attaches the token automatically through the `w365` auth handler (`AgenticUserAuthorization`, configured under `AgentApplication:UserAuthorization:Handlers:w365`). See `MyAgent.GetToolsAsync` → `UserAuthorization.GetTurnTokenAsync(context, "w365")`.
- **Local development:** mint the token with [`Get-CuaAgentUserToken.ps1`](#get-the-windows-365-for-agents-mcp-token) and set it as `BEARER_TOKEN`; the sample sends it directly on the MCP connection.

### Headers

Only one header is required: `Authorization: Bearer <token>` for the resource above. The sample also sends a few optional `x-ms-*` correlation headers (`x-ms-conversation-id`, `x-ms-channel-id`, `x-ms-user-message-id`, `x-ms-user-agent`) for telemetry — none are required.

> **Note:** the calling agent's identity is taken from the bearer token itself — you don't send a separate identity header.

### Minimal request example

The MCP client library performs the standard `initialize` handshake first; after that, calling a tool is a normal JSON-RPC `tools/call`. Starting a session (`mcp_W365ComputerUse_StartSession`) takes no arguments and returns a `sessionId`; every subsequent tool call (`mcp_W365ComputerUse_GetSessionDetails`, `mcp_W365ComputerUse_EndSession`, and the desktop/browser tools) passes that `sessionId`.

```http
POST /agents/servers/mcp_W365ComputerUse HTTP/1.1
Host: agent365.svc.cloud.microsoft
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json, text/event-stream

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "mcp_W365ComputerUse_StartSession",
    "arguments": {}
  }
}
```

The response includes a `sessionId` (and, on start, a `screenShareUrl`). Pass the `sessionId` on the next call:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "mcp_W365ComputerUse_GetSessionDetails",
    "arguments": { "sessionId": "<sessionId-from-StartSession>" }
  }
}
```

In .NET, the sample uses the MCP SDK rather than hand-rolling JSON-RPC — it attaches the headers via `SseClientTransportOptions.AdditionalHeaders` and calls `IMcpClient.CallToolAsync(...)` (see `ComputerUse/W365McpSessionClient.cs`):

```csharp
var transport = new SseClientTransportOptions
{
    Endpoint = new Uri("https://agent365.svc.cloud.microsoft/agents/servers/mcp_W365ComputerUse"),
    TransportMode = HttpTransportMode.AutoDetect,
    AdditionalHeaders = new Dictionary<string, string>
    {
        ["Authorization"] = $"Bearer {accessToken}",
    },
};
```

## Configuration Reference

| Setting | Description | Default |
|---------|-------------|---------|
| `AIServices:Provider` | Model provider | `AzureOpenAI` |
| `AIServices:AzureOpenAI:Endpoint` | Azure OpenAI resource URL | - |
| `AIServices:AzureOpenAI:ApiKey` | API key | - |
| `AIServices:AzureOpenAI:DeploymentName` | Backward-compatible model identifier fallback when `ModelName` is not set | `computer-use-preview` |
| `AIServices:AzureOpenAI:ModelName` | Model name (for model-based URLs, e.g., `gpt-5.4-mini`) | - |
| `McpServer:Url` | MCP server URL (dev only; omit for production) | - |
| `W365:GatewayUrl` | W365 Computer Use MCP gateway URL (production) | `https://agent365.svc.cloud.microsoft/agents/servers/mcp_W365ComputerUse` |
| `ComputerUse:MaxIterations` | Max CUA loop iterations | `30` |
| `ComputerUse:DisplayWidth` | Display width for computer_use_preview tool | `1024` |
| `ComputerUse:DisplayHeight` | Display height for computer_use_preview tool | `768` |
| `Screenshots:LocalPath` | Local path to save screenshots | `./Screenshots` |
| `Screenshots:OneDriveFolder` | OneDrive folder for screenshot upload | `CUA-Sessions` |
| `Screenshots:OneDriveUserId` | UPN/email to upload screenshots to a specific user's OneDrive (instead of token owner) | - |
| `BEARER_TOKEN` (env var) | MCP Platform token with `Tools.ListInvoke.All` scope (dev only) | - |
| `GRAPH_TOKEN` (env var) | Graph API token with `Files.ReadWrite` scope for OneDrive upload (dev only) | - |
| `AgentApplication:UserAuthorization:Handlers:w365:Settings:Scopes` | W365 MCP audience (`da81128c-e5b5-4f9e-8d89-50d906f107c5/.default`, scope `Tools.ListInvoke.All`) | - |
| `AgentApplication:ScreenShareAuthHandlerName` | Auth handler used to mint ARI screenshare tokens | `ari` |
| `AgentApplication:UserAuthorization:Handlers:ari:Settings:Scopes` | ARI audience (production `90ecec28-f5a6-42b3-9bde-dae1ca98f8b5/.default`) | - |
| `ScreenShare:AuthMode` | `EasyAuth` for Azure deployment, `DevBypass` for local development | `EasyAuth` |
| `ScreenShare:SdkVersion` | Screenshare SDK version loaded from the CDN | `1.0.0` |
| `ScreenShare:CdnOrigin` | Public Microsoft CDN origin for the screenshare SDK | `https://packages.global.cloudinferenceplatform.azure.com` |
| `ScreenShare:PageBaseUrl` | Public base URL for links to `screenshare.html`; defaults to the App Service host if unset | - |
| `ScreenShare:AllowedFrameAncestors` | CSP `frame-ancestors` values allowed to embed the screenshare page | Teams / M365 hosts |
| `ARI_BEARER_TOKEN` (env var) | Optional local ARI token override for screenshare development | - |

## Supported Models

| Model | Tool Type | Config | Notes |
|-------|-----------|--------|-------|
| `computer-use-preview` | `computer_use_preview` | `DeploymentName: "computer-use-preview"` | Uses `display_width`, `display_height`, `environment` params |
| `gpt-5.4` / `gpt-5.4-mini` | `computer` | `ModelName: "gpt-5.4-mini"` | Bare `{"type": "computer"}`. Initial screenshot sent with first message |

The tool type is auto-derived from the model name (`gpt-*` -> `computer`, otherwise -> `computer_use_preview`).

## How It Works

1. **User sends a message** -> `MyAgent.OnMessageAsync`
2. **MCP connection** established (direct SSE in dev, A365 SDK gateway in prod)
3. **Session startup** runs explicitly with `mcp_W365ComputerUse_StartSession` before the first desktop action. Returned `sessionId` values are cached per conversation, and the selected session ID is sent on every remote W365 tool call.
4. **CUA loop** in `ComputerUseOrchestrator.RunAsync`:
   - User message + conversation history sent to the model
   - Model returns `computer_call` actions (click, type, scroll, etc.)
   - Actions translated to MCP tool calls (`click`, `type_text`, `press_keys`, etc.) with the cached `sessionId`
   - Screenshot captured after each action and fed back to the model
   - Loop continues until model calls `OnTaskComplete` or max iterations reached
5. **Response** sent back to user
6. **Sessions persist** across messages for follow-up tasks, and a user can reference a specific `sessionId` to switch context
7. **EndSession** called on app shutdown (Ctrl+C) via `mcp_W365ComputerUse_EndSession` for each cached `sessionId` to release VMs

## Session Management

- Sessions are started with `mcp_W365ComputerUse_StartSession`; multiple session IDs can be cached for one conversation
- If a user references a known `sessionId`, the orchestrator selects that session before taking screenshots or sending remote W365 tool calls
- Conversation history accumulates across messages, giving the model context for follow-up tasks
- On app shutdown (`Ctrl+C`), the agent calls `EndSession` for each cached `sessionId` to release VMs back to the pool
- If the app crashes, sessions auto-expire after ~30 minutes on the W365 backend

## Screenshare

The agent can expose a live screenshare link to the running Cloud PC through the W365 / ARI screenshare SDK. The link is created during the bot turn, when `turnContext` is available.

1. The W365 MCP start-session response includes a `screenShareUrl`.
2. The agent mints an ARI token through the `ari` auth handler, or uses `ARI_BEARER_TOKEN` in local development.
3. The agent stores a one-time handoff record in memory (`HandoffStore`):
   - `sessionId`
   - `screenShareUrl`
   - owner Entra object id from the original Teams activity
   - hashed handoff code
   - ARI token and parsed token expiry
4. The bot posts a link to `/screenshare.html?sid=<sessionId>&hc=<handoffCode>`.
5. The browser signs in through EasyAuth and calls `POST /api/screenshare/{sid}/token`.
6. The server validates the EasyAuth identity against the original owner object id and returns the ARI token to the page.
7. The page loads the screenshare SDK from `ScreenShare:CdnOrigin` and starts the session.

The screenshare SDK is served from the public Microsoft CDN (`ScreenShare:CdnOrigin`, default `https://packages.global.cloudinferenceplatform.azure.com`); `/api/screenshare/config` templates the origin and SDK version so `screenshare.js` stays in sync.

The in-memory handoff store is single-process. If the web app is scaled out to multiple instances, replace it with a distributed cache.

### Local testing

- Run the agent — it binds `http://localhost:3978` and `https://localhost:3979` (the SPA requires a secure context).
- Set `ScreenShare:AuthMode` to `DevBypass` to skip the EasyAuth identity check locally.
- Set `ARI_BEARER_TOKEN` to a valid ARI token so the page can start the SDK without EasyAuth.

### Production

- Enable App Service Authentication (EasyAuth) with Microsoft Entra ID so browser requests to `screenshare.html` are authenticated.
- Set `ScreenShare:AuthMode=EasyAuth` and `ScreenShare:PageBaseUrl=https://<webapp-name>.azurewebsites.net`.
- Register the `ari` auth handler scopes and grant the agent identity the ARI screenshare permissions on the target W365 Cloud PC pool.

## Production Deployment

1. Register an Azure Bot and configure the agent
2. Set `AIServices` config with your Azure OpenAI credentials
3. Remove `McpServer:Url` — in production the agent connects directly to the W365 Computer Use MCP gateway (default `https://agent365.svc.cloud.microsoft/agents/servers/mcp_W365ComputerUse`, override via `W365:GatewayUrl`) using the `w365` agentic auth handler. The W365 server requires an explicit session, so the agent calls `StartSession` and sends `_meta.sessionId` on `tools/list`, rather than going through the generic A365 SDK Tooling Gateway.
4. Deploy and install the agent in Teams / M365

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `McpServer:Url is required` | Create `appsettings.Development.json` with the MCP server URL |
| `BEARER_TOKEN` not set | Set `$env:BEARER_TOKEN` before running |
| Model returns 400 | Check that the tool type matches your model (see Supported Models table) |
| Screenshot extraction fails | Ensure MCP server returns image content blocks |
| Session orphaned after crash | Sessions auto-expire after ~30 min on the W365 backend |
| Multiple sessions started | Ensure only one agent instance is running per MCP server |

## Links

- [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- [Microsoft 365 Agents SDK](https://learn.microsoft.com/microsoft-365/agents-sdk/)
- [Azure OpenAI Computer Use Guide](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/computer-use)
