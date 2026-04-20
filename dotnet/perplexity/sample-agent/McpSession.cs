// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.Text.Json;

namespace PerplexitySampleAgent;

/// <summary>
/// Minimal MCP client that speaks JSON-RPC over Streamable HTTP.
/// Direct port of the Python _McpSession class — no Semantic Kernel dependency.
/// </summary>
public sealed class McpSession : IAsyncDisposable
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly HttpClient _http;
    private readonly string _url;
    private readonly string _authToken;
    private readonly string _agentId;
    private readonly ILogger _logger;
    private string? _sessionId;
    private int _reqId;

    public string ServerName { get; }

    public McpSession(string url, string authToken, string agentId, string serverName, ILogger logger)
    {
        _url = url;
        _authToken = authToken;
        _agentId = agentId;
        ServerName = serverName;
        _logger = logger;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(120) };
    }

    // -- public API ----------------------------------------------------------

    public async Task InitializeAsync(CancellationToken ct = default)
    {
        _logger.LogDebug("[McpSession] Initializing session for server '{Server}' at {Url}", ServerName, _url);
        await RpcAsync("initialize", new Dictionary<string, object?>
        {
            ["protocolVersion"] = "2025-03-26",
            ["capabilities"] = new Dictionary<string, object>(),
            ["clientInfo"] = new Dictionary<string, object>
            {
                ["name"] = "perplexity-agent-dotnet",
                ["version"] = "0.1.0",
            },
        }, ct);

        // Notify the server that the client is ready (fire-and-forget).
        await NotifyAsync("notifications/initialized", ct: ct);
        _logger.LogDebug("[McpSession] Session initialized for server '{Server}'", ServerName);
    }

    public async Task<List<JsonElement>> ListToolsAsync(CancellationToken ct = default)
    {
        _logger.LogDebug("[McpSession] Listing tools from '{Server}'", ServerName);
        var result = await RpcAsync("tools/list", new Dictionary<string, object?>(), ct);
        if (result.TryGetProperty("tools", out var tools) && tools.ValueKind == JsonValueKind.Array)
        {
            return tools.EnumerateArray().Select(t => t.Clone()).ToList();
        }
        return new List<JsonElement>();
    }

    public async Task<string> CallToolAsync(string name, Dictionary<string, object?> arguments, CancellationToken ct = default)
    {
        _logger.LogDebug("[McpSession] Calling tool '{Tool}' on '{Server}'", name, ServerName);
        var result = await RpcAsync("tools/call", new Dictionary<string, object?>
        {
            ["name"] = name,
            ["arguments"] = arguments,
        }, ct);

        if (result.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
        {
            var texts = new List<string>();
            foreach (var item in content.EnumerateArray())
            {
                if (item.TryGetProperty("type", out var type) && type.GetString() == "text" &&
                    item.TryGetProperty("text", out var text))
                {
                    var t = text.GetString();
                    if (!string.IsNullOrEmpty(t)) texts.Add(t);
                }
            }
            if (texts.Count > 0)
            {
                var combined = string.Join("\n", texts);
                _logger.LogDebug("[McpSession] Tool '{Tool}' returned {Len} chars", name, combined.Length);
                return combined;
            }
        }
        var raw = result.GetRawText();
        _logger.LogDebug("[McpSession] Tool '{Tool}' returned {Len} chars (raw)", name, raw.Length);
        return raw;
    }

    // -- transport -----------------------------------------------------------

    private async Task<JsonElement> RpcAsync(string method, Dictionary<string, object?> @params, CancellationToken ct)
    {
        _reqId++;
        _logger.LogDebug("[McpSession] RPC #{Id} {Method} -> {Url}", _reqId, method, _url);
        var body = new Dictionary<string, object?>
        {
            ["jsonrpc"] = "2.0",
            ["id"] = _reqId,
            ["method"] = method,
            ["params"] = @params,
        };

        var json = JsonSerializer.Serialize(body, JsonOpts);
        using var request = new HttpRequestMessage(HttpMethod.Post, _url)
        {
            Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json"),
        };
        request.Headers.Accept.ParseAdd("application/json");
        request.Headers.Accept.ParseAdd("text/event-stream");
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", _authToken);
        if (!string.IsNullOrEmpty(_agentId))
            request.Headers.TryAddWithoutValidation("X-Agent-Id", _agentId);
        if (_sessionId != null)
            request.Headers.TryAddWithoutValidation("Mcp-Session-Id", _sessionId);

        var response = await _http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync(ct);
            var wwwAuth = response.Headers.WwwAuthenticate.ToString();
            _logger.LogError(
                "[McpSession] HTTP {Status} from '{Server}' ({Method}). WWW-Authenticate: {WwwAuth}. Body: {Body}",
                (int)response.StatusCode, ServerName, method,
                string.IsNullOrEmpty(wwwAuth) ? "(none)" : wwwAuth,
                string.IsNullOrEmpty(errorBody) ? "(empty)" : errorBody.Length > 1000 ? errorBody[..1000] : errorBody);
            response.EnsureSuccessStatusCode();
        }

        if (response.Headers.TryGetValues("mcp-session-id", out var sessionIds))
        {
            _sessionId = sessionIds.FirstOrDefault() ?? _sessionId;
        }

        return await ParseResponseAsync(response, ct);
    }

    private async Task NotifyAsync(string method, Dictionary<string, object?>? @params = null, CancellationToken ct = default)
    {
        try
        {
            var body = new Dictionary<string, object?>
            {
                ["jsonrpc"] = "2.0",
                ["method"] = method,
                ["params"] = @params ?? new Dictionary<string, object?>(),
            };

            var json = JsonSerializer.Serialize(body, JsonOpts);
            using var request = new HttpRequestMessage(HttpMethod.Post, _url)
            {
                Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json"),
            };
            request.Headers.Accept.ParseAdd("application/json");
            request.Headers.Accept.ParseAdd("text/event-stream");
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", _authToken);
            if (_sessionId != null)
                request.Headers.TryAddWithoutValidation("Mcp-Session-Id", _sessionId);

            await _http.SendAsync(request, ct);
        }
        catch
        {
            // Notifications are best-effort.
        }
    }

    private async Task<JsonElement> ParseResponseAsync(HttpResponseMessage response, CancellationToken ct)
    {
        var contentType = response.Content.Headers.ContentType?.MediaType ?? "";
        var text = await response.Content.ReadAsStringAsync(ct);

        if (contentType.Contains("text/event-stream"))
        {
            return ParseSse(text);
        }

        using var doc = JsonDocument.Parse(text);
        var root = doc.RootElement;
        if (root.TryGetProperty("error", out var error))
        {
            throw new InvalidOperationException($"MCP error from '{ServerName}': {error.GetRawText()}");
        }
        if (root.TryGetProperty("result", out var result))
        {
            return result.Clone();
        }
        return root.Clone();
    }

    private static JsonElement ParseSse(string text)
    {
        foreach (var line in text.Split('\n'))
        {
            if (line.StartsWith("data: "))
            {
                try
                {
                    using var doc = JsonDocument.Parse(line.Substring(6));
                    if (doc.RootElement.TryGetProperty("result", out var result))
                    {
                        return result.Clone();
                    }
                }
                catch (JsonException)
                {
                    continue;
                }
            }
        }
        return default;
    }

    public async ValueTask DisposeAsync()
    {
        _http.Dispose();
        await ValueTask.CompletedTask;
    }
}

