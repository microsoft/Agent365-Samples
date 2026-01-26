# Semantic Kernel Sample Agent Design

## Overview

This sample demonstrates an agent built using Microsoft Semantic Kernel as the AI orchestrator. It showcases enterprise patterns including multi-channel support (Teams, Emulator), notification handling, and seamless integration with Microsoft Agent 365 observability.

## What This Sample Demonstrates

- Semantic Kernel integration with Azure OpenAI / OpenAI
- Multi-channel message handling (Teams, Emulator, Test)
- Agent 365 notification processing (Email, WPX Comments)
- Installation/hire event handling
- Streaming responses in Teams
- MCP server tool registration
- Terms and conditions workflow pattern

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Program.cs                                │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────────┐ │
│  │ Kernel (SK) │  │ A365 Tracing│  │ ASP.NET Authentication │ │
│  │ Registration│  │ (SK ext)    │  │                          │ │
│  └─────────────┘  └─────────────┘  └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         MyAgent                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Event Handlers                            ││
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐││
│  │  │Notifications │ │Installation  │ │Message (Agentic &    │││
│  │  │(Email, WPX)  │ │Update (Hire) │ │Non-Agentic)          │││
│  │  └──────────────┘ └──────────────┘ └──────────────────────┘││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                 Channel Routing                              ││
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      ││
│  │  │Teams Handler │  │Emulator/Test │  │Other Channels│      ││
│  │  │(Streaming)   │  │Handler       │  │(Unsupported) │      ││
│  │  └──────────────┘  └──────────────┘  └──────────────┘      ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                   Agent365Agent                              ││
│  │  Semantic Kernel + Plugins → ChatCompletion                  ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### Program.cs
Entry point that configures:
- Semantic Kernel with Azure OpenAI or OpenAI
- Agent 365 tracing with SK extension
- MCP tool services
- Transcript logging middleware

### Agents/MyAgent.cs
Main agent class that:
- Routes messages by channel (Teams, Emulator, Test)
- Handles installation events (hire/fire)
- Processes Agent 365 notifications
- Manages chat history

### Agents/Agent365Agent.cs
Wrapper around Semantic Kernel that:
- Creates SK instances with MCP tools
- Invokes chat completion
- Supports streaming responses

### Agents/Agent365AgentResponse.cs
Response model for agent outputs with content type information.

## Message Flow

### Standard Message
```
1. HTTP POST /api/messages
   │
2. A365OtelWrapper.InvokeObservedAgentOperation("MessageProcessor")
   │
3. Channel Detection
   │
   ├─► Teams Channel
   │   └── TeamsMessageActivityAsync()
   │       ├── QueueInformativeUpdateAsync()
   │       ├── InvokeAgentAsync() with ChatHistory
   │       └── EndStreamAsync()
   │
   ├─► Emulator/Test Channel
   │   └── InvokeAgentAsync()
   │       └── OutputResponseAsync()
   │
   └─► Other Channel
       └── "I do not know how to respond..."
```

### Notification Flow
```
1. AgentNotificationActivityAsync()
   │
2. Switch on NotificationType
   │
   ├─► EmailNotification
   │   ├── Retrieve email content via MCP
   │   ├── Process email instructions
   │   └── CreateEmailResponseActivity()
   │
   └─► WpxComment (Word Comment)
       ├── Retrieve Word document + comments
       ├── Generate response to comment
       └── Send response
```

## Tool Integration

### Semantic Kernel Plugin Registration
```csharp
// MCP tools are registered as SK plugins
await _toolsService.AddMcpToolsToKernelAsync(
    kernel,
    UserAuthorization,
    authHandlerName,
    turnContext
);
```

### Agent365Agent Creation
```csharp
public static async Task<Agent365Agent> CreateA365AgentWrapper(
    Kernel kernel,
    IServiceProvider serviceProvider,
    IMcpToolRegistrationService toolsService,
    string authHandlerName,
    Authorization authorization,
    ITurnContext turnContext,
    IConfiguration configuration)
{
    // Clone kernel for this request
    var requestKernel = kernel.Clone();

    // Add MCP tools
    await toolsService.AddMcpToolsToKernelAsync(
        requestKernel,
        authorization,
        authHandlerName,
        turnContext
    );

    return new Agent365Agent(requestKernel, configuration);
}
```

## Configuration

### appsettings.json
```json
{
  "AIServices": {
    "UseAzureOpenAI": true,
    "AzureOpenAI": {
      "DeploymentName": "gpt-4o",
      "Endpoint": "https://your-resource.openai.azure.com",
      "ApiKey": "your-api-key"
    },
    "OpenAI": {
      "ModelId": "gpt-4o",
      "ApiKey": "your-api-key"
    }
  }
}
```

