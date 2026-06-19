# Agent Framework Sample — App Registration Setup

## Overview

This sample demonstrates how to set up a Custom Engine Agent using the [Agent Framework](https://github.com/microsoft/agent-framework) with the Microsoft Agent 365 SDK and Microsoft 365 Agents SDK, deployed as a Docker container on Azure App Service.

It covers:

- **App Registration**: Manual Azure AD app registration for bot authentication (SingleTenant)
- **Docker Deployment**: Containerized deployment to Azure App Service (Linux)
- **Teams SSO**: Single Sign-On with On-Behalf-Of (OBO) token flow
- **MCP Tooling**: Agent 365 Tools integration via Model Context Protocol
- **Observability**: End-to-end tracing via OpenTelemetry and A365 Service Exporter
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for .NET](https://github.com/microsoft/Agent365-dotnet).

For comprehensive documentation, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Prerequisites

- .NET 8.0 or higher
- Docker Desktop
- Azure CLI (`az`)
- Azure subscription with:
  - Azure Container Registry (ACR)
  - Azure App Service (Linux, B1 or higher)
  - Azure Bot resource (F0 or S1)
- Azure AD app registration (SingleTenant)
- Azure OpenAI resource with a deployed model (e.g., `gpt-4.1`)
- OpenWeather API key (free tier) — see: https://openweathermap.org/price

## Setup Guide

For step-by-step deployment instructions, see [claude.md](claude.md).

## Architecture

```
Teams Client
    │
    ▼
Bot Framework Service (MsTeams Channel)
    │
    ▼
Azure App Service (Docker container, port 8080)
    │  POST /api/messages
    ▼
ASP.NET Core → CloudAdapter → MyAgent
    │
    ├── Teams SSO → OBO Token Exchange → MCP Tools (Agent 365)
    ├── Azure OpenAI (gpt-4.1) — Chat completions with function calling
    └── Local Tools (Weather, DateTime)
```

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

## Key Files

| File | Purpose |
|---|---|
| `Program.cs` | ASP.NET host setup, DI registration, `/api/messages` endpoint |
| `Agent/MyAgent.cs` | Agent logic — message handling, LLM orchestration, tool loading |
| `appsettings.json` | Bot auth, Azure OpenAI, and agent configuration (use placeholders for secrets) |
| `appPackage/manifest.json` | Teams app manifest for sideloading |
| `telemetry/AgentMetrics.cs` | OpenTelemetry instrumentation for HTTP and agent operations |
| `telemetry/A365OtelWrapper.cs` | A365 observability wrapper with baggage propagation |
| `ToolingManifest.json` | MCP tool server configuration |
| `Dockerfile` | Multi-stage Docker build for Linux container deployment |

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
