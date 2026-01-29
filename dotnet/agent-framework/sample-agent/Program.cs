// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Agent365AgentFrameworkSampleAgent;
using Agent365AgentFrameworkSampleAgent.Agent;
using Agent365AgentFrameworkSampleAgent.telemetry;
using Azure;
using Azure.AI.OpenAI;
using Microsoft.Agents.A365.Observability.Hosting;
using Microsoft.Agents.A365.Observability.Extensions.AgentFramework;
using Microsoft.Agents.A365.Observability.Runtime;
using Microsoft.Agents.A365.Tooling.Extensions.AgentFramework.Services;
using Microsoft.Agents.A365.Tooling.Services;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Core;
using Microsoft.Agents.Hosting.AspNetCore;
using Microsoft.Agents.Storage;
using Microsoft.Agents.Storage.Transcript;
using Microsoft.Extensions.AI;
using System.Reflection;



var builder = WebApplication.CreateBuilder(args);

// Setup Aspire service defaults, including OpenTelemetry, Service Discovery, Resilience, and Health Checks
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
    //config.WithAgentFramework(additionalSources: AgentMetrics.SourceName);
});

// Add A365 Tooling Server integration
builder.Services.AddSingleton<IMcpToolRegistrationService, McpToolRegistrationService>();
builder.Services.AddSingleton<IMcpToolServerConfigurationService, McpToolServerConfigurationService>();
// **********  END Configure A365 Services **********

// Add AspNet token validation
builder.Services.AddAgentAspNetAuthentication(builder.Configuration);

// Register IStorage.  For development, MemoryStorage is suitable.
// For production Agents, persisted storage should be used so
// that state survives Agent restarts, and operate correctly
// in a cluster of Agent instances.
builder.Services.AddSingleton<IStorage, MemoryStorage>();

// Add AgentApplicationOptions from config.
builder.AddAgentApplicationOptions();

// Add the bot (which is transient)
builder.AddAgent<MyAgent>();

// Register IChatClient with correct types
builder.Services.AddSingleton<IChatClient>(sp => {

    var confSvc = sp.GetRequiredService<IConfiguration>();
    var endpoint = confSvc["AIServices:AzureOpenAI:Endpoint"] ?? string.Empty;
    var apiKey = confSvc["AIServices:AzureOpenAI:ApiKey"] ?? string.Empty;
    var deployment = confSvc["AIServices:AzureOpenAI:DeploymentName"] ?? string.Empty;

    // Validate OpenWeatherAPI key. 
    var openWeatherApiKey = confSvc["OpenWeatherApiKey"] ?? string.Empty;

    AssertionHelpers.ThrowIfNullOrEmpty(endpoint, "AIServices:AzureOpenAI:Endpoint configuration is missing and required.");
    AssertionHelpers.ThrowIfNullOrEmpty(apiKey, "AIServices:AzureOpenAI:ApiKey configuration is missing and required.");
    AssertionHelpers.ThrowIfNullOrEmpty(deployment, "AIServices:AzureOpenAI:DeploymentName configuration is missing and required.");
    AssertionHelpers.ThrowIfNullOrEmpty(openWeatherApiKey, "OpenWeatherApiKey configuration is missing and required.");

    // Convert endpoint to Uri
    var endpointUri = new Uri(endpoint);

    // Convert apiKey to ApiKeyCredential
    var apiKeyCredential = new AzureKeyCredential(apiKey);

    // Create and return the AzureOpenAIClient's ChatClient
    return new AzureOpenAIClient(endpointUri, apiKeyCredential)
        .GetChatClient(deployment)
        .AsIChatClient()
        .AsBuilder()
        .UseFunctionInvocation()
        .UseOpenTelemetry(sourceName: AgentMetrics.SourceName, configure: (cfg) => cfg.EnableSensitiveData = true)
        .Build(); 
});

// Add Bot Framework adapter for proactive messaging
builder.Services.AddSingleton<IAgentHttpAdapter, CloudAdapter>();

// Register the A365 Scope Middleware
// This middleware uses InvokeAgentScope and OutputScope for observability
builder.Services.AddSingleton<A365OutputScopeMiddleware>();

// Register middleware array with scope and transcript logging middleware
builder.Services.AddSingleton<Microsoft.Agents.Builder.IMiddleware[]>(sp =>
{
    var scopeMiddleware = sp.GetRequiredService<A365OutputScopeMiddleware>();
    return [
        scopeMiddleware,  // Scope middleware runs first
        new TranscriptLoggerMiddleware(new FileTranscriptLogger())  // Transcript logging
    ];
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


if (app.Environment.IsDevelopment() || app.Environment.EnvironmentName == "Playground")
{
    app.MapGet("/", () => "Agent Framework Example Weather Agent");
    app.UseDeveloperExceptionPage();
    app.MapControllers().AllowAnonymous();

    // Hard coded for brevity and ease of testing. 
    // In production, this should be set in configuration.
    app.Urls.Add($"http://localhost:3978");
}
else
{
    app.MapControllers();
}

app.Run();