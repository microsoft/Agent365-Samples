// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Agent365SemanticKernelSampleAgent.Agents;
using Agent365SemanticKernelSampleAgent.Models;
using Agent365SemanticKernelSampleAgent.Services;
using Agent365SemanticKernelSampleAgent.telemetry;
using Microsoft.Agents.A365.Observability;
using Microsoft.Agents.A365.Observability.Extensions.SemanticKernel;
using Microsoft.Agents.A365.Observability.Hosting;
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
using Microsoft.Extensions.Logging;
using Microsoft.SemanticKernel;
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Linq;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;


WebApplicationBuilder builder = WebApplication.CreateBuilder(args);

// Debug: Verify WnsConfiguration is loaded
var wnsSection = builder.Configuration.GetSection("WnsConfiguration");
var tenantId = wnsSection.GetValue<string>("TenantId");
var clientId = wnsSection.GetValue<string>("ClientId");
Console.WriteLine($"[STARTUP DEBUG] WnsConfiguration - TenantId: {(!string.IsNullOrEmpty(tenantId) ? "EXISTS" : "MISSING")}");
Console.WriteLine($"[STARTUP DEBUG] WnsConfiguration - ClientId: {(!string.IsNullOrEmpty(clientId) ? "EXISTS" : "MISSING")}");
Console.WriteLine($"[STARTUP DEBUG] WnsConfiguration - TenantId value: {(tenantId != null ? tenantId.Substring(0, Math.Min(8, tenantId.Length)) : "NULL")}...");

// WNS-related storage (in-memory for simplicity)
var sessions = new ConcurrentDictionary<string, McpSession>();
var registeredClients = new ConcurrentDictionary<string, ClientRegistration>();

// Setup Aspire service defaults, including OpenTelemetry, Service Discovery, Resilience, and Health Checks
 builder.ConfigureOpenTelemetry();

// Configure WnsConfiguration options
builder.Services.Configure<Agent365SemanticKernelSampleAgent.Models.WnsConfiguration>(
    builder.Configuration.GetSection("WnsConfiguration"));

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
builder.Services.AddAgenticTracingExporter();

// Add A365 tracing with Semantic Kernel integration
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

// Test WnsService construction at startup
try
{
    Console.WriteLine("[STARTUP TEST] Attempting to construct WnsService manually...");
    var testLogger = builder.Services.BuildServiceProvider().GetRequiredService<ILogger<WnsService>>();
    var testWns = new WnsService(builder.Configuration, testLogger);
    Console.WriteLine("[STARTUP TEST] ✓ WnsService constructed successfully!");
}
catch (Exception ex)
{
    Console.WriteLine($"[STARTUP TEST] ✗ WnsService construction FAILED: {ex.GetType().Name}: {ex.Message}");
    Console.WriteLine($"[STARTUP TEST] Stack: {ex.StackTrace}");
}

// Add WNS Service (using ProtoSite pattern - simple singleton registration)
builder.Services.AddSingleton<WnsService>();

// Add Local MCP Proxy Service for Windows desktop MCP servers
builder.Services.AddSingleton<LocalMcpProxyService>();

// Configure the HTTP request pipeline.
// Add AspNet token validation for Azure Bot Service and Entra.  Authentication is configured in the appsettings.json "TokenValidation" section.
builder.Services.AddControllers();
builder.Services.AddAgentAspNetAuthentication(builder.Configuration);

builder.Services.AddSingleton<Microsoft.Agents.Builder.IMiddleware[]>([new TranscriptLoggerMiddleware(new FileTranscriptLogger())]);

WebApplication app = builder.Build();

// Enable AspNet authentication and authorization
app.UseAuthentication();
app.UseAuthorization();

// Enable WebSockets for MCP communication
app.UseWebSockets();

// This receives incoming messages from Azure Bot Service or other SDK Agents
var incomingRoute = app.MapPost("/api/messages", async (HttpRequest request, HttpResponse response, IAgentHttpAdapter adapter, IAgent agent, CancellationToken cancellationToken) =>
{
    await AgentMetrics.InvokeObservedHttpOperation("agent.process_message", async () =>
    {
        await adapter.ProcessAsync(request, response, agent, cancellationToken);
    }).ConfigureAwait(false);
});

