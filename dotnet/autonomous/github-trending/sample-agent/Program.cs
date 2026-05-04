// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Azure;
using Azure.AI.OpenAI;
using Azure.Identity;
using GitHubTrending;
using GitHubTrending.Tools;
using Microsoft.Agents.A365.Observability.Hosting.Caching;
using Microsoft.Extensions.AI;
using Microsoft.OpenTelemetry;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHttpClient();
builder.Logging.AddConsole();

// A365 Observability — S2S token cache + background token service + AgentDetails context.
// ObservabilityTokenService acquires tokens via a 3-hop FMI chain (Blueprint → Agent Identity → API)
// and registers them with the ServiceTokenCache every 50 minutes.
builder.Services.AddAgent365Observability();

// Microsoft OpenTelemetry distro — configures OTel tracing pipeline + A365 exporter.
// The token resolver reads from the ServiceTokenCache populated by ObservabilityTokenService.
// Note: tokenCache is resolved lazily after Build() via the closure over the local variable.
IExporterTokenCache<string>? tokenCache = null;
builder.UseMicrosoftOpenTelemetry(o =>
{
    o.Exporters = builder.Environment.IsDevelopment()
        ? ExportTarget.Agent365 | ExportTarget.Console
        : ExportTarget.Agent365;

    o.Agent365.Exporter.UseS2SEndpoint = true;
    o.Agent365.Exporter.TokenResolver = async (agentId, tenantId) =>
    {
        return tokenCache != null
            ? await tokenCache.GetObservabilityToken(agentId, tenantId)
            : null;
    };
});

// Azure OpenAI client — supports both API key and DefaultAzureCredential (e.g. MSI)
var aoaiEndpoint = builder.Configuration["AzureOpenAI:Endpoint"]
    ?? throw new InvalidOperationException("AzureOpenAI:Endpoint configuration is required.");
var aoaiKey = builder.Configuration["AzureOpenAI:ApiKey"];

if (!string.IsNullOrEmpty(aoaiKey))
{
    builder.Services.AddSingleton(new AzureOpenAIClient(new Uri(aoaiEndpoint), new AzureKeyCredential(aoaiKey)));
}
else
{
    builder.Services.AddSingleton(new AzureOpenAIClient(new Uri(aoaiEndpoint), new DefaultAzureCredential()));
}

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
tokenCache = app.Services.GetService<IExporterTokenCache<string>>();

app.UseRouting();

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
