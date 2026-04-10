# LangChain Sample Agent - Python

This sample demonstrates how to build an agent using LangChain in Python with the Microsoft Agent 365 SDK. It covers:

- **Observability**: End-to-end tracing, caching, and monitoring for agent applications
- **Notifications**: Services and models for managing user notifications
- **Tools**: Model Context Protocol tools for building advanced agent solutions
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for Python](https://github.com/microsoft/Agent365-python).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

---

## Prerequisites

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) package manager (recommended) or pip
- Azure OpenAI or OpenAI API credentials
- Microsoft Agent 365 SDK credentials (for production / MCP tools)
- [Node.js](https://nodejs.org/) (only if installing Agents Playground via npm; not needed if using winget)

---

## Quick Start — Local Development

### 1. Clone and set up the environment

```bash
cd python/langchain/sample-agent

# Create virtual environment and install dependencies
uv venv
uv sync

# Bootstrap pip (required by the a365 CLI and some tools)
.venv/Scripts/python.exe -m ensurepip --upgrade   # Windows
.venv/bin/python -m ensurepip --upgrade            # Linux / macOS
```

### 2. Configure environment variables

Copy the template and fill in your values:

```bash
cp .env.template .env
```

Minimum required for local/Playground testing:

```env
AZURE_OPENAI_API_KEY=<your-azure-openai-api-key>
AZURE_OPENAI_ENDPOINT=<your-azure-openai-endpoint>
AZURE_OPENAI_DEPLOYMENT=gpt-4o
AZURE_OPENAI_API_VERSION=2024-12-01-preview
AUTH_HANDLER_NAME=              # leave empty for Playground/local dev
```

Or, if using OpenAI directly:

```env
OPENAI_API_KEY=<your-openai-api-key>
OPENAI_MODEL=gpt-4o
AUTH_HANDLER_NAME=              # leave empty for Playground/local dev
```

> **Note**: `AUTH_HANDLER_NAME` must be **empty** for Agents Playground. Setting it to `AGENTIC` requires a real AAD token that Playground does not provide.

### 3. Initialize A365 configuration

The fastest way is the **AI-guided setup** — attach the instruction file to GitHub Copilot Chat (agent mode) and it walks you through every step automatically:

```
Follow the steps in #file:a365-setup-instructions.md
```

> See [AI-guided setup for Agent 365](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/ai-guided-setup) for full instructions and to download `a365-setup-instructions.md`.

Alternatively, run the CLI manually:

```bash
a365 config init
```

This creates `a365.config.json` with your agent configuration.

You can also run `a365 setup all` to provision all cloud resources in one step. After setup completes, `a365.config.json` will include your `messagingEndpoint`. For local dev or self-hosted servers (GCP, AWS), set `"needDeployment": false` to tell the CLI not to deploy to Azure:

```json
{
  "messagingEndpoint": "https://<your-tunnel-or-server-url>/api/messages",
  "needDeployment": false
}
```

> `"needDeployment": false` — **I host my own server; don't deploy to Azure.** Use this for local dev tunnels, GCP Cloud Run, AWS, or any non-Azure hosting.
>
> `"needDeployment": true` — **Deploy my code to Azure App Service.** Use this when you want `a365 deploy` to package and upload your agent.

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
INFO  main: Listening on localhost:3978/api/messages
INFO  main: No auth handler configured — anonymous mode (Playground/local dev)
INFO  main: No token and no auth handler — skipping MCP tools, running bare LLM
```

### 5. Get a bearer token for MCP tools (optional)

To enable MCP tool access locally, get a fresh token using the A365 CLI:

```bash
a365 develop get-token -o raw
```

Copy the output and set it in `.env`:

```env
BEARER_TOKEN=<paste token here>
```

The token expires in ~90 minutes. The agent detects expiry automatically and falls back to bare LLM mode.

---

## Configuration Reference

All configuration is via environment variables (`.env` for local, App Settings for Azure):

### LLM Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AZURE_OPENAI_API_KEY` | — | **Required** (Azure). Azure OpenAI API key |
| `AZURE_OPENAI_ENDPOINT` | — | **Required** (Azure). Azure OpenAI endpoint URL |
| `AZURE_OPENAI_DEPLOYMENT` | — | **Required** (Azure). Model deployment name (e.g. `gpt-4o`) |
| `AZURE_OPENAI_API_VERSION` | `2024-12-01-preview` | Azure OpenAI API version |
| `OPENAI_API_KEY` | — | **Required** (OpenAI). Used if Azure OpenAI is not configured |
| `OPENAI_MODEL` | `gpt-4o` | OpenAI model name |

### Service Connection (OAuth client credentials)

| Variable | Default | Description |
|----------|---------|-------------|
| `CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID` | — | Blueprint App ID from `a365.generated.config.json` → `agentBlueprintId` |
| `CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTSECRET` | — | Blueprint client secret. Use `a365 config display -g` to view decrypted value |
| `CONNECTIONS__SERVICE_CONNECTION__SETTINGS__TENANTID` | — | Azure tenant ID from `a365.config.json` → `tenantId` |
| `CONNECTIONS__SERVICE_CONNECTION__SETTINGS__SCOPES` | — | `5a807f24-c9de-44ee-a3a7-329e88a00ffc/.default` |
| `CONNECTIONSMAP__0__SERVICEURL` | — | `*` (do not change) |
| `CONNECTIONSMAP__0__CONNECTION` | — | `SERVICE_CONNECTION` (do not change) |

### Agentic Auth Handler

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__SETTINGS__TYPE` | — | `AgenticUserAuthorization` (do not change) |
| `AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__SETTINGS__SCOPES` | — | `https://graph.microsoft.com/.default` (do not change) |
| `AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__SETTINGS__ALTERNATEBLUEPRINTCONNECTIONNAME` | — | `https://graph.microsoft.com/.default` (do not change) |
| `AUTH_HANDLER_NAME` | _(empty)_ | Empty = anonymous (Playground/local), `AGENTIC` = production |
| `BEARER_TOKEN` | _(empty)_ | Token for MCP tool access. Get with `a365 develop get-token -o raw` |

### Server & Observability

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3978` | Server port (Azure sets this to `8000` automatically) |
| `ENABLE_OBSERVABILITY` | `true` | Enable OpenTelemetry tracing |
| `ENABLE_A365_OBSERVABILITY_EXPORTER` | `false` | Send traces to A365 backend (`true` for production) |
| `OBSERVABILITY_SERVICE_NAME` | `LangChainSampleAgent` | Service name for telemetry |
| `OBSERVABILITY_SERVICE_NAMESPACE` | `LangChainTesting` | Namespace for telemetry |
| `LOG_LEVEL` | `INFO` | Logging level (`DEBUG`, `INFO`, `WARNING`, `ERROR`) |

---

## Testing with Agents Playground

The Agents Playground is a local testing tool that connects directly to your running agent — **no tunnel or deployment required**.

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

### Key CLI options

| Option | Description |
|--------|-------------|
| `-e` | Agent endpoint (e.g. `http://localhost:3978/api/messages`) |
| `-c` | Channel type: `emulator`, `webchat`, or `msteams` |
| `--client-id` | Entra ID client ID (for auth mode) |
| `--client-secret` | Client secret (for auth mode) |
| `--tenant-id` | Tenant ID (for auth mode) |

Run `agentsplayground --help` for all options.

> For full setup documentation see [Test your agent locally in Agents Playground](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/test-with-toolkit-project).

### Testing checklist

| Test | How |
|------|-----|
| Basic message | Send any text message in the Playground chat |
| Install/uninstall | Agents Playground → Mock an Activity → Install application |
| Typing indicator | Send a message — you should see "Got it — working on it…" then "..." animation |
| MCP tools | Set `BEARER_TOKEN` in `.env` and restart — tools listed in server logs |
| User identity | Check server logs for `Turn received from user — DisplayName:` |

### Expected Playground behavior

1. You send a message
2. Agent immediately replies: **"Got it — working on it…"**
3. Typing indicator (`...`) appears while the LLM processes
4. Agent sends the final response

---

## Working with User Identity

On every incoming message, the A365 platform populates `activity.from_property` with basic user
information — always available with no API calls or token acquisition:

| Field | Description |
|---|---|
| `activity.from_property.id` | Channel-specific user ID (e.g., `29:1AbcXyz...` in Teams) |
| `activity.from_property.name` | Display name as known to the channel |
| `activity.from_property.aad_object_id` | Azure AD Object ID — use this to call Microsoft Graph |

The sample logs these fields at the start of every message turn and injects the display name
into the LLM system instructions for personalized responses.

---

## Handling Agent Install and Uninstall

When a user installs (hires) or uninstalls (removes) the agent, the A365 platform sends an `InstallationUpdate` activity — also referred to as the `agentInstanceCreated` event. The sample handles this in `on_installation_update` in `hosting.py`:

| Action | Description |
|---|---|
| `add` | Agent was installed — send a welcome message |
| `remove` | Agent was uninstalled — send a farewell message |

```python
if action == "add":
    await context.send_activity("Thank you for hiring me! Looking forward to assisting you in your professional journey!")
elif action == "remove":
    await context.send_activity("Thank you for your time, I enjoyed working with you.")
```

To test with Agents Playground, use **Mock an Activity → Install application** to send a simulated `installationUpdate` activity.

---

## Sending Multiple Messages in Teams

Agent365 agents can send multiple discrete messages in response to a single user prompt. This is the recommended pattern for agentic identities in Teams.

> **Important**: Streaming (SSE) is not supported for agentic identities in Teams. The SDK detects agentic identity and buffers streaming into a single message. Instead, call `send_activity` multiple times to send multiple messages.

### Pattern

1. Send an immediate acknowledgment so the user knows work has started
2. Run a typing indicator loop — each indicator times out after ~5 seconds, so re-send every ~4 seconds
3. Do your LLM work, then send the response

### Typing Indicators

- Typing indicators show a progress animation in Teams
- They have a built-in ~5-second visual timeout
- For long-running operations, re-send the typing indicator in a loop every ~4 seconds
- Typing indicators are only visible in 1:1 chats and small group chats (not channels)

### Code Example

```python
# Multiple messages: send an immediate ack before the LLM work begins.
await context.send_activity("Got it — working on it…")

# Send typing indicator immediately.
await context.send_activity(Activity(type="typing"))

# Background loop refreshes the "..." animation every ~4s.
async def _typing_loop():
    while True:
        try:
            await asyncio.sleep(4)
            await context.send_activity(Activity(type="typing"))
        except asyncio.CancelledError:
            break

typing_task = asyncio.create_task(_typing_loop())
try:
    response = await agent.invoke_agent_with_scope(
        message=user_message,
        auth=self.auth,
        auth_handler_name=self.auth_handler_name,
        context=context,
    )
    await context.send_activity(Activity(type=ActivityTypes.message, text=response))
except Exception as e:
    logger.error("Error processing message: %s", e)
    await context.send_activity(f"Sorry, I encountered an error: {str(e)}")
finally:
    typing_task.cancel()
    try:
        await typing_task
    except asyncio.CancelledError:
        pass
```

---

## Deploying to Production

### Full lifecycle with A365 CLI

```bash
# 1. Initialize config (first time only)
a365 config init

# 2. Provision all cloud resources and set up the blueprint
a365 setup all

# 3. Deploy agent code to Azure
a365 deploy

# 4. Publish agent to Microsoft 365 admin center
a365 publish
```

### Running on Azure App Service

See [Deploy agent to Azure](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/deploy-agent-azure?tabs=dotnet) for full instructions.

Set `messagingEndpoint` in `a365.config.json` to your Azure Web App URL and `"needDeployment": true` (see [configuration reference above](#3-initialize-a365-configuration)).

Set the Azure App Service **startup command** to:

```bash
python main.py
```

> **Port**: Azure App Service injects `PORT=8000` automatically. The app reads it from the environment — do not hardcode `3978` in any startup command.

### Configure Application Settings

The `.env` file is **not** deployed. Set all variables as Azure App Service Application Settings.

All values below come from `a365.config.json` and `a365.generated.config.json` (produced by `a365 setup all`). Run `a365 config display -g` to view the decrypted generated values.

| Key | Source | Value |
|-----|--------|-------|
| `AZURE_OPENAI_API_KEY` | Azure AI Studio / Azure Portal | Your Azure OpenAI API key |
| `AZURE_OPENAI_ENDPOINT` | Azure AI Studio / Azure Portal | Your Azure OpenAI endpoint |
| `AZURE_OPENAI_DEPLOYMENT` | — | `gpt-4o` |
| `AZURE_OPENAI_API_VERSION` | — | `2024-12-01-preview` |
| `CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID` | `a365.generated.config.json` → `agentBlueprintId` | Blueprint App ID |
| `CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTSECRET` | `a365.generated.config.json` → `agentBlueprintClientSecret` | Blueprint client secret |
| `CONNECTIONS__SERVICE_CONNECTION__SETTINGS__TENANTID` | `a365.config.json` → `tenantId` | Azure tenant ID |
| `CONNECTIONS__SERVICE_CONNECTION__SETTINGS__SCOPES` | — | `5a807f24-c9de-44ee-a3a7-329e88a00ffc/.default` |
| `AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__SETTINGS__TYPE` | — | `AgenticUserAuthorization` |
| `AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__SETTINGS__SCOPES` | — | `https://graph.microsoft.com/.default` |
| `AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__SETTINGS__ALTERNATEBLUEPRINTCONNECTIONNAME` | — | `https://graph.microsoft.com/.default` |
| `CONNECTIONSMAP__0__SERVICEURL` | — | `*` |
| `CONNECTIONSMAP__0__CONNECTION` | — | `SERVICE_CONNECTION` |
| `AUTH_HANDLER_NAME` | — | `AGENTIC` |
| `ENABLE_OBSERVABILITY` | — | `true` |
| `ENABLE_A365_OBSERVABILITY_EXPORTER` | — | `true` |
| `OBSERVABILITY_SERVICE_NAME` | — | `LangChainSampleAgent` |
| `OBSERVABILITY_SERVICE_NAMESPACE` | — | `LangChainTesting` |
| `LOG_LEVEL` | — | `INFO` |

> **Important**: Do **not** set `BEARER_TOKEN` in production. The `AUTH_HANDLER_NAME=AGENTIC` handler acquires tokens automatically via OBO flow from the user's AAD token.

### Messaging endpoint reference

See [Configure messaging endpoint](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/agent-messaging-endpoint) for all hosting options.

| Hosting | `messagingEndpoint` format | `needDeployment` |
|---------|--------------------------|-----------------|
| Azure App Service | `https://<app>.azurewebsites.net/api/messages` | `true` |
| AWS | `https://<api-gateway>.amazonaws.com/api/messages` | `false` |
| Dev Tunnel (local) | `https://<id>.devtunnels.ms:3978/api/messages` | `false` |

---

## After Publishing — Post-Deployment Steps

After `a365 deploy` and `a365 publish` complete, the following steps require browser interaction and cannot be automated by the CLI.

### Step 1: Configure in Teams Developer Portal

1. Open your blueprint configuration page:
   ```
   https://dev.teams.microsoft.com/tools/agent-blueprint/<blueprint-id>/configuration
   ```
   Replace `<blueprint-id>` with the `agentBlueprintId` from `a365.generated.config.json` (run `a365 config display -g` to view it).

2. Under **Configuration**, set the **Messaging Endpoint** to your deployed URL:
   ```
   https://<your-app>.azurewebsites.net/api/messages
   ```
3. Click **Save**

> See [Configure agent in Teams Developer Portal](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/create-instance#1-configure-agent-in-teams-developer-portal) and [Publish agent](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/publish) for full instructions.

### Step 2: Upload manifest to M365 Admin Center

1. Go to [https://admin.microsoft.com](https://admin.microsoft.com) > **Agents** > **All agents** > **Upload custom agent**
2. Upload `manifest/manifest.zip` (created by `a365 publish`)

### Step 3: Create agent instance

1. In Microsoft Teams, go to **Apps** and search for your agent name
2. Select your agent and click **Request Instance**
3. A tenant admin must approve the request at:
   ```
   https://admin.cloud.microsoft/#/agents/all/requested
   ```

### Step 4: Update AGENTIC_USER_ID after approval

Once the admin approves the agent instance, the agent user is created. Update `AGENTIC_USER_ID` in two places:

1. Find the value in `a365.generated.config.json` → `AgenticUserId`

2. Update `.env`:
   ```env
   AGENTIC_USER_ID=<AgenticUserId from a365.generated.config.json>
   ```

3. Update the Azure App Service Application Setting:
   ```bash
   az webapp config appsettings set \
     --name <your-webapp-name> \
     --resource-group <your-resource-group> \
     --settings AGENTIC_USER_ID=<AgenticUserId>
   ```

> **Note:** The agent user creation is asynchronous — it can take a few minutes to a few hours to become searchable in Teams after the instance is approved.

---

## Troubleshooting

### Agent not responding in Playground

**Symptom**: Messages sent, no response appears.

**Cause**: `AUTH_HANDLER_NAME=AGENTIC` is set. Playground does not provide a real AAD token, so the OBO exchange hangs and the handler never fires.

**Fix**: Set `AUTH_HANDLER_NAME=` (empty) in `.env` for local/Playground testing.

---

### "Retrieving agentic user token" in logs — agent hangs

**Cause**: Same as above — `AUTH_HANDLER_NAME=AGENTIC` with no valid AAD token.

**Fix**: Clear `AUTH_HANDLER_NAME` for Playground. For production with MCP tools, provide a fresh `BEARER_TOKEN`.

---

### `No MCP tools discovered` / bare LLM mode

**Cause**: Missing or expired `BEARER_TOKEN` and no auth handler configured.

**Fix**: Either refresh `BEARER_TOKEN` with `a365 develop get-token -o raw`, or set `AUTH_HANDLER_NAME=AGENTIC` for production (requires a real AAD token from Teams).

---

### "Failed to create MCP session" error

**Cause**: Expired or missing `BEARER_TOKEN` with no auth handler configured — the agent tries to connect to MCP servers with invalid credentials.

**Fix**: Either refresh `BEARER_TOKEN` with `a365 develop get-token -o raw`, or set `AUTH_HANDLER_NAME=` to skip MCP tools entirely and run in bare LLM mode.

---

### MCP tools timeout during startup

**Cause**: MCP server discovery and tool loading can take 10–20 seconds on first connection, especially with multiple servers.

**Fix**: The sample uses a 30-second timeout (configurable in `agent.py`). If tools still time out, check network connectivity to the MCP endpoint and verify the token is valid.

---

### Getting HTTP 201 instead of 202 from `/api/messages`

**Cause**: Python on Windows defaults to `WindowsProactorEventLoopPolicy`, which can break aiohttp socket writes. The `run_app()` call in `main.py` uses the correct event loop — no manual policy override needed.

**Fix**: Ensure you are using `run_app()` from aiohttp (not `asyncio.run()`). Do not override the event loop policy manually.

---

### Azure container startup timeout (230s)

**Cause**: Port hardcoded to `3978` — Azure App Service injects `PORT=8000` and the app binds to the wrong port.

**Fix**: Already handled in `main.py` — `port = int(os.getenv("PORT", 3978))`.

---

### `pip not found` during `a365 deploy`

**Cause**: `uv venv` / `uv sync` does not install pip by default.

**Fix**:
```bash
.venv/Scripts/python.exe -m ensurepip --upgrade   # Windows
.venv/bin/python -m ensurepip --upgrade            # Linux / macOS
```

Note: Re-run this after every `uv sync` as uv removes pip.

---

### Azure OpenAI 400 / 401 errors

| Error | Cause | Fix |
|-------|-------|-----|
| `400 BadRequest` | Azure AI Foundry `/v1` endpoint doesn't accept `api-version` parameter | The sample auto-detects `/v1` endpoints and uses `ChatOpenAI` instead of `AzureChatOpenAI` — verify your `AZURE_OPENAI_ENDPOINT` |
| `401 Unauthorized` | Invalid API key or endpoint mismatch | Verify `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_ENDPOINT` are correct |

---

### Logs to check

```
INFO  agent: Using Azure AI Foundry endpoint    # LLM provider detected
INFO  agent: MCP tools loaded: 35 tools         # MCP connected successfully
INFO  hosting: Turn received from user           # Message processing started
INFO  hosting: Got it — working on it…           # Acknowledgment sent
```

## Running the Agent

To set up and test this agent, refer to the [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing?tabs=python) guide for complete instructions.

## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-python/issues) section
- **Documentation**: See the [Microsoft Agents 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: For security issues, please see [SECURITY.md](/SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 SDK - Python repository](https://github.com/microsoft/Agent365-python)
- [Microsoft 365 Agents SDK - Python repository](https://github.com/Microsoft/Agents-for-python)
- [LangChain documentation](https://python.langchain.com/)
- [LangGraph documentation](https://langchain-ai.github.io/langgraph/)
- [Python API documentation](https://learn.microsoft.com/python/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](LICENSE.md) file for details.
