# Google ADK Sample Agent - Node.js

This sample demonstrates how to build an agent using Google ADK (Agent Development Kit) in Node.js with the Microsoft Agent 365 SDK. It covers:

- **Observability**: End-to-end tracing, caching, and monitoring via Microsoft OpenTelemetry Distro
- **Notifications**: Handling email, Word comment, and lifecycle notifications
- **Tools**: Model Context Protocol (MCP) tools for sending emails and more
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for Node.js](https://github.com/microsoft/Agent365-nodejs).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Prerequisites

To run the template in your local dev machine, you will need:

- [Node.js](https://nodejs.org/), supported versions: 18.x or higher
- [Microsoft 365 Agents Toolkit Visual Studio Code Extension](https://aka.ms/teams-toolkit) latest version
- A Google Cloud project with Vertex AI enabled, or a Google API key
- Azure CLI signed in with `az login`

> - Microsoft Agent 365 SDK
> - Google ADK 1.1.0 or higher
> - A365 CLI: Required for agent deployment and management.

## Running the Agent in Microsoft 365 Agents Playground

1. First, select the Microsoft 365 Agents Toolkit icon on the left in the VS Code toolbar.
2. In file `env/.env.playground`, set `GOOGLE_GENAI_USE_VERTEXAI=FALSE` and fill in `GOOGLE_API_KEY=<your-key>` if using the public Gemini API.
3. Or for Vertex AI, set `GOOGLE_GENAI_USE_VERTEXAI=TRUE` and fill in `GOOGLE_CLOUD_PROJECT=<your-project>` and `GOOGLE_CLOUD_LOCATION=<your-region>`.
4. Press F5 to start debugging which launches your agent in Microsoft 365 Agents Playground using a web browser. Select `Debug in Microsoft 365 Agents Playground`.
5. You can send any message to get a response from the agent.

**Congratulations!** You are running an agent that can now interact with users in Microsoft 365 Agents Playground.

## Handling Agent Install and Uninstall

When a user installs (hires) or uninstalls (removes) the agent, the A365 platform sends an `InstallationUpdate` activity — also referred to as the `agentInstanceCreated` event. The sample handles this in `hosting.ts`:

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

The sample demonstrates this in `hosting.ts`:

```typescript
// Message 1: immediate ack — reaches the user right away
await context.sendActivity('Got it — working on it…');

// ... LLM processing ...

// Message 2: the LLM response
await context.sendActivity(response);
```

Each `sendActivity` call produces a separate Teams message. You can call it as many times as needed to send progress updates, partial results, or a final answer.

### Typing Indicators

The agent sends typing indicators in a loop every ~4 seconds to keep the `...` animation alive while the LLM processes the request:

```typescript
let typingInterval: ReturnType<typeof setInterval> | undefined;
const startTypingLoop = () => {
  typingInterval = setInterval(() => {
    context.sendActivity({ type: 'typing' } as Activity).catch(() => {});
  }, 4000);
};
const stopTypingLoop = () => { clearInterval(typingInterval); };
```

> **Note**: Typing indicators are only visible in 1:1 chats and small group chats — not in channels.

## Running the Agent

To set up and test this agent, refer to the [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing?tabs=nodejs) guide for complete instructions. For a detailed explanation of the agent code and implementation, see the [Agent Code Walkthrough](Agent-Code-Walkthrough.md).

For local Teams testing through a dev tunnel, keep the service connection values in `.env` populated. Bot Framework sends signed JWTs to `/api/messages` even in local development, so the server loads auth configuration from environment variables before accepting message activities.

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
- [Google ADK documentation](https://google.github.io/adk-docs/)
- [Node.js API documentation](https://learn.microsoft.com/javascript/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](../../../LICENSE.md) file for details.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/messages` | Main agent endpoint |
| GET | `/api/health` | Health check with JSON status |
| GET | `/` | Health check |
| GET | `/robots933456.txt` | Azure App Service probe |