if (app.Environment.IsDevelopment() || app.Environment.EnvironmentName == "Playground")
{
    app.MapGet("/", () => "Agent 365 Semantic Kernel Example Agent");
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

// ============================================
// WNS-RELATED ENDPOINTS (New Functionality)
// ============================================

// Start background cleanup task for MCP sessions
_ = Task.Run(async () =>
{
    while (true)
    {
        await Task.Delay(TimeSpan.FromSeconds(10));

        var now = DateTime.UtcNow;
        // Increased to 120 seconds to allow for ODR permission dialogs and slow startup
        var staleTimeout = TimeSpan.FromSeconds(
            app.Configuration.GetValue<int>("SessionTimeouts:IdleTimeoutSeconds", 120));

        foreach (var kvp in sessions)
        {
            var session = kvp.Value;
            var idleTime = now - session.LastActivity;

            if (idleTime > staleTimeout && session.IsConnected)
            {
                app.Logger.LogInformation("[CLEANUP] Session {SessionId} is stale (idle for {IdleSeconds}s), closing WebSocket...",
                    session.SessionId, idleTime.TotalSeconds);

                try
                {
                    await session.WebSocket!.CloseAsync(
                        WebSocketCloseStatus.NormalClosure,
                        "Session timeout due to inactivity",
                        CancellationToken.None);
                }
                catch (Exception ex)
                {
                    app.Logger.LogError(ex, "[CLEANUP] Error closing WebSocket for {SessionId}", session.SessionId);
                }

                sessions.TryRemove(session.SessionId, out _);
            }
            else if (!session.IsConnected && (now - session.Created) > TimeSpan.FromMinutes(5))
            {
                sessions.TryRemove(session.SessionId, out _);
                app.Logger.LogInformation("[CLEANUP] Old disconnected session {SessionId} removed", session.SessionId);
            }
        }
    }
});

// WNS: Register client channel URI (matches ProtoSite pattern)
app.MapPost("/api/channels/register", (ChannelRegistrationRequest request) =>
{
    var registration = new ClientRegistration
    {
        ClientName = request.ClientName,
        ChannelUri = request.ChannelUri,
        MachineName = request.MachineName,
        RegisteredAt = request.RegisteredAt,
        LastSeen = DateTime.UtcNow
    };

    registeredClients.AddOrUpdate(request.ClientName, registration, (key, old) => registration);

    app.Logger.LogInformation("[WNS REGISTRATION] Client '{ClientName}' from {MachineName}",
        request.ClientName, request.MachineName);

    return Results.Ok(new { message = "Registration successful", clientName = request.ClientName });
}).AllowAnonymous();

// WNS: List registered clients (matches ProtoSite pattern)
app.MapGet("/api/channels", () =>
{
    var clients = registeredClients.Values
        .Select(c => new
        {
            c.ClientName,
            c.MachineName,
            ChannelUri = c.ChannelUri.Length > 40
                ? c.ChannelUri.Substring(0, 40) + "..."
                : c.ChannelUri,
            c.RegisteredAt,
            c.LastSeen
        });
    return Results.Json(clients);
}).AllowAnonymous();

// WNS: Send notification to trigger client connection or discovery (matches ProtoSite pattern)
app.MapPost("/api/notify/{clientName}", async (string clientName, WnsService wnsService, HttpContext context) =>
{
    if (!registeredClients.TryGetValue(clientName, out var client))
    {
        app.Logger.LogWarning("[WNS NOTIFY] Client '{ClientName}' not found", clientName);
        return Results.NotFound(new { message = "Client not found" });
    }

    // Read the request body to check the notification type
    string requestBody;
    using (var reader = new StreamReader(context.Request.Body))
    {
        requestBody = await reader.ReadToEndAsync();
    }

    string? notificationType = null;
    string? requestId = null;
    string? serverId = null;
    string? callbackUrl = null;

    // Parse the request to determine the type
    if (!string.IsNullOrEmpty(requestBody))
    {
        try
        {
            var jsonDoc = System.Text.Json.JsonDocument.Parse(requestBody);
            if (jsonDoc.RootElement.TryGetProperty("type", out var typeElement))
            {
                notificationType = typeElement.GetString();
            }
            if (jsonDoc.RootElement.TryGetProperty("requestId", out var reqIdElement))
            {
                requestId = reqIdElement.GetString();
            }
            if (jsonDoc.RootElement.TryGetProperty("callbackUrl", out var callbackElement))
            {
                callbackUrl = callbackElement.GetString();
            }
            if (jsonDoc.RootElement.TryGetProperty("serverId", out var serverIdElement))
            {
                serverId = serverIdElement.GetString();
            }
        }
        catch (Exception ex)
        {
            app.Logger.LogWarning(ex, "[WNS NOTIFY] Failed to parse request body");
        }
    }

    var scheme = context.Request.IsHttps ? "wss" : "ws";
    var httpScheme = context.Request.IsHttps ? "https" : "http";
    var host = context.Request.Host.ToString();

    // Handle discovery requests (list_servers)
    if (notificationType == "list_servers")
    {
        requestId ??= Guid.NewGuid().ToString();
        callbackUrl ??= $"{httpScheme}://{host}/api/discovery/{requestId}/servers";

        app.Logger.LogInformation("[WNS NOTIFY] Sending DISCOVERY notification to '{ClientName}'", clientName);
        app.Logger.LogInformation("[WNS NOTIFY] Request ID: {RequestId}", requestId);
        app.Logger.LogInformation("[WNS NOTIFY] Callback URL: {CallbackUrl}", callbackUrl);

        // Send notification with type="list_servers" - desktop client should run odr mcp list
        // and POST results to the callback URL
        var (success, errorMessage) = await wnsService.SendDiscoveryNotificationAsync(
            client.ChannelUri, requestId, callbackUrl);

        if (success)
        {
            return Results.Ok(new
            {
                message = "Discovery notification sent",
                requestId,
                callbackUrl
            });
        }
        else
        {
            return Results.Json(new { message = $"Failed to send notification: {errorMessage}" }, statusCode: 500);
        }
    }
    else
    {
        // Handle MCP server invocation (original flow)
        var sessionId = Guid.NewGuid().ToString();

        // Use serverId from request body, or fall back to default file-mcp-server
        serverId ??= "MicrosoftWindows.Client.Core_cw5n1h2txyewy_com.microsoft.windows.ai.mcpServer_file-mcp-server";
        callbackUrl = $"{scheme}://{host}/ws/mcp/{sessionId}?serverId={Uri.EscapeDataString(serverId)}";

        // Create pending session
        sessions.TryAdd(sessionId, new McpSession { SessionId = sessionId });

        app.Logger.LogInformation("[WNS NOTIFY] Sending MCP notification to '{ClientName}'", clientName);
        app.Logger.LogInformation("[WNS NOTIFY] Session ID: {SessionId}", sessionId);
        app.Logger.LogInformation("[WNS NOTIFY] Callback URL: {CallbackUrl}", callbackUrl);
        app.Logger.LogInformation("[WNS NOTIFY] Server ID: {ServerId}", serverId);

        // Pass serverId in the payload so locaproto can use proxy mode
        var (success, errorMessage) = await wnsService.SendNotificationAsync(client.ChannelUri, callbackUrl, serverId);

        if (success)
        {
            return Results.Ok(new
            {
                message = "Notification sent",
                sessionId,
                callbackUrl
            });
        }
        else
        {
            sessions.TryRemove(sessionId, out _);
            return Results.Json(new { message = $"Failed to send notification: {errorMessage}" }, statusCode: 500);
        }
    }
}).AllowAnonymous();

// WebSocket endpoint for locaproto to connect
app.Map("/ws/mcp/{sessionId}", async (HttpContext context, string sessionId) =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = 400;
        return;
    }

    if (!sessions.TryGetValue(sessionId, out var session))
    {
        context.Response.StatusCode = 404;
        return;
    }

    var webSocket = await context.WebSockets.AcceptWebSocketAsync();
    session.WebSocket = webSocket;
    session.UpdateActivity();

    app.Logger.LogInformation("[MCP SESSION] {SessionId} WebSocket connected", sessionId);

    try
    {
        var buffer = new byte[1024 * 4];
        var messageBuilder = new StringBuilder();

        while (webSocket.State == WebSocketState.Open)
        {
            var result = await webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);

            if (result.MessageType == WebSocketMessageType.Close)
            {
                await webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", CancellationToken.None);
                break;
            }

            messageBuilder.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));

            if (result.EndOfMessage)
            {
                var message = messageBuilder.ToString();
                messageBuilder.Clear();

                session.UpdateActivity();
                app.Logger.LogDebug("[WS?LOCAPROTO] {Message}", message);

                // Parse the response to extract the ID for correlation
                try
                {
                    var jsonDoc = System.Text.Json.JsonDocument.Parse(message);
                    if (jsonDoc.RootElement.TryGetProperty("id", out var idElement))
                    {
                        var id = idElement.GetInt32();
                        if (session.PendingRequests.TryRemove(id, out var tcs))
                        {
                            tcs.SetResult(message);
                        }
                    }
                }
                catch (Exception ex)
                {
                    app.Logger.LogError(ex, "[WS] Error parsing response");
                }
            }
        }
    }
    catch (Exception ex)
    {
        app.Logger.LogError(ex, "[MCP SESSION] {SessionId} WebSocket error", sessionId);
    }
    finally
    {
        session.WebSocket = null;
        app.Logger.LogInformation("[MCP SESSION] {SessionId} WebSocket disconnected", sessionId);
    }
}).AllowAnonymous();

