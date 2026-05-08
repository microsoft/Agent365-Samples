# Claude (Anthropic SDK) Sample Agent

## Overview
This is a sample showing how to use [Anthropic Claude](https://docs.anthropic.com/) as the AI backbone in an agent using the Microsoft Agent 365 SDK and Microsoft 365 Agents SDK, via the [Anthropic.SDK](https://github.com/tghamm/Anthropic.SDK) NuGet package.

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
- Anthropic API Key ([console.anthropic.com](https://console.anthropic.com/))

## Working with User Identity

On every incoming message, the A365 platform populates `Activity.From` with basic user information — always available with no API calls or token acquisition:

| Field | Description |
|---|---|
| `Activity.From.Id` | Channel-specific user ID (e.g., `29:1AbcXyz...` in Teams) |
| `Activity.From.Name` | Display name as known to the channel |
| `Activity.From.AadObjectId` | Azure AD Object ID — use this to call Microsoft Graph |

The sample logs these fields at the start of every turn in `OnMessageAsync` ([MyAgent.cs](Agent/MyAgent.cs)) and injects `Activity.From.Name` into Claude's system instructions for personalized responses, with prompt injection sanitization:

```csharp
var fromAccount = turnContext.Activity.From;
_logger?.LogDebug(
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
- [Anthropic Claude documentation](https://docs.anthropic.com/)
- [Anthropic.SDK NuGet package](https://github.com/tghamm/Anthropic.SDK)
- [.NET API documentation](https://learn.microsoft.com/dotnet/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](LICENSE.md) file for details.
