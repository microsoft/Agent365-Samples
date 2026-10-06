# Devin Sample Agent - Python

This sample demonstrates how to build an agent using Devin AI in Python with the Microsoft Agent 365 SDK. It covers:

- **Observability**: End-to-end tracing, caching, and monitoring for agent applications
- **Notifications**: Services and models for managing user notifications
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for Python](https://github.com/microsoft/Agent365-python) and the official [Devin SDK (`devinai`)](https://pypi.org/project/devinai/) for Python.

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

---

## Prerequisites

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) package manager (recommended) or pip
- Devin API credentials (API key + Org ID from [app.devin.ai/settings](https://app.devin.ai/settings))
- Microsoft Agent 365 SDK credentials (for production / agentic auth)
- [Node.js](https://nodejs.org/) (for Agents Playground)

---

## Quick Start — Local Development

### 1. Clone and set up the environment

```bash
cd python/devin/sample-agent

# Create virtual environment and install dependencies
uv venv
uv pip install -e .

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
DEVIN_SDK_API_KEY=<your-devin-api-key>
DEVIN_ORG_ID=<your-devin-org-id>
AUTH_HANDLER_NAME=              # leave empty for Playground/local dev
```

> **Note**: `AUTH_HANDLER_NAME` must be **empty** for Agents Playground. Setting it to `AGENTIC` requires a real AAD token that Playground does not provide.

### 3. Initialize A365 configuration

The fastest way is the **AI-guided setup** — attach the instruction file to GitHub Copilot Chat (agent mode) and it walks you through every step automatically:

```
Follow the steps in #file:a365-setup-instructions.md
```

> See [AI-guided setup for Agent 365](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/ai-guided-setup) for full instructions.

Alternatively, run the CLI manually:

```bash
# Config-free setup (no a365.config.json needed)
a365 setup all --agent-name "MyDevinAgent" --aiteammate

# Or with a config file
a365 config init
a365 setup all
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
================================================================================
Devin Sample Agent (Python)
================================================================================
Auth: Anonymous
Server: localhost:3978
Endpoint: http://localhost:3978/api/messages
Health:   http://localhost:3978/api/health
```

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

### Testing checklist

| Test | How |
|------|-----|
| Basic message | Send any text message in the Playground chat |
| Install/uninstall | Agents Playground → Mock an Activity → Install application |
| Typing indicator | Send a message — you should see "Got it — working on it…" then "..." animation |
| User identity | Check server logs for `Turn received from user — DisplayName:` |
| Email notification | Agents Playground → Mock an Activity → Trigger Notification Activity → Send email |

### Expected Playground behavior

1. You send a message
2. Agent immediately replies: **"Got it — working on it…"**
3. Typing indicator (`...`) appears while Devin processes
4. Agent sends the final response from Devin

---

## Working with User Identity

On every incoming message, the A365 platform populates `activity.from_property` with basic user information — always available with no API calls or token acquisition:

| Field | Description |
|---|---|
| `activity.from_property.id` | Channel-specific user ID (e.g., `29:1AbcXyz...` in Teams) |
| `activity.from_property.name` | Display name as known to the channel |
| `activity.from_property.aad_object_id` | Azure AD Object ID — use this to call Microsoft Graph |

The sample logs these fields at the start of every message turn.

---

## Handling Agent Install and Uninstall

When a user installs (hires) or uninstalls (removes) the agent, the A365 platform sends an `InstallationUpdate` activity. The sample handles this in `on_installation_update` in `main.py`:

| Action | Description |
|---|---|
| `add` | Agent was installed — send a welcome message |
| `remove` | Agent was uninstalled — send a farewell message |

To test with Agents Playground, use **Mock an Activity → Install application**.

---

## Sending Multiple Messages in Teams

Agent365 agents can send multiple discrete messages in response to a single user prompt. This is the recommended pattern for agentic identities in Teams.

> **Important**: Streaming (SSE) is not supported for agentic identities in Teams. Instead, call `send_activity` multiple times.

### Pattern

1. Send an immediate acknowledgment so the user knows work has started
2. Run a typing indicator loop — each indicator times out after ~5 seconds, so re-send every ~4 seconds
3. Do your LLM work, then send the response

### Typing Indicators

- Typing indicators show a progress animation in Teams
- They have a built-in ~5-second visual timeout — re-send every ~4 seconds for long operations
- Only visible in 1:1 chats and small group chats (not channels)

### Code Example

```python
# Multiple messages: send an immediate ack before the LLM work begins.
# Each send_activity call produces a discrete Teams message.
await context.send_activity("Got it — working on it…")

# Send typing indicator immediately.
await context.send_activity(Activity(type="typing"))

# Background loop refreshes the "..." animation every ~4s.
async def _typing_loop():
    try:
        while True:
            await asyncio.sleep(4)
            await context.send_activity(Activity(type="typing"))
    except asyncio.CancelledError:
        pass

typing_task = asyncio.create_task(_typing_loop())
try:
    response = await agent.process_user_message(...)
    await context.send_activity(response)
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

### Running the Agent

To set up and test this agent, refer to the [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing?tabs=python) guide for complete instructions.

### Deploying the Agent

Refer to the [Deploy and publish agents](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/publish-deploy-agent?tabs=python) guide for complete instructions.

---

## Configuration Reference

All configuration is via environment variables (`.env` for local, App Settings for Azure):

| Variable | Default | Description |
|----------|---------|-------------|
| `DEVIN_SDK_API_KEY` | — | **Required**. Devin API key |
| `DEVIN_ORG_ID` | — | **Required**. Devin organization ID |
| `DEVIN_BASE_URL` | `https://api.devin.ai/v1` | Override the Devin API base URL |
| `POLLING_INTERVAL_SECONDS` | `10` | How often to poll for Devin responses |
| `AUTH_HANDLER_NAME` | _(empty)_ | Empty = anonymous (Playground/local), `AGENTIC` = production |
| `AGENTIC_APP_ID` | — | Agent App ID from A365 portal |
| `AGENTIC_TENANT_ID` | — | Azure tenant ID |
| `AGENTIC_USER_ID` | — | Agent User ID from A365 portal |
| `A365_AGENT_APP_INSTANCE_ID` | — | Same as `AGENTIC_APP_ID` — for FIC observability auth |
| `A365_AGENTIC_USER_ID` | — | Same as `AGENTIC_USER_ID` — for FIC observability auth |
| `PORT` | `3978` | Server port (Azure sets this to `8000` automatically) |
| `ENABLE_OBSERVABILITY` | `true` | Enable OpenTelemetry tracing |
| `ENABLE_A365_OBSERVABILITY_EXPORTER` | `false` | Send traces to A365 backend (`true` for production) |
| `LOG_LEVEL` | `INFO` | Logging level (`DEBUG`, `INFO`, `WARNING`, `ERROR`) |

---

## Troubleshooting

### Agent not responding in Playground

**Symptom**: Messages sent, no response appears.

**Cause**: `AUTH_HANDLER_NAME=AGENTIC` is set. Playground does not provide a real AAD token, so the OBO exchange hangs.

**Fix**: Set `AUTH_HANDLER_NAME=` (empty) in `.env` for local/Playground testing.

---

### "Auth handler agentic not recognized or not configured"

**Cause**: Case mismatch — the SDK registers the handler as `AGENTIC` (uppercase from env var key `AGENTAPPLICATION__USERAUTHORIZATION__HANDLERS__AGENTIC__...`), but `AUTH_HANDLER_NAME` was set to lowercase `agentic`.

**Fix**: Set `AUTH_HANDLER_NAME=AGENTIC` (uppercase).

---

### "consent_required" error from Teams

**Cause**: Delegated permissions not granted on the blueprint or agent identity.

**Fix**: Run `a365 setup permissions mcp`, `a365 setup permissions bot`, and grant Microsoft Graph permissions via `a365 setup permissions custom` or PowerShell:

```powershell
Connect-MgGraph -TenantId "<tenant-id>" -Scopes "DelegatedPermissionGrant.ReadWrite.All"
$bp = Get-MgServicePrincipal -Filter "appId eq '<blueprint-id>'"
$graph = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"
Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/oauth2PermissionGrants" `
  -Body (@{clientId=$bp.Id; consentType="AllPrincipals"; resourceId=$graph.Id; scope="Mail.ReadWrite Mail.Send Chat.ReadWrite User.Read.All"} | ConvertTo-Json) `
  -ContentType "application/json"
```

---

### "FIC env vars not set" — observability exporter falls back to DefaultAzureCredential

**Cause**: `A365_AGENT_APP_INSTANCE_ID` and `A365_AGENTIC_USER_ID` not set in `.env`.

**Fix**: Set both to your agent identity values:

```env
A365_AGENT_APP_INSTANCE_ID=<your-agentic-app-id>
A365_AGENTIC_USER_ID=<your-agentic-user-id>
```

---

## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-python/issues) section
- **Documentation**: See the [Microsoft Agents 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: For security issues, please see [SECURITY.md](SECURITY.md)

---

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

---

## Additional Resources

- [Microsoft Agent 365 SDK - Python repository](https://github.com/microsoft/Agent365-python)
- [Microsoft 365 Agents SDK - Python repository](https://github.com/Microsoft/Agents-for-python)
- [Devin API documentation](https://docs.devin.ai/)
- [Devin SDK (PyPI)](https://pypi.org/project/devinai/)
- [Python API documentation](https://learn.microsoft.com/python/api/?view=m365-agents-sdk&preserve-view=true)
- [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing?tabs=python)
- [Deploy and publish agents](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/publish-deploy-agent?tabs=python)

---

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](../../../LICENSE.md) file for details.