// API endpoint to check MCP connection status (matches ProtoSite pattern)
app.MapGet("/api/status/{sessionId}", (string sessionId) =>
{
    sessions.TryGetValue(sessionId, out var session);
    var isConnected = session?.IsConnected ?? false;

    return Results.Json(new
    {
        sessionId,
        registered = isConnected,
        connected = isConnected
    });
}).AllowAnonymous();

// Heartbeat endpoint to keep MCP session alive (matches ProtoSite pattern)
app.MapPost("/api/heartbeat/{sessionId}", (string sessionId) =>
{
    if (sessions.TryGetValue(sessionId, out var session))
    {
        session.UpdateActivity();
        return Results.Ok(new { alive = true });
    }

    return Results.NotFound();
}).AllowAnonymous();

// Proxy endpoint: Browser/API MCP requests → LocaProto via WebSocket (matches ProtoSite pattern)
app.MapPost("/api/mcp/{sessionId}", async (HttpContext context, string sessionId) =>
{
    if (!sessions.TryGetValue(sessionId, out var session) || !session.IsConnected)
    {
        return Results.Problem("Session not found or WebSocket not connected", statusCode: 404);
    }

    try
    {
        // Read the request body (JSON-RPC request)
        using var reader = new StreamReader(context.Request.Body);
        var requestBody = await reader.ReadToEndAsync();

        session.UpdateActivity();
        app.Logger.LogDebug("[API?WS] {RequestBody}", requestBody);

        // Extract the request ID for correlation
        var jsonDoc = System.Text.Json.JsonDocument.Parse(requestBody);
        
        // Check if this is a request with an ID or just a notification
        if (!jsonDoc.RootElement.TryGetProperty("id", out var idElement))
        {
            // This is a notification or message without an ID, log it and return success
            app.Logger.LogDebug("[API?WS] Received message without ID (notification or error): {RequestBody}", requestBody);
            return Results.Ok(new { message = "Notification received" });
        }
        
        var requestId = idElement.GetInt32();

        // Create a TaskCompletionSource to wait for the response
        var tcs = new TaskCompletionSource<string>();
        session.PendingRequests.TryAdd(requestId, tcs);

        try
        {
            // Send request through WebSocket to locaproto
            var messageBytes = Encoding.UTF8.GetBytes(requestBody);
            await session.WebSocket!.SendAsync(
                new ArraySegment<byte>(messageBytes),
                WebSocketMessageType.Text,
                true,
                CancellationToken.None);

            // Wait for response (with timeout - increased to 120s for ODR startup/permissions)
            // Use a loop with shorter intervals to keep updating activity while waiting
            var responseTask = tcs.Task;
            var timeout = TimeSpan.FromSeconds(120);
            var elapsed = TimeSpan.Zero;
            var checkInterval = TimeSpan.FromSeconds(5);

            while (elapsed < timeout)
            {
                var delayTask = Task.Delay(checkInterval);
                var completedTask = await Task.WhenAny(responseTask, delayTask);

                if (completedTask == responseTask)
                {
                    // Response received, break out of loop
                    break;
                }

                // Still waiting - update activity to prevent cleanup from killing session
                session.UpdateActivity();
                elapsed += checkInterval;
            }

            if (!responseTask.IsCompleted)
            {
                session.PendingRequests.TryRemove(requestId, out _);
                return Results.Problem("Request timeout", statusCode: 504);
            }

            var jsonResponse = await responseTask;

            app.Logger.LogDebug("[WS?API] {Response}", jsonResponse);

            // Return the response
            return Results.Content(jsonResponse, "application/json");
        }
        finally
        {
            // Clean up pending request if it wasn't completed
            session.PendingRequests.TryRemove(requestId, out _);
        }
    }
    catch (Exception ex)
    {
        app.Logger.LogError(ex, "[MCP PROXY] Error communicating with MCP server");
        return Results.Problem($"Error: {ex.Message}", statusCode: 500);
    }
}).AllowAnonymous();

