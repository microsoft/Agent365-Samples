// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using W365ComputerUseSample;
using W365ComputerUseSample.Agent;
using W365ComputerUseSample.ComputerUse;
using W365ComputerUseSample.Telemetry;
using Microsoft.Agents.A365.Observability;
using Microsoft.Agents.A365.Observability.Extensions.AgentFramework;
using Microsoft.Agents.A365.Observability.Runtime;
using Microsoft.Agents.A365.Tooling.Extensions.AgentFramework.Services;
using Microsoft.Agents.A365.Tooling.Services;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Core;
using Microsoft.Agents.Hosting.AspNetCore;
using Microsoft.Agents.Storage;
using System.Reflection;

var builder = WebApplication.CreateBuilder(args);

// Setup ASP service defaults, including OpenTelemetry, Service Discovery, Resilience, and Health Checks
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

// Add A365 Tooling Server integration
builder.Services.AddSingleton<IMcpToolRegistrationService, McpToolRegistrationService>();
builder.Services.AddSingleton<IMcpToolServerConfigurationService, McpToolServerConfigurationService>();
// **********  END Configure A365 Services **********

// Register the Azure OpenAI CUA model provider
builder.Services.AddSingleton<ICuaModelProvider, AzureOpenAIModelProvider>();

// Register the Computer Use orchestrator
builder.Services.AddSingleton<ComputerUseOrchestrator>();

// Add AspNet token validation
builder.Services.AddAgentAspNetAuthentication(builder.Configuration);

// Register IStorage. For development, MemoryStorage is suitable.
builder.Services.AddSingleton<IStorage, MemoryStorage>();

// Add AgentApplicationOptions from config.
builder.AddAgentApplicationOptions();

// Add the bot (which is transient)
builder.AddAgent<MyAgent>();

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
    // Allow multiple reads of the request body — tracing/observability middleware may
    // re-read it after the adapter, which otherwise triggers
    // "Reading is not allowed after reader was completed" on the Kestrel pipe reader.
    request.EnableBuffering();

    await AgentMetrics.InvokeObservedHttpOperation("agent.process_message", async () =>
    {
        await adapter.ProcessAsync(request, response, agent, cancellationToken);
    }).ConfigureAwait(false);
});

// Health check endpoint for CI/CD pipelines and monitoring
app.MapGet("/api/health", () => Results.Ok(new { status = "healthy", timestamp = DateTime.UtcNow }));

if (app.Environment.IsDevelopment() || app.Environment.EnvironmentName == "Playground")
{
    app.MapGet("/", () => "W365 Computer Use Sample Agent");
    app.UseDeveloperExceptionPage();
    app.MapControllers().AllowAnonymous();

    // Hard coded for brevity and ease of testing.
    // In production, this should be set in configuration.
    app.Urls.Add("http://localhost:3978");
}
else
{
    app.MapControllers();
}

app.Run();
