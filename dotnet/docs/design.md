# .NET Design Guidelines

## Overview

This document describes the design patterns and conventions for .NET sample agents in the Agent365-Samples repository. All .NET samples follow ASP.NET Core patterns and leverage the Microsoft.Extensions ecosystem for dependency injection, configuration, and logging.

## Supported Orchestrators

| Orchestrator | Description | Sample Location |
|--------------|-------------|-----------------|
| Agent Framework | Microsoft's agent orchestration framework | [agent-framework/sample-agent](../agent-framework/sample-agent/) |
| Semantic Kernel | Microsoft's AI orchestration SDK | [semantic-kernel/sample-agent](../semantic-kernel/sample-agent/) |

## Project Structure

```
sample-agent/
├── Agent/                     # Agent implementation
│   └── MyAgent.cs            # Main agent class
├── Tools/                     # Custom tool implementations
│   ├── DateTimeFunctionTool.cs
│   └── WeatherLookupTool.cs
├── telemetry/                 # Observability helpers
├── appPackage/                # Teams app package (optional)
├── manifest/                  # Agent manifest files
├── Program.cs                 # Application entry point
├── appsettings.json          # Configuration
└── *.csproj                  # Project file
```

## Core Patterns

### 1. Application Startup (Program.cs)

The entry point follows the ASP.NET Core minimal hosting pattern:

```csharp
var builder = WebApplication.CreateBuilder(args);

// 1. Configure OpenTelemetry distro
builder.UseMicrosoftOpenTelemetry(o =>
{
    o.Exporters = ExportTarget.Agent365 | ExportTarget.Console;
});

// 2. Register MCP tooling services
builder.Services.AddSingleton<IMcpToolRegistrationService, McpToolRegistrationService>();
builder.Services.AddSingleton<IMcpToolServerConfigurationService, McpToolServerConfigurationService>();

// 3. Configure authentication
builder.Services.AddAgentAspNetAuthentication(builder.Configuration);

// 4. Register storage and agent
builder.Services.AddSingleton<IStorage, MemoryStorage>();
builder.AddAgent<MyAgent>();

// 5. Register LLM client
builder.Services.AddSingleton<IChatClient>(sp => { ... });

var app = builder.Build();

// 6. Configure middleware
app.UseAuthentication();
app.UseAuthorization();

// 7. Map endpoints
app.MapPost("/api/messages", async (...) => {
    await adapter.ProcessAsync(request, response, agent, cancellationToken);
});

app.Run();
```

### 2. Agent Implementation

Agents inherit from `AgentApplication` and register message handlers:

```csharp
public class MyAgent : AgentApplication
{
    private readonly IChatClient _chatClient;
    private readonly IMcpToolRegistrationService _toolService;
    private readonly IExporterTokenCache<AgenticTokenStruct> _agentTokenCache;

    public MyAgent(
        AgentApplicationOptions options,
        IChatClient chatClient,
        IMcpToolRegistrationService toolService,
        IExporterTokenCache<AgenticTokenStruct> agentTokenCache,
        ILogger<MyAgent> logger) : base(options)
    {
        // Register handlers for different activity types
        OnConversationUpdate(ConversationUpdateEvents.MembersAdded, WelcomeMessageAsync);
        OnActivity(ActivityTypes.Message, OnMessageAsync, isAgenticOnly: true,
                   autoSignInHandlers: new[] { AgenticAuthHandlerName });
        OnActivity(ActivityTypes.Message, OnMessageAsync, isAgenticOnly: false,
                   autoSignInHandlers: oboHandlers);
    }

    protected async Task OnMessageAsync(ITurnContext turnContext, ITurnState turnState,
                                         CancellationToken cancellationToken)
    {
        // Tracing and instrumentation are handled by the distro.
        // Token cache registration for the Agent365 exporter is done
        // via A365OtelWrapper which resolves tenant/agent identity
        // and calls RegisterObservability on the agentic token cache.
        await A365OtelWrapper.InvokeObservedAgentOperation(
            "MessageProcessor", turnContext, turnState,
            _agentTokenCache, UserAuthorization, authHandlerName, _logger,
            async () => {
                // Process message with LLM
            });
    }
}
```

### 3. Dependency Injection

All services are registered via the DI container:

```csharp
// Core services
builder.Services.AddSingleton<IStorage, MemoryStorage>();

// MCP tooling
builder.Services.AddSingleton<IMcpToolRegistrationService, McpToolRegistrationService>();

// Agent (transient - one per request)
builder.AddAgent<MyAgent>();

// LLM client
builder.Services.AddSingleton<IChatClient>(sp => {
    // Configure and return chat client
});
```

### 4. Configuration

Configuration is loaded from multiple sources:

```csharp
builder.Configuration.AddUserSecrets(Assembly.GetExecutingAssembly());
```

**appsettings.json structure:**
```json
{
  "AIServices": {
    "UseAzureOpenAI": true,
    "AzureOpenAI": {
      "Endpoint": "https://...",
      "ApiKey": "...",
      "DeploymentName": "gpt-4o"
    }
  },
  "AgentApplication": {
    "AgenticAuthHandlerName": "agentic",
    "OboAuthHandlerName": "me"
  },
  "TokenValidation": {
    "Audiences": ["..."],
    "Issuers": ["..."]
  }
}
```

### 5. Tool Registration

Tools can be local functions or MCP server tools:

