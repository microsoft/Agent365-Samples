// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Azure;
using Azure.AI.OpenAI;
using GitHubTrending;
using GitHubTrending.Tools;
using Microsoft.Agents.A365.Observability.Hosting.Caching;
using Microsoft.Agents.Hosting.AspNetCore;
using Microsoft.Extensions.AI;
using Microsoft.OpenTelemetry;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHttpClient();
builder.Logging.AddConsole();

// Agent Framework: token validation + adapter
builder.Services.AddAuthentication();
builder.Services.AddAuthorization();
builder.Services.AddAgentAspNetAuthentication(builder.Configuration);

// A365 Observability — S2S token cache + background token service + AgentDetails context.
// ObservabilityTokenService acquires tokens via a 3-hop FMI chain (Blueprint → Agent Identity → API)
// and registers them with the ServiceTokenCache every 50 minutes.
builder.Services.AddAgent365Observability();

// Microsoft OpenTelemetry distro — configures OTel tracing pipeline + A365 exporter.
// The token resolver reads from the ServiceTokenCache populated by ObservabilityTokenService.
WebApplication? appRef = null;
builder.UseMicrosoftOpenTelemetry(o =>
{
    o.Exporters = builder.Environment.IsDevelopment()
        ? ExportTarget.Agent365 | ExportTarget.Console
        : ExportTarget.Agent365;

    o.Agent365.Exporter.TokenResolver = async (agentId, tenantId) =>
    {
        var cache = appRef?.Services.GetService<IExporterTokenCache<string>>();
        return cache != null
            ? await cache.GetObservabilityToken(agentId, tenantId)
            : null;
    };
});

// Azure OpenAI client
var aoaiEndpoint = builder.Configuration["AzureOpenAI:Endpoint"]!;
var aoaiKey = builder.Configuration["AzureOpenAI:ApiKey"]!;
builder.Services.AddSingleton(new AzureOpenAIClient(new Uri(aoaiEndpoint), new AzureKeyCredential(aoaiKey)));

// IChatClient with function invocation — lets the model call registered tools
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

// GitHub trending tool — registered as a plugin the model can call
builder.Services.AddSingleton<GitHubTrendingTool>();

// Background services
builder.Services.AddHostedService<HeartbeatService>();
builder.Services.AddHostedService<GitHubTrendingService>();

var app = builder.Build();
appRef = app;

app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();

// Health check
app.MapGet("/api/health", () => Results.Ok(new
{
    status = "healthy",
    timestamp = DateTimeOffset.UtcNow
}));

if (app.Environment.IsDevelopment())
{
    app.MapGet("/", () => "GitHubTrending — Autonomous agent monitoring trending repositories");
    var port = builder.Configuration["PORT"] ?? "3979";
    app.Urls.Add($"http://localhost:{port}");
}

app.Run();
