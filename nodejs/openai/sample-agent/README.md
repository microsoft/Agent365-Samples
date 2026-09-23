# OpenAI Sample Agent - Node.js

## OBS-only application authentication

This sample retains its compatible Agent 365 preview.125 SDK family. `index.ts`
imports `src/otel.ts` first, before HTTP and OpenAI modules. The bootstrap
configures one S2S exporter with the isolated app-token resolver and existing
OpenAI instrumentation. The supported legacy service route is
`/observabilityService/tenants/{tenant}/agents/{agent}/traces`, with distinct
tenant-eligibility policies; do not infer its authorization from public OTLP acceptance.
Per-request export is rejected because it bypasses the app-only resolver.

The published A365 OpenAI extensions require OpenAI Agents `^0.7.0`. This sample
uses that same Agents family and OpenAI `^6.27.0`, without overrides forcing older
`agents-core` or OpenAI majors into newer extensions. A clean installation must
resolve one shared Agents runtime for application and A365 instrumentation.
Keep SDK packages on a coherent published family; local tarballs and development
version stamps are not deployment prerequisites.

When `ENABLE_A365_OBSERVABILITY_EXPORTER=true`, configure
`AGENT365_OBS_TENANT_ID`, `AGENT365_OBS_AGENT_ID`,
`AGENT365_OBS_BLUEPRINT_CLIENT_ID`, and `AGENT365_OBS_BLUEPRINT_CLIENT_SECRET`
using the supplied template. The agent ID must be the actual instance **client ID**,
not its blueprint, service-principal object ID, or agent-user ID. Roleless tokens
are accepted by the helper only with explicit `idtyp=app`. Confirm instance
registration and the selected route's service policy; this sample grants no permissions.

The sample-local `src/observability-token-service.ts` uses the autonomous FMI flow:
blueprint `client_credentials` plus `fmi_path` → T1 → agent `client_credentials`
for the OBS audience. MCP/Graph/OBO authentication is unchanged. OBS no longer
uses `Use_Custom_Resolver` or the delegated token cache. Missing configuration,
identity mismatch, expired tokens, and rejected grants fail explicitly; no empty,
stale, delegated-token, or legacy-route fallback is allowed. Check provisioning
and credentials on `AADSTS82001`; check token identity, registration and service
policy on 401/403 rather than automatically adding an OBS grant.

This credential example is for development; keep blueprint secrets in a secret
store and never log token bodies. See the repository's **Observability routing**
section for service-side caller-attribution restrictions and offline test commands.

This sample demonstrates how to build an agent using OpenAI in Node.js with the Microsoft Agent 365 SDK. It covers:

- **Observability**: End-to-end tracing, caching, and monitoring for agent applications
- **Notifications**: Services and models for managing user notifications
- **Tools**: Model Context Protocol tools for building advanced agent solutions
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for Node.js](https://github.com/microsoft/Agent365-nodejs).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Prerequisites

- Node.js 18.x or higher
- Microsoft Agent 365 SDK
- OpenAI Agents SDK
- Azure/OpenAI API credentials

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
- [OpenAI API documentation](https://platform.openai.com/docs/)
- [Node.js API documentation](https://learn.microsoft.com/javascript/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](LICENSE.md) file for details.