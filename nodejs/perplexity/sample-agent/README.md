# Perplexity Sample Agent - Node.js

## Legacy S2S export with separate OBS-only application authentication

`src/index.ts` imports `src/otel.ts` first. This sample-local bootstrap loads
dotenv and configures one legacy `ObservabilityManager` before agent and HTTP
imports. `Agent365ExporterOptions.useS2SEndpoint = true` selects
`/observabilityService/tenants/{tenantId}/agents/{agentId}/traces?api-version=1`,
not the public `/otlp` route. The manager uses
`.withTokenResolver(createObservabilityTokenResolver())`; agents and clients do
not create additional managers.
Leave `ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT` unset or false. Startup
rejects that legacy mode because it bypasses the app-only resolver for a
context-supplied token.

**SDK module note:** Agent 365 packages are pinned to the published
`0.1.0-preview.115` version, without a caret. Imports use
`@microsoft/agents-a365-observability`, including its legacy `TenantDetails`,
`InvokeAgentDetails`, `ExecutionType`, and scope signatures. These APIs are not
interchangeable with the `@microsoft/opentelemetry` distribution.
`@opentelemetry/core@2.1.0` is explicit because the preview.115 exporter imports
it without declaring it; relying on incidental dependency hoisting can fail at startup.

When `ENABLE_A365_OBSERVABILITY_EXPORTER=true`, set `AGENT365_OBS_TENANT_ID`,
`AGENT365_OBS_AGENT_ID`, `AGENT365_OBS_BLUEPRINT_CLIENT_ID`, and
`AGENT365_OBS_BLUEPRINT_CLIENT_SECRET` from the template. The agent value must be
the actual provisioned instance **client ID**, not its blueprint or agent-user ID.
Confirm instance registration and the selected route's service policy; the sample grants no permissions.

The unchanged `src/observability-token-service.ts` uses blueprint credentials
plus `fmi_path` to acquire T1, then the actual agent's `client_credentials` grant
to the OBS resource scope. It accepts absent or empty roles only with `idtyp=app`.
It rejects every token containing `scp`, invalid roles or app-only type,
incorrect client/tenant/audience, and missing or expired
lifetimes. No empty, stale, delegated-token, or route fallback is permitted.
Business Graph/presence/OBO flows and their caches are unchanged.
Attribution uses `recipient.agenticAppId` and the activity tenant, with explicit
`AGENT365_OBS_*` fallbacks when metadata is absent, never the blueprint as agent.
Actual caller ID/name metadata remains separate from the application credential.

Public OTLP can authorize eligible registered instances without an OBS-specific
role grant, subject to service policy. That does **not** establish access to this
legacy route, which has distinct service-principal and tenant admission policies.
An app-only token, with or without roles, is not proof of service acceptance.
No general legacy admission is claimed. Keep blueprint credentials in a secret
store and confirm the selected route's service policy instead of automatically granting `OtelWrite`.

This sample demonstrates how to build an agent using Perplexity in Node.js with the Microsoft Agent 365 SDK. It covers:

- **Observability**: End-to-end tracing, caching, and monitoring for agent applications
- **Notifications**: Services and models for managing user notifications
- **Tools**: Model Context Protocol tools for building advanced agent solutions
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for Node.js](https://github.com/microsoft/Agent365-nodejs).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Prerequisites

- Node.js 22.x or higher
- Microsoft Agent 365 SDK
- Perplexity API credentials

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

## Sending Multiple Messages in Teams

Agent365 agents can send multiple discrete messages in response to a single user prompt in Teams. This is achieved by calling `sendActivity` multiple times within a single turn.

> **Important**: Streaming responses are not supported for agentic identities in Teams. The SDK detects agentic identity and buffers the stream into a single message. Use `sendActivity` directly to send immediate, discrete messages to the user.

The sample demonstrates this in the message activity handler ([agent.ts](src/agent.ts)):

```typescript
// Message 1: immediate ack — reaches the user right away
await context.sendActivity('Got it — working on it…');

// ... LLM processing ...

// Message 2: the LLM response
await context.sendActivity(modelResponse);
```

Each `sendActivity` call produces a separate Teams message. You can call it as many times as needed to send progress updates, partial results, or a final answer.

### Typing Indicators

The agent sends typing indicators in a loop every ~4 seconds to keep the `...` animation alive while the LLM processes the request:

```typescript
let typingInterval: ReturnType<typeof setInterval> | undefined;
const startTypingLoop = () => {
  typingInterval = setInterval(async () => {
    await context.sendActivity(Activity.fromObject({ type: ActivityTypes.Typing }));
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
- [Perplexity API documentation](https://docs.perplexity.ai/)
- [Node.js API documentation](https://learn.microsoft.com/javascript/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](LICENSE.md) file for details.
