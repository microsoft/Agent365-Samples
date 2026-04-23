# Semantic Kernel Sample Agent - Node.js

This sample demonstrates how to build an agent using Semantic Kernel patterns in Node.js with the Microsoft Agent 365 SDK. It covers:

- **Observability**: End-to-end tracing, caching, and monitoring for agent applications
- **Notifications**: Services and models for managing user notifications
- **Tools**: Model Context Protocol tools for building advanced agent solutions
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK
- **Function Calling**: Semantic Kernel-style automatic function calling with plugins

This sample uses the [Microsoft Agent 365 SDK for Node.js](https://github.com/microsoft/Agent365-nodejs).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Demonstrates

This sample mirrors the [C#/.NET Semantic Kernel sample](../../dotnet/semantic-kernel/sample-agent/) and demonstrates:

- **Semantic Kernel Agent Pattern**: Uses OpenAI Chat Completions with function calling (tools) in a loop — equivalent to the C# `ChatCompletionAgent` with `FunctionChoiceBehavior.Auto`
- **Plugin System**: Local plugins for terms and conditions management, similar to the C# `KernelPlugin` pattern
- **MCP Tool Integration**: Dynamic tool loading from Agent 365 MCP servers
- **Azure OpenAI / OpenAI Support**: Configurable to use either Azure OpenAI or standard OpenAI
- **Observability**: Agent 365 tracing and telemetry with baggage propagation
- **Notifications**: Email notification handling
- **Terms and Conditions Flow**: Plugin-based T&C acceptance workflow

## Prerequisites

- Node.js 18.x or higher
- Microsoft Agent 365 SDK
- Azure/OpenAI API credentials

## Configuration

1. Copy `.env.template` to `.env`:
   ```bash
   cp .env.template .env
   ```

2. Configure your LLM provider in `.env`:

   **Option 1: Standard OpenAI**
   ```env
   OPENAI_API_KEY=<<YOUR_API_KEY>>
   OPENAI_MODEL=gpt-4o
   ```

   **Option 2: Azure OpenAI**
   ```env
   AZURE_OPENAI_API_KEY=<<YOUR_API_KEY>>
   AZURE_OPENAI_ENDPOINT=<<YOUR_ENDPOINT>>
   AZURE_OPENAI_DEPLOYMENT=<<YOUR_DEPLOYMENT_NAME>>
   AZURE_OPENAI_API_VERSION=2024-10-21
   ```

3. For MCP tooling (optional), set the bearer token:
   ```bash
   a365 develop get-token
   ```
   Copy the token value to `BEARER_TOKEN` in your `.env` file.

## Working with User Identity

On every incoming message, the A365 platform populates `activity.from` with basic user information — always available with no API calls or token acquisition:

| Field | Description |
|---|---|
| `activity.from.id` | Channel-specific user ID (e.g., `29:1AbcXyz...` in Teams) |
| `activity.from.name` | Display name as known to the channel |
| `activity.from.aadObjectId` | Azure AD Object ID — use this to call Microsoft Graph |

The sample logs these fields at the start of every message turn and injects the display name into the LLM system instructions for personalized responses.

## Handling Agent Install and Uninstall

When a user installs (hires) or uninstalls (removes) the agent, the A365 platform sends an `InstallationUpdate` activity. The sample handles this in `handleInstallationUpdateActivity` ([src/agent.ts](src/agent.ts)):

| Action | Description |
|---|---|
| `add` | Agent was installed — send a welcome message |
| `remove` | Agent was uninstalled — send a farewell message |

```typescript
if (context.activity.action === 'add') {
  setTermsAndConditionsAccepted(true);
  await context.sendActivity('Thank you for hiring me! Looking forward to assisting you in your professional journey!');
} else if (context.activity.action === 'remove') {
  setTermsAndConditionsAccepted(false);
  await context.sendActivity('Thank you for your time, I enjoyed working with you.');
}
```

To test with Agents Playground, use **Mock an Activity → Install application** to send a simulated `installationUpdate` activity.

## Sending Multiple Messages in Teams

Agent365 agents can send multiple discrete messages in response to a single user prompt in Teams. This is achieved by calling `sendActivity` multiple times within a single turn.

> **Important**: Streaming responses are not supported for agentic identities in Teams. The SDK detects agentic identity and buffers the stream into a single message. Use `sendActivity` directly to send immediate, discrete messages to the user.

The sample demonstrates this in `handleAgentMessageActivity` ([src/agent.ts](src/agent.ts)):

```typescript
// Message 1: immediate ack — reaches the user right away
await turnContext.sendActivity('Got it — working on it…');

// ... LLM processing ...

// Message 2: the LLM response
await turnContext.sendActivity(response.content);
```

### Typing Indicators

The agent sends typing indicators in a loop every ~4 seconds to keep the `...` animation alive while the LLM processes the request:

```typescript
let typingInterval: ReturnType<typeof setInterval> | undefined;
const startTypingLoop = () => {
  typingInterval = setInterval(() => {
    turnContext.sendActivity({ type: 'typing' } as Activity).catch(() => {});
  }, 4000);
};
const stopTypingLoop = () => { clearInterval(typingInterval); };
```

> **Note**: Typing indicators are only visible in 1:1 chats and small group chats — not in channels.

## How to Run This Sample

### 1. Install Dependencies

```bash
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Run

**Production:**
```bash
npm start
```

**Development (with hot reload):**
```bash
npm run dev
```

### 4. Test with Agents Playground

```bash
npm run test-tool
```

## Project Structure

```
src/
├── index.ts          # Express server entry point
├── agent.ts          # MyAgent class — message routing, notifications, install/uninstall
├── client.ts         # Semantic Kernel-style agent with function calling loop
├── plugins.ts        # Terms and conditions plugins (accept/reject)
├── openai-config.ts  # OpenAI/Azure OpenAI client configuration
└── token-cache.ts    # In-memory token cache for observability
```

## Troubleshooting

| Issue | Solution |
|---|---|
| `No OpenAI credentials configured` | Set `OPENAI_API_KEY` or `AZURE_OPENAI_*` variables in `.env` |
| `Failed to register MCP tool servers` | Ensure `BEARER_TOKEN` is set. Run `a365 develop get-token` to get a fresh token |
| `Token expired` | Bearer tokens expire regularly. Refresh with `a365 develop get-token` |
| Agent not responding | Check that `NODE_ENV=development` is set in `.env` for local testing |
| `ECONNREFUSED` on port 3978 | Another process may be using port 3978. Change `PORT` in `.env` |

## Running the Agent

To set up and test this agent, refer to the [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing?tabs=nodejs) guide for complete instructions.

## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-nodejs/issues) section
- **Documentation**: See the [Microsoft Agents 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: For security issues, please see [SECURITY.md](../../../SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 SDK - Node.js repository](https://github.com/microsoft/Agent365-nodejs)
- [Microsoft 365 Agents SDK - Node.js repository](https://github.com/Microsoft/Agents-for-js)
- [Semantic Kernel documentation](https://learn.microsoft.com/semantic-kernel/)
- [OpenAI API documentation](https://platform.openai.com/docs/)
- [Node.js API documentation](https://learn.microsoft.com/javascript/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](../../../LICENSE.md) file for details.
