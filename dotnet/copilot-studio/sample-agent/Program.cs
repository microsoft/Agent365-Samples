// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Agent365CopilotStudioSampleAgent;
using Agent365CopilotStudioSampleAgent.Agent;
using Agent365CopilotStudioSampleAgent.telemetry;
using Microsoft.Agents.A365.Observability;
using Microsoft.Agents.A365.Observability.Extensions.AgentFramework;
using Microsoft.Agents.A365.Observability.Runtime;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Core;
using Microsoft.Agents.Hosting.AspNetCore;
using Microsoft.Agents.Storage;
using Microsoft.Agents.Storage.Transcript;
using System.Reflection;

var builder = WebApplication.CreateBuilder(args);

// Setup OpenTelemetry
builder.ConfigureOpenTelemetry();

builder.Configuration.AddUserSecrets(Assembly.GetExecutingAssembly());
builder.Services.AddControllers();
builder.Services.AddHttpClient("WebClient", client => client.Timeout = TimeSpan.FromSeconds(600));
builder.Services.AddHttpContextAccessor();
builder.Logging.AddConsole();

// **********  Configure A365 Services **********
// Configure observability.
builder.Services.AddAgenticTracingExporter(clusterCategory: "production");

// Add A365 tracing with Agent Framework integration
builder.AddA365Tracing(config =>
{
    config.WithAgentFramework();
});
// **********  END Configure A365 Services **********

// Add AspNet token validation
builder.Services.AddAgentAspNetAuthentication(builder.Configuration);

// Register IStorage. For development, MemoryStorage is suitable.
builder.Services.AddSingleton<IStorage, MemoryStorage>();

// Add AgentApplicationOptions from config.
builder.AddAgentApplicationOptions();

// Add the agent (which is transient)
builder.AddAgent<MyAgent>();

// Uncomment to add transcript logging middleware
builder.Services.AddSingleton<Microsoft.Agents.Builder.IMiddleware[]>([new TranscriptLoggerMiddleware(new FileTranscriptLogger())]);

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
app.MapGet("/api/health", () => Results.Ok(new { status = "healthy", timestamp = DateTime.UtcNow }));

if (app.Environment.IsDevelopment() || app.Environment.EnvironmentName == "Playground")
{
    app.MapGet("/", () => "Copilot Studio Sample Agent");
    app.UseDeveloperExceptionPage();
    app.MapControllers().AllowAnonymous();
    app.Urls.Add($"http://localhost:3978");
}
else
{
    app.MapControllers();
}

app.Run();