```csharp
// Local tools via AIFunctionFactory
var toolList = new List<AITool>();
toolList.Add(AIFunctionFactory.Create(DateTimeFunctionTool.getDate));
toolList.Add(AIFunctionFactory.Create(weatherLookupTool.GetCurrentWeatherForLocation));

// MCP tools from configured servers
var a365Tools = await toolService.GetMcpToolsAsync(
    agentId,
    UserAuthorization,
    authHandlerName,
    context
);
toolList.AddRange(a365Tools);
```

### 6. User Identity

The A365 platform populates `Activity.From` on every incoming message. Log it at message handler entry and inject the display name into LLM system instructions:

```csharp
protected async Task MessageActivityAsync(ITurnContext turnContext, ITurnState turnState,
                                          CancellationToken cancellationToken)
{
    var fromAccount = turnContext.Activity.From;
    _logger.LogInformation(
        "Turn received from user — DisplayName: '{Name}', UserId: '{Id}', AadObjectId: '{AadObjectId}'",
        fromAccount?.Name ?? "(unknown)",
        fromAccount?.Id ?? "(unknown)",
        fromAccount?.AadObjectId ?? "(none)");

    var displayName = fromAccount?.Name ?? "unknown";
    // Inject displayName into your LLM system prompt / agent instructions
}
```

| Field | Description |
|---|---|
| `Activity.From.Id` | Channel-specific user ID (e.g., `29:1AbcXyz...` in Teams) |
| `Activity.From.Name` | Display name as known to the channel |
| `Activity.From.AadObjectId` | Azure AD Object ID — use this to call Microsoft Graph |

### 7. Authentication Flow

```csharp
// Check for bearer token (development)
public static bool TryGetBearerTokenForDevelopment(out string? bearerToken)
{
    bearerToken = Environment.GetEnvironmentVariable("BEARER_TOKEN");
    return !string.IsNullOrEmpty(bearerToken);
}

// Select auth handler based on request type
if (turnContext.IsAgenticRequest())
{
    authHandlerName = AgenticAuthHandlerName;
}
else
{
    authHandlerName = OboAuthHandlerName;
}
```

### 8. Observability Integration

Observability is configured via the Microsoft.OpenTelemetry distro in `Program.cs`:

```csharp
// Single-line setup — configures tracing, metrics, Agent365 exporter,
// Agent Framework instrumentation, and Semantic Kernel instrumentation.
builder.UseMicrosoftOpenTelemetry(o =>
{
    o.Exporters = ExportTarget.Agent365 | ExportTarget.Console;
});
```

The distro automatically handles:
- ASP.NET Core and HttpClient instrumentation
- OpenAI / Semantic Kernel / Agent Framework span capture
- Agent365 exporter with agentic token cache
- Baggage propagation (tenant ID, agent ID)

Agent operations are wrapped with `A365OtelWrapper` to register the token cache and set baggage context:

```csharp
await A365OtelWrapper.InvokeObservedAgentOperation(
    "MessageProcessor",
    turnContext,
    turnState,
    _agentTokenCache,
    UserAuthorization,
    authHandlerName,
    _logger,
    async () => {
        // Process message with LLM
    });
```

## Key NuGet Packages

| Package | Purpose |
|---------|---------|
| `Microsoft.OpenTelemetry` | OpenTelemetry distro (tracing, metrics, exporters) |
| `Microsoft.Agents.Builder` | Agent application framework |
| `Microsoft.Agents.Hosting.AspNetCore` | ASP.NET Core hosting |
| `Microsoft.Agents.A365.Tooling.Extensions.*` | MCP tool integration |
| `Azure.AI.OpenAI` | Azure OpenAI client |
| `Microsoft.SemanticKernel` | Semantic Kernel (SK samples) |

## Interface Contracts

Key interfaces that agents implement or consume:

```csharp
// Agent contract
public interface IAgent { }

// Chat client for LLM interaction
public interface IChatClient { }

// Storage for state persistence
public interface IStorage { }

// Tool registration
public interface IMcpToolRegistrationService
{
    Task<List<AITool>> GetMcpToolsAsync(...);
}

// Token caching for observability (registered automatically by the distro)
public interface IExporterTokenCache<T> { }
```

## Middleware Pattern

Custom middleware for cross-cutting concerns:

```csharp
// Transcript logging middleware
builder.Services.AddSingleton<IMiddleware[]>([
    new TranscriptLoggerMiddleware(new FileTranscriptLogger())
]);
```

## Streaming Responses

Support for streaming responses to clients:

```csharp
await turnContext.StreamingResponse.QueueInformativeUpdateAsync("Processing...");
await foreach (var response in agent.RunStreamingAsync(userText, thread))
{
    if (response.Role == ChatRole.Assistant && !string.IsNullOrEmpty(response.Text))
    {
        turnContext.StreamingResponse.QueueTextChunk(response.Text);
    }
}
await turnContext.StreamingResponse.EndStreamAsync(cancellationToken);
```

## Build and Run

```bash
# Build
dotnet build

# Run (development)
dotnet run

# Run with specific environment
ASPNETCORE_ENVIRONMENT=Development dotnet run
```

## Sample Agents

- [Agent Framework Sample Design](../agent-framework/sample-agent/docs/design.md)
- [Semantic Kernel Sample Design](../semantic-kernel/sample-agent/docs/design.md)
