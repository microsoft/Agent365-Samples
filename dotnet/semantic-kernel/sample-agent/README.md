# Semantic Kernel Sample Agent - C#/.NET

This sample demonstrates how to build an agent using Semantic Kernel in C#/.NET with the Microsoft Agent 365 SDK. It covers:

- **Observability**: End-to-end tracing, caching, and monitoring for agent applications
- **Notifications**: Services and models for managing user notifications
- **Tools**: Model Context Protocol tools for building advanced agent solutions
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for .NET](https://github.com/microsoft/Agent365-dotnet).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Prerequisites

- .NET 8.0 or higher
- Microsoft Agent 365 SDK
- Semantic Kernel 1.66.0 or higher
- Azure/OpenAI API credentials

## Launch Profiles

Before selecting either profile, configure the **separate OBS-only application credentials**
in `Agent365Observability`: `TenantId` (agent home tenant GUID), `AgentId` (actual agent instance
client ID, never the blueprint or service principal object ID), and `BlueprintClientId`.
For Azure, set `UseManagedIdentity=true`; optional `ManagedIdentityClientId` selects a user-assigned
identity, otherwise the system-assigned identity is used. The blueprint federation must already exist.
For local development set `UseManagedIdentity=false` and supply `BlueprintClientSecret` through
user secrets or the `Agent365Observability__BlueprintClientSecret` environment variable.
The template is in `appsettings.json`; all keys support standard .NET double-underscore environment names.

The shared provider obtains a blueprint T1 using `client_credentials`, `fmi_path=AgentId`, and
`api://AzureADTokenExchange/.default`, then uses T1 as the agent's client assertion for
`api://9b975845-388f-4429-889e-eab1ef63949c/.default`.
This is the [documented app-only protocol](https://learn.microsoft.com/en-us/entra/agent-id/autonomous-agent-authentication-authorization-flow),
not OBO or `user_fic`. Existing business MCP/Graph tokens, auth handlers, and original turn baggage
remain unchanged; a developer bearer token cannot authenticate S2S OBS.

An app-only OBS token with `idtyp=app`, or without `idtyp` but with `oid` equal to `sub`, may
omit `roles` or have `roles: []`. Roleless service acceptance requires an **eligible registered
Agent 365 agent instance** and authorization under service policy; selecting S2S or creating an
Entra identity alone is insufficient.
Do not add an `Agent365.Observability.OtelWrite` grant solely to populate a `roles` claim.
Existing role-based authorization requirements still apply where used. Business OBO/MCP/Graph
permissions and consent remain independent.

**Troubleshooting:** Missing/placeholder credentials fail startup. Export tenant/agent mismatches,
any delegated `scp` claim (even empty), explicit non-app/null `idtyp`, malformed `roles`, and
invalid/expired responses are rejected rather than replaced with another identity or stale token.
Tokens without `idtyp` need either `oid` equal to `sub` or a valid nonempty array of nonblank string roles.
The configured identity must match the turn baggage. For service authorization failures, verify
instance registration, eligibility and service policy. No permissions are changed by the sample.
Requests have a 30-second bound; the isolated cache refreshes two minutes before the earliest expiry.

**Deployment:** Retain `dotnet/shared/Observability` when building from source. Its files are linked
into this application's assembly, so `dotnet publish` output is standalone without sibling files
at runtime. To copy only the source sample, copy both shared `.cs` files into `Observability/`,
remove the project's external `Compile` item, and retain the `Azure.Identity` alias.
Microsoft.OpenTelemetry 1.0.1 is explicitly configured with
`o.Agent365.Exporter.UseS2SEndpoint = true` and the dedicated provider's `TokenResolver`.

This sample includes two launch profiles in `Properties/launchSettings.json`:

### Sample Agent

Uses Agentic Users with Client Credentials or Managed Identity. Use this for production or when testing with full Azure Bot Service configuration.

### Sample Agent with Bearer Token Support

Simplified profile for early local development using bearer token authentication.

**Quick setup:**
1. Add required permissions using the a365 CLI:
   ```bash
   a365 develop add-permissions
   ```
   This grants the necessary scopes for MCP tool access.

2. Get a bearer token:
   ```bash
   a365 develop get-token
   ```
   The CLI will either automatically add the token to your `launchSettings.json` or provide it for you to copy/paste.

3. Select the "Sample Agent with Bearer Token Support" launch profile in Visual Studio
4. Run the agent

> **Note**: Bearer tokens are for development only and expire regularly. Refresh with `a365 develop get-token`.

## Working with User Identity

On every incoming message, the A365 platform populates `Activity.From` with basic user information — always available with no API calls or token acquisition:

| Field | Description |
|---|---|
| `Activity.From.Id` | Channel-specific user ID (e.g., `29:1AbcXyz...` in Teams) |
| `Activity.From.Name` | Display name as known to the channel |
| `Activity.From.AadObjectId` | Azure AD Object ID — use this to call Microsoft Graph |

The sample logs these fields at the start of every message turn and injects the display name into the LLM system instructions for personalized responses.

## Handling Agent Install and Uninstall

When a user installs (hires) or uninstalls (removes) the agent, the A365 platform sends an `InstallationUpdate` activity. The sample handles this in `OnHireMessageAsync` ([Agents/MyAgent.cs](Agents/MyAgent.cs)):

| Action | Description |
|---|---|
| `add` | Agent was installed — send a welcome message |
| `remove` | Agent was uninstalled — send a farewell message |

```csharp
if (turnContext.Activity.Action == InstallationUpdateActionTypes.Add)
{
    await turnContext.SendActivityAsync(MessageFactory.Text("Thank you for hiring me! Looking forward to assisting you in your professional journey!"), cancellationToken);
}
else if (turnContext.Activity.Action == InstallationUpdateActionTypes.Remove)
{
    await turnContext.SendActivityAsync(MessageFactory.Text("Thank you for your time, I enjoyed working with you."), cancellationToken);
}
```

To test with Agents Playground, use **Mock an Activity → Install application** to send a simulated `installationUpdate` activity.

## Sending Multiple Messages in Teams

Agent365 agents can send multiple discrete messages in response to a single user prompt in Teams. This is achieved by calling `SendActivityAsync` multiple times within a single turn.

> **Important**: Streaming responses are buffered by the SDK for Teams agentic identities and delivered as a single message. Use `SendActivityAsync` directly to send immediate, discrete messages to the user.

The ack and typing indicator are sent in `MessageActivityAsync` **before** agent initialization ([Agents/MyAgent.cs](Agents/MyAgent.cs)). This guarantees they arrive as discrete messages before the streaming connection opens:

```csharp
// Message 1: immediate ack
await turnContext.SendActivityAsync(MessageFactory.Text("Got it — working on it…"), cancellationToken);

// Typing indicator — visible while agent initializes, before the streaming response opens.
// Only visible in 1:1 and small group chats, not in channels.
await turnContext.SendActivityAsync(Activity.CreateTypingActivity(), cancellationToken);
```

Once agent initialization completes, the streaming response opens and takes over as the visual indicator:

```csharp
// Streaming response — arrives as message 2, buffered by the SDK for Teams agentic identities.
await turnContext.StreamingResponse.QueueInformativeUpdateAsync("Working on a response for you", cancellationToken);
// LLM call streams response chunks via QueueTextChunk...
await turnContext.StreamingResponse.EndStreamAsync(cancellationToken);
```

### Typing Indicators

Typing indicators show a `...` animation in Teams while the agent is working. They have a ~5-second visual timeout and must be re-sent to stay visible for long-running operations. For this sample, a single typing indicator is sent before the streaming response opens — once streaming starts, it takes over as the progress indicator.

> **Note**: Typing indicators are only visible in 1:1 chats and small group chats — not in channels.

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
