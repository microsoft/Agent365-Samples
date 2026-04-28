# Agent Framework Sample Agent - Python

This sample demonstrates how to build an agent using Agent Framework in Python with the Microsoft Agent 365 SDK. It covers:

- **Observability**: End-to-end tracing, caching, and monitoring for agent applications
- **Notifications**: Services and models for managing user notifications
- **Tools**: Model Context Protocol tools for building advanced agent solutions
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for Python](https://github.com/microsoft/Agent365-python).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Prerequisites

> To run the sample on your local dev machine, you will need:
>
> - [Python](https://www.python.org/) 3.11 or higher
> - [uv](https://docs.astral.sh/uv/) for dependency management
> - Azure OpenAI resource with a deployed model
> - Azure CLI signed in with `az login`
> - [A365 CLI](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/agent-365-cli) for agent provisioning and management
> - [AgentsPlayground](https://www.npmjs.com/package/@microsoft/agentsplayground) for local testing (`npm install -g @microsoft/agentsplayground`)
>
> SDK packages (installed automatically by `uv sync`):
> - Agent Framework (`agent-framework-openai`)
> - Microsoft Agents SDK (`microsoft-agents-hosting-aiohttp`, `microsoft-agents-authentication-msal`)
> - Microsoft Agent 365 SDK (`microsoft-agents-a365-observability-core`, `microsoft-agents-a365-tooling`, etc.)

## Python Environment Configuration

Set up the Python virtual environment manually before running the agent or deploy steps:

1. Install `uv`:
	- `pip install uv`
2. Create a virtual environment:
	- `uv venv`
3. Activate the virtual environment:
	- Windows PowerShell: `.venv\Scripts\Activate.ps1`
	- macOS/Linux: `source .venv/bin/activate`

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

## Configuration

1. Copy `.env.template` to `.env` and fill in the required values.
2. Run `a365 setup all --agent-name <your-agent-name>` to provision the A365 blueprint, identity, and permissions. This stamps service connection and observability settings into your `.env` automatically.
3. Key settings:

| Variable | Description |
|---|---|
| `AZURE_OPENAI_ENDPOINT` | Your Azure OpenAI resource endpoint |
| `AZURE_OPENAI_DEPLOYMENT` | Model deployment name (e.g., `gpt-4o`) |
| `AZURE_OPENAI_API_KEY` | API key (or omit to use Azure CLI credential) |
| `AUTH_HANDLER_NAME` | Set to `AGENTIC` for production, leave empty for local emulator testing |
| `ENABLE_A365_OBSERVABILITY_EXPORTER` | Set to `true` to export traces to A365 |

> **Note:** `AZURE_OPENAI_API_VERSION` is optional. The SDK defaults to the v1 Responses API. Only set this if your deployment requires a specific dated version.

## Running the Agent in Microsoft 365 Agents Playground

1. Start the agent:
   ```bash
   uv sync
   python start_with_generic_host.py
   ```
2. In a separate terminal, launch AgentsPlayground:
   ```bash
   agentsplayground -e "http://localhost:3978/api/messages" -c "emulator"
   ```
3. Send any message in the playground to test your agent.

> **Note:** For local emulator testing, set `AUTH_HANDLER_NAME=` (empty) in your `.env`. The emulator does not support agentic token exchange. For MCP tooling in local mode, run `a365 develop get-token` to acquire a short-lived bearer token.

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

Agent365 agents can send multiple discrete messages in response to a single user prompt in Teams. This is achieved by calling `send_activity` multiple times within a single turn.

> **Important**: Streaming responses are not supported for agentic identities in Teams. The SDK detects agentic identity and buffers the stream into a single message. Use `send_activity` directly to send immediate, discrete messages to the user.

The sample demonstrates this in `on_message` ([host_agent_server.py](host_agent_server.py)):

```python
# Message 1: immediate ack — reaches the user right away
await context.send_activity("Got it — working on it…")

# Send typing indicator immediately (awaited so it arrives before the LLM call starts).
await context.send_activity(Activity(type="typing"))

# Background loop refreshes the "..." animation every ~4s (it times out after ~5s).
async def _typing_loop():
    try:
        while True:
            await asyncio.sleep(4)
            await context.send_activity(Activity(type="typing"))
    except asyncio.CancelledError:
        pass  # Expected on cancel.

typing_task = asyncio.create_task(_typing_loop())
try:
    response = await agent.process_user_message(...)
    # Message 2: the LLM response
    await context.send_activity(response)
finally:
    typing_task.cancel()
    try:
        await typing_task
    except asyncio.CancelledError:
        pass
```

Each `send_activity` call produces a separate Teams message. You can call it as many times as needed to send progress updates, partial results, or a final answer.

### Typing Indicators

- Typing indicators show a "..." progress animation in Teams
- They have a built-in ~5-second visual timeout and must be refreshed in a loop every ~4 seconds
- Only visible in 1:1 chats and small group chats — not in channels

## Running the Agent

To set up and test this agent, refer to the [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing?tabs=python) guide for complete instructions.

For a detailed explanation of the agent code and implementation, see the [Agent Code Walkthrough](AGENT-CODE-WALKTHROUGH.md).

## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-python/issues) section
- **Documentation**: See the [Microsoft Agents 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: For security issues, please see [SECURITY.md](SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 SDK - Python repository](https://github.com/microsoft/Agent365-python)
- [Microsoft 365 Agents SDK - Python repository](https://github.com/Microsoft/Agents-for-python)
- [Agent Framework documentation](https://github.com/microsoft/Agent365-python/tree/main/packages/agent-framework)
- [Python API documentation](https://learn.microsoft.com/python/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](LICENSE.md) file for details.