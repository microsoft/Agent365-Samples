<!--
---
name: "W365 Computer Use Sample"
page_type: sample
languages:
- csharp
products:
- agent-365
description: "Control a Windows 365 Cloud PC from a .NET agent using the OpenAI Responses API and W365 Computer Use MCP tools."
---
-->

# W365 Computer Use Sample

## Overview

This sample demonstrates how to build an agent that controls a Windows 365 Cloud PC using the OpenAI Responses API and the W365 Computer Use MCP server.

The agent receives a natural language task from the user, provisions a W365 desktop session via MCP tools, then runs a CUA (Computer Use Agent) loop: the model sees screenshots, decides actions (click, type, scroll), and the MCP server executes them on the VM.

It supports two model types:
- **`computer-use-preview`** - The original CUA model on Azure OpenAI
- **`gpt-5.4` / `gpt-5.4-mini`** - Newer GPT models with built-in computer use capability

## Demonstrates

- Session-aware MCP discovery and desktop/browser tool calls.
- Optional W365 session kind, display dimensions and browser selection, with unchanged defaults.
- Human sign-in handoff, bounded readiness checks, same-session task resumption and cleanup.

## Architecture

```
User Message
    |
MyAgent (Agent Framework)
    | connects to MCP server
W365 MCP Tools (StartSession, take_screenshot, click, type_text, etc.)
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
- Access to the W365 Computer Use MCP server (via [Agent 365 MCP Platform](https://learn.microsoft.com/microsoft-agent-365/developer/))
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

The sample loads user secrets after environment variables, so a saved user secret overrides the corresponding environment variable. Restart the agent after changing configuration.

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

> **Note:** The default session requires an agentic context. Create an Agent Blueprint with an Agent Identity for that flow, then use that identity's client ID and the Agent Blueprint client credentials below. Explicit `human` sessions instead require a compatible human-user token; the agent-token helper below does not produce one. See [Optional session settings and human sign-in](#optional-session-settings-and-human-sign-in).

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

A365 export is disabled by default. To send traces to Agent 365, set `EnableAgent365Exporter=true` and configure the **independent OBS-only application credentials**. The MCP/Graph bearer
tokens above remain business tokens and are never sent to the S2S observability service:

```json
{
  "EnableAgent365Exporter": true,
  "Agent365Observability": {
    "TenantId": "<<AGENT_HOME_TENANT_ID>>",
    "AgentId": "<<AGENT_INSTANCE_CLIENT_ID>>",
    "BlueprintClientId": "<<BLUEPRINT_CLIENT_ID>>",
    "UseManagedIdentity": true,
    "ManagedIdentityClientId": ""
  }
}
```

`AgentId` must be the actual agent instance client ID, not the blueprint ID or service principal
object ID. For Azure, the configured managed identity must already be federated with the blueprint;
empty `ManagedIdentityClientId` selects the system-assigned identity, otherwise supply a user-assigned
client ID. For local development use `UseManagedIdentity=false` and supply
`Agent365Observability:BlueprintClientSecret` through user secrets, or
`Agent365Observability__BlueprintClientSecret` through the environment. All keys support the .NET
double-underscore environment format. Do not store a secret in checked-in configuration.

The sample-local provider implements the [documented app-only token flow](https://learn.microsoft.com/entra/agent-id/autonomous-agent-authentication-authorization-flow):
blueprint `client_credentials` with `fmi_path=AgentId` and `api://AzureADTokenExchange/.default`
produces T1; agent `client_credentials` uses T1 as `client_assertion` for
`api://9b975845-388f-4429-889e-eab1ef63949c/.default`. No user token, `user_fic`, or OBO is used for OBS.

This sample provider is single-instance: one configured tenant and agent instance. Multi-instance or multi-tenant deployments should cache per agent/tenant and reuse the hosting connection credential. The provider requests tokens from `login.microsoftonline.com`; sovereign clouds need provider changes.
Both Microsoft.OpenTelemetry 1.0.6's `options.Agent365` and the
`services.Configure<Agent365ExporterOptions>` registration explicitly set `UseS2SEndpoint=true`
and use the same separate provider as `TokenResolver`.

An app-only OBS token with `idtyp=app`, or without `idtyp` but with `oid` equal to `sub`, may
omit `roles` or have `roles: []`. Roleless service acceptance requires an **the **exact registered
Agent 365 agent instance** and authorization; selecting S2S or creating an
Entra identity alone is insufficient.
For registered blueprint agents, do not add an `Agent365.Observability.OtelWrite` grant solely to populate a `roles` claim. For AI Teammates, complete the OtelWrite application-role step printed by `a365 setup all --aiteammate`; AI Teammate S2S without that step has not been validated. Business OBO/MCP/Graph permissions and consent remain independent.

**Troubleshooting:** Missing/placeholder settings or using the blueprint as `AgentId` fail when export is enabled; with export disabled, placeholders do not block local/Playground startup.
Export identity mismatches, any delegated `scp` claim (even empty), explicit non-app/null `idtyp`,
malformed `roles`, and invalid/expired responses fail closed. Tokens without `idtyp` need either
`oid` equal to `sub` or a valid nonempty array of nonblank string roles. Original agent/user baggage
is preserved: use the matching configured identity rather than overwriting turn context. For service
authorization failures, verify instance registration and authorization; this sample
does not provision identities or modify permissions. Requests are bounded to 30 seconds; tokens
refresh 60 seconds before expiry with no stale-token fallback.

**Deployment:** The OBS helper files live in this sample's `Observability/` folder and are compiled with the project, so copying or publishing the sample is self-contained. Retain the `Azure.Identity` package alias in the project file.

```powershell
cd sample-agent
$env:ASPNETCORE_ENVIRONMENT = "Development"
$env:GRAPH_TOKEN = "<optional-graph-token-for-onedrive-upload>"
dotnet run
```

### 7. Test with Microsoft 365 Agents Playground

