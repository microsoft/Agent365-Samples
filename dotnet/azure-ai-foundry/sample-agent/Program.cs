// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Azure;
using Azure.AI.Agents.Persistent;
using Azure.Identity;
using AzureAIFoundrySampleAgent.Agent;
using AzureAIFoundrySampleAgent.Telemetry;
using Microsoft.Agents.A365.Observability;
using Microsoft.Agents.A365.Observability.Runtime;
using Microsoft.Agents.A365.Tooling.Extensions.AzureFoundry.Services;
using Microsoft.Agents.A365.Tooling.Services;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Core;
using Microsoft.Agents.Hosting.AspNetCore;
using Microsoft.Agents.Storage;
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
// Configure observability - Using console exporter for development
// Removed AddAgenticTracingExporter dependency, using OpenTelemetry Console exporter instead

// Add A365 tracing
builder.AddA365Tracing();

// Add A365 Tooling Server integration for MCP
builder.Services.AddSingleton<IMcpToolRegistrationService, McpToolRegistrationService>();
builder.Services.AddSingleton<IMcpToolServerConfigurationService, McpToolServerConfigurationService>();
// **********  END Configure A365 Services **********

// Add AspNet token validation
// Note: AddAgentAspNetAuthentication method doesn't exist in current SDK
// builder.Services.AddAgentAspNetAuthentication(builder.Configuration);

// Register IStorage.  For development, MemoryStorage is suitable.
// For production Agents, persisted storage should be used so
// that state survives Agent restarts, and operate correctly
// in a cluster of Agent instances.
builder.Services.AddSingleton<IStorage, MemoryStorage>();

// Add AgentApplicationOptions from config.
builder.AddAgentApplicationOptions();

// Add the bot (which is transient)
builder.AddAgent<MyAgent>();

// Register PersistentAgentsClient for Azure AI Foundry
builder.Services.AddSingleton<PersistentAgentsClient>(sp =>
{
    var confSvc = sp.GetRequiredService<IConfiguration>();
    var endpoint = confSvc["AzureAIFoundry:Endpoint"] ?? string.Empty;
    var tenantId = confSvc["TokenValidation:TenantId"] ?? string.Empty;
    
    if (string.IsNullOrEmpty(endpoint))
    {
        throw new ArgumentException("AzureAIFoundry:Endpoint configuration is required");
    }
    
    // Configure DefaultAzureCredential with tenant ID to ensure authentication token matches the Foundry resource tenant
    var credentialOptions = new DefaultAzureCredentialOptions
    {
        TenantId = tenantId
    };
    return new PersistentAgentsClient(endpoint, new DefaultAzureCredential(credentialOptions));
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

if (app.Environment.IsDevelopment())
{
    app.MapGet("/", () => "Azure AI Foundry Example Agent");
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