# Agent Framework (Simple) Sample

## Overview
This is a simple sample showing how to use the [Agent Framework](https://github.com/microsoft/agent-framework) as the orchestrator in an agent using the Microsoft Agent 365 SDK and Microsoft 365 Agents SDK
It covers:

- **Observability**: End-to-end tracing, caching, and monitoring for agent applications
- **Notifications**: Services and models for managing user notifications
- **Tools**: Model Context Protocol tools for building advanced agent solutions
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for .NET](https://github.com/microsoft/Agent365-dotnet).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Prerequisites

- .NET 8.0 or higher
- Microsoft Agent 365 SDK
- Azure/OpenAI API credentials
- OpenWeather Credentials (if using the OpenWeather Tool) 
    - see: https://openweathermap.org/price - You will need to create a free account to get an API key (its at the bottom of the page).

## Working with User Identity

On every incoming message, the A365 platform populates `Activity.From` with basic user information — always available with no API calls or token acquisition:

| Field | Description |
|---|---|
| `Activity.From.Id` | Channel-specific user ID (e.g., `29:1AbcXyz...` in Teams) |
| `Activity.From.Name` | Display name as known to the channel |
| `Activity.From.AadObjectId` | Azure AD Object ID — use this to call Microsoft Graph |

The sample logs these fields at the start of every turn in `OnMessageAsync` ([MyAgent.cs](Agent/MyAgent.cs)) and injects `Activity.From.Name` into the LLM system instructions for personalized responses:

```csharp
var fromAccount = turnContext.Activity.From;
_logger?.LogInformation(
    "Turn received from user — DisplayName: '{Name}', UserId: '{Id}', AadObjectId: '{AadObjectId}'",
    fromAccount?.Name ?? "(unknown)",
    fromAccount?.Id ?? "(unknown)",
    fromAccount?.AadObjectId ?? "(none)");
```

## Handling Agent Install and Uninstall

When a user installs (hires) or uninstalls (removes) the agent, the A365 platform sends an `InstallationUpdate` activity — also referred to as the `agentInstanceCreated` event. The sample handles this in `OnInstallationUpdateAsync` ([MyAgent.cs](Agent/MyAgent.cs)):

| Action | Description |
|---|---|
| `add` | Agent was installed — send a welcome message |
| `remove` | Agent was uninstalled — send a farewell message |

```csharp
if (turnContext.Activity.Action == InstallationUpdateActionTypes.Add)
{
    await turnContext.SendActivityAsync(MessageFactory.Text(AgentHireMessage), cancellationToken);
}
else if (turnContext.Activity.Action == InstallationUpdateActionTypes.Remove)
{
    await turnContext.SendActivityAsync(MessageFactory.Text(AgentFarewellMessage), cancellationToken);
}
```

The handler is registered twice in the constructor — once for agentic (A365 production) requests and once for non-agentic (Agents Playground / WebChat) requests, enabling local testing without a full A365 deployment.

To test with Agents Playground, use **Mock an Activity → Install application** to send a simulated `installationUpdate` activity.

## Sending Multiple Messages in Teams

Agent365 agents can send multiple discrete messages in response to a single user prompt in Teams. This is achieved by calling `SendActivityAsync` multiple times within a single turn.

> **Important**: Streaming responses are not supported for agentic identities in Teams. The SDK detects agentic identity and buffers the stream into a single message. Use `SendActivityAsync` directly to send immediate, discrete messages to the user.

The sample demonstrates this in `OnMessageAsync` ([MyAgent.cs](Agent/MyAgent.cs)) by sending an immediate acknowledgment before the LLM response:

```csharp
// Message 1: immediate ack — reaches the user right away
await turnContext.SendActivityAsync(MessageFactory.Text("Got it — working on it…"), cancellationToken);

// ... LLM processing ...

// Message 2: the LLM response (via StreamingResponse, buffered into one message for Teams agentic)
await turnContext.StreamingResponse.EndStreamAsync(cancellationToken);
```

Each `SendActivityAsync` call produces a separate Teams message. You can call it as many times as needed to send progress updates, partial results, or a final answer.

### Typing Indicators

For long-running operations, send a typing indicator to show a "..." progress animation in Teams:

```csharp
// Typing indicator loop — refreshes every ~4s for long-running operations.
using var typingCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
var typingTask = Task.Run(async () =>
{
    try
    {
        while (!typingCts.IsCancellationRequested)
        {
            await turnContext.SendActivityAsync(Activity.CreateTypingActivity(), typingCts.Token);
            await Task.Delay(TimeSpan.FromSeconds(4), typingCts.Token);
        }
    }
    catch (OperationCanceledException) { /* expected on cancel */ }
}, typingCts.Token);

try { /* ... do work ... */ }
finally
{
    typingCts.Cancel();
    try { await typingTask; } catch (OperationCanceledException) { }
}
```

> **Note**: Typing indicators are only visible in 1:1 chats and small group chats — not in channels.

## Observability

### Required OBS-only application credentials

Configure the separate `Agent365Observability` credentials before starting the app:

```json
{
  "Agent365Observability": {
    "TenantId": "<<AGENT_HOME_TENANT_ID>>",
    "AgentId": "<<AGENT_INSTANCE_CLIENT_ID>>",
    "BlueprintClientId": "<<BLUEPRINT_CLIENT_ID>>",
    "UseManagedIdentity": true,
    "ManagedIdentityClientId": ""
  }
}
```

`AgentId` is the actual agent instance **application/client ID**, not its service principal
object ID or the blueprint ID. Empty `ManagedIdentityClientId` selects the system-assigned
identity; set it to a user-assigned managed identity client ID otherwise. This identity must
already be configured as a federated credential on the blueprint. For local development,
set `UseManagedIdentity` to `false` and supply `Agent365Observability:BlueprintClientSecret`
through user secrets, or `Agent365Observability__BlueprintClientSecret` through the environment.
All settings support the standard .NET double-underscore environment syntax. Never commit secrets.

The [shared OBS provider](../../shared/Observability/ObservabilityAppTokenProvider.cs) uses the
[documented app-only flow](https://learn.microsoft.com/en-us/entra/agent-id/autonomous-agent-authentication-authorization-flow):
blueprint `client_credentials` with `fmi_path=AgentId` and `api://AzureADTokenExchange/.default`
produces T1; agent `client_credentials` uses T1 as `client_assertion` for
`api://9b975845-388f-4429-889e-eab1ef63949c/.default`. The existing autonomous sample uses the same
protocol through MSAL. No `user_fic`, OBO, or developer bearer token is used for OBS.
Business MCP/Graph authentication and original user/agent baggage are unchanged.

An app-only OBS token with `idtyp=app` may omit `roles` or have `roles: []`. Roleless service
acceptance requires an **eligible registered Agent 365 agent instance** and authorization
under service policy; selecting S2S or creating an Entra identity alone is insufficient.
Do not add an `Agent365.Observability.OtelWrite` grant solely to populate a `roles` claim.
Existing role-based authorization requirements still apply where used. Business OBO/MCP/Graph
permissions and consent remain independent.

**Troubleshooting:** Missing/placeholder settings or using the blueprint as `AgentId` fail at startup.
Tenant/agent export mismatches, any delegated `scp` claim (even empty), explicit non-app/null
`idtyp`, malformed `roles`, malformed responses, or expired tokens fail closed without a fallback
credential. Tokens without `idtyp` remain compatible only with a valid nonempty array of
nonblank string roles. Configure the actual identity represented in the original turn baggage;
do not rewrite baggage to bypass a mismatch. For service authorization failures, verify instance
registration, eligibility and service policy; the sample neither provisions identities nor changes
permissions. Acquisition has a 30-second bound and expiry-aware caching with a two-minute refresh
margin; a failed refresh never returns a stale token.

**Build/deployment:** Build from the repository checkout, retaining `dotnet/shared/Observability`.
The project links that source into its own application assembly; `dotnet publish` output is
standalone and needs no sibling source directory at runtime. If copying only `sample-agent` as
source, also copy the two shared `.cs` files into `Observability/`, remove the external `Compile`
item, and retain the `Azure.Identity` package alias in the project. Do not deploy a source-only
sample directory without its linked helper.

This sample uses the [`Microsoft.OpenTelemetry`](https://www.nuget.org/packages/Microsoft.OpenTelemetry) distro, configured in `Program.cs` with a single call:

```csharp
builder.UseMicrosoftOpenTelemetry(o =>
{
    o.Exporters = builder.Environment.IsDevelopment()
        ? ExportTarget.Agent365 | ExportTarget.Console
        : ExportTarget.Agent365;

    o.Agent365.Exporter.UseS2SEndpoint = true;
    o.Agent365.Exporter.TokenResolver = observabilityTokens.ResolveAsync;

    o.Instrumentation.EnableAspNetCoreInstrumentation = true;
    o.Instrumentation.EnableHttpClientInstrumentation = true;
    o.Instrumentation.EnableAzureSdkInstrumentation = true;
});
```

This produces the following spans automatically — no custom tracing code required:

| Span | Source | What it captures |
|---|---|---|
| `POST /api/messages` | ASP.NET Core | Inbound request — method, path, status code |
| `POST login.microsoftonline.com` | HttpClient | MSAL token acquisition |
| `POST smba.trafficmanager.net` | HttpClient | Outbound Teams messages |
| `POST …openai.azure.com/…/chat/completions` | HttpClient | Raw Azure OpenAI HTTP call |
| `chat <model>` | `Microsoft.Extensions.AI` | Full `gen_ai.*` semantics — model, tool definitions, system prompt, input/output messages, token counts, finish reason |
| `invoke_agent <id>` | `Microsoft.Agents.AI` | Agent-level span — agent ID, input/output, token counts |

The `gen_ai.*` attributes on the `chat` span come from `.UseOpenTelemetry()` on the `ChatClientAgent` builder in `Program.cs`. This is the only non-distro observability call in the sample and is worth keeping — it enriches every LLM call with structured semantic data at no cost.

### Service Name

By default the OTel SDK sets `service.name` to `unknown_service:<process-name>`. Set the standard `OTEL_SERVICE_NAME` environment variable to give your service a meaningful name in traces:

```bash
OTEL_SERVICE_NAME="Agent Framework Sample"
```

Set this in your local launch profile, deployment environment, or container configuration to match your service catalog.

## Running the Agent

To set up and test this agent, refer to the [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing?tabs=dotnet) guide for complete instructions.

For a detailed explanation of the agent code and implementation, see the [Agent Code Walkthrough](Agent-Code-Walkthrough.md).

## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-dotnet/issues) section
- **Documentation**: See the [Microsoft Agents 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: For security issues, please see [SECURITY.md](SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 SDK - .NET repository](https://github.com/microsoft/Agent365-dotnet)
- [Microsoft 365 Agents SDK - .NET repository](https://github.com/Microsoft/Agents-for-net)
- [Semantic Kernel documentation](https://learn.microsoft.com/semantic-kernel/)
- [.NET API documentation](https://learn.microsoft.com/dotnet/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](LICENSE.md) file for details.