1. Open [Microsoft 365 Agents Playground](https://dev.agents.cloud.microsoft/)
2. Connect to `http://localhost:3978/api/messages`
3. Send a message like: *"Open Notepad and type Hello World"*
4. Screenshots are saved under `./Screenshots/<session-id>/` automatically

#### V3 session examples

V3 adds optional session kinds, display/browser settings, and human sign-in readiness. Try the following chat prompts **one session at a time**. Say **"end my session"** before trying another startup example; options cannot be changed on an active or pending session. These are explicit chat choices, not appsettings or environment-variable defaults.

| Scenario | Playground message | Expected `StartSession` arguments |
|----------|--------------------|-----------------------------------|
| Existing default behavior | "Open Notepad and type Hello World" | `{}` |
| Properties only; default agentic kind retained | "Start a W365 session with a display 1280 pixels wide by 720 pixels tall using legacy browser mode and open Notepad" | `{"sessionProperties":{"displayWidth":1280,"displayHeight":720,"browserMode":"legacy"}}` |
| Explicit agentic session | "Start an agentic W365 session with a display 1920 pixels wide by 1080 pixels tall using chromium browser mode and open Notepad" | `{"sessionKind":"agentic","sessionProperties":{"displayWidth":1920,"displayHeight":1080,"browserMode":"chromium"}}` |
| Explicit local session | "Start a local W365 session and open Notepad" | `{"sessionKind":"local"}` |
| Human session with settings | "Start a human W365 session with a display 1600 pixels wide by 900 pixels tall using chromium browser mode and open Notepad" | `{"sessionKind":"human","sessionProperties":{"displayWidth":1600,"displayHeight":900,"browserMode":"chromium"}}` |

Use an agentic `BEARER_TOKEN` for default/agentic tests. For the human example, follow [Development human bearer token](#development-human-bearer-token): use a compatible **human-user** W365 token and restart the local Development process after changing it. `local` supports compatible human or agent callers; app-only callers cannot select explicit kinds. Playground does not turn an agent token into a human token. The hosted EasyAuth flow requires validated channel sender attribution and should be tested separately using the [hosted human live verification](#hosted-human-live-verification-only-after-approval) steps.

For a human session, a successful start can still return `awaitingHumanLogin: true`. Open the separate **Cloud PC sign-in** action (`connectivityUrl`) promptly, complete sign-in, then reply **"continue my pending request"** without repeating session options. The sample retains the same session/task and checks readiness before desktop actions. If still pending, continue waiting on that session; do not send another startup request. End the session when finished or abandoning sign-in.

The table describes requested settings, not proof of effective desktop dimensions or browser behavior. Where available, verify the session's actual details/display after readiness; a browser viewport size is not the desktop resolution. Invalid options, unavailable kinds, and incompatible callers must produce guidance/errors rather than silently switching kinds.

## Authentication to the W365 Computer Use MCP server

The W365 Computer Use MCP server is a standard **MCP-over-HTTP** endpoint (Streamable HTTP / SSE). Every request is authenticated with an OAuth 2.0 **bearer token for the caller**. Default sessions require an agentic context; explicit kinds also support compatible human callers. The service enforces caller compatibility and session ownership using the token. The sample also sends optional `x-ms-*` correlation headers (see below).

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
| Token type | Agent-identity ("agentic") token for default sessions; compatible delegated human-user token for explicit human sessions |

- **Production, default/agentic sessions:** the Microsoft Agents (A365) SDK acquires and attaches the token automatically through the `w365` auth handler (`AgenticUserAuthorization`, configured under `AgentApplication:UserAuthorization:Handlers:w365`). See `MyAgent.GetToolsAsync` → `UserAuthorization.GetTurnTokenAsync(context, "w365")`.
- **Production, explicit human sessions:** opt in to the implemented App Service EasyAuth flow below. `MyAgent` routes these desktop turns before SDK resource auto-sign-in; W365 uses the chat-bound human credential, not an agent handler or environment-token fallback.
- **Local development:** mint the agentic token with [`Get-CuaAgentUserToken.ps1`](#get-the-windows-365-for-agents-mcp-token) and set it as `BEARER_TOKEN`; the sample sends it directly on the MCP connection. For human sessions, supply a compatible human-user token instead, as described below.

### Headers

Only one header is required: `Authorization: Bearer <token>` for the resource above. The sample also sends a few optional `x-ms-*` correlation headers (`x-ms-conversation-id`, `x-ms-channel-id`, `x-ms-user-message-id`, `x-ms-user-agent`) for telemetry — none are required.

> **Note:** the calling agent's identity is taken from the bearer token itself — you don't send a separate identity header.

### Minimal request example

The MCP client library performs the standard `initialize` handshake first; after that, calling a tool is a normal JSON-RPC `tools/call`. **V3 is an additive session contract, not a new JSON-RPC version or endpoint:** keep `"jsonrpc": "2.0"` and the same tool names. By default, `mcp_W365ComputerUse_StartSession` receives `{}` and waits until ready, preserving existing agentic behavior. Every subsequent tool call (`mcp_W365ComputerUse_GetSessionDetails`, `mcp_W365ComputerUse_EndSession`, and the desktop/browser tools) passes the returned `sessionId`.

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

To use the V3 human-session options, send the following **instead of** the default `StartSession` body, using a compatible human-user bearer token:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "mcp_W365ComputerUse_StartSession",
    "arguments": {
      "sessionKind": "human",
      "sessionProperties": {
        "displayWidth": 1600,
        "displayHeight": 900,
        "browserMode": "chromium"
      }
    }
  }
}
```

`sessionProperties` is nested, dimensions are positive integers, and `browserMode` is `chromium` or `legacy`. Omit unrequested fields. For example, `"arguments": {"sessionProperties": {"browserMode": "legacy"}}` selects only the browser mode and retains the **default agentic** session kind; supplying properties does not select a human session. Human callers can explicitly request `human` or `local`, agent callers `agentic` or `local`; app-only callers cannot select explicit kinds. Do not retry an unavailable/incompatible kind as a different kind without an explicit decision.

The response retains its existing fields, includes a `sessionId`, and may include `screenShareUrl`, `connectivityUrl` and `awaitingHumanLogin`. A successful human-session start is **not** necessarily ready for remote tools. If `awaitingHumanLogin` is true, present `connectivityUrl` to the human and ask them to open it and sign in promptly; it is not `screenShareUrl`. Retain the same `sessionId` and use bounded progress checks rather than creating another session. Pass that ID when inspecting progress:

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

After sign-in, discover the remote tools with the session ID in **`params._meta`**, not tool arguments:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/list",
  "params": {
    "_meta": { "sessionId": "<sessionId-from-StartSession>" }
  }
}
```

Pending-login guidance from details/discovery is non-fatal: wait and check the same session again. If details omit the optional readiness flag, successful session-aware discovery confirms readiness before remote actions. Include `sessionId` in the **arguments** of every discovered remote tool call. If the service explicitly reports the session ended, stop using that ID.

Finish with `EndSession`, including when abandoning a session that is still awaiting sign-in:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "mcp_W365ComputerUse_EndSession",
    "arguments": { "sessionId": "<sessionId-from-StartSession>" }
  }
}
```

For clients managing `x-ms-authorization-auxiliary`, it remains an HTTP header, never a V3 tool argument: `local` rejects it, `human` accepts an optional single raw token, and `agentic` ignores a caller-supplied value. It does not replace the required primary caller identity.

In .NET, the sample attaches headers via `SseClientTransportOptions.AdditionalHeaders` and uses the MCP SDK's `SendRequestAsync` for session-aware discovery and tool calls (see `ComputerUse/W365McpSessionClient.cs`). Keeping the raw result preserves additive fields such as `structuredContent` that the pinned SDK's typed tool result would discard:

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

### Optional session settings and human sign-in

All W365 session options come **only from explicit chat requests**, for example **"Start a human W365 session at 1600 by 900 using chromium browser mode and open Notepad"**, **"Start a local W365 session"**, or **"Start an agentic W365 session using legacy browser mode"**. Session kind, display dimensions, and browser mode are not read from app settings or environment variables.

The chat router extracts options before session startup, without calling remote tools. Incidental words such as "human resources", numbers in a task, resizing an application window, simply opening Chrome, and questions about session settings do not select options. If routing fails or returns invalid, unsupported, or ambiguous options, the turn reports an error instead of starting a potentially unintended default session. Options cannot change or replace an active session: end it first, then explicitly request a new session with the desired options.

Without explicit chat options, `StartSession` still receives `{}`. The first example sends `{"sessionKind":"human","sessionProperties":{"displayWidth":1600,"displayHeight":900,"browserMode":"chromium"}}`. Requesting only **"Start a W365 session using legacy browser mode"** sends `{"sessionProperties":{"browserMode":"legacy"}}`; unspecified properties and kind are omitted rather than filled with defaults. Dimensions must be positive integers; browser mode is `chromium` or `legacy`.

For `computer-use-preview`, chat-selected dimensions also override the model's view for that conversation's session. `ComputerUse:DisplayWidth` / `DisplayHeight` remain model-only defaults for dimensions not selected in chat; they are never sent to `StartSession`. The bare `computer` tool still derives dimensions from screenshots. Model defaults and other conversations are not modified.

Omitting a kind in chat retains the default agentic behavior, **even when setting properties**. Availability depends on the service: human callers may request `local` or `human`, agent callers `local` or `agentic`, and app-only callers cannot select an explicit kind. The sample surfaces service validation, unavailable-kind and caller-compatibility errors without silently switching kinds or dropping properties. Chat options are scoped to the conversation's session and retained for in-turn recovery, not applied as defaults to later new sessions.

#### Development human bearer token

For local human sessions, run in `Development` and set `BEARER_TOKEN` to a human-user token for the W365 MCP resource with the required permission. Use your organization's approved delegated-user authentication flow; the agent-user helper is not a human-token acquisition flow. Configure the development W365 endpoint with `McpServer:Url` or `McpServers`. This existing Development path is distinct from hosted EasyAuth; requesting a human session does not convert an agentic token into a human token.

#### Hosted human authorization (opt-in EasyAuth)

The hosted flow is implemented in `Authentication/HumanW365Authentication.cs`, `Authentication/HumanW365AuthenticationEndpoints.cs`, `wwwroot/w365-human-auth.js`, `Program.cs`, and the human branches of `MyAgent` and `ComputerUseOrchestrator`. It is **disabled by default** (`HumanW365Authentication:Enabled=false`). After administrator approval and the prerequisites below, the authentication-only configuration is:

```json
{
  "HumanW365Authentication": {
    "Enabled": true,
    "TenantId": "<<YOUR_TENANT_ID>>",
    "ApplicationBaseUrl": "https://<<YOUR_WEBAPP_HOSTNAME>>"
  }
}
```

`TenantId` must be the Entra tenant GUID. `ApplicationBaseUrl` is an optional canonical HTTPS root URL, without a path, query, or fragment; when omitted, the sample uses App Service's `WEBSITE_HOSTNAME`. These settings configure authentication only. **Session kind, display dimensions, and browser mode remain chat-only**; do not add session defaults to configuration.

##### Keep the identities and audiences separate

| Identity / resource | Used for |
|---------------------|----------|
| Hosting/service-connection app, often the agent blueprint | Existing SDK connection under `Connections:ServiceConnection:Settings:ClientId`. It can also be the registered audience for incoming Agent365 delivery. |
| Agent instance / agent user | Default or explicit agentic W365 access. This is not the browser sign-in app or a human credential. |
| EasyAuth browser sign-in app | `authsettingsV2.identityProviders.azureActiveDirectory.registration.clientId`, its Web callback, and its own provider credential. Reuse the web app's existing sign-in registration when appropriate. |
| W365 MCP resource | Production resource `da81128c-e5b5-4f9e-8d89-50d906f107c5`; the browser app requests its delegated `Tools.ListInvoke.All` permission. |
| Incoming channel audience | The intended recipient of the JWT delivered to `/api/messages`, configured under `TokenValidation:Audiences`. Verify it from the channel registration; it is not automatically the EasyAuth or W365 resource ID. |

These are different roles even if a deployment deliberately reuses an app registration. Do not copy IDs between settings merely because each field is called a client ID or audience. OBS-only credentials and Graph/ARI permissions remain separate.

##### 1. Configure the Entra browser sign-in app

In **App Service > Authentication**, identify the Microsoft identity provider's application/client ID, then open that exact app in **Microsoft Entra ID > App registrations**. For a new setup, follow [Configure Microsoft Entra authentication for App Service](https://learn.microsoft.com/azure/app-service/configure-authentication-provider-aad) and use a workforce, single-tenant registration for this sample's configured tenant.

1. Under **Authentication**, register a **Web** redirect URI of `https://<<YOUR_WEBAPP_HOSTNAME>>/.auth/login/aad/callback`. Register the appropriate callback for each approved slot/custom hostname. This is the EasyAuth OAuth callback, **not** `/api/w365/human/complete`: EasyAuth completes sign-in first, then redirects to that protected application endpoint. Keep existing valid callback URIs.
2. Under **Certificates & secrets**, provide a valid credential for the provider. The client-secret setup stores the secret **value**, not the secret ID, in an App Service application setting, commonly `MICROSOFT_PROVIDER_AUTHENTICATION_SECRET`, or a supported Key Vault reference. `registration.clientSecretSettingName` must name that setting; it must not contain the secret itself. Check expiration and reference resolution privately. Do not use the agent blueprint's secret unless it is intentionally the same registration.
3. If the configured EasyAuth flow requests `response_type=code id_token`, enable **ID tokens** under the registration's implicit/hybrid settings. This does not require enabling implicit **access tokens**, a public-client flow, or a SPA redirect. Browser sign-in without a usable provider credential is insufficient for this sample's downstream W365 access-token acquisition.
4. Under **API permissions > Add a permission > APIs my organization uses**, find the W365 resource by application ID `da81128c-e5b5-4f9e-8d89-50d906f107c5` and add **Delegated permissions > Tools.ListInvoke.All**. Its display name can be the GUID. Do not substitute an application permission, Graph `User.Read`, or the agentic handler's existing grants.
5. Obtain the user/admin consent required by tenant policy. A permission listed in `requiredResourceAccess` is only a request, not proof of consent. Verify the corresponding **Enterprise application > Permissions** grant. For an administrator audit, the delegated `oauth2PermissionGrant` must link the EasyAuth **service-principal object ID** (`clientId`) to the W365 **service-principal object ID** (`resourceId`) and include `Tools.ListInvoke.All` in `scope`; these fields are not application/client IDs. An `AllPrincipals` grant represents tenant-wide consent; otherwise check the applicable user grant. Also check enterprise-app assignment and Conditional Access requirements for the actual human.

