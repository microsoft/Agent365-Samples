// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Azure;
using Azure.AI.OpenAI;
using DotNetAutonomous;
using DotNetAutonomous.Agent;
using DotNetAutonomous.Tools;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Hosting.AspNetCore;
using Microsoft.Agents.Storage;
using Microsoft.Extensions.AI;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHttpClient();
builder.Services.AddHttpContextAccessor();
builder.Logging.AddConsole();

// Agent Framework: token validation + adapter
// AddAuthentication and AddAuthorization are always required regardless of whether TokenValidation is enabled
// (UseAuthentication/UseAuthorization in the pipeline require these services even when validation is disabled)
builder.Services.AddAuthentication();
builder.Services.AddAuthorization();
builder.Services.AddAgentAspNetAuthentication(builder.Configuration);

// In-memory state storage (sufficient for a test agent; swap for persistent storage in production)
builder.Services.AddSingleton<IStorage, MemoryStorage>();

// Agent application options (reads AgentApplication section from appsettings)
builder.AddAgentApplicationOptions();

// Register the agent (transient per-turn)
builder.AddAgent<DotNetAutonomousAgent>();

// Azure OpenAI client — shared by WeatherMonitorService and the IChatClient below
var aoaiEndpoint = builder.Configuration["AzureOpenAI:Endpoint"]!;
var aoaiKey = builder.Configuration["AzureOpenAI:ApiKey"]!;
builder.Services.AddSingleton(new AzureOpenAIClient(new Uri(aoaiEndpoint), new AzureKeyCredential(aoaiKey)));

// IChatClient — used by DotNetAutonomousAgent for conversational chat with function invocation
builder.Services.AddSingleton<IChatClient>(sp =>
{
    var aoai = sp.GetRequiredService<AzureOpenAIClient>();
    var deployment = builder.Configuration["AzureOpenAI:Deployment"] ?? "gpt-4o";
    return aoai.GetChatClient(deployment)
               .AsIChatClient()
               .AsBuilder()
               .UseFunctionInvocation()
               .Build();
});

// Weather lookup tool — geocodes any city and fetches live conditions via Open-Meteo
builder.Services.AddSingleton<WeatherLookupTool>();

// Periodic weather monitor — fetches real conditions and logs a GPT-4o field advisory each cycle
builder.Services.AddHostedService<WeatherMonitorService>();

var app = builder.Build();

app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();

// Health check — unauthenticated, used by Azure App Service and a365 deploy verification
app.MapGet("/api/health", () => Results.Ok(new
{
    status = "healthy",
    timestamp = DateTimeOffset.UtcNow
}));

// Messages endpoint — routes to AgentApplication via the Agent Framework adapter
app.MapPost("/api/messages", async (HttpRequest request, HttpResponse response, IAgentHttpAdapter adapter, IAgent agent, CancellationToken ct) =>
{
    await adapter.ProcessAsync(request, response, agent, ct);
});

if (app.Environment.IsDevelopment())
{
    app.MapGet("/", () => "DotNetAutonomous — Agent Framework test agent");
    var port = builder.Configuration["PORT"] ?? "3978";
    app.Urls.Add($"http://localhost:{port}");
}

app.Run();
