# GitHub Copilot Instructions — Procurement Agent

## Project Overview

This is the **Procurement A365 Agent** — a .NET 9 application that runs as a Microsoft 365 Agent (formerly Bot) deployed to Azure App Service. It uses Semantic Kernel for AI orchestration and connects to Microsoft Graph, MCP servers, and various plugins (SAP, Dataverse, SharePoint, Outlook, Teams, etc.).

- **Solution**: `ProcurementA365Agent.sln`
- **Framework**: .NET 9 / ASP.NET Core
- **AI Orchestration**: Semantic Kernel + Azure OpenAI (`gpt-4.1`)
- **Azure OpenAI Endpoint**: `https://slava-foundry-tip.openai.azure.com`
- **Azure Developer CLI template**: `procurement-agent-a365`

## Azure Resources

All resources are in the **`mvp-demo-rg`** resource group.

| Resource | Name | Type | Location |
|----------|------|------|----------|
| **Subscription** | `9735e1e7-32c7-4396-94e7-822e706eafd1` | — | — |
| **Resource Group** | `mvp-demo-rg` | — | `westus2` |
| **Tenant** | `9c23c1e3-15be-4744-a3d7-027089c33654` | — | — |
| **Web App** | `mvp-demo-app` | `Microsoft.Web/sites` (Linux) | `westus2` |
| **App Service Plan** | `mvp-demo-app-plan` | `Microsoft.Web/serverFarms` (Basic B2) | `westus2` |
| **Bot Service** | `mvp-demo-app-endpoint` | `Microsoft.BotService/botServices` | `global` |
| **Managed Identity** | `mvp-demo-identity` | `Microsoft.ManagedIdentity/userAssignedIdentities` | `westus2` |
| **Key Vault** | `mvp-demo-kv` | `Microsoft.KeyVault/vaults` | `westus2` |
| **Storage Account** | `mvpdemost6hfdwq` | `Microsoft.Storage/storageAccounts` (Standard_LRS, StorageV2) | `westus2` |
| **Log Analytics** | `mvp-demo-logs` | `Microsoft.OperationalInsights/workspaces` | `westus2` |
| **App Insights** | `mvp-demo-insights` | `Microsoft.Insights/components` | `westus2` |

### Key Identifiers

- **Web App hostname**: `mvp-demo-app.azurewebsites.net`
- **Bot messaging endpoint**: `https://mvp-demo-app.azurewebsites.net/api/messages`
- **Bot MSA App ID**: `ac0fe0ec-74ab-41b8-b4da-3373bee598d4`
- **Managed Identity Client ID**: `fbf5ac70-2d95-4d21-bd06-e03a8d2e7d3b`
- **Managed Identity Principal ID**: `6ccf07db-db26-4e63-adaa-a8b302159a95`
- **Client App ID** (from a365 config): `81673882-b0c0-4efe-ba47-c112f77d2cde`
- **Graph Read App ID**: `acd364d1-a73f-430a-88f6-a668817540f3`
- **Storage Table endpoint**: `https://mvpdemost6hfdwq.table.core.windows.net/`
- **Key Vault certificate name**: `HelloWorldServiceAuth`
- **Agent Blueprint Display Name**: `The Zava Procurement Agent`

## Project Structure

```
├── Program.cs                  # App startup, DI, middleware
├── ServiceUtilities.cs         # Shared service helpers
├── AgentLogic/                 # Core agent logic
│   ├── A365AgentApplication.cs # Main agent application class
│   ├── AgentConfiguration.cs   # Agent config model
│   ├── AgentInstructions.cs    # System prompts / instructions
│   ├── OpenAIAgentLogicService.cs
│   ├── SemanticKernel/         # Semantic Kernel agent logic service
│   ├── AuthCache/              # Auth token caching
│   └── Tools/                  # Custom tool definitions
├── Controllers/                # ASP.NET controllers
├── Plugins/                    # Semantic Kernel plugins
│   ├── DataversePlugin.cs
│   ├── FilePlugin.cs
│   ├── KasistoPlugin.cs
│   ├── OutlookPlugin.cs
│   ├── RelecloudPlugin.cs
│   ├── SAPPlugin.cs
│   ├── SharePointPlugin.cs
│   ├── TeamsPlugin.cs
│   └── UsersPlugin.cs
├── Mcp/                        # MCP (Model Context Protocol) integration
├── Models/                     # Data models
├── Services/                   # Service layer
├── NotificationService/        # Background notification processing
├── Capabilities/               # File reading, Excel, Teams formatting
├── infra/                      # Bicep IaC templates
├── manifest/                   # Agent manifest files
├── Evals/                      # Evaluation scenarios and tooling
└── Tests/                      # Unit / integration tests
```

## MCP Servers (Tooling Manifest)

The agent connects to these platform-provided MCP tool servers:
- SharePointTools
- mcp_OneDriveServer
- mcp_SearchTools
- mcp_CalendarTools
- mcp_Admin365_GraphTools
- mcp_TeamsServer
- mcp_KnowledgeTools
- MeMCPServer
- mcp_NLWeb
- mcp_MailTools

## Deployment

- **Build & Deploy script**: `deploy-to-webapp.ps1 -ResourceGroup mvp-demo-rg -WebAppName mvp-demo-app`
- **VS Code Task**: Use the **"Build and Deploy to Azure"** task (defined in `.vscode/tasks.json`) to build and deploy with a single command. It runs `deploy-to-webapp.ps1 -ResourceGroup mvp-demo-rg -WebAppName mvp-demo-app -CleanPublish` from the workspace root.
- **Infrastructure**: `infra/main.bicep` (subscription-scoped Bicep deployment)
- **Azure Developer CLI**: `azure.yaml` with `azd up`
- **Runtime**: .NET 9 on Linux App Service

## Coding Conventions

- Use C# 12 / .NET 9 features (file-scoped namespaces, primary constructors, etc.)
- Follow existing patterns in `Plugins/` for adding new Semantic Kernel plugins
- Agent instructions are maintained in `AgentLogic/AgentInstructions.cs`
- Configuration flows through `appsettings.json` → Azure Key Vault → environment
- Use `ILogger<T>` for structured logging throughout
- Infrastructure changes go in `infra/` Bicep modules
