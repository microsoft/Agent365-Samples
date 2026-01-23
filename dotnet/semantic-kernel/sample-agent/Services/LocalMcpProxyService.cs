// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Agent365SemanticKernelSampleAgent.Models;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using System;
using System.Collections.Concurrent;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Agent365SemanticKernelSampleAgent.Services;

/// <summary>
/// Service that manages persistent sessions to local Windows MCP servers via WNS
/// </summary>
public class LocalMcpProxyService
{
    private readonly WnsService _wnsService;
    private readonly ILogger<LocalMcpProxyService> _logger;
    private readonly IConfiguration _configuration;
    private readonly HttpClient _httpClient;
    private readonly ConcurrentDictionary<string, LocalMcpSession> _sessions = new();
    private readonly string _baseUrl;

    public LocalMcpProxyService(
        WnsService wnsService,
        ILogger<LocalMcpProxyService> logger,
        IConfiguration configuration,
        IHttpClientFactory httpClientFactory)
    {
        _wnsService = wnsService;
        _logger = logger;
        _configuration = configuration;
        _httpClient = httpClientFactory.CreateClient();
        
        // Get the base URL from configuration or use current host
        _baseUrl = configuration["LocalMcp:BaseUrl"] ?? "https://localhost";
        
        _logger.LogInformation("[LOCAL MCP] Initialized with WnsService: {HasWns}", wnsService != null);
    }

    /// <summary>
    /// Gets or creates a session for a specific user/client
    /// </summary>
    public async Task<LocalMcpSession> GetOrCreateSessionAsync(string clientName, CancellationToken cancellationToken = default)
    {
        // Check if we have an active session
        if (_sessions.TryGetValue(clientName, out var existingSession))
        {
            // Verify session is still alive
            try
            {
                var statusResponse = await _httpClient.GetAsync(
                    $"{_baseUrl}/api/status/{existingSession.SessionId}", 
                    cancellationToken);
                
                if (statusResponse.IsSuccessStatusCode)
                {
                    var status = await statusResponse.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: cancellationToken);
                    if (status.GetProperty("connected").GetBoolean())
                    {
                        _logger.LogDebug("[LOCAL MCP] Reusing existing session {SessionId} for {ClientName}", 
                            existingSession.SessionId, clientName);
                        return existingSession;
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[LOCAL MCP] Failed to check session status for {ClientName}", clientName);
            }

            // Session is dead, remove it
            _sessions.TryRemove(clientName, out _);
        }

        // Create new session
        _logger.LogInformation("[LOCAL MCP] Creating new session for {ClientName}", clientName);
        
        // Send WNS notification to trigger desktop connection
        var notifyResponse = await _httpClient.PostAsync(
            $"{_baseUrl}/api/notify/{clientName}", 
            null, 
            cancellationToken);
        
        notifyResponse.EnsureSuccessStatusCode();
        
        var notifyResult = await notifyResponse.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: cancellationToken);
        var sessionId = notifyResult.GetProperty("sessionId").GetString()!;
        
        _logger.LogInformation("[LOCAL MCP] Session {SessionId} created, waiting for desktop connection...", sessionId);
        
        // Wait for desktop to connect (with timeout)
        var timeout = TimeSpan.FromSeconds(_configuration.GetValue<int>("LocalMcp:ConnectionTimeoutSeconds", 30));
        var connected = await WaitForConnectionAsync(sessionId, timeout, cancellationToken);
        
        if (!connected)
        {
            throw new TimeoutException($"Desktop client '{clientName}' did not connect within {timeout.TotalSeconds}s");
        }
        
        _logger.LogInformation("[LOCAL MCP] Desktop connected, now waiting for WebSocket to be fully ready...");
        
        // CRITICAL FIX: Wait for WebSocket to be fully ready before initializing
        // This prevents sending MCP requests before the desktop is ready to receive them
        var wsReady = await WaitForWebSocketReadyAsync(sessionId, TimeSpan.FromSeconds(10), cancellationToken);
        
        if (!wsReady)
        {
            throw new TimeoutException($"WebSocket for '{clientName}' did not become ready within 10 seconds");
        }
        
        _logger.LogInformation("[LOCAL MCP] ? WebSocket confirmed ready, starting MCP initialization");
        
        // Initialize MCP session
        await InitializeMcpSessionAsync(sessionId, cancellationToken);
        
        var session = new LocalMcpSession
        {
            SessionId = sessionId,
            ClientName = clientName,
            ConnectedAt = DateTime.UtcNow
        };
        
        _sessions.TryAdd(clientName, session);
        
        _logger.LogInformation("[LOCAL MCP] Session {SessionId} ready for {ClientName}", sessionId, clientName);
        
        return session;
    }

    /// <summary>
    /// Sends an MCP request to a local session
    /// </summary>
    public async Task<JsonElement> SendMcpRequestAsync(
        string clientName, 
        string method, 
        object? parameters = null,
        CancellationToken cancellationToken = default)
    {
        var session = await GetOrCreateSessionAsync(clientName, cancellationToken);
        
        // Increment the request ID (must use a local variable since properties cannot be used with ref)
        session.RequestId++;
        var requestId = session.RequestId;
        
        var request = new
        {
            jsonrpc = "2.0",
            id = requestId,
            method,
            @params = parameters ?? new { }
        };
        
        var requestJson = JsonSerializer.Serialize(request);
        
        _logger.LogDebug("[LOCAL MCP] Sending request to {SessionId}: {Method}", 
            session.SessionId, method);
        
        var response = await _httpClient.PostAsync(
            $"{_baseUrl}/api/mcp/{session.SessionId}",
            new StringContent(requestJson, Encoding.UTF8, "application/json"),
            cancellationToken);
        
        response.EnsureSuccessStatusCode();
        
        var result = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: cancellationToken);
        
