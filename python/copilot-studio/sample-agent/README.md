# Copilot Studio Sample Agent - Python

This sample demonstrates how to bridge a **Microsoft Copilot Studio** low-code agent into the **Microsoft Agent 365** managed environment using the [Microsoft Agent 365 SDK for Python](https://github.com/microsoft/Agent365-python). Every message arriving through Agent 365 channels (Teams, email, etc.) is forwarded to your published Copilot Studio agent, and the response is relayed back — giving low-code agents access to enterprise identity, notifications, observability, and the full Agent 365 lifecycle.

This sample uses the [`microsoft-agents-copilotstudio-client`](https://pypi.org/project/microsoft-agents-copilotstudio-client/) package for Copilot Studio connectivity and the [`microsoft-opentelemetry`](https://pypi.org/project/microsoft-opentelemetry/) distro for end-to-end observability.

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Demonstrates

- **Copilot Studio Integration** — Forward messages to a published low-code Copilot Studio agent via `CopilotClient`
- **Notifications** — Handle email notifications from Agent 365 and return responses via `EmailResponse`
- **Observability** — End-to-end tracing with `InferenceScope`, `BaggageBuilder`, and `AgenticTokenCache`
- **Hosting Patterns** — Hosting with the Microsoft 365 Agents SDK (Python / aiohttp) including typing indicators and multiple-message patterns

## Prerequisites

- **Python 3.11+**
- **[uv](https://docs.astral.sh/uv/)** package manager (recommended) or pip
- **Microsoft Copilot Studio** access (Frontier preview program)
- A **published Copilot Studio agent** with authentication configured
- **Azure / Microsoft 365 tenant** with administrative permissions
- **Microsoft 365 Copilot license** (required to publish agents in Copilot Studio)
- **[Node.js](https://nodejs.org/)** (for Agents Playground)

## Copilot Studio Setup

Before running this sample you need a published Copilot Studio agent:

1. Go to [Copilot Studio](https://copilotstudio.microsoft.com/)
2. Create a new agent (or use an existing one)
3. Configure authentication: **Microsoft Entra ID** → **Require users to sign in**
4. Publish your agent
5. Go to **Settings → Advanced → Metadata** and copy:
   - **Environment ID**
   - **Schema Name** (agent identifier)
6. Alternatively, copy the **Direct Connect URL** from the agent's channel settings

## Required Setup Steps

### 1. Add CopilotStudio.Copilots.Invoke API Permission

The `CopilotStudio.Copilots.Invoke` scope must be added to your agent's blueprint. The fastest way is via the A365 CLI:

```bash
a365 setup permissions copilotstudio
```

Or manually in the Azure Portal:

1. Go to [Azure Portal](https://portal.azure.com/) → **Microsoft Entra ID** → **App registrations**
2. Select your agent's blueprint app registration
3. Go to **API permissions → Add a permission**
4. Select **APIs my organization uses** → search for **Power Platform API**
5. Add the `CopilotStudio.Copilots.Invoke` **delegated** permission
6. **Grant admin consent** for the permission

### 2. Grant User Access to the Copilot Studio Agent

Users must have access to chat with your Copilot Studio agent:

- **Option A: Organization-wide access** (used in this sample)
  1. Open your agent in Copilot Studio
  2. Click **…** (three dots) → **Share**
  3. Select the option to share with everyone in your organization

- **Option B: Security group access**
  1. Create a security group in Microsoft Entra ID
  2. Add users who need access to the group
  3. Share the agent with that security group in Copilot Studio

> **Note:** Individual users cannot be granted access directly — you must use security groups or organization-wide sharing. Authentication must be configured with Microsoft Entra ID and "Require users to sign in" enabled.

For more details, see [Share agents with other users](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-share-bots).

### 3. Microsoft 365 Copilot License Requirement

A Microsoft 365 Copilot license is required to publish agents in Copilot Studio. Ensure your tenant has the appropriate licensing before attempting to publish your agent.

## Quick Start — Local Development

### 1. Clone and set up the environment

```bash
cd python/copilot-studio/sample-agent

# Create virtual environment and install dependencies
uv venv
uv sync
```

### 2. Configure environment variables

Copy the template and fill in your values:

```bash
cp .env.template .env
```

Minimum required for local/Playground testing:

```env
ENVIRONMENT_ID=<your-environment-id>
AGENT_IDENTIFIER=<your-schema-name>
AUTH_HANDLER_NAME=              # leave empty for Playground/local dev
BEARER_TOKEN=<run: a365 develop get-token -o raw>
```

> **Note:** `AUTH_HANDLER_NAME` must be empty for Agents Playground. Setting it to `AGENTIC` requires a real AAD token that Playground does not provide.

### 3. Initialize A365 configuration

The fastest way is the AI-guided setup — attach the instruction file to GitHub Copilot Chat (agent mode) and it walks you through every step automatically:

```
Follow the steps in #file:a365-setup-instructions.md
```

> See [AI-guided setup for Agent 365](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/ai-guided-setup) for full instructions and to download `a365-setup-instructions.md`.

Alternatively, run the CLI manually:

```bash
a365 setup all --agent-name "<your-agent-name>" --aiteammate
```

### 4. Run the agent

```bash
# Activate the virtual environment
.venv/Scripts/activate          # Windows
source .venv/bin/activate       # Linux / macOS

# Start the server (listens on localhost:3978)
python main.py
```

You should see:

```
Copilot Studio Sample Agent (Python)
Auth: Anonymous
Server: localhost:3978
Endpoint: http://localhost:3978/api/messages
Health:   http://localhost:3978/api/health
```

### 5. Get a bearer token for Copilot Studio (required)

To authenticate with Copilot Studio locally without agentic auth, get a fresh token:

```bash
a365 develop get-token -o raw
```

Copy the output and set it in `.env`:

```env
BEARER_TOKEN=<paste token here>
```

The token expires in ~90 minutes.

## Testing with Agents Playground

The Agents Playground is a local testing tool that connects directly to your running agent — no tunnel or deployment required.

### Install

```bash
# Via npm (recommended)
npm install -g @microsoft/m365agentsplayground

# Or via winget (Windows)
winget install agentsplayground
```

### Run locally (anonymous mode)

1. Start your agent:

```bash
python main.py
```

2. In a separate terminal, launch the Playground:

```bash
agentsplayground -e "http://localhost:3978/api/messages" -c "emulator"
```

3. The Playground opens in your browser — start chatting with your agent.

### Run with authentication

```bash
agentsplayground -e "http://localhost:3978/api/messages" -c "emulator" \
  --client-id "<your-client-id>" \
  --client-secret "<your-client-secret>" \
  --tenant-id "<your-tenant-id>"
```

### Testing checklist

| Test | How |
|---|---|
| Basic message | Send any text message in the Playground chat |
| Install/uninstall | Agents Playground → Mock an Activity → Install application |
| Typing indicator | Send a message — you should see "Got it — working on it…" then "..." animation |
| Health endpoint | Navigate to `http://localhost:3978/api/health` |
| User identity | Check server logs for `Turn received from user — DisplayName:` |

## Deploying to Production

### Full lifecycle with A365 CLI

```bash
# 1. Provision all cloud resources, blueprint, and permissions
a365 setup all --agent-name "<your-agent-name>" --aiteammate

# 2. Add Copilot Studio permission (if not done during setup)
a365 setup permissions copilotstudio

# 3. Publish agent — creates manifest package for upload to M365 Admin Center
a365 publish --agent-name "<your-agent-name>" --aiteammate
```

### Running on Azure App Service

See [Deploy agent to Azure](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/deploy-agent-azure?tabs=dotnet) for full instructions.

Deploy using Azure CLI:

```bash
# Create the App Service (first time only)
az webapp create \
  --name <your-app-name> \
  --resource-group <your-resource-group> \
  --runtime "PYTHON:3.13" \
  --sku B1

# Set the startup command
az webapp config set \
  --name <your-app-name> \
  --resource-group <your-resource-group> \
  --startup-file "python main.py"

# Set Application Settings (see table below)
az webapp config appsettings set \
  --name <your-app-name> \
  --resource-group <your-resource-group> \
  --settings AUTH_HANDLER_NAME=AGENTIC ENABLE_OBSERVABILITY=true ...

# Deploy code via zip deploy
az webapp deploy \
  --name <your-app-name> \
  --resource-group <your-resource-group> \
  --src-path deploy.zip
```

> **Port:** Azure App Service injects `PORT=8000` automatically. The app reads it from the environment — do not hardcode `3978` in any startup command.

### Configure Application Settings

The `.env` file is not deployed. Set all variables as Azure App Service Application Settings.

All values below come from `a365.config.json` and `a365.generated.config.json` (produced by `a365 setup all`). Run `a365 config display -g` to view the decrypted generated values.

| Setting | Source | Example |
|---|---|---|
| `ENVIRONMENT_ID` | Copilot Studio → Metadata | `Default-xxxxxxxx-...` |
| `AGENT_IDENTIFIER` | Copilot Studio → Metadata | `cr0b4_YourAgent` |
| `CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID` | `a365.generated.config.json` → `agentBlueprintId` | Blueprint App ID |
| `CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTSECRET` | `a365.generated.config.json` → `agentBlueprintClientSecret` | Blueprint client secret |
| `CONNECTIONS__SERVICE_CONNECTION__SETTINGS__TENANTID` | `a365.config.json` → `tenantId` | Azure tenant ID |
| `CONNECTIONS__SERVICE_CONNECTION__SETTINGS__SCOPES` | — | `5a807f24-c9de-44ee-a3a7-329e88a00ffc/.default` |
| `AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__SETTINGS__TYPE` | — | `AgenticUserAuthorization` |
| `AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__SETTINGS__ALT_BLUEPRINT_NAME` | — | `SERVICE_CONNECTION` |
| `AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__SETTINGS__SCOPES` | — | `https://graph.microsoft.com/.default` |
| `AUTH_HANDLER_NAME` | — | `AGENTIC` |
| `CLIENT_ID` | `a365.generated.config.json` → `agentBlueprintId` | Blueprint App ID |
| `TENANT_ID` | `a365.config.json` → `tenantId` | Azure tenant ID |
| `CLIENT_SECRET` | `a365.generated.config.json` → `agentBlueprintClientSecret` | Blueprint client secret |
| `AGENTIC_TENANT_ID` | `a365.config.json` → `tenantId` | Azure tenant ID |
| `ENABLE_OBSERVABILITY` | — | `true` |
| `ENABLE_A365_OBSERVABILITY_EXPORTER` | — | `true` |

### Messaging endpoint reference

See [Configure messaging endpoint](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/agent-messaging-endpoint) for all hosting options.

| Platform | Endpoint | needDeployment |
|---|---|---|
| Azure App Service | `https://<app>.azurewebsites.net/api/messages` | `true` |
| Dev Tunnel (local) | `https://<id>.devtunnels.ms:3978/api/messages` | `false` |

## After Publishing — Post-Deployment Steps

After `a365 setup all` and `a365 publish` complete, and the code is deployed to Azure App Service, the following steps require browser interaction and cannot be automated by the CLI.

### Step 1: Configure in Teams Developer Portal

1. Get your blueprint App ID:

```bash
a365 config display -g
```

Copy the `agentBlueprintId` value from the output.

2. Open your blueprint configuration page:

```
https://dev.teams.microsoft.com/tools/agent-blueprint/<blueprint-id>/configuration
```

3. Set Agent Type to `Bot Based`
4. Set Bot ID to your `agentBlueprintId`
5. Click Save

> See [Configure agent in Teams Developer Portal](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/create-instance#1-configure-agent-in-teams-developer-portal) and [Publish agent](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/publish) for full instructions.

### Step 2: Upload manifest to M365 Admin Center

1. Go to [https://admin.microsoft.com](https://admin.microsoft.com) > Agents > All agents > Upload custom agent
2. Upload `manifest/manifest.zip` (created by `a365 publish`)

### Step 3: Create agent instance

1. In Microsoft Teams, go to Apps and search for your agent name
2. Select your agent and click Request Instance
3. A tenant admin must approve the request at:
```
https://admin.cloud.microsoft/#/agents/all/requested
```

### Step 4: Verify the deployed endpoint

After the instance is approved, send a message to the agent from Teams. Check the App Service logs for:

```text
Observability identity — agent_id: '<agentic-app-id>', tenant_id: '<tenant-id>', source: activity.recipient
Exporting 1 spans to endpoint: https://agent365.svc.cloud.microsoft/...
HTTP 200 success ... rejectedSpans: 0
```

The sample reads agent and tenant identity from the incoming `TurnContext` activity at runtime. No static `AGENTIC_USER_ID` setting is required for observability export.

## Configuration Reference

All configuration is via environment variables (`.env` for local, App Settings for Azure):

| Variable | Default | Description |
|---|---|---|
| `DIRECT_CONNECT_URL` | _(none)_ | Copilot Studio Direct Connect URL (alternative to Environment ID + Agent Identifier) |
| `ENVIRONMENT_ID` | _(required)_ | Copilot Studio Environment ID |
| `AGENT_IDENTIFIER` | _(required)_ | Copilot Studio Schema Name |
| `AUTH_HANDLER_NAME` | _(empty)_ | Empty = anonymous (Playground/local), `AGENTIC` = production |
| `BEARER_TOKEN` | _(none)_ | Token for local dev without agentic auth. Get with `a365 develop get-token -o raw` |
| `AGENTIC_TENANT_ID` | _(from activity)_ | Azure tenant ID (fallback for Playground) |
| `CLIENT_ID` / `TENANT_ID` / `CLIENT_SECRET` | _(required for production)_ | JWT validation credentials for incoming Bot Framework traffic |
| `CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID` / `CLIENTSECRET` / `TENANTID` | _(required for production)_ | Service connection used by the Agent 365 SDK |
| `AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__SETTINGS__TYPE` | `AgenticUserAuthorization` | Configures the agentic OBO auth handler |
| `AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__SETTINGS__ALT_BLUEPRINT_NAME` | `SERVICE_CONNECTION` | Service connection name used for agentic auth |
| `AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__SETTINGS__SCOPES` | `https://graph.microsoft.com/.default` | Default user auth scopes for the handler |
| `ENABLE_OBSERVABILITY` | `true` | Enable OpenTelemetry tracing |
| `ENABLE_A365_OBSERVABILITY_EXPORTER` | `false` | Send traces to A365 backend (`true` for production) |
| `ENABLE_KAIRO_EXPORTER` | `false` | Enables the Kairo exporter when supported by the environment |
| `PORT` | `3978` | Server port (Azure sets this to 8000 automatically) |

## Working with User Identity

On every incoming message, the A365 platform populates `activity.from_property` with basic user information — always available with no API calls or token acquisition:

| Field | Description |
|---|---|
| `activity.from_property.id` | Channel-specific user ID (e.g., `29:1AbcXyz...` in Teams) |
| `activity.from_property.name` | Display name as known to the channel |
| `activity.from_property.aad_object_id` | Azure AD Object ID — use this to call Microsoft Graph |

The sample logs these fields at the start of every message turn in `agent.py`.

## Handling Agent Install and Uninstall

When a user installs (hires) or uninstalls (removes) the agent, the A365 platform sends an `InstallationUpdate` activity. The sample handles this in `on_installation_update` in `main.py`:

| Action | Behavior |
|---|---|
| `add` | Agent was installed — send a welcome message |
| `remove` | Agent was uninstalled — send a farewell message |

To test with Agents Playground, use Mock an Activity → Install application to send a simulated `installationUpdate` activity.

## Sending Multiple Messages in Teams

Agent365 agents can send multiple discrete messages in response to a single user prompt. This is the recommended pattern for agentic identities in Teams.

> **Important:** Streaming (SSE) is not supported for agentic identities in Teams. Instead, call `send_activity` multiple times.

### Pattern

1. Send an immediate acknowledgment so the user knows work has started
2. Run a typing indicator loop — each indicator times out after ~5 seconds, so re-send every ~4 seconds
3. Do your LLM work, then send the response

### Code Example

```python
# Multiple messages: send an immediate ack before the LLM work begins.
# Each send_activity call produces a discrete Teams message.
await context.send_activity("Got it — working on it…")

# Send typing indicator immediately (awaited so it arrives before the LLM call starts).
await context.send_activity(Activity(type="typing"))

# Background loop refreshes the "..." animation every ~4s (it times out after ~5s).
# asyncio.create_task is used because all aiohttp handlers share the same event loop.
async def _typing_loop():
    while True:
        try:
            await asyncio.sleep(4)
            await context.send_activity(Activity(type="typing"))
        except asyncio.CancelledError:
            break

typing_task = asyncio.create_task(_typing_loop())
try:
    response = await agent.process_user_message(user_message, ...)
    await context.send_activity(response)
finally:
    typing_task.cancel()
    try:
        await typing_task
    except asyncio.CancelledError:
        pass
```

### Typing Indicators

- Typing indicators show a progress animation in Teams
- They have a built-in ~5-second visual timeout — re-send every ~4 seconds for long operations
- Only visible in 1:1 chats and small group chats (not channels)

## Architecture

### File Structure

```
sample-agent/
├── main.py                 # Server entry point — CopilotStudioAgentHost, handlers, observability
├── agent.py                # MyAgent — message/notification routing logic
├── client.py               # McsClient — CopilotClient wrapper with InferenceScope
├── .env.template           # Environment variable template
├── pyproject.toml          # Project metadata and dependencies
├── requirements.txt        # Pip-compatible dependency list (for Azure Oryx build)
├── ToolingManifest.json    # A365 tooling manifest (empty — proxies to Copilot Studio)
└── docs/
    └── design.md           # Detailed design document
```

### Message Flow

```
User ──▶ Agent 365 SDK ──▶ main.py (CopilotStudioAgentHost)
                                 │
                                 ├─▶ agent.py (MyAgent.process_user_message)
                                 │        │
                                 │        └─▶ client.py (get_client → McsClient)
                                 │                 │
                                 │                 └─▶ CopilotClient ──▶ Copilot Studio API
                                 │                           ◀── response ──┘
                                 │        ◀── response ──┘
                                 ◀── send_activity ──┘
User ◀──
```

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|---|---|---|
| `403 Forbidden` from Copilot Studio | Missing permission or user access | Run `a365 setup permissions copilotstudio` and share the agent org-wide |
| `Auth handler AGENTIC not recognized` | Auth handler name case mismatch | Ensure `AUTH_HANDLER_NAME=AGENTIC` (uppercase) matches `AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__...` |
| `No auth handler and no BEARER_TOKEN` | Anonymous mode with no fallback | Set `AUTH_HANDLER_NAME=AGENTIC` for production, or provide `BEARER_TOKEN` for local dev |
| Agent not responding in Playground | `AUTH_HANDLER_NAME=AGENTIC` is set | Clear `AUTH_HANDLER_NAME` for Playground — it doesn't provide a real AAD token |
| Observability export 400 "Tenant id is invalid" | Missing `BaggageBuilder` context | Ensure `AGENTIC_TENANT_ID` is set as a fallback for Playground |
| `ConnectionSettings` validation error | Neither `DIRECT_CONNECT_URL` nor `ENVIRONMENT_ID`+`AGENT_IDENTIFIER` set | Set one of the two options in `.env` |
| Azure container startup timeout (230s) | Wrong port | `main.py` reads `PORT` from env — Azure sets `PORT=8000` automatically |
| `No response from Copilot Studio agent` | Agent not published | Publish your agent in Copilot Studio and verify the Schema Name |

### Checking Logs

Enable debug logging for the observability exporter to verify telemetry is flowing:

```
INFO  microsoft.opentelemetry...agent365_exporter: Exporting 1 spans to endpoint: https://agent365.svc.cloud.microsoft/...
DEBUG microsoft.opentelemetry...agent365_exporter: HTTP 200 success. Response: {"partialSuccess":{"rejectedSpans":0}}
```

For a detailed explanation of the agent code and implementation, see the [Design Document](docs/design.md).

## Support

For issues, questions, or feedback:

- **Issues:** Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-Samples/issues) section
- **Documentation:** See the [Microsoft Agent 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Copilot Studio:** See [Copilot Studio documentation](https://learn.microsoft.com/en-us/microsoft-copilot-studio/)
- **Security:** For security issues, please see [SECURITY.md](../../../../SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit [https://cla.opensource.microsoft.com](https://cla.opensource.microsoft.com/).

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 SDK — Python repository](https://github.com/microsoft/Agent365-python)
- [Microsoft 365 Agents SDK — Python repository](https://github.com/Microsoft/Agents-for-python)
- [`microsoft-agents-copilotstudio-client` on PyPI](https://pypi.org/project/microsoft-agents-copilotstudio-client/)
- [Copilot Studio documentation](https://learn.microsoft.com/en-us/microsoft-copilot-studio/)
- [Configure messaging endpoint](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/agent-messaging-endpoint)
- [Deploy agent to Azure](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/deploy-agent-azure?tabs=dotnet)
- [Publish agent](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/publish)
- [Configure agent in Teams Developer Portal](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/create-instance#1-configure-agent-in-teams-developer-portal)
- [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing?tabs=python)
- [Test your agent locally in Agents Playground](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/test-with-toolkit-project)
- [Python API documentation](https://learn.microsoft.com/python/api/?view=m365-agents-sdk&preserve-view=true)
- [Share agents with other users](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-share-bots)

## Trademarks

Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at [http://go.microsoft.com/fwlink/?LinkID=254653](http://go.microsoft.com/fwlink/?LinkID=254653).

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](../../../../LICENSE.md) file for details.
