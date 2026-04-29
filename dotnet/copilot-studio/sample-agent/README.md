# Copilot Studio Sample Agent (.NET)

This sample demonstrates how to integrate a **Microsoft Copilot Studio** agent with the **Microsoft 365 Agents SDK** and **Agent 365 SDK** in .NET. It enables enterprise developers to bridge low-code Copilot Studio agents into Agent 365 managed environments with full feature parity.

## Why use this integration?

| Copilot Studio | Agent 365 SDK | Together |
|----------------|---------------|----------|
| Low-code agent building | Enterprise identity (Entra ID) | Best of both worlds |
| Visual flow designer | Microsoft 365 notifications | Low-code agents with enterprise features |
| Built-in connectors | OpenTelemetry observability | Full compliance and monitoring |
| Quick prototyping | Secure Graph access (MCP) | Production-ready deployment |

## Demonstrates

This sample demonstrates:

- **Copilot Studio Integration**: Forward messages to your low-code Copilot Studio agent
- **Observability**: End-to-end tracing with OpenTelemetry spans for Copilot Studio calls
- **Notifications**: Handle email notifications from Agent 365 and return responses
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Microsoft.Agents.CopilotStudio.Client](https://github.com/Microsoft/Agents-for-net) package and the [Microsoft Agent 365 SDK for .NET](https://github.com/microsoft/Agent365-dotnet).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Architecture

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────────┐
│  Agent 365 SDK  │      │   This Sample    │      │  Copilot Studio     │
│  (Notifications)│─────>│   (MyAgent)      │─────>│  (Your Low-code     │
└─────────────────┘      └──────────────────┘      │   Agent)            │
        │                        │                 └─────────────────────┘
        │   Email notification   │                          │
        │───────────────────────>│   Forward message        │
        │                        │─────────────────────────>│
        │                        │                          │
        │                        │   Agent response         │
        │                        │<─────────────────────────│
        │   Email response       │                          │
        │<───────────────────────│                          │
```

The agent does **not** call an LLM directly. Instead, it delegates all reasoning to a published Copilot Studio agent via the Power Platform API.

## Prerequisites

- [.NET 8.0 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) or later
- Microsoft Agent 365 SDK
- Access to **Microsoft Copilot Studio** (Frontier preview program)
- A published Copilot Studio agent with Web channel enabled
- Azure/Microsoft 365 tenant with administrative permissions
- A **Microsoft 365 Copilot license** (required to publish agents in Copilot Studio)

## Required Setup Steps

This sample requires additional configuration beyond the standard Agent 365 setup:

### 1. Add CopilotStudio.Copilots.Invoke API Permission

The `CopilotStudio.Copilots.Invoke` scope must be added to your Microsoft Entra ID app registration and blueprint:

1. Go to [Azure Portal](https://portal.azure.com) → **Microsoft Entra ID** → **App registrations**
2. Select your agent's app registration
3. Go to **API permissions** → **Add a permission**
4. Select **APIs my organization uses** → search for **Power Platform API**
5. Add the `CopilotStudio.Copilots.Invoke` delegated permission
6. Grant admin consent for the permission
7. Update your blueprint to include this scope in the allowed permissions

### 2. Grant User Access to the Copilot Studio Agent

Users must have access to chat with your Copilot Studio agent:

- **Option A: Organization-wide access** (used in this sample)
  1. Open your agent in Copilot Studio
  2. Click **… (three dots)** → **Share**
  3. Select the option to share with everyone in your organization

- **Option B: Security group access**
  1. Create a security group in Microsoft Entra ID
  2. Add users who need access to the group
  3. Share the agent with that security group in Copilot Studio

> **Note:** Individual users cannot be granted access directly — you must use security groups or organization-wide sharing. Authentication must be configured with **Microsoft Entra ID** and **"Require users to sign in"** enabled.

For more details, see [Share agents with other users](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-share-bots).

### 3. Agentic Authentication with Power Platform Audience

This sample uses the agentic authentication flow to request a token with the **Power Platform audience** (`https://api.powerplatform.com/.default`). This token is required to access and invoke Copilot Studio agents.

```csharp
// Token provider acquires the agentic OBO token for Copilot Studio API
Func<string, Task<string>> tokenProvider = async (scope) =>
{
    var token = await authorization.GetTurnTokenAsync(turnContext, authHandlerName);
    return token;
};
```

## Copilot Studio Setup

Before running this sample, you need a Copilot Studio agent:

1. Go to [Copilot Studio](https://copilotstudio.microsoft.com)
2. Create a new agent (or use an existing one)
3. **Publish** your agent
4. Go to **Settings > Advanced > Metadata** and copy:
   - **Environment ID**
   - **Schema Name** (agent identifier)

   Or copy the **Direct Connect URL** from the agent's channel settings.

## Configuration

### Option 1: Direct Connect URL (Recommended)

Get the Direct Connect URL from Copilot Studio → Settings → Advanced → Metadata.

In `appsettings.json`:
```json
{
  "CopilotStudio": {
    "DirectConnectUrl": "https://your-direct-connect-url"
  }
}
```

### Option 2: Environment ID + Schema Name

```json
{
  "CopilotStudio": {
    "EnvironmentId": "Default-your-tenant-id",
    "SchemaName": "your_agent_schema_name",
    "Cloud": "Prod"
  }
}
```

### Authentication

The agent uses agentic authentication to acquire tokens scoped to `https://api.powerplatform.com/.default` for calling the Copilot Studio API.

Configure the blueprint connection in `appsettings.json` under `Connections` > `ServiceConnection`.

## Working with User Identity

On every incoming message, the A365 platform populates `Activity.From` with basic user information — always available with no API calls or token acquisition:

| Field | Description |
|---|---|
| `Activity.From.Id` | Channel-specific user ID (e.g., `29:1AbcXyz...` in Teams) |
| `Activity.From.Name` | Display name as known to the channel |
| `Activity.From.AadObjectId` | Azure AD Object ID — use this to call Microsoft Graph |

The sample logs these fields at the start of every turn in `OnMessageAsync` ([MyAgent.cs](Agent/MyAgent.cs)):

```csharp
var fromAccount = turnContext.Activity.From;
_logger.LogDebug(
    "Turn received from user — DisplayName: '{Name}', UserId: '{Id}', AadObjectId: '{AadObjectId}'",
    fromAccount?.Name ?? "(unknown)",
    fromAccount?.Id ?? "(unknown)",
    fromAccount?.AadObjectId ?? "(none)");
```

## Handling Agent Install and Uninstall

When a user installs (hires) or uninstalls (removes) the agent, the A365 platform sends an `InstallationUpdate` activity. The sample handles this in `OnInstallationUpdateAsync` ([MyAgent.cs](Agent/MyAgent.cs)):

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

## Sending Multiple Messages in Teams

Agent365 agents can send multiple discrete messages in response to a single user prompt in Teams. This is achieved by calling `SendActivityAsync` multiple times within a single turn.

> **Important**: Streaming responses are not supported for agentic identities in Teams. The SDK detects agentic identity and buffers the stream into a single message. Use `SendActivityAsync` directly to send immediate, discrete messages to the user.

The sample demonstrates this in `OnMessageAsync` ([MyAgent.cs](Agent/MyAgent.cs)) by sending an immediate acknowledgment before the Copilot Studio response:

```csharp
// Message 1: immediate ack — reaches the user right away
await turnContext.SendActivityAsync(MessageFactory.Text("Got it — working on it…"), cancellationToken);

// ... Copilot Studio processing ...

// Message 2: the Copilot Studio response
await turnContext.SendActivityAsync(MessageFactory.Text(response), cancellationToken);
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
            await Task.Delay(TimeSpan.FromSeconds(4), typingCts.Token);
            await turnContext.SendActivityAsync(Activity.CreateTypingActivity(), typingCts.Token);
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

## Running the Agent

To set up and test this agent, refer to the [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing?tabs=dotnet) guide for complete instructions.

## Project Structure

```
sample-agent/
├── Agent/
│   └── MyAgent.cs                  # Main agent — routes messages to Copilot Studio
├── Client/
│   └── CopilotStudioAgentClient.cs # Copilot Studio client wrapper + factory
├── telemetry/
│   ├── AgentOTELExtensions.cs      # OpenTelemetry setup
│   ├── AgentMetrics.cs             # Custom metrics and tracing
│   └── A365OtelWrapper.cs          # A365 observability wrapper
├── Program.cs                      # Entry point and DI configuration
├── AspNetExtensions.cs             # JWT token validation
├── appsettings.json                # Production configuration (fill in your values)
├── appsettings.Playground.json     # Local development configuration
└── CopilotStudioSampleAgent.csproj
```

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `Microsoft.Agents.CopilotStudio.Client` | Core Copilot Studio client SDK |
| `Microsoft.Agents.Hosting.AspNetCore` | Agent 365 hosting infrastructure |
| `Microsoft.Agents.Authentication.Msal` | MSAL-based authentication |
| `Microsoft.Agents.A365.Notifications` | A365 notification support |
| `Microsoft.Agents.A365.Observability.Extensions.AgentFramework` | A365 observability |

## Troubleshooting

### Authentication errors

**Error:** `401 Unauthorized` when connecting to Copilot Studio

**Solution:**
- Verify that `CopilotStudio.Copilots.Invoke` permission is added to your Entra ID app registration
- Ensure the permission is granted admin consent
- Check that your agent ID and environment ID are correct
- Verify you have shared access to your Copilot to other users in your organization

### Consent errors

**Error:** `AADSTS65001: consent_required`

**Solution:**
- Grant admin consent for the `CopilotStudio.Copilots.Invoke` delegated permission on the Power Platform API
- Ensure oauth2PermissionGrants include `CopilotStudio.Copilots.Invoke` for all relevant service principals

### Wrong Environment ID

**Error:** `404` or empty responses from Copilot Studio

**Solution:**
- Use the Power Platform environment ID (e.g., `Default-your-tenant-id`), not just the tenant ID
- Verify the schema name matches your published bot exactly

## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-Samples/issues) section
- **Documentation**: See the [Microsoft Agents 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Copilot Studio**: See [Copilot Studio documentation](https://learn.microsoft.com/en-us/microsoft-copilot-studio/)
- **Security**: For security issues, please see [SECURITY.md](../../../SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 SDK - .NET repository](https://github.com/microsoft/Agent365-dotnet)
- [Microsoft 365 Agents SDK - .NET repository](https://github.com/Microsoft/Agents-for-net)
- [Microsoft.Agents.CopilotStudio.Client package](https://github.com/Microsoft/Agents-for-net)
- [Copilot Studio documentation](https://learn.microsoft.com/en-us/microsoft-copilot-studio/)
- [.NET API documentation](https://learn.microsoft.com/dotnet/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](../../../LICENSE.md) file for details.
