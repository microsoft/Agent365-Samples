// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using PerplexitySampleAgent;
using PerplexitySampleAgent.Agent;
using PerplexitySampleAgent.telemetry;
using Microsoft.Agents.A365.Observability;
using Microsoft.Agents.A365.Observability.Runtime;
using Microsoft.Agents.A365.Tooling.Services;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Hosting.AspNetCore;
using Microsoft.Agents.Storage;
using Microsoft.Agents.Storage.Transcript;
using System.Reflection;

var builder = WebApplication.CreateBuilder(args);

// Setup Aspire service defaults (OpenTelemetry, Service Discovery, Resilience, Health Checks).
builder.ConfigureOpenTelemetry();

builder.Configuration.AddUserSecrets(Assembly.GetExecutingAssembly());
builder.Services.AddControllers();
builder.Services.AddHttpClient("WebClient", client => client.Timeout = TimeSpan.FromSeconds(600));
// Extend default HttpClient timeout — the A365 Tooling SDK's gateway call can exceed the 30s default.
builder.Services.ConfigureHttpClientDefaults(opts => opts.ConfigureHttpClient(c => c.Timeout = TimeSpan.FromSeconds(180)));
builder.Services.AddHttpContextAccessor();
builder.Logging.AddConsole();

// Register PerplexityClient — uses HttpClient directly against the Responses API.
// This gives full control over the tool-call loop, argument enrichment, nudge, and auto-finalize.
builder.Services.AddSingleton<PerplexityClient>(sp =>
{
    var confSvc = sp.GetRequiredService<IConfiguration>();
    var endpoint = confSvc["AIServices:Perplexity:Endpoint"] ?? "https://api.perplexity.ai/v1";
    var apiKey = confSvc["AIServices:Perplexity:ApiKey"]
                 ?? Environment.GetEnvironmentVariable("PERPLEXITY_API_KEY")
                 ?? string.Empty;
    var model = confSvc["AIServices:Perplexity:Model"]
                ?? Environment.GetEnvironmentVariable("PERPLEXITY_MODEL")
                ?? "perplexity/sonar";

    var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(180) };
    var logger = sp.GetRequiredService<ILogger<PerplexityClient>>();
    return new PerplexityClient(httpClient, endpoint, apiKey, model, logger);
});

// **********  Configure A365 Services **********
// Configure observability.
builder.Services.AddAgenticTracingExporter(clusterCategory: "production");

// Add A365 tracing.
builder.AddA365Tracing();

// Register McpToolService (direct MCP JSON-RPC — no Semantic Kernel).
builder.Services.AddSingleton<IMcpToolServerConfigurationService, McpToolServerConfigurationService>();
builder.Services.AddSingleton<McpToolService>();
// **********  END Configure A365 Services **********

// AspNet token validation.
builder.Services.AddAgentAspNetAuthentication(builder.Configuration);

// Register IStorage. MemoryStorage is suitable for development; use persistent storage in production.
builder.Services.AddSingleton<IStorage, MemoryStorage>();

// Add AgentApplicationOptions from config.
builder.AddAgentApplicationOptions();

// Add the Agent (transient).
builder.AddAgent<MyAgent>();

// Transcript logging middleware (logs conversations to files for debugging).
builder.Services.AddSingleton<Microsoft.Agents.Builder.IMiddleware[]>([new TranscriptLoggerMiddleware(new FileTranscriptLogger())]);

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseDeveloperExceptionPage();
}

app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();

// Map the /api/messages endpoint.
app.MapPost("/api/messages", async (HttpRequest request, HttpResponse response, IAgentHttpAdapter adapter, IAgent agent, CancellationToken cancellationToken, ILogger<Program> logger) =>
{
    try
    {
        await AgentMetrics.InvokeObservedHttpOperation("agent.process_message", async () =>
        {
            await adapter.ProcessAsync(request, response, agent, cancellationToken);
        }).ConfigureAwait(false);
    }
    catch (Exception ex) when (ex is ObjectDisposedException or OperationCanceledException
                                 or Microsoft.AspNetCore.Connections.ConnectionAbortedException)
    {
        // The upstream caller (Bot Framework) closed the connection before processing finished.
        // Log and swallow — crashing the process is worse than a dropped request.
        logger.LogWarning("Connection dropped during message processing: {Error}", ex.GetType().Name);
    }
});

// Health check endpoint.
app.MapGet("/api/health", () => Results.Ok(new { status = "healthy", timestamp = DateTime.UtcNow }));

if (app.Environment.IsDevelopment() || app.Environment.EnvironmentName == "Playground")
{
    app.MapGet("/", () => "Perplexity Sample Agent");
    app.UseDeveloperExceptionPage();
    app.MapControllers().AllowAnonymous();
    app.Urls.Add("http://localhost:3978");
}
else
{
    app.MapControllers();
}

app.Run();
