# E2E Test Scripts

This folder contains PowerShell scripts used by the GitHub Actions E2E workflow to test agent samples.

## Scripts

| Script | Description |
|--------|-------------|
| [Acquire-BearerToken.ps1](Acquire-BearerToken.ps1) | Acquires a bearer token using ROPC flow for MCP authentication |
| [Generate-EnvConfig.ps1](Generate-EnvConfig.ps1) | Generates `.env` configuration files for Python/Node.js agents |
| [Generate-AppSettings.ps1](Generate-AppSettings.ps1) | Updates `appsettings.json` for .NET agents |
| [Start-Agent.ps1](Start-Agent.ps1) | Starts an agent and waits for health check |
| [Stop-AgentProcess.ps1](Stop-AgentProcess.ps1) | Stops agent processes and cleans up ports |
| [Capture-AgentLogs.ps1](Capture-AgentLogs.ps1) | Captures agent logs with secrets redacted |
| [Copy-ToolingManifest.ps1](Copy-ToolingManifest.ps1) | Creates ToolingManifest.json for MCP server configuration |

## MCP Authentication

MCP servers require **delegated (user) permissions**, not application permissions. This means:

- Client credentials flow (service principal) does **not** work
- ROPC (Resource Owner Password Credentials) flow is used with a test service account
- The test account should be excluded from MFA/Conditional Access

### Required Secrets

| Secret | Description |
|--------|-------------|
| `GH_PAT` | GitHub Personal Access Token with repo access to checkout E2E tests repository |
| `MCP_CLIENT_ID` | App registration client ID with MCP permissions (`0de5c94a-9929-45e1-a436-ffe5b3415df3`) |
| `MCP_TENANT_ID` | Azure AD tenant ID |
| `MCP_TEST_USERNAME` | Test service account UPN |
| `MCP_TEST_PASSWORD` | Test service account password |
| `TENANT_ID` | Common tenant ID for agent connections |

### Repository Variables (Optional)

| Variable | Description |
|----------|-------------|
| `E2E_TESTS_REPO` | Override the E2E tests repository (default: `microsoft/Agent365-E2EIntegration`) |

### Per-Sample Secrets

Each sample requires its own set of secrets:

**Python OpenAI (`PYTHON_OPENAI_*`):**
- `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`
- `AGENT_ID`, `CLIENT_SECRET`

**Node.js OpenAI (`NODEJS_OPENAI_*`):**
- `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`
- `AGENT_ID`, `CLIENT_SECRET`

**.NET Semantic Kernel (`DOTNET_SK_*`):**
- `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`
- `CLIENT_ID`, `CLIENT_SECRET`

**.NET Agent Framework (`DOTNET_AF_*`):**
- `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`
- `CLIENT_ID`, `CLIENT_SECRET`

## Environment Variable: ENVIRONMENT

Setting `ENVIRONMENT=Development` is **critical** for E2E tests. This tells the SDK to:

1. Read from local `ToolingManifest.json` instead of calling the cloud gateway
2. Use the `BEARER_TOKEN` environment variable for MCP authentication

Without this, the agent will try to call the cloud MCP gateway and fail.

## Usage

These scripts are designed to be called from GitHub Actions but can also be run locally for testing:

```powershell
# Acquire token
$token = ./Acquire-BearerToken.ps1 -ClientId $clientId -TenantId $tenantId -Username $user -Password $pass

# Generate .env
./Generate-EnvConfig.ps1 -OutputPath "./sample/.env" -BearerToken $token -Port 3979 -ConfigMappings @{ "API_KEY" = "xxx" }

# Start agent
$pid = ./Start-Agent.ps1 -AgentPath "./sample" -StartCommand "npm start" -Port 3979 -BearerToken $token -Runtime "nodejs"

# Stop agent
./Stop-AgentProcess.ps1 -AgentPID $pid -Port 3979
```
