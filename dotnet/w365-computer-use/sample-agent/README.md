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
- An Azure tenant where you can run `a365 setup` to provision the agent identity and grant the `McpServers.W365ComputerUse.All` admin consent
- An end user with a Windows 365 Cloud PC license / pool entitlement in that tenant
- The [Agent 365 dev-tools CLI](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/) installed: `dotnet tool install -g Microsoft.Agents.A365.DevTools.Cli`

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

### 3. Provision the agent identity

The sample uses agentic auth and connects to the production Agent Tooling Gateway. Provision the agent blueprint, app registration, and consent grants via the Agent 365 dev-tools CLI.

First, copy the committed template into a working config:

```bash
cp a365.config.example.json a365.config.json
```

Then open `a365.config.json` and fill in the placeholders for your tenant — `tenantId`, `subscriptionId`, `resourceGroup`, `webAppName`, `appServicePlanName`, `agentUserPrincipalName`, `managerEmail`. Leave `customBlueprintPermissions` as-is unless you intend to extend the agent with additional MCP servers; the W365 sample only needs `McpServers.W365ComputerUse.All` (and `McpServersMetadata.Read.All` for tool discovery).

Then run setup. Use `--m365` so the CLI registers the agent identity in M365 (the bot channels registration is done separately — see [Production Deployment](#production-deployment)):

```bash
a365 setup all --m365
```

This writes `a365.generated.config.json` next to your config file — both `a365.config.json` and `a365.generated.config.json` are gitignored and contain tenant-specific values you must not commit. The generated file contains the new agent blueprint id, the agent blueprint client secret, and consent URLs you must visit to grant tenant admin consent for each resource.

### 4. Configure local secrets

For local runs, write a personal `appsettings.Development.json` next to `appsettings.json` (gitignored) that overrides the connection block from `UserManagedIdentity` to `ClientSecret` and supplies the Azure OpenAI credentials. The blueprint id and client secret come from `a365.generated.config.json` (produced by `a365 setup all --m365`):

```jsonc
{
  "AIServices": {
    "AzureOpenAI": {
      "Endpoint": "https://your-resource.openai.azure.com",
      "ApiKey": "<your-azure-openai-key>",
      "DeploymentName": "computer-use-preview" // or set ModelName for gpt-5.4-mini
    }
  },
  "Connections": {
    "ServiceConnection": {
      "Settings": {
        "AuthType": "ClientSecret",
        "AuthorityEndpoint": "https://login.microsoftonline.com/<your-tenant-id>",
        "ClientId": "<agentBlueprintId from a365.generated.config.json>",
        "ClientSecret": "<agentBlueprintClientSecret from a365.generated.config.json>"
      }
    }
  }
}
```

Alternatively use `dotnet user-secrets` if you prefer to keep secrets out of the working tree:

```bash
dotnet user-secrets init
dotnet user-secrets set "AIServices:AzureOpenAI:Endpoint" "https://your-resource.openai.azure.com"
dotnet user-secrets set "AIServices:AzureOpenAI:ApiKey" "<your-key>"
dotnet user-secrets set "AIServices:AzureOpenAI:DeploymentName" "computer-use-preview"
dotnet user-secrets set "Connections:ServiceConnection:Settings:AuthType" "ClientSecret"
dotnet user-secrets set "Connections:ServiceConnection:Settings:AuthorityEndpoint" "https://login.microsoftonline.com/<your-tenant-id>"
dotnet user-secrets set "Connections:ServiceConnection:Settings:ClientId" "<agentBlueprintId>"
dotnet user-secrets set "Connections:ServiceConnection:Settings:ClientSecret" "<your-secret>"
```

### 5. Run the agent

```bash
cd sample-agent
dotnet run
```

The agent listens on `http://localhost:3978/api/messages`.

### 6. Test with Agent Playground

1. Open [Microsoft 365 Agents Playground](https://dev.agents.cloud.microsoft/).
2. Connect to `http://localhost:3978/api/messages`.
3. Send a message like *"Open Notepad and type Hello World"*.
4. Screenshots are saved to `./Screenshots/` locally and uploaded to the OneDrive folder configured in `appsettings.json` (with a per-prompt subfolder link surfaced in chat).

## Configuration Reference

| Setting | Description | Default |
|---------|-------------|---------|
| `AIServices:AzureOpenAI:Endpoint` | Azure OpenAI resource URL | - |
| `AIServices:AzureOpenAI:ApiKey` | API key | - |
| `AIServices:AzureOpenAI:DeploymentName` | Deployment name (for deployment-based URLs) | `computer-use-preview` |
| `AIServices:AzureOpenAI:ModelName` | Model name (for model-based URLs, e.g., `gpt-5.4-mini`) | - |
| `ComputerUse:MaxIterations` | Max CUA loop iterations | `30` |
| `ComputerUse:DisplayWidth` | Display width for computer_use_preview tool | `1024` |
| `ComputerUse:DisplayHeight` | Display height for computer_use_preview tool | `768` |
| `Screenshots:LocalPath` | Local path to save screenshots | `./Screenshots` |
| `Screenshots:OneDriveFolder` | OneDrive folder for screenshot upload | `CUA-Sessions` |
| `Screenshots:OneDriveUserId` | UPN/email to upload screenshots to a specific user's OneDrive (instead of token owner) | - |

## Supported Models

| Model | Tool Type | Config | Notes |
|-------|-----------|--------|-------|
| `computer-use-preview` | `computer_use_preview` | `DeploymentName: "computer-use-preview"` | Uses `display_width`, `display_height`, `environment` params |
| `gpt-5.4` / `gpt-5.4-mini` | `computer` | `ModelName: "gpt-5.4-mini"` | Bare `{"type": "computer"}`. Initial screenshot sent with first message |

The tool type is auto-derived from the model name (`gpt-*` -> `computer`, otherwise -> `computer_use_preview`).

## How It Works

1. **User sends a message** -> `MyAgent.OnMessageAsync`
2. **MCP connection** established via the Agent 365 SDK's tooling gateway based on the agent blueprint's permissions
3. **Session acquisition** runs transparently on the first W365 tool call — ATG picks an eligible Cloud PC pool, checks out a session, and probes readiness. The session is reused across messages.
4. **CUA loop** in `ComputerUseOrchestrator.RunAsync`:
   - User message + conversation history sent to the model
   - Model returns `computer_call` actions (click, type, scroll, etc.)
   - Actions translated to MCP tool calls (`click`, `type_text`, `press_keys`, etc. — discovered dynamically from the W365 remote server)
   - Screenshot captured after each action and fed back to the model
   - Loop continues until model calls `OnTaskComplete` or max iterations reached
5. **Response** sent back to user
6. **Session persists** across messages for follow-up tasks
7. **EndSession** called on app shutdown (Ctrl+C) via `mcp_W365ComputerUse_EndSession` to release the VM

## Session Management

- Sessions are started **once** on the first message and reused across all subsequent messages
- Conversation history accumulates across messages, giving the model context for follow-up tasks
- On app shutdown (`Ctrl+C`), the agent calls `EndSession` to release the VM back to the pool
- If the app crashes, sessions auto-expire after ~30 minutes on the W365 backend

## Production Deployment

The dev-tools CLI provisions the agent identity, but the rest of the production pipeline (Azure infrastructure, App Service settings, the Bot Channels Registration, blueprint linking, and Teams app upload) is currently a manual flow. Follow the steps below for an end-to-end deployment.

### 1. Provision the agent identity

If you haven't already done it during local setup, run:

```bash
a365 setup all --m365
```

This creates the agent blueprint, the agent app registration, and the agent user, and writes consent URLs into `a365.generated.config.json`. Open each `consentUrl` in the generated file as a tenant administrator to grant admin consent for every required resource (Microsoft Graph, Agent 365 Tools, Messaging Bot API, Observability API, Power Platform API).

### 2. Verify license readiness

Each end user invoking the agent must hold an `AGENT_365_TOOLS` or `AGENT_365` license, plus a Windows 365 Cloud PC license / pool entitlement (the Cloud PC license is what `mcp_W365ComputerUse` uses to provision a session for the user).

### 3. Create the Azure infrastructure

Create the resource group, App Service plan, and web app:

```bash
az group create --name <rg> --location <location>

az appservice plan create \
  --name <plan-name> \
  --resource-group <rg> \
  --sku B1 \
  --is-linux false

az webapp create \
  --name <webapp-name> \
  --resource-group <rg> \
  --plan <plan-name> \
  --runtime "DOTNETCORE:8.0"
```

### 4. Configure App Service application settings

Push the runtime configuration into App Service. The committed `appsettings.json` defaults the connection to `UserManagedIdentity` — override it to `ClientSecret` here so the agent blueprint can authenticate with the secret produced by `a365 setup`. Use double-underscore separators for nested keys:

```bash
az webapp config appsettings set \
  --name <webapp-name> \
  --resource-group <rg> \
  --settings \
    AIServices__AzureOpenAI__Endpoint=https://<your-resource>.openai.azure.com \
    AIServices__AzureOpenAI__ApiKey=<your-azure-openai-key> \
    AIServices__AzureOpenAI__DeploymentName=computer-use-preview \
    Connections__ServiceConnection__Settings__AuthType=ClientSecret \
    Connections__ServiceConnection__Settings__AuthorityEndpoint=https://login.microsoftonline.com/<your-tenant-id> \
    Connections__ServiceConnection__Settings__ClientId=<agentBlueprintId-from-generated-config> \
    Connections__ServiceConnection__Settings__ClientSecret=<agentBlueprintClientSecret-from-generated-config> \
    ASPNETCORE_ENVIRONMENT=Production
```

For higher-trust deployments, assign a User-Assigned Managed Identity to the App Service and leave the connection on `UserManagedIdentity` (the default), or store the client secret in Azure Key Vault and reference it from App Service via Key Vault references.

### 5. Build and deploy the code

```bash
dotnet publish W365ComputerUseSample.csproj -c Release -o ./publish
Compress-Archive -Path ./publish/* -DestinationPath ./app.zip -Force
az webapp deploy \
  --resource-group <rg> \
  --name <webapp-name> \
  --src-path ./app.zip \
  --type zip
```

Confirm the messaging endpoint is reachable: `https://<webapp-name>.azurewebsites.net/api/health` should return `{"status":"healthy", ...}`.

### 6. Create the Bot Channels Registration in Azure AI Foundry

In Azure AI Foundry (or the Azure portal), create a Bot Channels Registration (Azure Bot resource) that points at your messaging endpoint:

- **Messaging endpoint**: `https://<webapp-name>.azurewebsites.net/api/messages`
- **Microsoft App type**: Single Tenant
- **Microsoft App ID**: the agent's app-registration client id (the same one you set as `Connections__ServiceConnection__Settings__ClientId`)
- Enable the **Microsoft Teams** channel

Take note of the bot's resource id — you will need it in step 7.

### 7. Link the bot to the agent blueprint

Link the Azure Bot resource to the agent blueprint so the platform recognises the bot as the messaging endpoint for this agent identity. This is currently a portal/CLI step (the dev-tools CLI does not yet automate it). Confirm the linkage by checking that the agent blueprint shows a `botId` and `botMsaAppId` in its agent identity record.

### 8. Generate and upload the Teams app package

The dev-tools CLI generates the Teams app manifest from internal templates — no manifest is committed to the repo:

```bash
a365 publish
```

This writes the manifest, icons, and `manifest.zip` into a local `manifest/` folder (gitignored). Upload `manifest/manifest.zip` through the [Microsoft 365 Admin Center](https://admin.microsoft.com/) under **Settings → Integrated apps → Upload custom apps**.

### 9. Send a test message

Open Microsoft Teams (or the Microsoft 365 chat client) as a user with the required licenses, install the uploaded custom app, and send the agent a message such as *"Open Notepad and type Hello World"*.

In Production the SDK discovers MCP servers through the platform's Agent Tooling Gateway based on the agent blueprint's permissions — `ToolingManifest.json` is reference material only.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Model returns 400 | Check that the tool type matches your model (see Supported Models table) |
| `Failed to acquire a W365 session: no Cloud PC pools are available` | The acting user has no Windows 365 Cloud PC entitlement. Assign a Cloud PC license / pool membership in the user's tenant. |
| `invalid_function_parameters` from Azure OpenAI | One of the MCP server's tool responses returned an Error sentinel. The orchestrator filters it from the LLM tool list — confirm the filter is in place in `ComputerUseOrchestrator.cs`. |
| Screenshot extraction fails | Ensure MCP server returns image content blocks |
| Session orphaned after crash | Sessions auto-expire after ~30 min on the W365 backend |
| Multiple sessions started | Ensure only one agent instance is running per conversation |

## Links

- [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- [Microsoft 365 Agents SDK](https://learn.microsoft.com/microsoft-365/agents-sdk/)
- [Azure OpenAI Computer Use Guide](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/computer-use)