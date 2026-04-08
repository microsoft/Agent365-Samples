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
- A bearer token with `McpServers.W365ComputerUse.All` scope

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

Get a token with the `McpServers.W365ComputerUse.All` scope for your tenant. See the [Agent 365 MCP Platform docs](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/) for details.

### 5. Start the MCP Platform server

Ensure the MCP Platform is running locally on port 52857, or update the `McpServer:Url` in your config.

### 6. Run the agent

```powershell
cd sample-agent
$env:ASPNETCORE_ENVIRONMENT = "Development"
$env:BEARER_TOKEN = "<your-mcp-platform-token>"
$env:GRAPH_TOKEN = "<optional-graph-token-for-onedrive-upload>"
dotnet run
```

### 7. Test with Agent Builder

1. Open [Microsoft 365 Agents Playground](https://dev.agents.cloud.microsoft/)
2. Connect to `http://localhost:3978/api/messages`
3. Send a message like: *"Open Notepad and type Hello World"*
4. Screenshots are saved to `./Screenshots/` automatically

## Configuration Reference

| Setting | Description | Default |
|---------|-------------|---------|
| `AIServices:Provider` | Model provider | `AzureOpenAI` |
| `AIServices:AzureOpenAI:Endpoint` | Azure OpenAI resource URL | - |
| `AIServices:AzureOpenAI:ApiKey` | API key | - |
| `AIServices:AzureOpenAI:DeploymentName` | Deployment name (for deployment-based URLs) | `computer-use-preview` |
| `AIServices:AzureOpenAI:ModelName` | Model name (for model-based URLs, e.g., `gpt-5.4-mini`) | - |
| `McpServer:Url` | MCP server URL (dev only; omit for production) | - |
| `ComputerUse:MaxIterations` | Max CUA loop iterations | `30` |
| `ComputerUse:DisplayWidth` | Display width for computer_use_preview tool | `1024` |
| `ComputerUse:DisplayHeight` | Display height for computer_use_preview tool | `768` |
| `Screenshots:LocalPath` | Local path to save screenshots | `./Screenshots` |
| `Screenshots:OneDriveFolder` | OneDrive folder for screenshot upload | `CUA-Sessions` |
| `Screenshots:OneDriveUserId` | UPN/email to upload screenshots to a specific user's OneDrive (instead of token owner) | - |
| `BEARER_TOKEN` (env var) | MCP Platform token with `McpServers.W365ComputerUse.All` scope (dev only) | - |
| `GRAPH_TOKEN` (env var) | Graph API token with `Files.ReadWrite` scope for OneDrive upload (dev only) | - |

## Supported Models

| Model | Tool Type | Config | Notes |
|-------|-----------|--------|-------|
| `computer-use-preview` | `computer_use_preview` | `DeploymentName: "computer-use-preview"` | Uses `display_width`, `display_height`, `environment` params |
| `gpt-5.4` / `gpt-5.4-mini` | `computer` | `ModelName: "gpt-5.4-mini"` | Bare `{"type": "computer"}`. Initial screenshot sent with first message |

The tool type is auto-derived from the model name (`gpt-*` -> `computer`, otherwise -> `computer_use_preview`).

## How It Works

1. **User sends a message** -> `MyAgent.OnMessageAsync`
2. **MCP connection** established (direct SSE in dev, A365 SDK gateway in prod)
3. **QuickStartSession** provisions a W365 Cloud PC (once per app lifetime, reused across messages)
4. **CUA loop** in `ComputerUseOrchestrator.RunAsync`:
   - User message + conversation history sent to the model
   - Model returns `computer_call` actions (click, type, scroll, etc.)
   - Actions translated to MCP tool calls (`W365_Click2`, `W365_WriteText`, etc.)
   - Screenshot captured after each action and fed back to the model
   - Loop continues until model calls `OnTaskComplete` or max iterations reached
5. **Response** sent back to user
6. **Session persists** across messages for follow-up tasks
7. **EndSession** called on app shutdown (Ctrl+C) to release the VM

## Session Management

- Sessions are started **once** on the first message and reused across all subsequent messages
- Conversation history accumulates across messages, giving the model context for follow-up tasks
- On app shutdown (`Ctrl+C`), the agent calls `EndSession` to release the VM back to the pool
- If the app crashes, sessions auto-expire after ~30 minutes on the W365 backend

## Production Deployment

1. Register an Azure Bot and configure the agent
2. Set `AIServices` config with your Azure OpenAI credentials
3. Remove `McpServer:Url` - the A365 SDK will discover the MCP server via the Tooling Gateway
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