// ============================================
// END OF WNS-RELATED ENDPOINTS
// ============================================

// ============================================
// DISCOVERY ENDPOINTS (for list_servers)
// ============================================

// Storage for discovery requests
var discoveryRequests = new ConcurrentDictionary<string, DiscoveryResult>();

// Desktop client posts discovery results here
app.MapPost("/api/discovery/{requestId}/servers", async (string requestId, HttpContext context) =>
{
    try
    {
        using var reader = new StreamReader(context.Request.Body);
        var requestBody = await reader.ReadToEndAsync();

        app.Logger.LogInformation("[DISCOVERY] Received server list for request {RequestId}: {Body}",
            requestId, requestBody.Length > 200 ? requestBody.Substring(0, 200) + "..." : requestBody);

        var result = new DiscoveryResult
        {
            RequestId = requestId,
            Status = "completed",
            RawResponse = requestBody,
            ReceivedAt = DateTime.UtcNow
        };

        discoveryRequests.AddOrUpdate(requestId, result, (key, old) => result);

        return Results.Ok(new { message = "Servers received", requestId });
    }
    catch (Exception ex)
    {
        app.Logger.LogError(ex, "[DISCOVERY] Error processing server list for request {RequestId}", requestId);
        return Results.Problem($"Error: {ex.Message}", statusCode: 500);
    }
}).AllowAnonymous();

