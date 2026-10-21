# Agent Code Walkthrough

This document provides a detailed walkthrough of the code for this agent. The
agent is designed to perform specific tasks autonomously using Anthropic Claude
as the AI backbone, interacting with the user as needed.

## Key Files in this Solution

- `Program.cs`:
  - This is the entry point for the application. It sets up the necessary services
    and middleware for the agent.
  - Registers the Anthropic Claude `IChatClient` using the Anthropic.SDK NuGet package:
    ```csharp
    builder.Services.AddSingleton<IChatClient>(sp =>
    {
        var apiKey = confSvc["AIServices:Anthropic:ApiKey"] ?? string.Empty;
        return new AnthropicClient(apiKey)
            .Messages
            .AsBuilder()
            .UseFunctionInvocation()
            .UseOpenTelemetry(sourceName: AgentMetrics.SourceName, configure: (cfg) => cfg.EnableSensitiveData = true)
            .Build();
    });
    ```
  - Configures A365 observability with tracing and the Agent Framework integration:
    ```csharp
    builder.Services.AddAgenticTracingExporter(clusterCategory: "production");
    builder.AddA365Tracing(config =>
    {
        config.WithAgentFramework();
    });
    ```
  - Registers MCP tooling services for Model Context Protocol tool integration:
    ```csharp
    builder.Services.AddSingleton<IMcpToolRegistrationService, McpToolRegistrationService>();
    builder.Services.AddSingleton<IMcpToolServerConfigurationService, McpToolServerConfigurationService>();
    ```
  - Maps the `/api/messages` endpoint wrapped with observability:
    ```csharp
    app.MapPost("/api/messages", async (...) =>
    {
        await AgentMetrics.InvokeObservedHttpOperation("agent.process_message", async () =>
        {
            await adapter.ProcessAsync(request, response, agent, cancellationToken);
        });
    });
    ```

- `Agent/MyAgent.cs`:
  - This file contains the implementation of the agent's core logic, including how
    it registers handling of activities.
  - The constructor registers the agent's activity handlers:
    - `OnConversationUpdate(ConversationUpdateEvents.MembersAdded, WelcomeMessageAsync)`:
      - This registers a handler for when new members are added to the conversation,
        sending a welcome message.
    - `OnActivity(ActivityTypes.InstallationUpdate, OnInstallationUpdateAsync, isAgenticOnly: true, autoSignInHandlers: agenticHandlers)`:
      - This registers the `InstallationUpdate` activity type for agentic requests,
        triggered when the agent is installed ("hired") or uninstalled ("offboarded").
    - `OnActivity(ActivityTypes.InstallationUpdate, OnInstallationUpdateAsync, isAgenticOnly: false)`:
      - Same handler registered for non-agentic requests (Playground / WebChat testing).
    - `OnActivity(ActivityTypes.Message, OnMessageAsync, isAgenticOnly: true, autoSignInHandlers: agenticHandlers)`:
      - This registers a handler for messages in agentic mode with auto sign-in.
    - `OnActivity(ActivityTypes.Message, OnMessageAsync, isAgenticOnly: false, autoSignInHandlers: oboHandlers)`:
      - Same handler for non-agentic messages with OBO auth.
  - The `GetClientAgent` method builds the `ChatClientAgent` with tools and options:
    - Acquires an access token via agentic auth, OBO auth, or the `BEARER_TOKEN` environment variable (development).
    - Creates local tools (e.g., `DateTimeFunctionTool.getDate`).
    - Loads MCP tools from the A365 platform via `IMcpToolRegistrationService.GetMcpToolsAsync(...)`.
    - Constructs `ChatOptions` with `ModelId`, `Temperature`, `Tools`, and `Instructions`.
    - Returns a `ChatClientAgent` backed by the Claude `IChatClient`.
  - The `GetConversationSessionAsync` method manages conversation session state:
    - Reads serialized session from turn state (`conversation.threadInfo`).
    - Creates a new `AgentSession` if none exists, or deserializes the existing one.

- `Tools/DateTimeFunctionTool.cs`:
  - This file contains a local tool that provides the current date and time to the agent.
  - Registered as an `AITool` via `AIFunctionFactory.Create(DateTimeFunctionTool.getDate)`.

- `telemetry/AgentMetrics.cs`:
  - Defines the OpenTelemetry `ActivitySource` and `Meter` for the agent (source name: `A365.Claude`).
  - Provides counters, histograms, and helper methods for instrumented agent operations.

- `telemetry/A365OtelWrapper.cs`:
  - Wraps agent operations with A365 observability, resolving tenant/agent identity and
    propagating baggage via `BaggageBuilder`.
  - Registers the observability token cache for the A365 tracing exporter.

- `telemetry/AgentOTELExtensions.cs`:
  - Configures OpenTelemetry for ASP.NET Core, HTTP client, and runtime instrumentation.
  - Sets up health check endpoints and service discovery.

- `ToolingManifest.json`:
  - Declares the MCP servers (e.g., `mcp_MailTools`) the agent connects to, including
    their URL, required scope, and audience for token acquisition.

- `appPackage/manifest.json`:
  - Teams app manifest defining the agent as a custom engine agent.

## Activities Handled by the Agent

### ConversationUpdate Activity (MembersAdded)

- This activity is triggered when new members join the conversation.
- The `WelcomeMessageAsync` method in `MyAgent.cs` handles this activity:
  - It sends a welcome message to each new member (excluding the agent itself).

### InstallationUpdate Activity

- This activity is triggered when the agent is installed or uninstalled.
- The `OnInstallationUpdateAsync` method in `MyAgent.cs` handles this activity:
  - If the agent is installed (`Add`), it sends a welcome message to the user.
  - If the agent is uninstalled (`Remove`), it sends a farewell message to the user.
  - The handler logs the action, display name, and user ID for observability.

### Message Activity

- This activity is triggered when the agent receives a message from the user.
- The `OnMessageAsync` method in `MyAgent.cs` handles this activity:
  - Sends an immediate acknowledgment ("Got it — working on it…").
  - Starts a background typing indicator loop (refreshes every ~4 seconds).
  - Resolves the `ChatClientAgent` with MCP tools and Claude model options.
  - Streams the Claude response back to the user via `StreamingResponse.QueueTextChunk`.
  - Serializes the conversation session to turn state for multi-turn continuity.
  - The entire operation is wrapped in `A365OtelWrapper.InvokeObservedAgentOperation`
    for full observability with tenant/agent baggage.
