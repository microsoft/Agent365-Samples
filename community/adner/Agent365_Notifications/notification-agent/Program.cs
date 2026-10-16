// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using NotificationAgent;
using NotificationAgent.Agent;
using Azure;
using Azure.AI.OpenAI;
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

builder.Configuration.AddUserSecrets(Assembly.GetExecutingAssembly());
builder.Services.AddControllers();
builder.Services.AddHttpClient("WebClient", client => client.Timeout = TimeSpan.FromSeconds(600));
builder.Services.AddHttpContextAccessor();
builder.Logging.AddConsole();

// Add A365 Tooling Server integration
builder.Services.AddSingleton<IMcpToolRegistrationService, McpToolRegistrationService>();
builder.Services.AddSingleton<IMcpToolServerConfigurationService, McpToolServerConfigurationService>();

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

    AssertionHelpers.ThrowIfNullOrEmpty(endpoint, "AIServices:AzureOpenAI:Endpoint configuration is missing and required.");
    AssertionHelpers.ThrowIfNullOrEmpty(apiKey, "AIServices:AzureOpenAI:ApiKey configuration is missing and required.");
    AssertionHelpers.ThrowIfNullOrEmpty(deployment, "AIServices:AzureOpenAI:DeploymentName configuration is missing and required.");

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
        .Build(); 
});

var app = builder.Build();

app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();

// Map the /api/messages endpoint to the AgentApplication
app.MapPost("/api/messages", async (HttpRequest request, HttpResponse response, IAgentHttpAdapter adapter, IAgent agent, CancellationToken cancellationToken) =>
{
        await adapter.ProcessAsync(request, response, agent, cancellationToken);
});

if (app.Environment.IsDevelopment() || app.Environment.EnvironmentName == "Playground")
{
    app.MapGet("/", () => "Agent Framework Notification Agent");
    app.UseDeveloperExceptionPage();
    app.MapControllers().AllowAnonymous();

    app.Urls.Add($"http://localhost:3978");
}
else
{
    app.MapControllers();
}

app.Run();