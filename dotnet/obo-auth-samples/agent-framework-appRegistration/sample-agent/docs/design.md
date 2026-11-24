# Agent Framework Sample Agent Design

## Overview

This sample demonstrates a weather-focused agent built using the Microsoft Agent Framework orchestrator. It showcases the core patterns for building production-ready agents with local tools, MCP server integration, and Microsoft Agent 365 observability.

## What This Sample Demonstrates

- Agent Framework integration with Azure OpenAI
- Local tool implementation (weather lookup, datetime)
- MCP server tool registration and invocation
- Streaming responses to clients
- Conversation thread management
- Dual authentication (agentic and OBO handlers)
- Microsoft Agent 365 observability integration

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Program.cs                                │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────────┐ │
│  │ OpenTelemetry│  │ A365 Tracing│  │ ASP.NET Authentication │ │
│  └─────────────┘  └─────────────┘  └──────────────────────────┘ │
│                           │                                      │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Dependency Injection Container                  ││
│  │  ┌─────────┐ ┌───────────┐ ┌──────────┐ ┌───────────────┐  ││
│  │  │IChatClient│ │IMcpToolSvc│ │IStorage │ │ITokenCache    │  ││
│  │  └─────────┘ └───────────┘ └──────────┘ └───────────────┘  ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         MyAgent                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Event Handlers                            ││
│  │  ┌────────────────┐  ┌────────────────┐                     ││
│  │  │MembersAdded    │  │Message (Agentic│                     ││
│  │  │→ Welcome       │  │& Non-Agentic)  │                     ││
│  │  └────────────────┘  └────────────────┘                     ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                   Tool Management                            ││
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      ││
│  │  │DateTime Tool │  │Weather Tool  │  │MCP Tools     │      ││
│  │  └──────────────┘  └──────────────┘  └──────────────┘      ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                ChatClientAgent (LLM)                         ││
│  │  Instructions + Tools → Streaming Response                   ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### Program.cs
Entry point that configures:
- OpenTelemetry and Agent 365 tracing
- MCP tool services (`IMcpToolRegistrationService`, `IMcpToolServerConfigurationService`)
- Authentication middleware
- IChatClient with Azure OpenAI
- Memory storage for conversation state

### Agent/MyAgent.cs
Main agent class that:
- Extends `AgentApplication`
- Registers handlers for conversation updates and messages
- Manages conversation threads
- Coordinates tool registration and LLM invocation

### Tools/WeatherLookupTool.cs
Local tool implementation for weather queries:
- `GetCurrentWeatherForLocation` - Current weather data
- `GetWeatherForecastForLocation` - 5-day forecast

### Tools/DateTimeFunctionTool.cs
Utility tool for date/time queries.

### telemetry/AgentMetrics.cs
Custom observability helpers for tracing agent operations.

## Message Flow

```
1. HTTP POST /api/messages
   │
2. AgentMetrics.InvokeObservedHttpOperation()
   │
3. adapter.ProcessAsync() → MyAgent.OnMessageAsync()
   │
4. A365OtelWrapper.InvokeObservedAgentOperation()
   │  └── Observability context setup
   │
5. StreamingResponse.QueueInformativeUpdateAsync("Just a moment...")
   │
6. GetClientAgent()
   │  ├── Create local tools (DateTime, Weather)
   │  ├── GetMcpToolsAsync() from MCP servers
   │  └── Build ChatClientAgent with instructions
   │
7. GetConversationThread() - Load or create thread
   │
8. agent.RunStreamingAsync()
   │  └── Stream responses to client
   │
9. Save thread state
   │
10. StreamingResponse.EndStreamAsync()
```

## Tool Integration

### Local Tools
```csharp
var toolList = new List<AITool>();

// Static function tool
toolList.Add(AIFunctionFactory.Create(DateTimeFunctionTool.getDate));

// Instance method tools (with context access)
WeatherLookupTool weatherLookupTool = new(context, _configuration!);
toolList.Add(AIFunctionFactory.Create(weatherLookupTool.GetCurrentWeatherForLocation));
toolList.Add(AIFunctionFactory.Create(weatherLookupTool.GetWeatherForecastForLocation));
```

### MCP Tools
```csharp
// With auth handler
var a365Tools = await toolService.GetMcpToolsAsync(
    agentId,
    UserAuthorization,
    authHandlerName,
    context
);

// With bearer token (development)
var a365Tools = await toolService.GetMcpToolsAsync(
    agentId,
    UserAuthorization,
    handlerForBearerToken,
    context,
    bearerToken  // Override token
);
```

## Configuration

### appsettings.json
```json
{
  "AIServices": {
    "AzureOpenAI": {
      "Endpoint": "https://your-resource.openai.azure.com",
      "ApiKey": "your-api-key",
      "DeploymentName": "gpt-4o"
    }
  },
  "OpenWeatherApiKey": "your-weather-api-key",
  "AgentApplication": {
    "AgenticAuthHandlerName": "agentic",
    "OboAuthHandlerName": "me"
  }
}
```

### Environment Variables
```bash
ASPNETCORE_ENVIRONMENT=Development
BEARER_TOKEN=your-bearer-token  # Development only
SKIP_TOOLING_ON_ERRORS=true     # Development fallback
```

## Observability

### Tracing Setup
```csharp
builder.ConfigureOpenTelemetry();
builder.Services.AddAgenticTracingExporter(clusterCategory: "production");
builder.AddA365Tracing(config => {
    config.WithAgentFramework();
});
```

### Observed Operations
- `agent.process_message` - HTTP endpoint
- `MessageProcessor` - Message handling
- `WelcomeMessage` - Welcome flow

## Authentication

Dual handler support:
- **Agentic Handler**: For requests from Agent 365 orchestration
- **OBO Handler**: For direct user requests (Playground, WebChat)

```csharp
if (turnContext.IsAgenticRequest())
{
    authHandlerName = AgenticAuthHandlerName;  // "agentic"
}
else
{
    authHandlerName = OboAuthHandlerName;      // "me"
}
```

## Conversation Management

Thread state persisted in conversation storage:
```csharp
// Load existing thread
string? agentThreadInfo = turnState.Conversation.GetValue<string?>("conversation.threadInfo");
if (!string.IsNullOrEmpty(agentThreadInfo))
{
    thread = agent.DeserializeThread(ele);
}
else
{
    thread = agent.GetNewThread();
}

// Save thread after processing
turnState.Conversation.SetValue("conversation.threadInfo", ProtocolJsonSerializer.ToJson(thread.Serialize()));
```

## Extension Points

1. **Add New Local Tools**: Create tool classes, register with `AIFunctionFactory`
2. **Custom MCP Servers**: Configure in tool manifest, automatic registration
3. **Custom Middleware**: Add to `IMiddleware[]` array
4. **Response Formatting**: Customize in agent instructions
5. **Authentication**: Configure additional auth handlers

## Dependencies

```xml
<PackageReference Include="Microsoft.Agents.Builder" />
<PackageReference Include="Microsoft.Agents.Hosting.AspNetCore" />
<PackageReference Include="Microsoft.Agents.A365.Observability" />
<PackageReference Include="Microsoft.Agents.A365.Observability.Extensions.AgentFramework" />
<PackageReference Include="Microsoft.Agents.A365.Tooling.Extensions.AgentFramework" />
<PackageReference Include="Azure.AI.OpenAI" />
```
