// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Agent365SemanticKernelSampleAgent;
using Microsoft.Agents.A365.Observability;
using Microsoft.Agents.A365.Observability.Extensions.SemanticKernel;
using Microsoft.Agents.A365.Observability.Runtime;
using Microsoft.Agents.A365.Tooling.Extensions.SemanticKernel.Services;
using Microsoft.Agents.A365.Tooling.Services;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Hosting.AspNetCore;
using Microsoft.Agents.Storage;
using Microsoft.Agents.Storage.Transcript;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.SemanticKernel;
using SemanticKernelSampleAgent;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;

//System.Environment.SetEnvironmentVariable("EnableAgent365Exporter", "true");


WebApplicationBuilder builder = WebApplication.CreateBuilder(args);


// Setup Aspire service defaults, including OpenTelemetry, Service Discovery, Resilience, and Health Checks
 builder.ConfigureOpenTelemetry();

if (builder.Environment.IsDevelopment())
{
    builder.Configuration.AddUserSecrets<Program>();
}

builder.Services.AddHttpClient();

// Register Semantic Kernel
builder.Services.AddKernel();

// Register the AI service of your choice. AzureOpenAI and OpenAI are demonstrated...
if (builder.Configuration.GetSection("AIServices").GetValue<bool>("UseAzureOpenAI"))
{
    builder.Services.AddAzureOpenAIChatCompletion(
        deploymentName: builder.Configuration.GetSection("AIServices:AzureOpenAI").GetValue<string>("DeploymentName")!,
        endpoint: builder.Configuration.GetSection("AIServices:AzureOpenAI").GetValue<string>("Endpoint")!,
        apiKey: builder.Configuration.GetSection("AIServices:AzureOpenAI").GetValue<string>("ApiKey")!);

    //Use the Azure CLI (for local) or Managed Identity (for Azure running app) to authenticate to the Azure OpenAI service
    //credentials: new ChainedTokenCredential(
    //   new AzureCliCredential(),
    //   new ManagedIdentityCredential()
    //));
}
else
{
    builder.Services.AddOpenAIChatCompletion(
        modelId: builder.Configuration.GetSection("AIServices:OpenAI").GetValue<string>("ModelId")!,
        apiKey: builder.Configuration.GetSection("AIServices:OpenAI").GetValue<string>("ApiKey")!);
}

// Configure observability.
builder.Services.AddAgenticTracingExporter(clusterCategory: builder.Environment.IsDevelopment() ? "preprod" : "production");

builder.AddA365Tracing(config =>
{
    config.WithSemanticKernel();
});

builder.AddA365Tracing(config =>
{
    config.WithSemanticKernel();
});


// Add AgentApplicationOptions from appsettings section "AgentApplication".
builder.AddAgentApplicationOptions();

// Add the AgentApplication, which contains the logic for responding to
// user messages.
builder.AddAgent<MyAgent>();

// Register IStorage.  For development, MemoryStorage is suitable.
// For production Agents, persisted storage should be used so
// that state survives Agent restarts, and operates correctly
// in a cluster of Agent instances.
builder.Services.AddSingleton<IStorage, MemoryStorage>();

builder.Services.AddSingleton<IMcpToolRegistrationService, McpToolRegistrationService>();
builder.Services.AddSingleton<IMcpToolServerConfigurationService, McpToolServerConfigurationService>();

// Configure the HTTP request pipeline.
// Add AspNet token validation for Azure Bot Service and Entra.  Authentication is configured in the appsettings.json "TokenValidation" section.
builder.Services.AddControllers();
builder.Services.AddAgentAspNetAuthentication(builder.Configuration);

builder.Services.AddSingleton<Microsoft.Agents.Builder.IMiddleware[]>([new TranscriptLoggerMiddleware(new FileTranscriptLogger())]);

WebApplication app = builder.Build();

// Enable AspNet authentication and authorization
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/", () => "Microsoft Agents SDK Sample");

// This receives incoming messages from Azure Bot Service or other SDK Agents
var incomingRoute = app.MapPost("/api/messages", async (HttpRequest request, HttpResponse response, IAgentHttpAdapter adapter, IAgent agent, CancellationToken cancellationToken) =>
{
    using var activity = AgentMetrics.ActivitySource.StartActivity("agent.process_message");
    try
    {
        activity?.SetTag("agent.type", agent.GetType().Name);
        activity?.SetTag("request.path", request.Path);
        activity?.SetTag("request.method", request.Method);

        await adapter.ProcessAsync(request, response, agent, cancellationToken);

        activity?.SetStatus(ActivityStatusCode.Ok);
        AgentMetrics.MessageProcessedCounter.Add(1,
            new KeyValuePair<string, object?>("agent.type", agent.GetType().Name),
            new KeyValuePair<string, object?>("status", "success"));
    }
    catch (Exception ex)
    {
        activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
        activity?.AddEvent(new ActivityEvent("exception", DateTimeOffset.UtcNow, new()
        {
            ["exception.type"] = ex.GetType().FullName,
            ["exception.message"] = ex.Message,
            ["exception.stacktrace"] = ex.StackTrace
        }));
        AgentMetrics.MessageProcessedCounter.Add(1,
            new KeyValuePair<string, object?>("agent.type", agent.GetType().Name),
            new KeyValuePair<string, object?>("status", "error"));
        throw;
    }
});

// Hardcoded for brevity and ease of testing. 
// In production, this should be set in configuration.
app.Urls.Add($"http://localhost:3978");

app.Run();
