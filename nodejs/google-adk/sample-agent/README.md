# Google ADK Sample Agent - Node.js

## Demonstrates

This sample demonstrates how to build an agent using Google ADK (Agent Development Kit) in Node.js with the Microsoft Agent 365 SDK. It covers:

- **Observability**: End-to-end tracing, caching, and monitoring via Microsoft OpenTelemetry Distro
- **Notifications**: Handling email, Word comment, and lifecycle notifications
- **Tools**: Model Context Protocol (MCP) tools for sending emails and more
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for Node.js](https://github.com/microsoft/Agent365-nodejs).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Prerequisites

To run the template in your local dev machine, you will need:

- [Node.js](https://nodejs.org/), supported versions: 22.12 or higher (with npm)
- [Microsoft 365 Agents Toolkit Visual Studio Code Extension](https://aka.ms/teams-toolkit) latest version
- A Google Cloud project with Vertex AI enabled, or a Google API key
- Azure CLI signed in with `az login`

> - Microsoft Agent 365 SDK
> - Google ADK 1.1.0 or higher
> - A365 CLI: Required for agent deployment and management.

## Running the Agent in Microsoft 365 Agents Playground

1. First, select the Microsoft 365 Agents Toolkit icon on the left in the VS Code toolbar.
2. Copy `env/.env.playground` to the **gitignored** `env/.env.playground.user`. In the user copy only, set `GOOGLE_GENAI_USE_VERTEXAI=FALSE` and `GOOGLE_GENAI_API_KEY=<your-key>` for the public Gemini API. Never put credentials in the tracked template.
3. Or for Vertex AI, set `GOOGLE_GENAI_USE_VERTEXAI=TRUE`, `GOOGLE_CLOUD_PROJECT=<your-project>`, and `GOOGLE_CLOUD_LOCATION=<your-region>` in the user copy. Keep `AGENT_ENV_FILE=env/.env.playground.user` so startup loads this file rather than the root `.env`. F5 and both Playground scripts use the ignored user file.
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

Anonymous access is permitted only with `NODE_ENV=development` and no Azure App Service marker. Production/App Service (and environments not explicitly marked as local development) must supply a nonempty authentication client ID; configuration-loading errors fail startup before listening. Anonymous message and notification handlers pass no authorization object to the agent.

Rejected adapter processing is handled by Express rather than becoming an unhandled rejection. Requests that fail before a response receive a generic HTTP 500 without exception details; if headers have already been sent, Express handles the connection error. Health endpoints remain available after request failures.

### Configuration and observability

Copy [.env.example](.env.example) to `.env`, populate the Google model settings and existing Agent 365 service connection, then run:

```shell
npm install
npm run build
npm start
```

For Teams workload authorization, set `AUTH_HANDLER_NAME=AGENTIC`. Leave it empty for bare local/Playground testing without MCP tools.

```dotenv
ENABLE_OBSERVABILITY=true
ENABLE_A365_OBSERVABILITY_EXPORTER=true
OTEL_LOG_LEVEL=INFO
A365_OBSERVABILITY_LOG_LEVEL=info|warn|error
```

Telemetry uses an **app-only token and S2S transport**, independently of the delegated agentic-user tokens used for MCP/Graph. The resolver reuses the adapter's default blueprint connection, obtains an FMI assertion for the runtime agent identity, validates the resulting token claims, and caches tokens per agent/tenant. No separate telemetry credentials are needed.

The resolver currently targets the commercial-cloud authority `login.microsoftonline.com`; sovereign clouds require provider changes and are not supported by this sample. AI Teammate S2S export without the `Agent365.Observability.OtelWrite` application-role assignment has not been validated in this sample. Follow the application-role step printed by your CLI for this validation path; do not assume a delegated grant authorizes S2S export. Registered-instance authorization is service-policy dependent; see [S2S operator guidance](../../../docs/observability-s2s.md).

Checked-in local and Playground templates keep export disabled. Enable `ENABLE_A365_OBSERVABILITY_EXPORTER=true` explicitly only after validating identity and authorization; the block above is the opt-in configuration, not the template default.

### Local MCP versus agentic authorization

`BEARER_TOKEN` is a development-only **discovery/shared-audience** credential. When a local activity lacks an agent ID, set `AGENTIC_APP_ID` or `A365_AGENT_APP_INSTANCE_ID` to the real runtime application instance ID, not a blueprint or agent-user ID. This fallback applies only to local bearer-token tooling and does not change the runtime-only telemetry guards.

The shipped V2 mail server and other audience-specific V2 servers **require `AUTH_HANDLER_NAME=AGENTIC`**, the configured blueprint connection, and a real agentic activity so the handler can acquire separate resource tokens. Bearer-only mode does not support those servers; it fails explicitly rather than reusing the discovery token for a different audience. Use Teams for this agentic workflow. Without an auth handler or bearer token, Playground runs in bare LLM mode.

Nonempty development bearer tokens are rejected when `NODE_ENV=production` or `WEBSITE_SITE_NAME` is set. Remove them and use agentic authorization in deployed environments.

MCP initialization has a single **60-second total deadline** across discovery, response parsing, and per-resource token exchanges. Cancellation aborts discovery and stops initialization at asynchronous boundaries; partially created toolsets are closed on failure. The hosting token API does not accept an abort signal: an already-started exchange may finish internally, but its result is observed and cannot resume canceled initialization.

Google ADK calls are manually traced with `invoke_agent`, `chat`, `execute_tool`, and `output_messages` scopes. Baggage carries the conversation, channel, session, runtime agent, agent-user object ID (`recipient.aadObjectId`, not its UPN), and human-caller identities. Tool scopes wrap actual tool execution, including failures. Tool argument/result payloads are omitted in production and Azure App Service in both manual and native ADK spans. The agent enforces `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false` during construction and before each invocation in those environments, even if the setting was explicitly enabled. This suppresses native ADK request/response capture as well. Local development retains the ADK capture setting and can contain business content. Existing manual prompt/completion tracing still captures message content, so apply your data-handling policy before enabling export. Personalized instructions retain the configured base instructions and security rules.

The OpenTelemetry API override keeps Google ADK and the Microsoft distro on one compatible API version. Mixed API minor versions can produce no-op spans even when initialization reports success. Axios is declared because the tooling SDK loads it internally, although this sample's gateway calls use built-in `fetch`.

The runtime agent ID comes from the incoming activity, **never the blueprint ID or display name**. Local turns without a real runtime agent/tenant identity still return LLM responses but skip semantic telemetry with a warning. A missing runtime agent-user ID or human caller object ID cannot be invented from the blueprint config; test attribution with a real agentic turn.

Set `ENABLE_A365_OBSERVABILITY_EXPORTER=false` for local console-only tracing, or `ENABLE_OBSERVABILITY=false` to disable tracing entirely. Exporter logging uses the SDK's supported diagnostics; the sample does not patch global `fetch` or log upstream response bodies. Durable replay is disabled during the migration away from delegated telemetry.

### Regression tests

```shell
npm test
```

The tests use mocked model/tool/token calls and an in-memory span processor; they need no cloud credentials and do not prove live export. The CI Orchestrator runs this suite on Node.js 22.12 and includes its result in the required aggregate CI Status.

## Troubleshooting

- **No A365 export:** Confirm both observability flags above are true in the running process, not just the template. Check SDK logs for export success or rejected spans.
- **Local turns skip telemetry:** Playground messages may lack runtime agent identity. Use an approved AI Teammate instance and a real agentic activity; do not fill the gap with a blueprint ID.
- **Token acquisition or claim-validation warning:** Verify the default service connection, tenant, and runtime agent identity. A delegated token is not accepted for telemetry. Do not copy the encrypted secret from the generated config directly into `.env`.
- **Gemini returns 403 / API disabled:** Enable the [Gemini API](https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com) in the Google Cloud project owning the key, or use a key from an enabled project. `GOOGLE_GENAI_API_KEY` (or `GEMINI_API_KEY`) is required for public Gemini; `GOOGLE_API_KEY` is not read by this ADK adapter. Model error events are logged with a sanitized reason and fail the turn instead of being reported as a successful fallback.
- **MCP token is empty / connection not found:** Set `agentic_altBlueprintConnectionName=SERVICE_CONNECTION`. Connection lookup is case-sensitive and must match the configured connection name, not a scope URL. The authorization failure callback logs a safe error category.
- **MCP discovery fails:** Check the reported HTTP status and workload permissions. Both gateway array response shapes are supported; malformed payloads are rejected rather than silently treated as an empty catalog. V2 tool servers receive a separate workload token for their advertised audience/scope using the SDK resolver; the discovery token is not reused for a different resource. Configured tool/auth initialization failures fail the turn; bare local LLM mode remains available when no token or auth handler is configured.
- **Export succeeds but Activity is empty:** Export acceptance alone does not establish reporting eligibility. Verify agent-instance approval, caller attribution, and indexing in the target tenant. Filter Activity using the runtime agent ID, not the blueprint ID.

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
