# Semantic Kernel Sample Agent (Python)

This sample demonstrates how to build a production-ready Microsoft 365 agent using **Semantic Kernel** (Python) with the **Microsoft Agent 365 SDK**. It supports both **Azure OpenAI** and **OpenAI** as LLM providers and includes MCP tool integration, observability, authentication, and notification handling.

This sample uses the [Microsoft Agent 365 SDK for Python](https://github.com/microsoft/Agent365-python).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Demonstrates

- **Semantic Kernel ChatCompletionAgent** with automatic function calling
- **Dual LLM support**: Azure OpenAI _or_ OpenAI via API key — configurable via environment variable
- **MCP (Model Context Protocol)** tool integration — auto-discovered Mail/Calendar tools
- **Agent 365 Observability** — InvokeAgentScope, InferenceScope, ExecuteToolScope with token tracking
- **Agentic Authentication** — token exchange for Graph API, MCP, and observability
- **Notification handling** — email and Word comment notifications
- **User identity** — personalized responses using `activity.from_property`
- **Conversation continuity** — per-conversation ChatHistory across turns
- **Generic host pattern** — reusable hosting infrastructure compatible with Agents Playground

## Prerequisites

- Python 3.11 or later
- [uv](https://docs.astral.sh/uv/) package manager (recommended) or pip
- An Azure OpenAI resource **or** an OpenAI API key
- [A365 CLI](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/) — for agent deployment, token management, and configuration
- (Optional) [M365 Agents Toolkit VS Code Extension](https://marketplace.visualstudio.com/items?itemName=TeamsDevApp.ms-teams-vscode-extension) — for integrated development experience
- (Optional) Microsoft 365 Agent Blueprint for agentic auth and MCP tools

## Quick Start

### 1. Install dependencies

```bash
cd python/semantic-kernel/sample-agent
uv sync
```

Or with pip:

```bash
pip install -e .
```

### 2. Configure environment

```bash
cp .env.template .env
```

Edit `.env` and set your LLM credentials:

**Option A — Azure OpenAI:**

```env
USE_AZURE_OPENAI=true
AZURE_OPENAI_DEPLOYMENT_NAME=gpt-4o
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_API_KEY=your-key-here
```

**Option B — OpenAI:**

```env
USE_AZURE_OPENAI=false
OPENAI_MODEL_ID=gpt-4o
OPENAI_API_KEY=sk-your-key-here
```

### 3. Run the agent

```bash
uv run start_with_generic_host.py
```

Or:

```bash
python start_with_generic_host.py
```

The server starts on `http://localhost:3978/api/messages`.

### 4. Test with Agents Playground

Get a bearer token using the A365 CLI:

```bash
a365 develop get-token -o raw
```

Then configure `.env` for Playground mode:

```env
AUTH_HANDLER_NAME=
USE_AGENTIC_AUTH=false
BEARER_TOKEN=<paste token from above>
```

Restart the agent and connect the Agents Playground to `http://localhost:3978/api/messages`.

For detailed setup and testing instructions, see [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing).

## Project Structure

```
sample-agent/
├── agent.py                         # Semantic Kernel agent implementation
├── host_agent_server.py             # Generic hosting server (shared pattern)
├── start_with_generic_host.py       # Entry point
├── agent_interface.py               # Abstract base class for agents
├── mcp_tool_registration_service.py # MCP server discovery and SK plugin registration
├── observability_config.py          # Agent 365 observability initialization
├── turn_context_utils.py            # TurnContext utilities for observability
├── token_cache.py                   # In-memory token caching
├── local_authentication_options.py  # Environment-based auth configuration
├── ToolingManifest.json             # MCP server manifest (fallback)
├── .env.template                    # Environment variable reference
├── pyproject.toml                   # Python project configuration
└── README.md                        # This file
```

## Architecture

```
User Message
     │
     ▼
┌─────────────────────┐
│  Generic Agent Host  │  ← Microsoft Agents SDK (aiohttp)
│  host_agent_server   │  ← JWT auth, notifications, typing indicators
└─────────────────────┘
     │
     ▼
┌──────────────────────┐
│  SemanticKernelAgent │  ← agent.py
│  ┌────────────────┐  │
│  │ Semantic Kernel│  │  ← ChatCompletionAgent + FunctionChoiceBehavior.Auto()
│  │ ┌────────────┐ │  │
│  │ │ Azure AOAI │ │  │  ← or OpenAI (configurable)
│  │ └────────────┘ │  │
│  │ ┌────────────┐ │  │
│  │ │ MCP Plugins│ │  │  ← Mail, Calendar tools via MCP protocol
│  │ └────────────┘ │  │
│  └────────────────┘  │
│  ┌────────────────┐  │
│  │ Observability  │  │  ← InvokeAgentScope → InferenceScope → ExecuteToolScope
│  └────────────────┘  │
└──────────────────────┘
```

## Working with User Identity

On every incoming message, the A365 platform populates `activity.from_property` with basic user
information — always available with no API calls or token acquisition:

| Field                                    | Description                                                |
| ---------------------------------------- | ---------------------------------------------------------- |
| `activity.from_property.id`            | Channel-specific user ID (e.g.,`29:1AbcXyz...` in Teams) |
| `activity.from_property.name`          | Display name as known to the channel                       |
| `activity.from_property.aad_object_id` | Azure AD Object ID — use this to call Microsoft Graph     |

The sample logs these fields at the start of every message turn and injects the display name
into the LLM system instructions for personalized responses.

## Handling Agent Install and Uninstall

When a user installs (hires) or uninstalls (removes) the agent, the A365 platform sends an `InstallationUpdate` activity — also referred to as the `agentInstanceCreated` event. The sample handles this in `on_installation_update` in `host_agent_server.py`:

| Action     | Description                                      |
| ---------- | ------------------------------------------------ |
| `add`    | Agent was installed — send a welcome message    |
| `remove` | Agent was uninstalled — send a farewell message |

```python
if action == "add":
    await context.send_activity("Thank you for hiring me! Looking forward to assisting you in your professional journey!")
elif action == "remove":
    await context.send_activity("Thank you for your time, I enjoyed working with you.")
```

To test with Agents Playground, use **Mock an Activity → Install application** to send a simulated `installationUpdate` activity.

## Sending Multiple Messages and Typing Indicators

Agent365 agents can send multiple discrete messages in response to a single user prompt. This is the recommended pattern for agentic identities in Teams.

> **Important**: Streaming (SSE) is not supported for agentic identities in Teams. The SDK detects agentic identity and buffers streaming into a single message. Instead, call `send_activity` multiple times to send multiple messages.

### Pattern

1. Send an immediate acknowledgment so the user knows work has started
2. Run a typing indicator loop — each indicator times out after ~5 seconds, so re-send every ~4 seconds
3. Do your LLM work, then send the response

### Code Example

```python
# Multiple messages: send an immediate ack before the LLM work begins.
await context.send_activity("Got it — working on it…")

# Send typing indicator immediately.
await context.send_activity(Activity(type="typing"))

# Background loop refreshes the "..." animation every ~4s (it times out after ~5s).
async def _typing_loop():
    while True:
        try:
            await asyncio.sleep(4)
            await context.send_activity(Activity(type="typing"))
        except asyncio.CancelledError:
            break

typing_task = asyncio.create_task(_typing_loop())
try:
    response = await agent.process_user_message(user_message, auth, context, auth_handler_name)
    await context.send_activity(response)
finally:
    typing_task.cancel()
    try:
        await typing_task
    except asyncio.CancelledError:
        pass
```

## Notifications

The agent processes notification activities from the `agents` and `msteams` channels:

- **Email notifications**: Processes email content and responds
- **Word comment notifications**: Reads document context and responds to mentions

## MCP Tooling Integration

This sample supports MCP (Model Context Protocol) tools for extended capabilities like email, calendar, and other Microsoft 365 services.

### MCP Configuration

MCP servers are configured in `ToolingManifest.json`:

```json
{
  "mcpServers": [
    {
      "mcpServerName": "mcp_MailTools",
      "mcpServerUniqueName": "mcp_MailTools",
      "url": "https://agent365.svc.cloud.microsoft/agents/servers/mcp_MailTools",
      "scope": "McpServers.Mail.All",
      "audience": ""
    }
  ]
}
```

### MCP Authentication

MCP tools require proper Azure authentication:

- **Development**: Set `USE_AGENTIC_AUTH=false` with a valid `BEARER_TOKEN` for local testing
- **Production**: Set `USE_AGENTIC_AUTH=true` — uses token exchange with proper scopes via the Microsoft 365 Agents SDK

### Environment Variables for MCP

```env
ENVIRONMENT=Development          # "Development" allows BEARER_TOKEN for MCP auth
USE_AGENTIC_AUTH=false           # false = static bearer token, true = agentic token exchange
SKIP_TOOLING_ON_ERRORS=true      # Falls back to bare LLM mode if MCP tools fail
```

> **Note**: MCP server discovery first attempts SDK-based discovery. If no servers are returned, the agent falls back to `ToolingManifest.json` regardless of `ENVIRONMENT`.

## Authentication

Authentication is controlled by the `AUTH_HANDLER_NAME` environment variable:

| Value       | Mode       | Description                                                  |
| ----------- | ---------- | ------------------------------------------------------------ |
| _(empty)_ | Playground | No JWT auth — for local testing with Agents Playground      |
| `AGENTIC` | Production | Enables token exchange for Graph API, MCP, and observability |

Service-connection credentials (`CONNECTIONS__SERVICE_CONNECTION__SETTINGS__*`) remain available to the SDK regardless of auth mode.

## Observability

The agent uses the Agent 365 Observability SDK for production monitoring:

- **InvokeAgentScope**: Wraps the full user message processing
- **InferenceScope**: Tracks LLM calls (model, tokens, finish reasons)
- **ExecuteToolScope**: Tracks MCP tool invocations
- **BaggageBuilder**: Propagates tenant/agent context through all spans

Enable the A365 exporter for production:

```env
ENABLE_A365_OBSERVABILITY_EXPORTER=true
```

## Troubleshooting

| Issue                              | Solution                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `401 Unauthorized` in Playground | Set `AUTH_HANDLER_NAME=` (empty) and `USE_AGENTIC_AUTH=false`                              |
| MCP tools not loading              | Ensure `BEARER_TOKEN` is set and not expired. Refresh with `a365 develop get-token -o raw` |
| Slow first response                | MCP servers connect on first message. Subsequent messages reuse the connection                 |
| `Import could not be resolved`   | Run `uv sync` or `pip install -e .` to install all dependencies                            |
| Token exchange failures            | Verify `CONNECTIONS__SERVICE_CONNECTION__SETTINGS__*` credentials are correct                |

## Documentation

- **[Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)** — Complete setup, testing, and deployment guide
- **[Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing)** — Playground and dev tunnel testing instructions

## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-python/issues) section
- **Documentation**: See the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: See [SECURITY.md](../../../SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit [https://cla.opensource.microsoft.com](https://cla.opensource.microsoft.com).

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Resources

- [Semantic Kernel Python Documentation](https://learn.microsoft.com/semantic-kernel/)
- [Microsoft 365 Agents SDK](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/)
- [Microsoft Agent 365 Python SDK](https://github.com/microsoft/Agent365-python)
- [Agent365-Samples](https://github.com/microsoft/Agent365-Samples)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](../../../LICENSE.md) file for details.
