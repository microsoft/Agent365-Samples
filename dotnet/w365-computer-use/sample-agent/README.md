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

The sample uses agentic auth and connects to the production Agent Tooling Gateway. Provision the agent blueprint, app registration, and consent grants via the Agent 365 dev-tools CLI:

```bash
a365 setup all
```

This writes `a365.config.json` and `a365.generated.config.json` locally — both are gitignored and contain tenant-specific values you must not commit. See the [Production Deployment](#production-deployment) section for the full provisioning details and required permissions.

### 4. Configure Azure OpenAI credentials

Use `dotnet user-secrets` to set your model credentials without committing them:

```bash
cd sample-agent
dotnet user-secrets init
dotnet user-secrets set "AIServices:AzureOpenAI:Endpoint" "https://your-resource.openai.azure.com"
dotnet user-secrets set "AIServices:AzureOpenAI:ApiKey" "<your-key>"
dotnet user-secrets set "AIServices:AzureOpenAI:DeploymentName" "computer-use-preview"   # or set ModelName for gpt-5.4-mini
```

Alternatively write a personal `appsettings.Development.json` (gitignored).

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
| `AIServices:Provider` | Model provider | `AzureOpenAI` |
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

## Handling Secrets

Don't commit secrets — use one of the standard configuration providers instead.

**Local runs.** Use `dotnet user-secrets` for sensitive values, or write a personal `appsettings.Development.json` (gitignored):

```bash
cd sample-agent
dotnet user-secrets init
dotnet user-secrets set "AIServices:AzureOpenAI:ApiKey" "<your-key>"
dotnet user-secrets set "Connections:ServiceConnection:Settings:ClientSecret" "<your-secret>"
```

**Production (Azure App Service).** Set the values as App Service application settings via the portal, Azure CLI, or your deployment pipeline. Use double-underscore separators for nested keys:

```bash
az webapp config appsettings set --name <app> --resource-group <rg> --settings \
  AIServices__AzureOpenAI__ApiKey=<your-key> \
  Connections__ServiceConnection__Settings__ClientSecret=<your-secret>
```

For higher-trust deployments, store secrets in Azure Key Vault and pull them into App Service via Key Vault references.

## Production Deployment

1. **Provision the agent identity and consent** with the Agent 365 dev-tools CLI:
   ```bash
   a365 setup all
   ```
   This creates the agent blueprint, registers permissions, and (with admin consent) prepares the agent identity. The CLI writes `a365.config.json` and `a365.generated.config.json` locally — both are gitignored and contain tenant-specific values you should never commit.
2. **Confirm app-registration permissions.** The agent's app registration must request `McpServers.<ServerName>.All` for every server in `ToolingManifest.json` (e.g., `McpServers.W365ComputerUse.All`). Admin consent is required in each customer tenant.
3. **Verify license readiness.** Each end user invoking the agent must have an `AGENT_365_TOOLS` or `AGENT_365` license. The platform logs license-check failures and may enforce them in the future.
4. **Configure App Service settings** for `AIServices`, `Connections:ServiceConnection`, and any Azure OpenAI overrides — see the *Handling Secrets* section above.
5. **Deploy the code:**
   ```bash
   dotnet publish W365ComputerUseSample.csproj -c Release -o ./publish
   Compress-Archive -Path ./publish/* -DestinationPath ./app.zip -Force
   az webapp deploy --resource-group <rg> --name <app> --src-path ./app.zip --type zip
   ```
6. **Package and upload the Teams app** with `a365 publish`, or zip `appPackage/` and upload it through the Microsoft 365 Admin Center.

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