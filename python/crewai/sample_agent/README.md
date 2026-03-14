# CrewAI Agent Sample - Python

This sample demonstrates how to build a multi-agent system using CrewAI while integrating with the Microsoft Agent 365 SDK. It mirrors the structure and hosting patterns of the AgentFramework/OpenAI Agent 365 samples, while preserving native CrewAI logic in `src/crew_agent/`.

## Demonstrates

- **MCP Tooling**: Full Model Context Protocol (MCP) integration with Microsoft 365 services (Mail, Calendar, Copilot)
- **Observability**: Complete tracing with `InvokeAgentScope`, `InferenceScope`, and `ExecuteToolScope` for all agent operations
- **Notifications**: Email and Teams @mention notification support
- **Multi-Agent Orchestration**: Sequential agent workflow with Weather Checker and Driving Safety Advisor agents
- **Azure OpenAI Integration**: Native support for Azure OpenAI deployments via CrewAI's `azure-ai-inference` extra and LiteLLM routing
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for Python](https://github.com/microsoft/Agent365-python).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Prerequisites

- Python 3.11+
- [UV](https://docs.astral.sh/uv/) (recommended for dependency management)
- Azure OpenAI API credentials OR OpenAI API key
- [Tavily API key](https://tavily.com) for weather search functionality
- Microsoft 365 Agents Playground (optional, for testing)
- Bearer token from `a365 develop get-token -o raw` (for MCP server authentication)

## Configuration

### Step 1: Create Environment File

Copy `.env.template` to `.env`:

```bash
cp .env.template .env
```

### Step 2: Configure Required Variables

**For Azure OpenAI (recommended):**
```env
AZURE_API_KEY=your-azure-openai-key
AZURE_API_BASE=https://your-resource.openai.azure.com/
AZURE_API_VERSION=2025-01-01-preview
OPENAI_API_KEY=your-azure-openai-key  # CrewAI requires this
OPENAI_MODEL_NAME=azure/gpt-4.1       # Use azure/ prefix for LiteLLM
```

**For OpenAI:**
```env
OPENAI_API_KEY=sk-your-openai-key
OPENAI_MODEL_NAME=gpt-4o-mini
```

**For MCP Tools (Mail, Calendar, Copilot):**
```env
BEARER_TOKEN=<run: a365 develop get-token -o raw>
USE_AGENTIC_AUTH=false
AGENTIC_APP_ID=crewai-agent
```

**For Weather Tool:**
```env
TAVILY_API_KEY=tvly-your-tavily-key
```

## Working with User Identity

On every incoming message, the A365 platform populates `activity.from_property` with basic user
information — always available with no API calls or token acquisition:

| Field | Description |
|---|---|
| `activity.from_property.id` | Channel-specific user ID (e.g., `29:1AbcXyz...` in Teams) |
| `activity.from_property.name` | Display name as known to the channel |
| `activity.from_property.aad_object_id` | Azure AD Object ID — use this to call Microsoft Graph |

The sample logs these fields at the start of every message turn and injects the display name
into the LLM task instructions for personalized responses via the `{user_name}` input variable.

## Handling Agent Install and Uninstall

When a user installs (hires) or uninstalls (removes) the agent, the A365 platform sends an `InstallationUpdate` activity — also referred to as the `agentInstanceCreated` event. The sample handles this in `on_installation_update` in `host_agent_server.py`:

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
    response = await agent.invoke(user_message)
    await context.send_activity(response)
finally:
    typing_task.cancel()
    try:
        await typing_task
    except asyncio.CancelledError:
        pass
```

## Running the Agent

### Option 1: Run via Agent Runner (Standalone)

```bash
uv run python -m crew_agent.agent_runner "London"
# or
uv run agent_runner "San Francisco, CA"
```

### Option 2: Hosted via Generic Agent Host (Recommended)

This option integrates with Microsoft 365 Agents SDK for full observability and MCP tooling.

1. Ensure `.env` is configured (see above)

2. Get a bearer token for MCP authentication:
   ```bash
   a365 develop get-token -o raw
   ```
   Copy the token to `BEARER_TOKEN` in `.env`

3. Start the agent host:
   ```bash
   uv run python start_with_generic_host.py
   ```

4. Test endpoints:
   - Health check: `http://localhost:3978/api/health`
   - Bot Framework: `http://localhost:3978/api/messages`

5. Connect with Agents Playground:
   ```bash
   agentsplayground -e "http://localhost:3978/api/messages" -c "emulator"
   ```

### Example Prompts

```
Find weather in Dublin and email the information to user@example.com under the subject "Weather Report"
```

```
What's the weather in Seattle? Is it safe to drive with summer tires?
```

## Architecture

### Agent Workflow

```
┌─────────────────────────┐     ┌──────────────────────────┐
│  Weather Information    │────▶│  Driving Safety          │
│  Specialist             │     │  Specialist              │
│  (Tavily + MCP Tools)   │     │  (MCP Tools only)        │
└─────────────────────────┘     └──────────────────────────┘
         │                                │
         ▼                                ▼
   Weather Report              Safety Assessment + Email
```

### MCP Tools Available

When connected with a valid bearer token, the following MCP servers are available:

| Server | Tools | Description |
|--------|-------|-------------|
| `mcp_MailTools` | 20 tools | Send/receive emails, manage drafts, attachments |
| `mcp_CalendarTools` | 12 tools | Create/manage events, check availability |
| `mcp_M365Copilot` | 1 tool | Query Microsoft 365 Copilot |

### Observability Scopes

All agent operations are traced with Agent 365 observability:

- **InvokeAgentScope**: Wraps the entire agent invocation
- **InferenceScope**: Wraps LLM calls (CrewAI crew execution)
- **ExecuteToolScope**: Wraps each MCP tool execution

## File Structure

```
sample_agent/
├── .env.template              # Environment template with documentation
├── start_with_generic_host.py # Main entry point
├── host_agent_server.py       # Agent 365 SDK hosting + observability setup
├── agent.py                   # CrewAI agent wrapper with observability
├── turn_context_utils.py      # Turn context utilities
├── ToolingManifest.json       # MCP server definitions
└── src/crew_agent/
    ├── config/
    │   ├── agents.yaml        # Agent definitions
    │   └── tasks.yaml         # Task definitions
    ├── crew.py                # CrewAI crew orchestration
    └── tools/
        └── custom_tool.py     # WeatherTool (Tavily)
```

## Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| `No MCP tools discovered` | Ensure `BEARER_TOKEN` is set and not expired. Run `a365 develop get-token -o raw` |
| `Weather tool returns no data` | Set `TAVILY_API_KEY` in `.env` |
| `Azure OpenAI 401 error` | Verify `AZURE_API_KEY` and `AZURE_API_BASE` are correct |
| `Duplicate emails sent` | Update `tasks.yaml` - only Driving Safety agent should send emails |
| `CrewAI tracing 401` | This is expected when CrewAI cloud tracing is not configured. It can be safely ignored; local observability still works |

### Logs to Check

```
INFO:agent:✅ 33 MCP tool(s) available:        # MCP connected successfully
INFO:agent:📊 Created observable wrapper       # Tool wrappers with ExecuteToolScope
INFO:agent:🔧 Calling MCP tool: SendEmail...   # Tool execution
```

## Support

For issues, questions, or feedback:

- **CrewAI Documentation**: https://docs.crewai.com
- **CrewAI GitHub**: https://github.com/joaomdmoura/crewai
- **Microsoft Agent 365 Documentation**: https://learn.microsoft.com/en-us/microsoft-agent-365/developer/
- **Discord**: https://discord.com/invite/X4JWnZnxPb

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 SDK - Python repository](https://github.com/microsoft/Agent365-python)
- [Microsoft 365 Agents SDK - Python repository](https://github.com/Microsoft/Agents-for-python)
- [CrewAI API documentation](https://docs.crewai.com)
- [Python API documentation](https://learn.microsoft.com/python/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](LICENSE.md) file for details.