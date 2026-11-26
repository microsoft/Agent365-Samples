# Semantic Kernel Sample Agent (Python)

This sample demonstrates how to build a production-ready Microsoft 365 agent using **Semantic Kernel** (Python) with the **Microsoft Agent 365 SDK**. It supports both **Azure OpenAI** and **OpenAI** as LLM providers and includes MCP tool integration, observability, authentication, and notification handling.

This sample uses the [Microsoft Agent 365 SDK for Python](https://github.com/microsoft/Agent365-python).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Demonstrates

- **Semantic Kernel ChatCompletionAgent** with automatic function calling
- **Dual LLM support**: Azure OpenAI _or_ OpenAI via API key — configurable via environment variable
- **MCP (Model Context Protocol)** tool integration — auto-discovered Mail/Calendar tools
- **Agent 365 Observability** — invoke, inference, tool, and output spans with token tracking
- **Agentic Authentication** — delegated token exchange for Graph/MCP; app-only tokens for telemetry
- **Notification handling** — email and Word comment notifications
- **User identity** — personalized responses using `activity.from_property`
- **Conversation continuity** — identity-scoped, bounded chat history across turns
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
ENABLE_A365_OBSERVABILITY_EXPORTER=false
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
├── observability/app_token_resolver.py # App-only telemetry token acquisition/cache
├── tests/test_regressions.py         # Isolated regression checks
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
│  │ Observability  │  │  ← InvokeAgentScope → InferenceScope → execute_tool
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

At the start of each message turn, the sample logs only whether the caller object ID is
available, without printing these identity values. It injects the display name into the
LLM system instructions for personalized responses.

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

- **Email notifications**: Drafts a reply from untrusted email content with tools disabled; sender-authored instructions cannot authorize remote actions
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
      "scope": "Tools.ListInvoke.All",
      "audience": "16b1878d-62c7-4009-aa25-68989d63bbad",
      "publisher": "Microsoft"
    }
  ]
}
```

### MCP Authentication

MCP tools require proper Azure authentication:

- **Development**: Set `USE_AGENTIC_AUTH=false` with a valid `BEARER_TOKEN` for local testing
- **Production**: Set `USE_AGENTIC_AUTH=true` — uses token exchange with proper scopes via the Microsoft 365 Agents SDK

MCP connections belong to a single turn, not the process. Each turn clones the
kernel, discovers tools with the current authorization context, and closes its
plugins in `finally` (including failures/cancellation). This avoids sharing a
previous caller's token or retaining an expired Authorization header. Gateway
discovery receives the SDK authorization context, preserves per-server headers,
and exchanges a server-specific audience/scope token for manifest fallback.
Development static tokens are accepted only with `ENVIRONMENT=Development`;
optional `BEARER_TOKEN_<MCPSERVERNAME_UPPER>` overrides support per-server tokens.

### Environment Variables for MCP

```env
ENVIRONMENT=Development          # "Development" allows BEARER_TOKEN for MCP auth
USE_AGENTIC_AUTH=false           # false = static bearer token, true = agentic token exchange
SKIP_TOOLING_ON_ERRORS=false     # Explicitly opt in only during Development
```

> **Note**: MCP server discovery first attempts SDK-based discovery. If no servers are returned, the agent falls back to `ToolingManifest.json` regardless of `ENVIRONMENT`.

Connection and manual-registration failures propagate. Only Development with
`SKIP_TOOLING_ON_ERRORS=true` may continue without tools; partially registered
plugins are removed and their sessions closed. Production always fails the turn.
Manual fallback exposes each MCP input schema's properties and required fields
to Semantic Kernel rather than advertising a generic `kwargs` argument.

## Authentication

Authentication is controlled by the `AUTH_HANDLER_NAME` environment variable:

| Value       | Mode       | Description                                                  |
| ----------- | ---------- | ------------------------------------------------------------ |
| _(empty)_ | Playground | No JWT auth — for local testing with Agents Playground      |
| `AGENTIC` | Production | Requires valid service credentials and JWT validation; enables workload token exchange for Graph/MCP |

Service-connection credentials (`CONNECTIONS__SERVICE_CONNECTION__SETTINGS__*`) remain available to the SDK regardless of auth mode.
Missing or invalid production credentials stop startup instead of silently enabling
anonymous hosting. Shared clients and observability are closed in aiohttp's
`on_cleanup`, after active requests drain. Typing-indicator failures are logged
without turning a successfully delivered answer into an error.

History is partitioned by tenant, agent, caller, conversation, and tool-enabled
versus email-reply mode. The Semantic Kernel truncation reducer retains roughly
20 recent messages (with a five-message threshold and safe tool-call/result
boundaries); at most 100 histories are retained. The model-usage totals include
intermediate tool-selection completions, not only the final assistant reply.

## Observability

The agent uses the Agent 365 Observability SDK for production monitoring:

- **InvokeAgentScope**: Wraps the full user message processing
- **InferenceScope**: Tracks LLM calls (model, tokens, finish reasons)
- **execute_tool spans**: Semantic Kernel wraps actual MCP tool execution; a per-turn filter records arguments/results without creating duplicate spans
- **BaggageBuilder**: Propagates tenant/agent context through all spans
- **OutputScope**: Records the final response

Manual inference scopes are used for this sample. Overlapping OpenAI/framework
auto-instrumentation is disabled through the distro's supported instrumentation
options so one completion isn't counted twice. Native Semantic Kernel tool spans
remain enabled and receive blueprint, agent-user object ID, caller, and run metadata
through baggage. The agent-user object ID comes from `recipient.aad_object_id`;
`recipient.agentic_user_id` is recorded separately as the agent user's address.
When the channel doesn't supply a human IP, `client.address` uses `0.0.0.0`
(unknown), not the proxy address. Endpoint attributes identify the model service
and local invocation/tool-execution host.

The unified `microsoft-opentelemetry` distribution is initialized before LLM imports.
Telemetry uses the S2S transport with an **app-only token for the runtime agent identity**,
not the delegated token used for Graph or MCP. Each message/notification turn prefetches
the token using the existing hosting blueprint connection; the exporter reads the cache
synchronously. Tokens are checked for matching agent, tenant, audience, and expiry.
Token and failure caches each retain at most 256 identities and prune expired
entries. Best-effort prefetch has a ten-second deadline, three-second HTTP
timeouts, and a four-worker admission cap, so telemetry cannot indefinitely block
message processing or queue unlimited blocked workers. DNS/OS waits cannot be
forcibly interrupted, so their worker slots remain reserved until they finish.
The bounded hosting transport follows the installed MSAL hosting credential
configuration (SDK 1.9+); non-MSAL providers and Service Fabric managed identity
are not supported for telemetry and report acquisition failures without disabling
workload processing. Tooling 2.0+ supplies per-audience authorization context.
Offline replay is disabled during the migration from delegated telemetry.
The agent builds baggage around its scopes directly. The distro's baggage middleware
is not registered: in `microsoft-opentelemetry` 1.6.0 it calls the next handler without
the context argument required by the hosting SDK 1.9.0.

Configure `CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID`, `CLIENTSECRET`,
and `TENANTID` using the blueprint credentials. An encrypted secret in
`a365.generated.config.json` is not a plaintext client secret.
The blueprint metadata defaults to the hosting connection's client ID; an optional
`AGENT_BLUEPRINT_ID` overrides it. Never set `AGENT_ID` to the blueprint ID.
AI Teammates resolve their agent identity from the incoming activity. Playground turns
without a valid agent/tenant identity skip A365 scopes rather than inventing identities.

Enable the A365 exporter for production:

```env
ENABLE_A365_OBSERVABILITY_EXPORTER=true
```

Set `AGENT_NAME=Semantic-Kernel` and `OBSERVABILITY_SERVICE_NAME=Semantic-Kernel`
in `.env` for consistent agent/model/tool span names and the telemetry service name.
The configured agent name overrides the incoming activity's display name.
Restart the agent after changing these values. These settings affect new telemetry,
not historical records or the Entra/Teams registered display names. Surfaces that
resolve names from the directory require a separate administrator-managed rename
of the existing blueprint, agent instance, and agent user; do not change their IDs.

Console logging is explicitly installed alongside the distro's handler. A later
`logging.basicConfig()` alone cannot configure output after the distro initializes.
Application INFO messages, tool completion, and app-only token acquisition are
visible without dumping prompt/response text to the application console.

For diagnostics, set `OTEL_LOG_LEVEL=INFO` and
`A365_OBSERVABILITY_LOG_LEVEL=debug|info|warn|error` in `.env`, then restart.
The installed Python exporter logs HTTP success and its response at DEBUG.
Return the exporter level to `info|warn|error` when finished; diagnostic logs may
contain endpoint and identity metadata. Never share unredacted logs publicly.
Verify response destination statuses (`sent`, rather than `rejected`/`not_routed`)
as well as `partialSuccess`; HTTP 200 alone isn't proof of downstream delivery.
Verify exporter success before checking MAC;
successful export does not by itself prove Activity attribution. Use the runtime agent
identity, not the blueprint ID, when filtering activity reports.

### Regression checks

```bash
python -m unittest discover -s tests -v
```

These checks use mocked authentication and HTTP responses; they do not call the LLM,
change tenant permissions, or prove live telemetry delivery.
They exercise the real Semantic Kernel/OpenAI integration, exporter HTTP serialization,
console diagnostics, conversation history, and per-operation identity attributes.
The required CI orchestrator runs this sample's unittest suite on Python 3.11/3.12
on both Windows and Ubuntu.

## Troubleshooting

| Issue                              | Solution                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `401 Unauthorized` in Playground | Set `AUTH_HANDLER_NAME=` (empty) and `USE_AGENTIC_AUTH=false`                              |
| MCP tools not loading              | Ensure `BEARER_TOKEN` is set and not expired. Refresh with `a365 develop get-token -o raw` |
| Slow response during tool setup | Each turn opens fresh authenticated MCP sessions; check gateway/token/server latency |
| `Import could not be resolved`   | Run `uv sync` or `pip install -e .` to install all dependencies                            |
| Token exchange failures            | Verify `CONNECTIONS__SERVICE_CONNECTION__SETTINGS__*` credentials are correct                |
| Agentic MCP without an auth handler | Set `AUTH_HANDLER_NAME=AGENTIC`, or use Playground settings with a non-empty bearer token |
| MCP HTTP or JSON-RPC errors | Check the reported status/error and credentials; failed manual registrations are not counted as loaded |
| No MAC Activity | Check the exporter flag, runtime identity, app-only token acquisition, and exporter logs before investigating indexing |

The entry point configures Python stdout/stderr as UTF-8 before imports, avoiding
`UnicodeEncodeError` when Windows redirects emoji output through a CP1252 pipe.
For PowerShell to decode that output correctly when logging (including emoji):

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding
$env:PYTHONIOENCODING = "utf-8"
& ".\.venv\Scripts\python.exe" -u .\start_with_generic_host.py 2>&1 | Tee-Object -FilePath ".\log.txt"
```

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
