// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Agent365AgentFrameworkSampleAgent;
using Agent365AgentFrameworkSampleAgent.Agent;
using Agent365AgentFrameworkSampleAgent.telemetry;
using Azure;
using Azure.AI.OpenAI;
using Microsoft.Agents.A365.Observability;
using Microsoft.Agents.A365.Observability.Caching;
using Microsoft.Agents.A365.Observability.Extensions.AgentFramework;
using Microsoft.Agents.A365.Observability.Runtime;
using Microsoft.Agents.A365.Observability.Runtime.Common;
using Microsoft.Agents.A365.Tooling.Extensions.AgentFramework.Services;
using Microsoft.Agents.A365.Tooling.Services;
using Microsoft.Agents.Authentication;
using Microsoft.Agents.Authentication.Msal;
using Microsoft.Agents.Authentication.Model;
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
// Configure observability (Service exporter — token acquired via BlueprintFmiTokenProvider in A365OtelWrapper).
builder.Services.AddServiceTracingExporter(clusterCategory: "production");

// Add A365 tracing with Agent Framework integration
builder.AddA365Tracing(config =>
{
    config.WithAgentFramework();
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

// Register custom IConnections with BlueprintFmiTokenProvider for bot service auth.
// This MUST be registered BEFORE AddAgent so the SDK uses our provider.
builder.Services.AddSingleton<IConnections>(sp =>
{
    var config = sp.GetRequiredService<IConfiguration>();
    var logger = sp.GetRequiredService<ILogger<BlueprintFmiTokenProvider>>();

    // Create the FMI token provider for bot service connection
    var blueprintSection = config.GetSection("Connections:BlueprintConnection:Settings");
    var identityAppId = config["BlueprintIdentity:IdentityAppId"]!;
    var tenantId = config["BlueprintIdentity:TenantId"]!;
    var fmiProvider = new BlueprintFmiTokenProvider(sp, blueprintSection, identityAppId, tenantId, logger);

    // Also create a standard MsalAuth for the BlueprintConnection (used for agentic/OBO flows)
    var blueprintAuth = new MsalAuth(sp, blueprintSection);

    // Register both connections
    var connections = new Dictionary<string, IAccessTokenProvider>
    {
        ["BotConnection"] = fmiProvider,
        ["BlueprintConnection"] = blueprintAuth
    };

    var map = new List<ConnectionMapItem>
    {
        new() { ServiceUrl = "*", Connection = "BotConnection" }
    };

    return new ConfigurationConnections(connections, map, sp.GetRequiredService<ILogger<ConfigurationConnections>>());
});

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

// Uncomment to add transcript logging middleware to log all conversations to files
builder.Services.AddSingleton<Microsoft.Agents.Builder.IMiddleware[]>([new TranscriptLoggerMiddleware(new FileTranscriptLogger())]);

// CORS for chat.html
builder.Services.AddCors(options =>
{
    options.AddPolicy("ChatUI", policy => policy
        .AllowAnyOrigin()
        .AllowAnyHeader()
        .AllowAnyMethod());
});

var app = builder.Build();

app.UseCors("ChatUI");

if (app.Environment.IsDevelopment())
{
    app.UseDeveloperExceptionPage();
}

app.UseStaticFiles();
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

// Health check endpoint for CI/CD pipelines and monitoring
app.MapGet("/api/health", () => Results.Ok(new { status = "healthy", timestamp = System.DateTime.UtcNow }));

// OBO test endpoint — accepts a user assertion token (audience = Blueprint) in the
// Authorization header, performs the FMI + OBO exchange via BlueprintFmiTokenProvider,
// and returns the result metadata (proving the OBO chain works end-to-end).
// Does NOT route through the Bot Framework adapter (which requires channel auth).
app.MapPost("/api/obo-test", async (HttpRequest request, HttpResponse response, IConnections connections, IConfiguration config, CancellationToken cancellationToken) =>
{
    var logger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("OboTest");

    // Extract Bearer token
    var authHeader = request.Headers.Authorization.ToString();
    if (string.IsNullOrEmpty(authHeader) || !authHeader.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
    {
        response.StatusCode = 401;
        await response.WriteAsJsonAsync(new { error = "Missing or invalid Authorization header. Expected: Bearer <user-token>" }, cancellationToken);
        return;
    }
    var userAssertionToken = authHeader["Bearer ".Length..].Trim();

    var fmiProvider = connections.GetConnection("BotConnection") as BlueprintFmiTokenProvider;
    if (fmiProvider == null)
    {
        response.StatusCode = 500;
        await response.WriteAsJsonAsync(new { error = "BotConnection is not a BlueprintFmiTokenProvider. OBO flow requires Blueprint+Identity auth." }, cancellationToken);
        return;
    }

    // Read requested scopes from the body, or default to MCP gateway
    string[] scopes;
    try
    {
        var body = await request.ReadFromJsonAsync<OboTestRequest>(cancellationToken);
        scopes = body?.Scopes ?? ["ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/.default"];
    }
    catch
    {
        scopes = ["ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/.default"];
    }

    try
    {
        logger.LogInformation("OBO test: starting exchange for {ScopeCount} scope(s)", scopes.Length);
        var accessToken = await fmiProvider.GetOnBehalfOfAccessTokenAsync(scopes, userAssertionToken);

        // Decode the token to return metadata (not the token itself)
        var parts = accessToken.Split('.');
        string claims = "{}";
        if (parts.Length >= 2)
        {
            var payload = parts[1];
            // Fix base64url padding
            payload = payload.Replace('-', '+').Replace('_', '/');
            switch (payload.Length % 4)
            {
                case 2: payload += "=="; break;
                case 3: payload += "="; break;
            }
            claims = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(payload));
        }
        var claimsJson = System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(claims);

        await response.WriteAsJsonAsync(new
        {
            status = "success",
            message = "OBO exchange completed successfully",
            tokenLength = accessToken.Length,
            audience = claimsJson.TryGetProperty("aud", out var aud) ? aud.GetString() : null,
            subject = claimsJson.TryGetProperty("sub", out var sub) ? sub.GetString() : null,
            upn = claimsJson.TryGetProperty("upn", out var upn) ? upn.GetString() : null,
            name = claimsJson.TryGetProperty("name", out var name) ? name.GetString() : null,
            scpClaim = claimsJson.TryGetProperty("scp", out var scp) ? scp.GetString() : null,
            expires = claimsJson.TryGetProperty("exp", out var exp) ? DateTimeOffset.FromUnixTimeSeconds(exp.GetInt64()).ToString("o") : null,
            requestedScopes = scopes
        }, cancellationToken);
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "OBO test: exchange failed");
        response.StatusCode = 500;
        await response.WriteAsJsonAsync(new
        {
            status = "error",
            error = ex.Message,
            innerError = ex.InnerException?.Message,
            requestedScopes = scopes
        }, cancellationToken);
    }
});

// OBO message endpoint — accepts a user assertion token in the Authorization header,
// stores it in HttpContext.Items so MyAgent can perform the FMI+OBO exchange when
// building tools, then routes through the Bot Framework adapter pipeline.
// NOTE: This only works when called FROM Bot Framework (e.g., DirectLine) because
// the adapter validates channel auth. For direct API testing, use /api/obo-test.
app.MapPost("/api/obo-messages", async (HttpRequest request, HttpResponse response, IAgentHttpAdapter adapter, IAgent agent, CancellationToken cancellationToken) =>
{
    var authHeader = request.Headers["X-User-Assertion"].ToString();
    if (!string.IsNullOrEmpty(authHeader))
    {
        request.HttpContext.Items["UserAssertionToken"] = authHeader;
    }

    await AgentMetrics.InvokeObservedHttpOperation("agent.obo_message", async () =>
    {
        await adapter.ProcessAsync(request, response, agent, cancellationToken);
    }).ConfigureAwait(false);
});

// OBO chat endpoint — full end-to-end: accepts user assertion token, performs OBO exchange,
// loads MCP tools with the delegated token, sends the user's message to the LLM, and returns
// the model response. Completely standalone from Bot Framework.
// A365 observability tracing is enabled — spans are exported to Power Platform.
app.MapPost("/api/obo-chat", async (HttpRequest request, HttpResponse response, IConnections connections, IChatClient chatClient, IMcpToolRegistrationService toolService, IConfiguration config, CancellationToken cancellationToken) =>
{
    var logger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("OboChat");
    var serviceTokenCache = app.Services.GetService<IExporterTokenCache<string>>();

    // Extract Bearer token
    var authHeader = request.Headers.Authorization.ToString();
    if (string.IsNullOrEmpty(authHeader) || !authHeader.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
    {
        response.StatusCode = 401;
        await response.WriteAsJsonAsync(new { error = "Missing or invalid Authorization header. Expected: Bearer <user-token>" }, cancellationToken);
        return;
    }
    var userAssertionToken = authHeader["Bearer ".Length..].Trim();

    var fmiProvider = connections.GetConnection("BotConnection") as BlueprintFmiTokenProvider;
    if (fmiProvider == null)
    {
        response.StatusCode = 500;
        await response.WriteAsJsonAsync(new { error = "BotConnection is not a BlueprintFmiTokenProvider." }, cancellationToken);
        return;
    }

    // Parse request body
    OboChatRequest? body;
    try
    {
        body = await request.ReadFromJsonAsync<OboChatRequest>(cancellationToken);
    }
    catch
    {
        response.StatusCode = 400;
        await response.WriteAsJsonAsync(new { error = "Invalid JSON body. Expected: { \"text\": \"your question\" }" }, cancellationToken);
        return;
    }

    if (string.IsNullOrWhiteSpace(body?.Text))
    {
        response.StatusCode = 400;
        await response.WriteAsJsonAsync(new { error = "\"text\" field is required." }, cancellationToken);
        return;
    }

    var mcpScopes = body.Scopes ?? ["ea9ffc3e-8a23-4a7d-836d-234d7c7565c1/.default"];

    // Result container — populated inside the tracing wrapper, written to response outside it.
    // This avoids the IFeatureCollection disposed error that occurs when WriteAsJsonAsync
    // runs inside InvokeObservedHttpOperation after a long-running LLM call.
    object? resultPayload = null;
    int resultStatusCode = 200;

    // Wrap the business logic in A365 observability tracing
    await AgentMetrics.InvokeObservedHttpOperation("agent.obo_chat", async () =>
    {
    try
    {
        // Step 1: OBO exchange — get a delegated MCP token
        logger.LogInformation("OBO chat: performing OBO exchange for {ScopeCount} scope(s)", mcpScopes.Length);
        var mcpToken = await fmiProvider.GetOnBehalfOfAccessTokenAsync(mcpScopes, userAssertionToken);
        logger.LogInformation("OBO chat: OBO exchange succeeded (token length={Length})", mcpToken.Length);

        // Step 2: Resolve agent identity from the MCP token (decode JWT to get appid/azp claim)
        string? agentId = null;
        string? tenantId = null;
        try
        {
            var parts = mcpToken.Split('.');
            if (parts.Length >= 2)
            {
                var payload = parts[1].Replace('-', '+').Replace('_', '/');
                switch (payload.Length % 4) { case 2: payload += "=="; break; case 3: payload += "="; break; }
                var json = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(payload));
                var claims = System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(json);
                // For delegated tokens, the app acting as the agent is in 'azp' (authorized party)
                if (claims.TryGetProperty("azp", out var azp))
                    agentId = azp.GetString();
                else if (claims.TryGetProperty("appid", out var appid))
                    agentId = appid.GetString();
                // Extract tenant from 'tid' claim
                if (claims.TryGetProperty("tid", out var tid))
                    tenantId = tid.GetString();
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "OBO chat: failed to decode agentId from token");
        }

        // Fallback tenant from config
        tenantId ??= config["BlueprintIdentity:TenantId"] ?? Guid.Empty.ToString();
        agentId ??= Guid.Empty.ToString();
        logger.LogInformation("OBO chat: resolved agentId='{AgentId}', tenantId='{TenantId}'", agentId, tenantId);

        // Step 2.5: Register A365 observability — set baggage and acquire PP token for exporter
        using var baggageScope = new BaggageBuilder()
            .TenantId(tenantId)
            .AgentId(agentId)
            .Build();

        try
        {
            var observabilityScope = "https://api.powerplatform.com/.default";
            var ppToken = await fmiProvider.GetAccessTokenAsync(
                "https://api.powerplatform.com",
                new List<string> { observabilityScope });
            serviceTokenCache?.RegisterObservability(agentId, tenantId, ppToken, new[] { observabilityScope });
            logger.LogInformation("OBO chat: A365 observability registered for agentId={AgentId}", agentId);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "OBO chat: failed to register A365 observability — spans won't be exported");
        }

        // Step 3: Load MCP tools using the delegated token
        var toolList = new List<AITool>();
        if (!string.IsNullOrEmpty(agentId) && agentId != Guid.Empty.ToString())
        {
            try
            {
                var a365Tools = await toolService.GetMcpToolsAsync(agentId, null!, string.Empty, null!, mcpToken).ConfigureAwait(false);
                if (a365Tools != null && a365Tools.Count > 0)
                {
                    toolList.AddRange(a365Tools);
                    logger.LogInformation("OBO chat: loaded {Count} MCP tool(s)", a365Tools.Count);
                }
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "OBO chat: failed to load MCP tools, continuing with local tools only");
            }
        }

        // Step 4: Add local tools
        toolList.Add(AIFunctionFactory.Create(Agent365AgentFrameworkSampleAgent.Tools.DateTimeFunctionTool.getDate));

        // Cap tools at 128 (OpenAI limit). Keep local tools (added last) and trim MCP tools if needed.
        const int MaxTools = 128;
        if (toolList.Count > MaxTools)
        {
            logger.LogWarning("OBO chat: {Total} tools exceeds OpenAI limit of {Max}. Truncating.", toolList.Count, MaxTools);
            toolList = toolList.Take(MaxTools).ToList();
        }

        // Step 5: Invoke the LLM
        var chatOptions = new ChatOptions
        {
            Temperature = 0.2f,
            Tools = toolList
        };

        var messages = new List<ChatMessage>
        {
            new(ChatRole.System, "You are a helpful assistant. Use the tools available to answer the user's questions."),
            new(ChatRole.User, body.Text)
        };

        var result = await chatClient.GetResponseAsync(messages, chatOptions, cancellationToken);

        resultPayload = new
        {
            status = "success",
            userMessage = body.Text,
            agentId,
            tenantId,
            tracingEnabled = serviceTokenCache != null,
            toolCount = toolList.Count,
            response = result.Text
        };
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "OBO chat: failed");
        resultStatusCode = 500;
        resultPayload = new
        {
            status = "error",
            error = ex.Message,
            innerError = ex.InnerException?.Message
        };
    }
    }).ConfigureAwait(false);

    // Write response OUTSIDE the metrics wrapper to avoid IFeatureCollection disposed errors
    response.StatusCode = resultStatusCode;
    if (resultPayload != null)
    {
        await response.WriteAsJsonAsync(resultPayload, cancellationToken);
    }
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

// Minimal request model for /api/obo-test
record OboTestRequest(string[]? Scopes);

// Request model for /api/obo-chat
record OboChatRequest(string Text, string[]? Scopes);