# Claude Sample Agent - Node.js

This sample demonstrates how to build an agent using Claude in Node.js with the Microsoft Agent 365 SDK. It covers:

- **Observability**: End-to-end tracing, caching, and monitoring for agent applications
- **Notifications**: Services and models for managing user notifications
- **Tools**: Model Context Protocol tools for building advanced agent solutions
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for Node.js](https://github.com/microsoft/Agent365-nodejs).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Prerequisites
>
> To run the template in your local dev machine, you will need:
>
> - [Node.js](https://nodejs.org/), supported versions: 18.x or higher
> - [Microsoft 365 Agents Toolkit Visual Studio Code Extension](https://aka.ms/teams-toolkit) latest version
> - Prepare your own Anthropic API credentials
> - Azure CLI signed in with `az login`

> - Microsoft Agent 365 SDK
> - Claude Agent SDK 0.1.1 or higher
> - A365 CLI: Required for agent deployment and management.

## Working with User Identity

On every incoming message, the A365 platform populates `activity.from` with basic user
information — always available with no API calls or token acquisition:

| Field | Description |
|---|---|
| `activity.from.id` | Channel-specific user ID (e.g., `29:1AbcXyz...` in Teams) |
| `activity.from.name` | Display name as known to the channel |
| `activity.from.aadObjectId` | Azure AD Object ID — use this to call Microsoft Graph |

The sample logs these fields at the start of every message turn and injects the display name
into the LLM system instructions for personalized responses.

## Running the Agent in Microsoft 365 Agents Playground

1. First, select the Microsoft 365 Agents Toolkit icon on the left in the VS Code toolbar.
1. In file *env/.env.playground.user*, fill in your Anthropic API key `SECRET_ANTHROPIC_API_KEY=<your-key>`.
1. In file *env/.env.playground*, fill in your custom app registration client id `CLIENT_APP_ID`.
1. Press F5 to start debugging which launches your agent in Microsoft 365 Agents Playground using a web browser. Select `Debug in Microsoft 365 Agents Playground`.
1. You can send any message to get a response from the agent.

**Congratulations**! You are running an agent that can now interact with users in Microsoft 365 Agents Playground.

## Running Locally with Teams

Use this path when testing against real Teams traffic via a dev tunnel instead of Agents Playground.

### 1. Create your .env file

Copy `.env.template` to `.env` in the `sample-agent` directory and fill in the required values:

```bash
cp .env.template .env
```

Required values:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key — get one at [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| `NODE_ENV` | Set to `production` so JWT validation is enabled (Teams always sends auth tokens) |
| `connections__service_connection__settings__clientId` | Blueprint App ID from `a365.generated.config.json` (`agentBlueprintId`) |
| `connections__service_connection__settings__clientSecret` | Blueprint client secret value (not the secret ID) |
| `connections__service_connection__settings__tenantId` | Your Azure AD tenant ID |

> **Note**: `NODE_ENV=development` (the template default) skips JWT validation entirely, which works for Agents Playground (no auth header) but fails for Teams (always sends a JWT). Set `NODE_ENV=production` when testing with real Teams traffic.

### 2. Start the agent

```bash
npm run dev
```

The agent listens on `http://127.0.0.1:3978`. You should see:

```
Server listening on 127.0.0.1:3978 for appId <blueprint-id> debug agents:*
```

### 3. Start a dev tunnel

```bash
devtunnel host <your-tunnel-name> --allow-anonymous
```

If port 3978 is not yet mapped to the tunnel:

```bash
devtunnel port create <your-tunnel-name> -p 3978 --protocol https
```

### 4. Test in Teams

Send the agent a message. The agent only handles new messages (`message` activity type) — **do not edit a sent message**, as Teams sends a `messageUpdate` activity for edits which has no handler.

## Handling Agent Install and Uninstall

When a user installs (hires) or uninstalls (removes) the agent, the A365 platform sends an `InstallationUpdate` activity — also referred to as the `agentInstanceCreated` event. The sample handles this in `handleInstallationUpdateActivity` ([agent.ts](src/agent.ts)):

| Action | Description |
|---|---|
| `add` | Agent was installed — send a welcome message |
| `remove` | Agent was uninstalled — send a farewell message |

```typescript
if (context.activity.action === 'add') {
  await context.sendActivity('Thank you for hiring me! Looking forward to assisting you in your professional journey!');
} else if (context.activity.action === 'remove') {
  await context.sendActivity('Thank you for your time, I enjoyed working with you.');
}
```

To test with Agents Playground, use **Mock an Activity → Install application** to send a simulated `installationUpdate` activity.

## Sending Multiple Messages in Teams

Agent365 agents can send multiple discrete messages in response to a single user prompt in Teams. This is achieved by calling `sendActivity` multiple times within a single turn.

> **Important**: Streaming responses are not supported for agentic identities in Teams. The SDK detects agentic identity and buffers the stream into a single message. Use `sendActivity` directly to send immediate, discrete messages to the user.

The sample demonstrates this in `handleAgentMessageActivity` ([agent.ts](src/agent.ts)):

```typescript
// Message 1: immediate ack — reaches the user right away
await turnContext.sendActivity('Got it — working on it…');

// ... LLM processing ...

// Message 2: the LLM response
await turnContext.sendActivity(response);
```

Each `sendActivity` call produces a separate Teams message. You can call it as many times as needed to send progress updates, partial results, or a final answer.

### Typing Indicators

The agent sends typing indicators in a loop every ~4 seconds to keep the `...` animation alive while the LLM processes the request:

```typescript
let typingInterval: ReturnType<typeof setInterval> | undefined;
const startTypingLoop = () => {
  typingInterval = setInterval(async () => {
    await turnContext.sendActivity({ type: 'typing' } as Activity);
  }, 4000);
};
const stopTypingLoop = () => { clearInterval(typingInterval); };

startTypingLoop();
try {
  // ... LLM processing ...
} finally {
  stopTypingLoop();
}
```

> **Note**: Typing indicators are only visible in 1:1 chats and small group chats — not in channels.

## Running the Agent

To set up and test this agent, refer to the [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing?tabs=nodejs) guide for complete instructions.

## Troubleshooting

### Audience mismatch / 401 Unauthorized from Teams

```
agents:jwt-middleware:error Audience mismatch <blueprint-id>
```

**Cause**: `NODE_ENV=development` causes the agent to skip loading auth configuration, so JWT audience matching fails when Teams sends a token.

**Fix**: Set `NODE_ENV=production` in `.env` and ensure `connections__service_connection__settings__clientId` matches your Blueprint App ID.

---

### `Error: Claude Code process exited with code 1`

**Cause**: The `@anthropic-ai/claude-agent-sdk` spawns the `claude` CLI as a subprocess. If you're developing inside VS Code with the Claude Code extension, the `CLAUDECODE` environment variable is set in the parent process and inherited by the subprocess, which rejects nested sessions.

**Fix**: Already handled in `src/client.ts` — the `CLAUDECODE` variable is deleted from the subprocess environment before spawning. If you see this error, ensure you are on the latest version of this sample.

---

### Port 3978 already in use

```
Error: listen EADDRINUSE: address already in use 127.0.0.1:3978
```

**Cause**: A previous agent process crashed but did not release the port.

**Fix**: Kill the occupying process and restart:

```powershell
# PowerShell
$proc = Get-NetTCPConnection -LocalPort 3978 | Select-Object -ExpandProperty OwningProcess
Stop-Process -Id $proc -Force
```

```bash
# bash / macOS / Linux
lsof -ti:3978 | xargs kill -9
```

---

### Agent does not respond to an edited message

**Cause**: Editing a message in Teams sends a `messageUpdate` activity (`eventType: editMessage`). The agent only registers a handler for `message` activities.

**Fix**: Send a new message instead of editing an existing one. Support for `messageUpdate` can be added by registering a handler for `ActivityTypes.MessageUpdate` if needed.

---

### `invalid_client` when acquiring tokens

```
AADSTS7000216: 'client_assertion', 'client_secret' or 'request' is required
```

**Cause**: `connections__service_connection__settings__clientSecret` is empty in `.env`.

**Fix**: Set the Blueprint client secret value (not the secret ID) in `.env`.

## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-nodejs/issues) section
- **Documentation**: See the [Microsoft Agents 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: For security issues, please see [SECURITY.md](SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 SDK - Node.js repository](https://github.com/microsoft/Agent365-nodejs)
- [Microsoft 365 Agents SDK - Node.js repository](https://github.com/Microsoft/Agents-for-js)
- [Claude API documentation](https://docs.anthropic.com/)
- [Node.js API documentation](https://learn.microsoft.com/javascript/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](LICENSE.md) file for details.