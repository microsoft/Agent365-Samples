// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.Net;
using System.Text;
using System.Text.Json;

namespace Agent365.E2E.Tests;

/// <summary>
/// Mock Bot Framework Connector server that captures agent responses.
/// 
/// When an agent receives a message via /api/messages, it sends responses
/// back via the Bot Framework Connector API (POST to serviceUrl).
/// This mock server captures those responses for testing.
/// 
/// How it works:
/// 1. Start mock server on a local port (e.g., http://localhost:3980)
/// 2. Send message to agent with serviceUrl pointing to mock server
/// 3. Agent processes message and calls mock server to send response
/// 4. Mock server captures response for test validation
/// </summary>
public class MockBotFrameworkServer : IAsyncDisposable
{
    private readonly int _port;
    private HttpListener? _listener;
    private CancellationTokenSource? _cts;
    private Task? _listenTask;
    
    // Store responses by conversation ID
    private readonly Dictionary<string, List<Dictionary<string, JsonElement>>> _responses = new();
    private readonly object _lock = new();

    public string ServiceUrl => $"http://localhost:{_port}";

    public MockBotFrameworkServer(int port = 3980)
    {
        _port = port;
    }

    /// <summary>
    /// Start the mock server to capture agent responses.
    /// </summary>
    public async Task StartAsync()
    {
        _listener = new HttpListener();
        _listener.Prefixes.Add($"http://localhost:{_port}/");
        _cts = new CancellationTokenSource();

        try
        {
            _listener.Start();
            _listenTask = ListenAsync(_cts.Token);
            
            // Give it a moment to start
            await Task.Delay(100);
        }
        catch (HttpListenerException ex) when (ex.ErrorCode == 5)
        {
            // Access denied - port may be in use or need admin rights
            throw new InvalidOperationException(
                $"Cannot start mock server on port {_port}. Port may be in use or requires admin rights.", ex);
        }
    }

    /// <summary>
    /// Stop the mock server.
    /// </summary>
    public async Task StopAsync()
    {
        if (_cts != null)
        {
            _cts.Cancel();
            
            if (_listenTask != null)
            {
                try
                {
                    await _listenTask;
                }
                catch (OperationCanceledException)
                {
                    // Expected
                }
            }
            
            _cts.Dispose();
            _cts = null;
        }

        if (_listener != null)
        {
            _listener.Stop();
            _listener.Close();
            _listener = null;
        }
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
    }

    /// <summary>
    /// Create a conversation to track responses.
    /// </summary>
    public void CreateConversation(string conversationId)
    {
        lock (_lock)
        {
            _responses[conversationId] = new List<Dictionary<string, JsonElement>>();
        }
    }

    /// <summary>
    /// Clear responses for a conversation.
    /// </summary>
    public void ClearResponses(string conversationId)
    {
        lock (_lock)
        {
            if (_responses.TryGetValue(conversationId, out var list))
            {
                list.Clear();
            }
        }
    }

    /// <summary>
    /// Wait for responses from the agent.
    /// </summary>
    public async Task<List<Dictionary<string, JsonElement>>> WaitForResponsesAsync(
        string conversationId,
        TimeSpan? timeout = null)
    {
        var deadline = DateTime.UtcNow + (timeout ?? TimeSpan.FromSeconds(10));

        while (DateTime.UtcNow < deadline)
        {
            lock (_lock)
            {
                if (_responses.TryGetValue(conversationId, out var responses) && responses.Count > 0)
                {
                    return new List<Dictionary<string, JsonElement>>(responses);
                }
            }

            await Task.Delay(100);
        }

        // Return empty list if no responses
        lock (_lock)
        {
            if (_responses.TryGetValue(conversationId, out var responses))
            {
                return new List<Dictionary<string, JsonElement>>(responses);
            }
        }

        return new List<Dictionary<string, JsonElement>>();
    }