##### 2. Configure App Service EasyAuth v2

Use **App Service > Authentication** for provider selection and authentication policy. Advanced settings such as login scopes and exact path exclusions can be inspected through **Azure portal > API Playground** using:

```text
subscriptions/<<SUBSCRIPTION_ID>>/resourceGroups/<<RESOURCE_GROUP>>/providers/Microsoft.Web/sites/<<WEBAPP_NAME>>/config/authsettingsV2?api-version=2024-11-01
```

Read the current configuration with **GET** first. For an approved change, edit a copy of the complete current configuration and apply **PUT**, preserving unrelated providers, restrictions, routes, and existing exclusions. The fragments and tables here are **not a replacement PUT payload**. An older `az webapp auth show` command can expose a legacy schema; missing v2 fields there do not prove the token store or provider is disabled.

| `authsettingsV2.properties` setting | Required configuration / check |
|-----------------------------------|--------------------------------|
| `platform.enabled` | `true`; EasyAuth must authenticate requests and strip/replace caller-supplied identity headers. |
| `httpSettings.requireHttps` | `true`; use HTTPS for the canonical host, callback, and browser confirmation. |
| `globalValidation.requireAuthentication` | `true`; retain the existing authentication-required policy. |
| `globalValidation.unauthenticatedClientAction` | Browser sign-in uses `RedirectToLoginPage`; keep the Microsoft provider selected and confirm unauthenticated completion is blocked or redirected. |
| `identityProviders.azureActiveDirectory.enabled` | `true`. |
| `identityProviders.azureActiveDirectory.registration.clientId` | The browser sign-in app from step 1, not the W365 resource. |
| `identityProviders.azureActiveDirectory.registration.openIdIssuer` | Tenant-specific issuer, normally `https://login.microsoftonline.com/<<YOUR_TENANT_ID>>/v2.0`. Preserve tenant restrictions; do not broaden to `common` to bypass a rejection. |
| `identityProviders.azureActiveDirectory.registration.clientSecretSettingName` | The existing, valid provider credential setting reference from step 1. |
| `identityProviders.azureActiveDirectory.validation.allowedAudiences` | Preserve the browser app's intended audiences, such as its configured `api://<<EASYAUTH_CLIENT_ID>>` identifier. This is separate from incoming chat audiences and the downstream W365 token audience. |
| `login.tokenStore.enabled` | `true`; browser authentication alone does not supply a W365 provider access token to application code. |