## Notification Handling

### Email Notifications
```csharp
case NotificationTypeEnum.EmailNotification:
    var chatHistory = new ChatHistory();

    // Step 1: Retrieve email content
    var emailContent = await agent.InvokeAgentAsync(
        $"Retrieve email with id '{notification.EmailNotification.Id}'...",
        chatHistory
    );

    // Step 2: Process email
    var response = await agent.InvokeAgentAsync(
        $"Process this email: {emailContent.Content}",
        chatHistory
    );

    // Step 3: Send response
    var responseActivity = EmailResponse.CreateEmailResponseActivity(response.Content);
    await turnContext.SendActivityAsync(responseActivity);
```

### Word Comments (WPX)
```csharp
case NotificationTypeEnum.WpxComment:
    // Retrieve document and comments
    var wordContent = await agent.InvokeAgentAsync(
        $"Retrieve Word document '{notification.WpxCommentNotification.DocumentId}'...",
        chatHistory
    );

    // Generate response to comment
    var response = await agent.InvokeAgentAsync(
        $"Respond to comment '{notification.Text}' given: {wordContent.Content}",
        chatHistory
    );
```

## Installation Events

```csharp
protected async Task OnHireMessageAsync(ITurnContext turnContext, ...)
{
    if (turnContext.Activity.Action == InstallationUpdateActionTypes.Add)
    {
        IsApplicationInstalled = true;
        TermsAndConditionsAccepted = turnContext.IsAgenticRequest();

        string message = "Thank you for hiring me!";
        if (!turnContext.IsAgenticRequest())
        {
            message += " Please confirm terms and conditions.";
        }
        await turnContext.SendActivityAsync(message);
    }
    else if (turnContext.Activity.Action == InstallationUpdateActionTypes.Remove)
    {
        IsApplicationInstalled = false;
        TermsAndConditionsAccepted = false;
        await turnContext.SendActivityAsync("Thank you for your time.");
    }
}
```

## Observability

### SK-Specific Tracing
```csharp
builder.AddA365Tracing(config => {
    config.WithSemanticKernel();  // SK-specific instrumentation
});
```

### Observed Operations
- `agent.process_message` - HTTP endpoint
- `MessageProcessor` - Message handling
- `AgentNotificationActivityAsync` - Notification processing
- `OnHireMessageAsync` - Installation events

## Authentication

Dual handler configuration:
```csharp
private readonly string AgenticIdAuthHandler = "agentic";
private readonly string MyAuthHandler = "me";

// Bearer token fallback for development
bool useBearerToken = Agent365Agent.TryGetBearerTokenForDevelopment(out var bearerToken);
string[] autoSignInHandlers = useBearerToken ? [] : new[] { MyAuthHandler };
```

## Streaming in Teams

```csharp
protected async Task TeamsMessageActivityAsync(...)
{
    await turnContext.StreamingResponse.QueueInformativeUpdateAsync(
        "Working on a response for you"
    );

    try
    {
        ChatHistory chatHistory = turnState.GetValue("conversation.chatHistory",
            () => new ChatHistory());

        Agent365AgentResponse response = await agent.InvokeAgentAsync(
            turnContext.Activity.Text,
            chatHistory,
            turnContext  // Enables streaming
        );
    }
    finally
    {
        await turnContext.StreamingResponse.EndStreamAsync(cancellationToken);
    }
}
```

## Extension Points

1. **Custom SK Plugins**: Add to kernel via `kernel.Plugins.AddFromType<T>()`
2. **New Notification Types**: Extend switch statement in `AgentNotificationActivityAsync`
3. **Channel Handlers**: Add new channel routing in `MessageActivityAsync`
4. **Response Types**: Extend `Agent365AgentResponseContentType` enum

## Dependencies

```xml
<PackageReference Include="Microsoft.SemanticKernel" />
<PackageReference Include="Microsoft.Agents.Builder" />
<PackageReference Include="Microsoft.Agents.Hosting.AspNetCore" />
<PackageReference Include="Microsoft.Agents.A365.Observability" />
<PackageReference Include="Microsoft.Agents.A365.Observability.Extensions.SemanticKernel" />
<PackageReference Include="Microsoft.Agents.A365.Tooling.Extensions.SemanticKernel" />
<PackageReference Include="Microsoft.Agents.A365.Notifications" />
```