// SDK polls this endpoint for discovery results
app.MapGet("/api/discovery/{requestId}/servers", (string requestId) =>
{
    app.Logger.LogInformation("[DISCOVERY] SDK polling for request {RequestId}", requestId);

    if (discoveryRequests.TryGetValue(requestId, out var result))
    {
        app.Logger.LogInformation("[DISCOVERY] Found result for {RequestId}, status: {Status}", requestId, result.Status);

        if (result.Status == "completed")
        {
            // Parse the raw response to extract servers
            // Desktop may post either:
            // 1. Bare array: [ { "id": "...", ... }, ... ]
            // 2. Wrapped: { "servers": [ ... ] }
            // 3. Wrapped with error: { "servers": [], "error": "..." }
            try
            {
                var jsonDoc = System.Text.Json.JsonDocument.Parse(result.RawResponse);
                System.Text.Json.JsonElement serversArray;
                string? errorMessage = null;

                if (jsonDoc.RootElement.ValueKind == System.Text.Json.JsonValueKind.Array)
                {
                    // Case 1: Desktop posted bare array
                    serversArray = jsonDoc.RootElement;
                    app.Logger.LogInformation("[DISCOVERY] Raw response is bare array with {Count} items", serversArray.GetArrayLength());
                }
                else if (jsonDoc.RootElement.TryGetProperty("servers", out var servers))
                {
                    // Case 2/3: Desktop posted wrapped object
                    serversArray = servers;
                    jsonDoc.RootElement.TryGetProperty("error", out var errorElement);
                    errorMessage = errorElement.ValueKind == System.Text.Json.JsonValueKind.String ? errorElement.GetString() : null;
                    app.Logger.LogInformation("[DISCOVERY] Raw response is wrapped object with {Count} servers, error: {Error}", 
                        serversArray.GetArrayLength(), errorMessage ?? "none");
                }
                else
                {
                    // Unexpected format - return empty
                    app.Logger.LogWarning("[DISCOVERY] Unexpected response format: {Response}", 
                        result.RawResponse.Length > 100 ? result.RawResponse.Substring(0, 100) + "..." : result.RawResponse);
                    return Results.Json(new { status = "completed", requestId, servers = new object[] { }, error = "Unexpected response format" });
                }

                if (!string.IsNullOrEmpty(errorMessage))
                {
                    return Results.Json(new { status = "error", requestId, servers = new object[] { }, error = errorMessage });
                }

                return Results.Json(new
                {
                    status = "completed",
                    requestId = requestId,
                    servers = serversArray
                });
            }
            catch (Exception ex)
            {
                app.Logger.LogError(ex, "[DISCOVERY] Failed to parse response: {Response}", 
                    result.RawResponse?.Length > 100 ? result.RawResponse.Substring(0, 100) + "..." : result.RawResponse);
                return Results.Json(new
                {
                    status = "completed",
                    requestId = requestId,
                    servers = new object[] { }
                });
            }
        }
        else
        {
            return Results.Json(new { status = result.Status, requestId });
        }
    }

    // Request not yet received - create a pending entry
    app.Logger.LogDebug("[DISCOVERY] No result yet for {RequestId}, creating pending entry", requestId);
    discoveryRequests.TryAdd(requestId, new DiscoveryResult
    {
        RequestId = requestId,
        Status = "pending",
        ReceivedAt = DateTime.UtcNow
    });

    return Results.Json(new { status = "pending", requestId });
}).AllowAnonymous();

// ============================================
// END OF DISCOVERY ENDPOINTS
// ============================================

app.Run();