Configure the provider's `identityProviders.azureActiveDirectory.login` scope parameter as follows, retaining other approved login parameters and any required OIDC scopes:

```json
{
  "loginParameters": [
    "scope=openid profile offline_access da81128c-e5b5-4f9e-8d89-50d906f107c5/Tools.ListInvoke.All"
  ]
}
```

`offline_access` enables provider refresh tokens. Request the **W365** resource here, not a Graph access token or only an ID token. Do not combine Graph and W365 resource scopes into one access-token request. After changing scopes/consent, sign out and start a fresh sign-in from the latest chat link so an old EasyAuth session does not retain the previous token. See [Work with OAuth tokens in App Service](https://learn.microsoft.com/azure/app-service/configure-authentication-oauth-tokens).

Keep `/api/messages` and `/api/health` in this sample's existing exact EasyAuth exclusions: the message endpoint performs its own channel JWT validation, and health probes must still work. Add the following **exact public paths** to `globalValidation.excludedPaths`, preserving other approved entries:

```json
[
  "/w365/sign-in",
  "/w365-auth/sign-in.css",
  "/w365-auth/ms-signin-light.svg",
  "/w365-auth/ms-signin-dark.svg",
  "/w365-auth/ms-symbol.svg",
  "/w365-auth/ms-symbol.png"
]
```

The entry page must load before authentication, and chat renderers must retrieve the PNG without a login redirect. **Never exclude `/api/w365/human/complete`, add `/api/*` or `/w365-auth/*` wildcards, or disable authentication globally.** The confirmation script `/w365-human-auth.js` is loaded after authentication and need not be public. Completion fails closed unless HTTPS, `WEBSITE_INSTANCE_ID`, and the platform's `WEBSITE_AUTH_ENABLED=True` marker are present. These deployment guards do not validate JWT signatures or prove that the completion route is protected: the header/token consistency checks still rely on EasyAuth's enforced protected-route and trusted-header boundary. Do not manually set the marker to bypass disabled authentication.

##### 3. Configure the web app and incoming chat validation

Under **App Service > Settings > Environment variables**, add the authentication settings below (or use the equivalent JSON configuration shown earlier). Replace every placeholder before enabling:

| Application setting | Value / source |
|---------------------|----------------|
| `HumanW365Authentication__Enabled` | `true`. |
| `HumanW365Authentication__TenantId` | Your Entra tenant GUID, matching the browser provider and chat tenant. |
| `HumanW365Authentication__ApplicationBaseUrl` | `https://<<YOUR_WEBAPP_HOSTNAME>>`, or omit to use `WEBSITE_HOSTNAME`; no path, query, or fragment. Use the same canonical host throughout the handoff. |
| `TokenValidation__Enabled` | `true`; the checked-in `false` is not suitable for hosted human authorization. |
| `TokenValidation__TenantId` | Your channel's tenant GUID; used to add tenant issuers when `ValidIssuers` is not explicitly supplied. |
| `TokenValidation__Audiences__0` | The existing approved recipient/client GUID for incoming channel delivery. Replace the shipped `{{ClientId}}` placeholder. |
| `TokenValidation__Audiences__1` | Only if the channel also legitimately targets a different hosting/service-connection client GUID; retain the existing accepted audience rather than overwriting it. Do not add a second ID without verifying the channel registration. |
| Provider credential setting named by `clientSecretSettingName` | The browser app's valid secret value or approved Key Vault reference, managed separately; never put it in this README or source control. |

`TokenValidation:Audiences` is a .NET array: environment keys use `__0`, `__1`, etc., not one comma-separated value. This sample requires **GUID audience entries**, not `api://` strings. If an incoming token actually uses a URI-form audience, this validator/configuration contract needs investigation; removing the prefix in configuration does not make that JWT match. `TokenValidation:ValidIssuers`, when explicitly supplied, replaces the built-in issuer list; include all and only the issuers your delivery path requires. Signature, issuer, audience, and lifetime validation must stay enabled. Keep the existing service connection and agentic auth handlers intact.

EasyAuth browser authentication alone does not verify a chat sender. The code requires GUID `Activity.Conversation.TenantId` and `Activity.From.AadObjectId`, plus successful validation by the named JWT bearer middleware. Validation proof and a claims snapshot are attached to the incoming identity before the SDK queues the turn; background turns do not depend on a live HTTP context. Sender attribution follows these paths:

- A validated `https://api.botframework.com` issuer can attest the activity sender only on Teams (`msteams` or `msteams:*`). Direct Line, Web Chat, and other channels require matching validated tenant/object claims; client-supplied activity sender IDs are not sufficient. The Agent365-to-Web-App path does not require creating an Azure Bot Service resource merely to use EasyAuth.
- For Teams (`msteams` or `msteams:*`), Agent365 delivery must have a matching validated tenant claim, that tenant's commercial Entra v1/v2 issuer, and exactly one caller claim identifying the allowlisted Agent365 platform application. `azp` takes precedence; `appid` is used only when `azp` is absent. Missing, invalid, or multiple caller claims cannot authorize channel attribution. The platform token's `oid` need not identify the human sender. This follows the [Teams SDK platform-caller validation pattern](https://github.com/microsoft/teams.net/pull/695).
- Other validated JWTs retain direct-user verification: both tenant and object claims must match the activity. A Teams channel name, valid audience, or arbitrary tenant-issued token alone cannot attest another human.
- All paths bind the handoff to the attributed chat human and conversation. EasyAuth must independently confirm that same human before any W365 credential is accepted. No agent token is substituted for human credentials.

Keep chat turns and browser completion on the **same process**: use a single instance, or verify routing of both paths to the same worker. Browser affinity alone is insufficient if the channel lands on another worker. Check actual App Service instances rather than interpreting a plan's `sku.capacity` as the running worker count. Handoffs, human credentials, tasks/options, and session tracking are in memory; restarts and deployments lose them. EasyAuth's provider token store does not make this state durable. Save/restart after configuration changes, then request a new handoff in chat.

##### 4. Inspect and verify without exposing credentials

For a read-only EasyAuth audit, the following projection retrieves configuration metadata, not secret values or user tokens:

```powershell
$siteId = az webapp show --subscription "<<SUBSCRIPTION_ID>>" `
  --resource-group "<<RESOURCE_GROUP>>" --name "<<WEBAPP_NAME>>" --query id --output tsv

az resource show --ids "$siteId/config/authsettingsV2" --api-version 2024-11-01 `
  --query "{enabled:properties.platform.enabled,https:properties.httpSettings.requireHttps,requireAuthentication:properties.globalValidation.requireAuthentication,unauthenticatedAction:properties.globalValidation.unauthenticatedClientAction,excludedPaths:properties.globalValidation.excludedPaths,providerEnabled:properties.identityProviders.azureActiveDirectory.enabled,clientId:properties.identityProviders.azureActiveDirectory.registration.clientId,issuer:properties.identityProviders.azureActiveDirectory.registration.openIdIssuer,credentialSetting:properties.identityProviders.azureActiveDirectory.registration.clientSecretSettingName,allowedAudiences:properties.identityProviders.azureActiveDirectory.validation.allowedAudiences,loginParameters:properties.identityProviders.azureActiveDirectory.login.loginParameters,tokenStoreEnabled:properties.login.tokenStore.enabled}" `
  --output json
```

Inspect the referenced registration's Web callbacks and delegated permissions, verify actual consent separately, and check credential presence/expiry privately. Do not dump application-setting values, `/.auth/me` responses, authentication cookies, raw JWTs, or a full unredacted HAR into logs or issues. The temporary MCP payload/header capture was removed from this revision; historical `W365__Diagnostics__*` settings do not enable it here.

| Smoke check | Expected result / what it proves |
|-------------|---------------------------------|
| Anonymous **GET** `/api/health` | Healthy response; does not prove human authorization. |
| Anonymous **GET** `/w365/sign-in` without a code | Branded invalid-link page (400), not an EasyAuth sign-in redirect. This checks the public entry route, not a valid handoff. |
| Anonymous **GET** `/w365-auth/ms-symbol.png` | 200 with an image, not HTML or a login redirect; check the other public assets too. |
| Anonymous **GET** `/api/w365/human/complete` | Authentication challenge/redirect or denial, never a usable anonymous confirmation page. |
| Fresh human request in a real Teams/M365 chat | Dedicated Microsoft sign-in action plus separate Continue/Cancel controls, after validated sender attribution. |
| Sign in as that same human and select **Confirm authorization** | `/.auth/refresh` and the completion POST succeed; GET alone does not authorize. Keep any one-time code private. |
| Continue in the original chat | Starts/resumes as the human; a separate Cloud PC sign-in action may still be required. Complete it promptly, check readiness with the same session ID, and explicitly end the session afterward. |

Use GET rather than `curl -I`/HEAD for the application routes: these handlers map GET/POST, and a HEAD 405 is not evidence that browser authentication failed. A successful generic EasyAuth login followed by "The sign-in link is invalid" without a chat-issued code proves only browser sign-in/protected-route access, not delegated W365-token acceptance, pool availability, or desktop readiness.

Settings changes, consent changes, and deployment each require separate approval. This README describes source behavior and setup checks, not proof of current cloud configuration or a successful end-to-end run. After any deployment or restart, request a fresh chat handoff and verify the full chat/browser/W365 sequence.

**Chat and browser sequence:**

1. In chat, explicitly request a human session and task, optionally with dimensions/browser mode. Before allocating a Cloud PC, the sample pins the verified chat tenant/object identity and saves the task/options, then explains sign-in in normal message text with a dedicated **Sign in with Microsoft** card action. The sign-in URL is in the action, not repeated in the prose.
2. The link opens `/w365/sign-in`, this sample's Windows 365-branded entry page. Select its official **Sign in with Microsoft** button using the **same work or school account as the original chat**. The button goes through EasyAuth to Microsoft-hosted authentication, then returns to `/api/w365/human/complete`. The sample never displays its own credential form. Select **Confirm authorization**: the page refreshes the provider token through `/.auth/refresh`, then submits an origin-checked, antiforgery-protected POST. GET alone does not complete authorization or consume the handoff. The server requires matching tenant/object identity, W365 audience, delegated scope, and a usable token lifetime before binding the credential to the saved request.
3. Return to the **original chat** and select **Continue after sign-in** in the separate Continue/Cancel message. This directly resumes the saved task/options without LLM intent classification. Only then does the sample connect as that human and start the requested session. If sign-in or confirmation is incomplete or expired, it returns a fresh sign-in action and replacement controls in separate messages instead of starting a session.
4. If W365 reports `awaitingHumanLogin`, use the dedicated **Sign in** card accompanying **Sign in to your Cloud PC** (`connectivityUrl`). Explanatory text stays in the message; the URL stays in its action. This opens the service-provided desktop sign-in experience, **not** API authorization or the screenshare page. The sample does not replace or rebrand that hosted experience.
5. Reply in the original chat to resume the same session and task. Say **end my session** to release that same session; do not start a replacement merely to resume.

Overlapping chat turns are reclassified against the current saved task before execution, so a newer replacement or amendment is not silently discarded. If reclassification changes the required resource route or session options, the sample asks you to retry that instruction without acting on the stale route.

If the initial screenshot fails while resuming saved work, the sample retains the task and prior history. Retry **continue** in the original chat to prepare the same session again; saved work is consumed only after the resumed input is recorded successfully.

The sign-in handoff uses two separate chat activities, each with its own Adaptive Card: the first explains sign-in and contains only **Sign in with Microsoft**; the next contains **Continue after sign-in** and **Cancel request**. The first message is finalized before sending the controls, so navigation and submitted-action status do not share a card. Sign-in opens the issued entry link; Continue/Cancel submit structured actions directly to the sample, not prompts for the model. Actions require the same verified sender and conversation and are bound to the current pending request. Old or repeated clicks cannot start a replacement request or cancel a newer one. Text commands **continue** and **end my session** remain available. A client must display Adaptive Card `Action.OpenUrl` to open the chat sign-in handoffs; if actions are unavailable, switch to a card-capable client rather than sending credentials in chat. Non-chat orchestrator consumers that omit the handoff callbacks retain Markdown-link guidance.

The entry, confirmation, success, and error pages share responsive light/dark styling, keyboard focus indicators, accessible status feedback, and clear recovery guidance. The sign-in buttons and Microsoft symbol are unmodified official assets from the [Microsoft sign-in branding guidelines](https://learn.microsoft.com/entra/identity-platform/howto-add-branding-in-apps), served locally under `/w365-auth/`. Browser pages retain SVG assets; the chat sign-in icon uses Microsoft's official PNG for renderer compatibility. Do not alter the logo or substitute a custom Microsoft credential form. The sample styles its own product pages, not Microsoft's identity pages or SDK/platform-owned sign-in screens. Tenant-wide company branding is an administrator-managed option, not changed by this sample. Pages use no-store, anti-framing, strict-origin referrer protection, and a same-origin CSP without inline scripts/styles.

Use **Sign out and use another account** when the browser is signed in to the wrong work or school account. Its fixed same-site return points back to the current entry link; it cannot redirect to an arbitrary website. Signing out clears the browser's EasyAuth session, but does not revoke an already accepted delegated credential or end a Cloud PC session. Cancel or end the request in the original chat to use the sample's actual cleanup flow.

Authorization links are single-use, expire after **five minutes**, and only the **latest link for that request** remains valid. A different account cannot complete the handoff or take over the pinned request; switch to the original account and use the latest link, or request a new link in chat. Before allocation, **Cancel request** (or **end my session**) clears the saved request, buttons, and handoff without allocating a Cloud PC. If a Cloud PC already exists, cancellation uses the existing **EndSession** flow: it retains that session and the end intent if fresh authorization is required and confirms release only after the service succeeds.

Credentials are treated as expired within two minutes of expiry. Expiry or a W365 transport HTTP 401 discards the human connection/credential and requests authorization again, without substituting an agent, environment, Graph, or ARI token. The existing session ID, saved task/options, and pending **EndSession** intent are retained: authorize as the same human, then return to chat to resume or finish ending that session. Successful end/explicit service-ended responses clear the associated state. Shutdown attempts cleanup with usable human authorization, but cannot confirm release when that authorization is missing/expired or cleanup fails; do not assume shutdown or a restart released the Cloud PC.

An asynchronous hosted service attempts shutdown cleanup within **10 seconds**, or the host's remaining cancellation budget if shorter. Lock acquisition, remote termination, and transport disposal share that budget. Expiry/cancellation logs that release is unconfirmed instead of blocking shutdown indefinitely or claiming a Cloud PC was released. Shutdown continues past expected network, timeout, protocol, and tool-state failures, retaining unconfirmed sessions for retry while the process remains alive. Cancellation unrelated to the shutdown budget and unexpected exceptions propagate.

The hosted human flow does **not** support human Graph/ARI acquisition: no agent-authenticated screenshare links or OneDrive screenshot uploads are provided. The W365 `connectivityUrl` remains available when required; it is not replaced by an agent-authenticated viewer.

#### Cloud PC sign-in and readiness

When `awaitingHumanLogin` is true, the sample immediately replies with **Sign in to your Cloud PC** and a dedicated **Sign in** card using `connectivityUrl`, retains the session, and does not take screenshots or enter the computer-use action loop. Use the action promptly and sign in with your work or school account. It is not the screen-share link or agent-authorization handoff and does not bypass authentication. Invalid or missing sign-in URLs produce explicit recovery guidance without a sign-in action; the session remains selected. On a later computer-use turn, the sample checks `GetSessionDetails` up to three times, two seconds apart, within a 15-second local budget. If a details response omits the optional readiness flag, successful session-aware `tools/list` must confirm readiness before any remote action; pending discovery guidance preserves the session. If still pending, the turn returns one sign-in guidance reply. These local limits are not a guaranteed service timeout.

A sign-in acknowledgement resumes the same session and saved task. Corrections amend that task, and a new computer-use request replaces it without allocating another session. A request that explicitly selects session options instead receives the end-first guidance while the active session and task are retained. Greetings, unrelated questions, and non-desktop function-tool requests follow the normal non-CUA path while the pending task is retained. The intent classifier does not run remote actions; if classification fails, the sample logs a warning and reports the error without modifying the saved task or starting another session.

Ready hosted-human follow-up turns retain the existing conversation history. A task is staged for resumption only when authorization or session readiness interrupts it; ordinary follow-ups do not reset prior instructions and responses.

Every turn accessing a hosted-human conversation requires the same verified chat owner, including non-desktop replies and intent classification that reads the saved task. Activity-supplied conversation/sender IDs are not proof of ownership. The verified owner can still send ordinary chat messages while W365 authorization is pending or expired, without connecting to W365 or changing the saved task.

If startup allocates a session but returns invalid sign-in metadata (such as a missing or non-HTTPS `connectivityUrl`), the sample reports the error and retains the session, original task, and selected options. Retry with "continue" to check readiness or say "end my session" to cancel; the sample does not allocate another session to recover.

Pending-login guidance is non-fatal. The sample retains the ID when discovery or a remote call reports pending sign-in, and clears it only when the service explicitly reports an ended/expired session. Say **end my session** to abandon sign-in or release a ready session; shutdown also attempts `EndSession` for retained pending sessions, subject to usable human authorization for hosted human sessions. An explicitly ended session cannot be reused.

If `GetSessionDetails` explicitly inspects another session ID and reports that it has ended or is awaiting human sign-in, the sample returns that inspection error without changing the selected session's readiness, conversation state, or shutdown tracking. An ended response for the selected session still clears that session's state; pending-login guidance for the selected session still enters its sign-in flow.

Once ready, remote discovery uses `tools/list` with `params._meta.sessionId`, and every remote call includes `sessionId` in its arguments. The ordinary no-options session still waits until ready, and existing additive response fields remain accepted.

For integrations managing `x-ms-authorization-auxiliary`, this is an **HTTP request header**, never a tool argument: `local` rejects a supplied header, `human` accepts an optional single raw token, and `agentic` ignores a caller-supplied value. This sample does not configure or store auxiliary tokens. An auxiliary token cannot change the primary bearer-token caller or turn an agentic caller into a human.

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
| `HumanW365Authentication:Enabled` | Opt in to hosted EasyAuth human W365 authorization; does not select a session kind | `false` |
| `HumanW365Authentication:TenantId` | Entra tenant GUID for hosted human authorization | - |
| `HumanW365Authentication:ApplicationBaseUrl` | Optional canonical HTTPS application root for human authorization links | App Service `WEBSITE_HOSTNAME` when omitted |
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
2. **MCP connection** established directly to the configured W365 endpoint in development or the W365 gateway in production, without requiring remote discovery first
3. **Session startup and readiness** run explicitly with `mcp_W365ComputerUse_StartSession`. Pending human sign-in is handled outside the model loop. Once ready, `tools/list` uses `_meta.sessionId`; the selected ID is sent on every remote W365 call.
4. **CUA loop** in `ComputerUseOrchestrator.RunAsync`:
   - User message + conversation history sent to the model
   - Model returns `computer_call` actions (click, type, scroll, etc.)
   - Actions translated to MCP tool calls (`click`, `type_text`, `press_keys`, etc.) with the cached `sessionId`
   - Screenshot captured after each action and fed back to the model
   - Loop continues until model calls `OnTaskComplete` or max iterations reached
5. **Response** sent back to user
6. **Sessions persist** across messages for follow-up tasks, and a user can reference a specific `sessionId` to switch context
7. **EndSession** attempted on app shutdown (Ctrl+C) via `mcp_W365ComputerUse_EndSession` for cached sessions; hosted human cleanup requires usable human authorization and does not guarantee release

## Session Management

- Sessions are started with `mcp_W365ComputerUse_StartSession`; multiple session IDs can be cached for one conversation
- To select a session, begin the message with `Use session <UUID>`, `Switch to W365 session <UUID>`, or `session <UUID>`; a UUID sent alone also selects it. UUIDs elsewhere in task data do not select sessions or block startup. Hosted-human ownership and end-first restrictions still apply.
- Conversation history accumulates across messages, giving the model context for follow-up tasks
- On app shutdown (`Ctrl+C`), the agent attempts `EndSession` for cached sessions; hosted human sessions require usable human authorization, and cleanup failures leave release unconfirmed
- If the app crashes, backend expiration is service-controlled; do not rely on a fixed timeout, especially while sign-in is pending

## Screenshare

For the existing agent-authenticated path, the agent can expose a live screenshare link to the running Cloud PC through the W365 / ARI screenshare SDK. The link is created during the bot turn, when `turnContext` is available. The hosted human authorization path does not acquire ARI tokens or emit these links; use the separate W365 `connectivityUrl` for required Cloud PC sign-in.

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
3. Remove `McpServer:Url` — in production the agent connects directly to the W365 Computer Use MCP gateway (default `https://agent365.svc.cloud.microsoft/agents/servers/mcp_W365ComputerUse`, override via `W365:GatewayUrl`) using the `w365` agentic auth handler for default/agentic sessions, or the opt-in EasyAuth human credential for explicit human sessions. The W365 server requires an explicit session, so the agent calls `StartSession` and sends `_meta.sessionId` on `tools/list`, rather than going through the generic A365 SDK Tooling Gateway.
4. Deploy and install the agent in Teams / M365

### Hosted human live verification (only after approval)

This is a verification recipe, not authorization to change infrastructure, consent, or deployment. Local/synthetic checks do not prove the deployed issue is fixed.

- **Startup:** verify the approved app settings and EasyAuth provider/token-store configuration without exposing credentials. Check health and messaging still work, completion remains EasyAuth-protected, and the actual channel passes JWT validation with verifiable sender tenant/object IDs. Unsupported sender shape must fail closed before any W365 connection.
- **API handoff:** request a human task with chat-only options. Confirm no Cloud PC is allocated before authorization. Verify latest-link-only/five-minute expiry, wrong-account rejection, and pre-allocation cancellation; then authorize as the original chat human and return to chat.
- **Pending Cloud PC:** if the service requires desktop sign-in, verify the separate `connectivityUrl`, no screenshots/actions while pending, bounded readiness guidance, and no duplicate allocation.
- **Desktop:** after signing in, acknowledge in the same chat and verify the same session resumes the saved task/options. Confirm no agent-authenticated screenshare or OneDrive upload is offered.
- **Refresh:** verify browser confirmation refreshes the provider token. In a controlled approved test of expiry/HTTP 401, verify reauthorization preserves the session/task/options and reconnects only as the original human.
- **End:** end both pending and ready sessions and verify release of the original session. If authorization expires during end, reauthorize and confirm the saved EndSession intent completes without resuming desktop work or allocating another PC. Treat cleanup failures as unconfirmed release, not success.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `McpServer:Url is required` | Create `appsettings.Development.json` with the MCP server URL |
| `BEARER_TOKEN` not set | Set `$env:BEARER_TOKEN` before running |
| Model returns 400 | Check that the tool type matches your model (see Supported Models table) |
| Screenshot extraction fails | Ensure MCP server returns image content blocks |
| Session orphaned after crash | End known sessions when possible; backend expiration is service-controlled, not a guaranteed fixed timeout |
| Multiple sessions started | Ensure only one agent instance is running per MCP server |
| Waiting for human sign-in | Open `connectivityUrl` promptly, sign in, then reply to resume; do not start another session |
| Resume says session options cannot be changed | Use the separate **Continue after sign-in** action, or say "continue my pending request" without repeating `human`, dimensions, or browser options. Explicit options are blocked while a session/request is pinned, even when the repeated values are unchanged. To change options, end the existing session first |
| Invalid display/browser option | Use positive integer dimensions and `chromium` or `legacy` |
| Unavailable kind / incompatible caller | Check service availability and token identity; an agentic token cannot request `human`, and app-only callers cannot select explicit kinds |
| W365 gateway HTTP 403 | Check the selected gateway environment against the access token's intended resource and delegated scope. A production-resource token against a test gateway was an observed configuration mismatch; a 403 alone does not establish missing consent or its exact cause. Do not copy test overrides into production or broaden token validation |
| No free W365 sessions / no pools found | Ask the administrator to check pool discovery and eligibility for the actual caller as well as free checkout capacity. An observed human call returned an empty `/me/cloudPcPools` collection before any pool checkout; the capacity message did not mean all existing pools were full. Agent-pool provisioning/assignment alone does not establish human eligibility |
| Windows App stays on its loading screen | Open the exact current `connectivityUrl` in a full, updated browser with the original human account/tenant. Check browser errors and resource/feed discovery separately from EasyAuth. Successful HTTP asset requests or a telemetry SDK error alone do not prove the cause of the spinner. Retain the same session while checking readiness unless the service explicitly reports it ended |
| `BitBlt failed` / display DC unavailable | This is a remote Windows desktop-capture failure, not by itself a W365 OAuth rejection or invalid display setting. Correlate lifecycle responses and the failed tool's correlation ID/timestamp with the W365 backend to check readiness, lock/disconnect state, and capture-worker session attachment. A previously ready session does not guarantee its desktop remains capturable; do not change app permissions based on this error alone |
| Metadata-only request fails taking a screenshot | This revision can capture an initial screenshot before model execution, including a request to return session details. A capture failure can prevent later details tools from running; it does not prove `StartSession` failed or that no session was allocated. Use lifecycle/backend evidence rather than the model's inferred explanation |
| Session ended while signing in | The old ID cannot be reused; send a new computer-use request |
| W365 authentication expired | Refresh the W365 token and retry; the service session ID is retained |
| Hosted human sign-in unavailable/disabled | Verify the opt-in authentication settings, tenant GUID, canonical HTTPS origin (or `WEBSITE_HOSTNAME`), and App Service EasyAuth boundary; do not add session defaults |
| Branded entry/card icon redirects to login or is missing | Check the exact public EasyAuth exclusions listed above and deployed `wwwroot` assets. Code deployment does not apply EasyAuth exclusions. Keep completion protected; do not solve this with wildcard exclusions |
| Entra redirect mismatch / `AADSTS50011` | Compare the sign-in app's **Web** callback with the actual canonical host/slot: `https://<<HOSTNAME>>/.auth/login/aad/callback`. Do not register the application completion route as the OAuth callback |
| Invalid/expired provider secret / `AADSTS7000215` or `AADSTS7000222` | Check the EasyAuth registration and its referenced App Service credential setting, not just the agent's service-connection secret. Use the current secret value, not its ID; rotate through the approved secret store and reauthenticate. Never print the value |
| Consent denied | Have an administrator review the sign-in app's delegated W365 permission and tenant consent policy; retry the latest chat link only after appropriate consent |
| Permission configured but consent still required / `AADSTS65001` | Verify an actual delegated grant to W365 for the browser sign-in enterprise application, the relevant user/tenant, and `Tools.ListInvoke.All`. A configured permission is not a grant. Reauthenticate after consent and scope changes |
| Missing provider token / confirmation refresh fails | Verify EasyAuth v2 token store, valid provider credential reference, and `loginParameters` scopes; sign in again. Do not copy tokens into chat, logs, or configuration |
| Access denied after clicking Confirm authorization | Keep the confirmation page's `Referrer-Policy: strict-origin`: `no-referrer` makes normal form submissions send `Origin: null`, conflicting with EasyAuth and the endpoint's same-origin checks. `strict-origin` preserves the HTTPS origin without disclosing the handoff path or query. Do not disable EasyAuth, origin validation, or antiforgery protection |
| Confirmation 400 / 403 / 410 / 429 | 400: reload the latest confirmation page for a fresh valid form/antiforgery cookie; a missing/invalid link code is also 400. 403: check the exact canonical HTTPS origin and original account/tenant. 410: the handoff expired, was consumed, was superseded, or was lost on restart; request a fresh link in the original chat. 429: wait before retrying; completion POSTs are limited to five per minute per IP |
| Wrong token audience/scope or expired authorization | The completion endpoint fails closed. Request a W365 access token for `da81128c-e5b5-4f9e-8d89-50d906f107c5` (also accepts `api://` prefix) with delegated `Tools.ListInvoke.All`; Graph/ID/app-only tokens are not substitutes |
| Wrong account / expired or reused authorization link | Use the original chat human in the configured tenant and the latest link within five minutes; request a fresh link in the original chat if necessary |
| Unverified chat sender | Check the reply's diagnostic code and the matching `ReasonCode` warning. `activity_tenant_id_missing_or_invalid` / `activity_sender_object_id_missing_or_invalid` identify missing or invalid activity IDs; `incoming_jwt_identity_unavailable` means the queued identity has no proof of successful named JWT bearer validation at HTTP ingress; `jwt_tenant_does_not_match_activity` / `jwt_sender_does_not_match_activity` identify absent or mismatched validated identity claims when no supported channel-attribution path applies. Enable incoming JWT `TokenValidation` with the actual channel's expected issuers/audiences and verify sender attribution. Diagnostics contain no tokens, personal IDs, or message content. Unknown Agent365 callers/channels remain fail-closed |
| Validated sender claim comparison fails | The associated warning reports fixed `ClaimKind` (`tid` or `oid`) and `ClaimStatus`: `missing` means neither claim spelling exists; `malformed` means a value is not a GUID; `conflicting` means the claim spellings/occurrences contain distinct GUIDs; `mismatch` means one distinct GUID differs from the activity. Malformed values take precedence over conflicts. Matching duplicates remain accepted. These categories do not reveal identity values, establish a service caller's authority to attest a human sender, or change rejection behavior |
| Identify a mismatching validated token subject | An object-ID rejection also logs fixed `IdentityType` / `SubjectFacets` categories and booleans for delegated-scope presence, application-role presence, and object-ID equality to a configured incoming audience. Subject facet `11` means agent identity; `13` means agent user account. `idtyp=user` alone does not establish a human subject. Missing/other facets do not prove a human either. Audience equality is diagnostic only, not sender-attestation authorization. No identity, scope, role, or token values are logged; rejection remains unchanged. See the [Entra agent token claims reference](https://learn.microsoft.com/en-us/entra/agent-id/agent-token-claims) |
| Identify the validated delivery caller | An object-ID rejection reports `CallerCategory`: `agent365_platform`, `other`, `missing`, or `ambiguous`. It compares `azp` (or `appid` only when `azp` is absent) to the public platform application ID documented in the [Teams SDK caller-validation change](https://github.com/microsoft/teams.net/pull/695). Multiple caller claims are classified as ambiguous. A platform match alone does not authorize channel attribution: ingress validation, a matching tenant and Entra issuer, and a supported Teams channel are also required. Caller IDs are not logged |
| Missing incoming JWT proof | Check the HTTP-ingress `ReasonCode` warning: `incoming_jwt_bearer_scheme_missing` / `incoming_jwt_bearer_handler_unexpected` identify registration issues; `incoming_jwt_bearer_token_missing` means no Authorization header and no successful bearer authentication; `incoming_jwt_authentication_no_result` means a header was present but the handler supplied no result. Token validation failures report fixed codes for expiry, not-yet-valid tokens, invalid audience/issuer/signature, missing signing key, or generic authentication failure. `incoming_jwt_ticket_scheme_unexpected` / `incoming_jwt_principal_unauthenticated` identify unusable authentication results. Successful binding logs `incoming_jwt_identity_bound` at Information level; if the same request later lacks proof, investigate the adapter/turn pipeline. EasyAuth browser sign-in alone is not incoming channel JWT validation |
| Incoming JWT audience rejected | `incoming_jwt_audience_matches_service_connection` / `incoming_jwt_audience_matches_service_connection_uri` mean the rejected audience matches `Connections:ServiceConnection:Settings:ClientId` or its `api://` form instead of the configured incoming audience. `incoming_jwt_audience_matches_configured_uri` / `incoming_jwt_audience_matches_configured_case_variant` identify URI-form or case-only differences from a configured incoming audience. Other values retain `incoming_jwt_audience_invalid`. These are diagnostic comparisons only: the token remains rejected, no token/audience values are logged, and a match does not establish that the hosting application's audience is appropriate for this channel. Verify the channel registration before changing accepted audiences; do not disable audience validation or substitute the W365 resource audience |
| Human expiry/HTTP 401 while resuming or ending | Complete a new API authorization handoff as the original human, then reply in the same chat. Session/task/options and pending end intent are retained; do not allocate another session |
| State lost after restart / completion reaches another worker | Use a single instance or verified same-worker routing for channel and browser. State is not durable; a restart does not prove service-side release |
| Human screenshare or OneDrive upload unavailable | Hosted human Graph/ARI authentication is unsupported; do not substitute agent tokens. Use W365 `connectivityUrl` for required desktop sign-in |

## Links

- [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/microsoft-agent-365/developer/)
- [Microsoft 365 Agents SDK](https://learn.microsoft.com/microsoft-365/agents-sdk/)
- [Azure OpenAI Computer Use Guide](https://learn.microsoft.com/azure/foundry-classic/openai/how-to/computer-use)
- [Work with OAuth tokens in Azure App Service authentication](https://learn.microsoft.com/en-us/azure/app-service/configure-authentication-oauth-tokens)
