# Devin (Cognition AI) Sample Agent

## Overview

This sample demonstrates how to use [Devin](https://devin.ai) (by Cognition AI) as the AI backbone in an agent using the **Microsoft Agent 365 SDK** and **Microsoft 365 Agents SDK**. It enables enterprise developers to connect Devin's autonomous coding agent capabilities into Agent 365 managed environments.

It covers:

- **Devin API Integration**: Forward messages to Devin and poll for responses
- **Observability**: End-to-end tracing, caching, and monitoring for agent applications
- **Notifications**: Services and models for managing user notifications
- **Multi-turn Sessions**: Maintain Devin session across conversation turns
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Devin REST API](https://docs.devin.ai) and the [Microsoft Agent 365 SDK for .NET](https://github.com/microsoft/Agent365-dotnet).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Architecture

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────────┐
│  Agent 365 SDK  │      │   This Sample    │      │  Devin API          │
│  (Notifications)│─────>│   (MyAgent)      │─────>│  (Cognition AI)     │
└─────────────────┘      └──────────────────┘      └─────────────────────┘
        │                        │                          │
        │   Incoming message     │   POST /sessions         │
        │───────────────────────>│─────────────────────────>│
        │                        │                          │
        │                        │   Poll GET /sessions/{id}│
        │                        │─────────────────────────>│
        │                        │                          │
        │                        │   devin_message response │
        │   Response             │<─────────────────────────│
        │<───────────────────────│                          │
```

The agent does **not** call an LLM directly. Instead, it delegates all reasoning to Devin's hosted API (which uses Claude under the hood).

## Prerequisites

- [.NET 8.0 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) or later
- Microsoft Agent 365 SDK
- A [Devin](https://devin.ai) API key ([app.devin.ai](https://app.devin.ai))
- Agent 365 blueprint credentials (ClientId, ClientSecret, TenantId)

## Launch Profiles

This sample includes two launch profiles in `Properties/launchSettings.json`:

### Sample Agent

Uses Agentic Users with Client Credentials or Managed Identity. Use this for production or when testing with full Azure Bot Service configuration.

### Sample Agent (Playground)

Simplified profile for early local development using bearer token authentication.

**Quick setup:**
1. Add required permissions using the a365 CLI:
   ```bash
   a365 develop add-permissions
   ```
   This grants the necessary scopes for agent access.

2. Get a bearer token:
   ```bash
   a365 develop get-token
   ```
   The CLI will either automatically add the token to your `launchSettings.json` or provide it for you to copy/paste.

3. Select the "Sample Agent (Playground)" launch profile in Visual Studio
4. Run the agent

> **Note**: Bearer tokens are for development only and expire regularly. Refresh with `a365 develop get-token`.

## Configuration

### Devin API Settings

Get your API key from the [Devin dashboard](https://app.devin.ai).

In `appsettings.json`:
```json
{
  "Devin": {
    "BaseUrl": "https://api.devin.ai/v1",
    "ApiKey": "<your-devin-api-key>",
    "PollingIntervalSeconds": 10,
    "TimeoutSeconds": 300
  }
}
```

### Authentication

Configure the blueprint connection in `appsettings.json` under `Connections` > `ServiceConnection`:

```json
{
  "Connections": {
    "ServiceConnection": {
      "Settings": {
        "AuthType": "ClientSecret",
        "ClientId": "<your-agent-blueprint-id>",
        "ClientSecret": "<your-client-secret>",
        "AuthorityEndpoint": "https://login.microsoftonline.com/<your-tenant-id>",
        "Scopes": ["5a807f24-c9de-44ee-a3a7-329e88a00ffc/.default"]
      }
    }
  }
}
```

## Working with User Identity

On every incoming message, the A365 platform populates `Activity.From` with basic user information — always available with no API calls or token acquisition:

| Field | Description |
|---|---|
| `Activity.From.Id` | Channel-specific user ID (e.g., `29:1AbcXyz...` in Teams) |
| `Activity.From.Name` | Display name as known to the channel |
| `Activity.From.AadObjectId` | Azure AD Object ID — use this to call Microsoft Graph |

The sample logs these fields at the start of every message turn in `OnMessageAsync` ([MyAgent.cs](Agent/MyAgent.cs)):

```csharp
var fromAccount = turnContext.Activity.From;
_logger.LogDebug(
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
    _logger.LogInformation("Agent installed");
    await turnContext.SendActivityAsync(MessageFactory.Text(AgentHireMessage), cancellationToken);
}
else if (turnContext.Activity.Action == InstallationUpdateActionTypes.Remove)
{
    _logger.LogInformation("Agent uninstalled");
    await turnContext.SendActivityAsync(MessageFactory.Text(AgentFarewellMessage), cancellationToken);
}
```

The handler is registered twice in the constructor — once for agentic (A365 production) requests and once for non-agentic (Agents Playground / WebChat) requests, enabling local testing without a full A365 deployment.

To test with Agents Playground, use **Mock an Activity → Install application** to send a simulated `installationUpdate` activity.

## Sending Multiple Messages in Teams

Agent365 agents can send multiple discrete messages in response to a single user prompt in Teams. This is achieved by calling `SendActivityAsync` multiple times within a single turn.

> **Important**: Streaming responses are not supported for agentic identities in Teams. The SDK detects agentic identity and buffers the stream into a single message. Use `SendActivityAsync` directly to send immediate, discrete messages to the user.

The sample demonstrates this in `OnMessageAsync` ([MyAgent.cs](Agent/MyAgent.cs)) by sending an immediate acknowledgment before the Devin response:

```csharp
// Message 1: immediate ack — reaches the user right away
await turnContext.SendActivityAsync(MessageFactory.Text("Got it — working on it…"), cancellationToken);

// ... Devin API polling ...

// Message 2: the Devin response
await turnContext.SendActivityAsync(MessageFactory.Text(response), cancellationToken);
```

Each `SendActivityAsync` call produces a separate Teams message. You can call it as many times as needed to send progress updates, partial results, or a final answer.

### Typing Indicators

For long-running operations (Devin typically takes 10-60s), the agent sends typing indicators every ~4 seconds to show a "..." progress animation:

```csharp
// Typing indicator loop — refreshes every ~4s for long-running operations.
using var typingCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
var typingTask = Task.Run(async () =>
{
    try
    {
        while (!typingCts.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromSeconds(4), typingCts.Token);
            await turnContext.SendActivityAsync(
                new Activity { Type = ActivityTypes.Typing }, typingCts.Token);
        }
    }
    catch (OperationCanceledException) { /* expected on cancel */ }
}, typingCts.Token);