        _logger.LogInformation("[LOCAL MCP] Response from {SessionId}: {Response}", 
            session.SessionId, result.ToString());
        
        // Keep session alive
        session.LastActivity = DateTime.UtcNow;
        
        return result;
    }

    private async Task<bool> WaitForConnectionAsync(string sessionId, TimeSpan timeout, CancellationToken cancellationToken)
    {
        var startTime = DateTime.UtcNow;
        
        while (DateTime.UtcNow - startTime < timeout)
        {
            try
            {
                var response = await _httpClient.GetAsync(
                    $"{_baseUrl}/api/status/{sessionId}",
                    cancellationToken);
                
                if (response.IsSuccessStatusCode)
                {
                    var status = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: cancellationToken);
                    if (status.GetProperty("connected").GetBoolean())
                    {
                        return true;
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "[LOCAL MCP] Connection check failed");
            }
            
            await Task.Delay(1000, cancellationToken);
        }
        
        return false;
    }
    
    /// <summary>
    /// Waits for WebSocket to be fully ready to receive MCP requests
    /// This is critical to prevent sending requests before the desktop client is ready
    /// </summary>
    private async Task<bool> WaitForWebSocketReadyAsync(string sessionId, TimeSpan timeout, CancellationToken cancellationToken)
    {
        var startTime = DateTime.UtcNow;
        
        _logger.LogInformation("[LOCAL MCP] Waiting for WebSocket to be ready for session {SessionId}", sessionId);
        
        while (DateTime.UtcNow - startTime < timeout)
        {
            try
            {
                var response = await _httpClient.GetAsync(
                    $"{_baseUrl}/api/status/{sessionId}", 
                    cancellationToken);
                
                if (response.IsSuccessStatusCode)
                {
                    var status = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: cancellationToken);
                    if (status.GetProperty("connected").GetBoolean())
                    {
                        // WebSocket is connected - wait a bit more to ensure it's fully ready
                        await Task.Delay(1000, cancellationToken); // Give 1 second grace period
                        
                        _logger.LogInformation("[LOCAL MCP] ? WebSocket is ready for session {SessionId}", sessionId);
                        return true;
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "[LOCAL MCP] WebSocket readiness check failed");
            }
            
            await Task.Delay(500, cancellationToken); // Poll every 500ms
        }
        
        _logger.LogWarning("[LOCAL MCP] ? WebSocket did not become ready within {Timeout}s for session {SessionId}", 
            timeout.TotalSeconds, sessionId);
        return false;
    }

    private async Task InitializeMcpSessionAsync(string sessionId, CancellationToken cancellationToken)
    {
        // Step 1: Send initialize request
        _logger.LogInformation("[LOCAL MCP] Step 1: Sending initialize request to session {SessionId}", sessionId);
        
        var initRequest = JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 1,
            method = "initialize",
            @params = new
            {
                protocolVersion = "2025-06-18",
                capabilities = new { },
                clientInfo = new
                {
                    name = "agent365-sample",
                    version = "1.0.0"
                }
            }
        });
        
        var initResponse = await _httpClient.PostAsync(
            $"{_baseUrl}/api/mcp/{sessionId}",
            new StringContent(initRequest, Encoding.UTF8, "application/json"),
            cancellationToken);
        
        initResponse.EnsureSuccessStatusCode();
        
        var initResult = await initResponse.Content.ReadAsStringAsync(cancellationToken);
        _logger.LogInformation("[LOCAL MCP] Initialize response: {Response}", initResult);
        
        // Step 2: Send initialized notification
        _logger.LogInformation("[LOCAL MCP] Step 2: Sending initialized notification to session {SessionId}", sessionId);
        
        var notifyRequest = JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            method = "notifications/initialized"
        });
        
        try
        {
            await _httpClient.PostAsync(
                $"{_baseUrl}/api/mcp/{sessionId}",
                new StringContent(notifyRequest, Encoding.UTF8, "application/json"),
                cancellationToken);
        }
        catch (Exception ex)
        {
            // Notifications don't get responses, ignore errors
            _logger.LogDebug(ex, "[LOCAL MCP] Initialized notification send failed (expected for notifications)");
        }
        
        // Step 3: Discover available tools via tools/list
        _logger.LogInformation("[LOCAL MCP] Step 3: Discovering available tools via tools/list");
        
        var toolsListRequest = JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 2,
            method = "tools/list",
            @params = new { }
        });
        
        var toolsListResponse = await _httpClient.PostAsync(
            $"{_baseUrl}/api/mcp/{sessionId}",
            new StringContent(toolsListRequest, Encoding.UTF8, "application/json"),
            cancellationToken);
        
        toolsListResponse.EnsureSuccessStatusCode();
        
        var toolsListResult = await toolsListResponse.Content.ReadAsStringAsync(cancellationToken);
        _logger.LogInformation("[LOCAL MCP] Available tools: {Tools}", toolsListResult);
        
        _logger.LogInformation("[LOCAL MCP] ? MCP session fully initialized with tool discovery complete");
    }
}

public class LocalMcpSession
{
    public string SessionId { get; set; } = "";
    public string ClientName { get; set; } = "";
    public DateTime ConnectedAt { get; set; }
    public DateTime LastActivity { get; set; } = DateTime.UtcNow;
    public int RequestId { get; set; } = 1;
}
