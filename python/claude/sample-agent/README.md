# Claude Sample Agent - Python

This directory contains a sample agent implementation using Python and Anthropic's Claude Agent SDK with extended thinking capabilities. This sample demonstrates how to build an agent using the Agent365 framework with Python and Claude Agent SDK. It covers:

- **Observability**: End-to-end tracing, caching, and monitoring for agent applications
- **Notifications**: Services and models for managing user notifications
- **Tools**: Built-in Claude tools (Read, Write, WebSearch, Bash, Grep) for building advanced agent solutions
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for Python](https://github.com/microsoft/Agent365-python).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Prerequisites

- Python 3.11+
- Anthropic Claude API access (API key)

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

## Documentation

For detailed setup and running instructions, please refer to the official documentation:

- **[Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)** - Complete setup and testing guide
- **[AGENT-CODE-WALKTHROUGH.md](AGENT-CODE-WALKTHROUGH.md)** - Detailed code explanation and architecture walkthrough

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Microsoft 365 Agents Playground / Client       │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│  host_agent_server.py                           │
│  - HTTP endpoint (/api/messages)                │
│  - Authentication middleware                    │
│  - Notification routing                         │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│  agent.py (ClaudeAgent)                         │
│  - Message processing                           │
│  - Notification handling                        │
│  - Claude SDK integration                       │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│  Claude Agent SDK                               │
│  - Extended thinking                            │
│  - Built-in tools                               │
│  - Streaming responses                          │
└─────────────────────────────────────────────────┘
```

## Built-in Claude Tools

The Claude Agent SDK provides these tools out of the box:

- **Read**: Read files from the workspace
- **Write**: Create/modify files
- **WebSearch**: Search the web for information
- **Bash**: Execute shell commands
- **Grep**: Search file contents

## MCP Tooling Integration

This sample also supports MCP (Model Context Protocol) tools for extended capabilities like email, calendar, and other Microsoft 365 services.

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
      "audience": "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1"
    }
  ]
}
```

### Environment Variables for MCP

Add these to your `.env` file:

```
# Optional environment label used by local tooling
ENVIRONMENT=Development

# Set to true to use proper token exchange for MCP authentication (required for cloud MCP servers)
USE_AGENTIC_AUTH=true
```

Notes:
- MCP server discovery first attempts SDK-based discovery. If no servers are returned, the agent falls back to `ToolingManifest.json` regardless of `ENVIRONMENT`.

### MCP Authentication

MCP tools require proper Azure authentication:

- **Development**: Set `USE_AGENTIC_AUTH=false` with a valid `BEARER_TOKEN` for local testing
- **Production**: Uses token exchange with proper scopes via the Microsoft 365 Agents SDK

## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-python/issues) section
- **Documentation**: See the [Microsoft Agents 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Resources

- [Claude Agent SDK](https://anthropic.mintlify.app/en/api/agent-sdk/overview)
- [Microsoft 365 Agents SDK](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/)
- [Microsoft Agents A365 Python](https://github.com/microsoft/Agent365-python)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](../../../LICENSE.md) file for details.