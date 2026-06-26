// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Agent365ClaudeSampleAgent;
using Agent365ClaudeSampleAgent.Agent;
using Agent365ClaudeSampleAgent.telemetry;
using Anthropic.SDK;
using Microsoft.Agents.A365.Observability;
using Microsoft.Agents.A365.Observability.Extensions.AgentFramework;
using Microsoft.Agents.A365.Observability.Runtime;
using Microsoft.Agents.A365.Tooling.Extensions.AgentFramework.Services;
using Microsoft.Agents.A365.Tooling.Services;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Core;
using Microsoft.Agents.Hosting.AspNetCore;
using Microsoft.Agents.Storage;
using Microsoft.Extensions.AI;
using System.Reflection;

var builder = WebApplication.CreateBuilder(args);

// Setup OpenTelemetry, Service Discovery, Resilience, and Health Checks
builder.ConfigureOpenTelemetry();

builder.Configuration.AddUserSecrets(Assembly.GetExecutingAssembly());
builder.Services.AddControllers();
builder.Services.AddHttpClient("WebClient", client => client.Timeout = TimeSpan.FromSeconds(600));
builder.Services.AddHttpContextAccessor();
builder.Logging.AddConsole();

// **********  Configure A365 Services **********
// Configure observability
builder.Services.AddAgenticTracingExporter(clusterCategory: "production");

// Add A365 tracing with Agent Framework integration
builder.AddA365Tracing(config =>
{
    config.WithAgentFramework();
});

// Add A365 Tooling Server integration (MCP)
builder.Services.AddSingleton<IMcpToolRegistrationService, McpToolRegistrationService>();
builder.Services.AddSingleton<IMcpToolServerConfigurationService, McpToolServerConfigurationService>();
// **********  END Configure A365 Services **********

// Add AspNet token validation
builder.Services.AddAgentAspNetAuthentication(builder.Configuration);

// Register IStorage (MemoryStorage for development; use persisted storage in production)
builder.Services.AddSingleton<IStorage, MemoryStorage>();

// Add AgentApplicationOptions from config
builder.AddAgentApplicationOptions();

// Add the agent (transient)
builder.AddAgent<MyAgent>();

// Uncomment to add transcript logging middleware to log all conversations to files
// builder.Services.AddSingleton<Microsoft.Agents.Builder.IMiddleware[]>([new TranscriptLoggerMiddleware(new FileTranscriptLogger())]);

// Register IChatClient backed by Anthropic Claude via Anthropic.SDK
builder.Services.AddSingleton<IChatClient>(sp =>
{
    var confSvc = sp.GetRequiredService<IConfiguration>();
    var apiKey = confSvc["AIServices:Anthropic:ApiKey"] ?? string.Empty;
    var modelId = confSvc["AIServices:Anthropic:ModelId"] ?? "claude-sonnet-4-20250514";

    AssertionHelpers.ThrowIfNullOrEmpty(apiKey, "AIServices:Anthropic:ApiKey configuration is missing and required.");

    // Create the Anthropic.SDK client → IChatClient via .Messages
    // .AsBuilder() → UseFunctionInvocation (auto-invokes tools) → UseOpenTelemetry → Build
    return new AnthropicClient(apiKey)
        .Messages
        .AsBuilder()
        .UseFunctionInvocation()
        .UseOpenTelemetry(sourceName: AgentMetrics.SourceName, configure: (cfg) => cfg.EnableSensitiveData = true)
        .Build();
});

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseDeveloperExceptionPage();
}

app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();

// Map the /api/messages endpoint to the AgentApplication
app.MapPost("/api/messages", async (HttpRequest request, HttpResponse response, IAgentHttpAdapter adapter, IAgent agent, CancellationToken cancellationToken) =>
{
    await AgentMetrics.InvokeObservedHttpOperation("agent.process_message", async () =>
    {
        await adapter.ProcessAsync(request, response, agent, cancellationToken);
    }).ConfigureAwait(false);
});

// Health check endpoint
app.MapGet("/api/health", () => Results.Ok(new { status = "healthy", timestamp = System.DateTime.UtcNow }));

if (app.Environment.IsDevelopment() || app.Environment.EnvironmentName == "Playground")
{
    app.MapGet("/", () => "Claude Sample Agent - Powered by Anthropic SDK");
    app.UseDeveloperExceptionPage();
    app.MapControllers().AllowAnonymous();

    app.Urls.Add($"http://localhost:3978");
}
else
{
    app.MapControllers();
}

app.Run();