    /// <summary>
    /// Extract response text from activity JSON.
    /// </summary>
    public static string? GetResponseText(Dictionary<string, JsonElement> activity)
    {
        if (activity.TryGetValue("text", out var textElement))
        {
            return textElement.GetString();
        }
        return null;
    }

    /// <summary>
    /// Extract response text from JsonElement activity.
    /// </summary>
    public static string? GetResponseText(JsonElement activity)
    {
        if (activity.TryGetProperty("text", out var textElement))
        {
            return textElement.GetString();
        }
        return null;
    }

    private async Task ListenAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested && _listener?.IsListening == true)
        {
            try
            {
                var contextTask = _listener.GetContextAsync();
                
                // Wait with cancellation support
                using var registration = cancellationToken.Register(() =>
                {
                    try { _listener?.Stop(); } catch { }
                });
                
                HttpListenerContext context;
                try
                {
                    context = await contextTask;
                }
                catch (HttpListenerException)
                {
                    break;
                }
                catch (ObjectDisposedException)
                {
                    break;
                }

                // Process request in background
                _ = ProcessRequestAsync(context);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception)
            {
                // Log error but continue listening
            }
        }
    }

    private async Task ProcessRequestAsync(HttpListenerContext context)
    {
        var request = context.Request;
        var response = context.Response;

        try
        {
            // Bot Framework Connector API endpoints
            var path = request.Url?.AbsolutePath ?? "";

            // POST /v3/conversations/{conversationId}/activities
            if (request.HttpMethod == "POST" && path.Contains("/v3/conversations/") && path.Contains("/activities"))
            {
                await HandleSendActivityAsync(request, response);
                return;
            }

            // POST /v3/conversations (create conversation)
            if (request.HttpMethod == "POST" && path == "/v3/conversations")
            {
                await HandleCreateConversationAsync(response);
                return;
            }

            // Default response
            response.StatusCode = 200;
            var bytes = Encoding.UTF8.GetBytes("{\"status\":\"ok\"}");
            await response.OutputStream.WriteAsync(bytes);
        }
        catch (Exception)
        {
            response.StatusCode = 500;
        }
        finally
        {
            response.Close();
        }
    }

    private async Task HandleSendActivityAsync(HttpListenerRequest request, HttpListenerResponse response)
    {
        // Read activity from request body
        using var reader = new StreamReader(request.InputStream);
        var body = await reader.ReadToEndAsync();

        try
        {
            var activity = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(body);
            
            if (activity != null)
            {
                // Extract conversation ID from path or activity
                string? conversationId = null;
                
                var path = request.Url?.AbsolutePath ?? "";
                var match = System.Text.RegularExpressions.Regex.Match(
                    path, @"/v3/conversations/([^/]+)/activities");
                if (match.Success)
                {
                    conversationId = match.Groups[1].Value;
                }
                else if (activity.TryGetValue("conversation", out var conv) && 
                         conv.TryGetProperty("id", out var convId))
                {
                    conversationId = convId.GetString();
                }

                if (!string.IsNullOrEmpty(conversationId))
                {
                    lock (_lock)
                    {
                        if (!_responses.ContainsKey(conversationId))
                        {
                            _responses[conversationId] = new List<Dictionary<string, JsonElement>>();
                        }
                        _responses[conversationId].Add(activity);
                    }
                }
            }

            // Return success (Bot Framework expects 200 or 201)
            response.StatusCode = 200;
            response.ContentType = "application/json";
            var result = new { id = Guid.NewGuid().ToString() };
            var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(result));
            await response.OutputStream.WriteAsync(bytes);
        }
        catch (JsonException)
        {
            response.StatusCode = 400;
        }
    }

    private async Task HandleCreateConversationAsync(HttpListenerResponse response)
    {
        // Return a fake conversation ID
        response.StatusCode = 200;
        response.ContentType = "application/json";
        var result = new
        {
            id = Guid.NewGuid().ToString(),
            serviceUrl = ServiceUrl
        };
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(result));
        await response.OutputStream.WriteAsync(bytes);
    }
}