try { /* ... invoke Devin ... */ }
finally
{
    await typingCts.CancelAsync();
    try { await typingTask; } catch (OperationCanceledException) { }
}
```

> **Note**: Typing indicators are only visible in 1:1 chats and small group chats — not in channels.

## Running the Agent

To set up and test this agent, refer to the [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing?tabs=dotnet) guide for complete instructions.

## Project Structure

```
sample-agent/
├── Agent/
│   └── MyAgent.cs              # Main agent — routes messages to Devin
├── Client/
│   └── DevinClient.cs          # Devin API client (create session, poll response)
├── telemetry/
│   ├── AgentOTELExtensions.cs  # OpenTelemetry setup
│   ├── AgentMetrics.cs         # Custom metrics and tracing
│   └── A365OtelWrapper.cs      # A365 observability wrapper
├── manifest/
│   ├── manifest.json           # Teams app manifest
│   └── agenticUserTemplateManifest.json
├── Program.cs                  # Entry point and DI configuration
├── AspNetExtensions.cs         # JWT token validation
├── appsettings.json            # Production configuration (fill in your values)
├── appsettings.Playground.json # Local development / Playground configuration
├── a365.config.json            # A365 CLI configuration
└── DevinSampleAgent.csproj
```

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `Microsoft.Agents.Hosting.AspNetCore` | Agent 365 hosting infrastructure |
| `Microsoft.Agents.Authentication.Msal` | MSAL-based authentication |
| `Microsoft.Agents.A365.Notifications` | A365 notification support |
| `Microsoft.Agents.A365.Observability.Extensions.AgentFramework` | A365 observability |
| `OpenTelemetry.Exporter.OpenTelemetryProtocol` | OpenTelemetry OTLP exporter |
| `Microsoft.Extensions.Http.Resilience` | HTTP resilience policies |

## Devin API Reference

| Endpoint | Purpose |
|----------|---------|
| `POST /sessions` | Create a new Devin session with a prompt |
| `POST /sessions/{id}/message` | Send a follow-up message to existing session |
| `GET /sessions/{id}` | Poll session for `devin_message` responses |

For full API documentation, see [Devin API docs](https://docs.devin.ai).

## Troubleshooting

### Timeout waiting for Devin response

**Symptom:** Agent responds with "I'm still working on this..."

**Solution:**
- Increase `Devin:TimeoutSeconds` in appsettings.json (default: 300s)
- Decrease `Devin:PollingIntervalSeconds` for faster detection (default: 10s)
- Complex tasks may take longer — Devin runs autonomously

### 401/403 from Devin API

**Solution:**
- Verify your `Devin:ApiKey` is correct and not expired
- Check that your Devin account has API access enabled
- Regenerate the key from the [Devin dashboard](https://app.devin.ai) if needed

### AADSTS65001 Consent Error

**Symptom:** Authentication fails with consent-related error during agent setup.

**Solution:**
- Ensure `aiTeammate: true` is set in `a365.config.json`
- Re-run `a365 setup blueprint` — the CLI handles consent automatically for AI teammates
- Verify the `--m365` flag is used when registering the endpoint

## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-dotnet/issues) section
- **Documentation**: See the [Microsoft Agents 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Devin**: See [Devin documentation](https://docs.devin.ai)
- **Security**: For security issues, please see [SECURITY.md](SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 SDK - .NET repository](https://github.com/microsoft/Agent365-dotnet)
- [Microsoft 365 Agents SDK - .NET repository](https://github.com/Microsoft/Agents-for-net)
- [Devin API documentation](https://docs.devin.ai)
- [Devin dashboard](https://app.devin.ai)
- [.NET API documentation](https://learn.microsoft.com/dotnet/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](LICENSE.md) file for details.
