// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.Text.Json;
using Microsoft.Agents.A365.Tooling.Services;

namespace PerplexitySampleAgent;

/// <summary>
/// Discovers MCP servers, connects via JSON-RPC, and returns tool definitions and a tool executor.
/// No Semantic Kernel dependency — uses <see cref="McpSession"/> for direct MCP communication.
/// Arguments (including arrays) flow through as native JSON — no CLR type mangling.
/// </summary>
public sealed class McpToolService
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    // Keys Perplexity doesn't understand in tool schemas.
    private static readonly HashSet<string> UnsupportedSchemaKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "$defs", "$ref", "additionalProperties", "allOf", "anyOf",
        "oneOf", "not", "$schema", "definitions",
    };

    private readonly IMcpToolServerConfigurationService _configService;
    private readonly ILogger<McpToolService> _logger;

    public McpToolService(
        IMcpToolServerConfigurationService configService,
        ILogger<McpToolService> logger)
    {
        _configService = configService;
        _logger = logger;
    }

    /// <summary>
    /// Connect to all MCP servers, list tools, and return (tools, toolExecutor).
    /// tools = Responses API format (flat: type/name/description/parameters).
    /// toolExecutor = async callback that dispatches tool calls to the right MCP session.
    /// </summary>
    public async Task<(List<JsonElement> Tools, Func<string, Dictionary<string, object?>, Task<string>> Executor)>
        LoadToolsAsync(
            string agentId,
            string authToken,
            string mcpToken,
            CancellationToken ct = default)
    {
        // Try cloud config first, fall back to local ToolingManifest.json.
        List<(string Name, string Url)> servers;
        try
        {
            var serverConfigs = await _configService.ListToolServersAsync(agentId, authToken);
            _logger.LogDebug("Discovered {Count} MCP server configurations from cloud", serverConfigs.Count);
            servers = serverConfigs.Select(c => (c.mcpServerName ?? "unknown", c.url ?? "")).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Cloud config failed, falling back to ToolingManifest.json");
            servers = LoadServersFromManifest();
            _logger.LogDebug("Loaded {Count} MCP server configurations from ToolingManifest.json", servers.Count);
        }

        var allTools = new List<JsonElement>();
        var toolMap = new Dictionary<string, McpSession>(StringComparer.OrdinalIgnoreCase);
        var sessions = new List<McpSession>();

        // Connect to each MCP server and list tools.
        // Use mcpToken (A365 Tools API audience) for MCP server communication.
        foreach (var (name, url) in servers)
        {
            _logger.LogDebug("Connecting to MCP server '{Name}' at {Url}", name, url);
            if (string.IsNullOrEmpty(url))
            {
                _logger.LogWarning("Skipping MCP server '{Name}' — no URL configured", name);
                continue;
            }

            try
            {
                var session = new McpSession(url, mcpToken, agentId, name, _logger);
                await session.InitializeAsync(ct);
                var tools = await session.ListToolsAsync(ct);
                _logger.LogDebug("Server '{Name}' exposes {Count} tools", name, tools.Count);

                sessions.Add(session);
                foreach (var tool in tools)
                {
                    var toolName = tool.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
                    if (string.IsNullOrEmpty(toolName)) continue;

                    // Get the original MCP inputSchema and sanitize for Perplexity.
                    var rawSchema = tool.TryGetProperty("inputSchema", out var schema) ? schema : default;
                    var sanitized = SanitizeSchema(rawSchema);
                    var description = tool.TryGetProperty("description", out var d) ? d.GetString() ?? "" : "";

                    // Build Responses API format tool definition.
                    var toolDef = new Dictionary<string, object?>
                    {
                        ["type"] = "function",
                        ["name"] = toolName,
                        ["description"] = description,
                        ["parameters"] = sanitized,
                    };

                    var json = JsonSerializer.Serialize(toolDef, JsonOpts);
                    allTools.Add(JsonDocument.Parse(json).RootElement.Clone());
                    toolMap[toolName] = session;
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to connect to MCP server '{Name}' at {Url}", name, url);
            }
        }

        _logger.LogInformation("Loaded {Count} MCP tools from {Sessions} servers", allTools.Count, sessions.Count);

        // Build a tool executor that dispatches to the right MCP session.
        async Task<string> ToolExecutor(string toolName, Dictionary<string, object?> arguments)
        {
            if (!toolMap.TryGetValue(toolName, out var session))
            {
                _logger.LogWarning("Tool '{Tool}' not found in any MCP session (available: {Available})", toolName, string.Join(", ", toolMap.Keys));
                return JsonSerializer.Serialize(new { error = $"Tool '{toolName}' not found" });
            }

            _logger.LogDebug("[ToolExecutor] Dispatching '{Tool}' to server '{Server}'", toolName, session.ServerName);

            const int maxRetries = 2;
            Exception? lastError = null;
            for (int attempt = 0; attempt <= maxRetries; attempt++)
            {
                try
                {
                    return await session.CallToolAsync(toolName, arguments, ct);
                }
                catch (HttpRequestException ex) when (attempt < maxRetries)
                {
                    lastError = ex;
                    _logger.LogWarning("Retryable error on attempt {Attempt}/{Max} for tool '{Tool}': {Error}",
                        attempt + 1, maxRetries + 1, toolName, ex.Message);
                    await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, attempt) + Random.Shared.NextDouble() * 0.5), ct);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Tool call '{Tool}' failed", toolName);
                    return $"Error executing tool '{toolName}': {ex.Message}";
                }
            }

            return $"Error executing tool '{toolName}': {lastError?.Message}";
        }

        return (allTools, ToolExecutor);
    }

    /// <summary>
    /// Sanitize MCP inputSchema for Perplexity compatibility.
    /// Removes unsupported keys, empty required arrays, and ensures valid structure.
    /// </summary>
    private static Dictionary<string, object?> SanitizeSchema(JsonElement raw)
    {
        var empty = new Dictionary<string, object?> { ["type"] = "object", ["properties"] = new Dictionary<string, object?>() };
        if (raw.ValueKind != JsonValueKind.Object) return empty;

        var type = raw.TryGetProperty("type", out var t) ? t.GetString() : null;
        if (type != "object") return empty;

        var result = CleanSchema(raw);
        if (!result.ContainsKey("properties"))
            result["properties"] = new Dictionary<string, object?>();
        return result;
    }

    private static Dictionary<string, object?> CleanSchema(JsonElement schema)
    {
        var cleaned = new Dictionary<string, object?>();
        foreach (var prop in schema.EnumerateObject())
        {
            if (UnsupportedSchemaKeys.Contains(prop.Name)) continue;
            if (prop.Name == "required" && prop.Value.ValueKind == JsonValueKind.Array && prop.Value.GetArrayLength() == 0) continue;

            if (prop.Name == "properties" && prop.Value.ValueKind == JsonValueKind.Object)
            {
                var props = new Dictionary<string, object?>();
                foreach (var p in prop.Value.EnumerateObject())
                {
                    if (p.Value.ValueKind == JsonValueKind.Object)
                        props[p.Name] = CleanSchema(p.Value);
                }
                cleaned["properties"] = props;
            }
            else if (prop.Name == "items" && prop.Value.ValueKind == JsonValueKind.Object)
            {
                cleaned["items"] = CleanSchema(prop.Value);
            }
            else if (prop.Name == "required" && prop.Value.ValueKind == JsonValueKind.Array)
            {
                cleaned["required"] = prop.Value.EnumerateArray()
                    .Where(v => v.ValueKind == JsonValueKind.String)
                    .Select(v => (object?)v.GetString())
                    .ToList();
            }
            else
            {
                // Preserve primitive values as-is.
                cleaned[prop.Name] = prop.Value.ValueKind switch
                {
                    JsonValueKind.String => prop.Value.GetString(),
                    JsonValueKind.Number => prop.Value.GetDouble(),
                    JsonValueKind.True => true,
                    JsonValueKind.False => false,
                    JsonValueKind.Null => null,
                    _ => JsonSerializer.Deserialize<object>(prop.Value.GetRawText(), JsonOpts),
                };
            }
        }
        return cleaned;
    }

    /// <summary>
    /// Reads MCP server configs from ToolingManifest.json as fallback when cloud config is unavailable.
    /// </summary>
    private List<(string Name, string Url)> LoadServersFromManifest()
    {
        var manifestPath = Path.Combine(AppContext.BaseDirectory, "ToolingManifest.json");
        if (!File.Exists(manifestPath))
        {
            // Try project root (for dev)
            manifestPath = Path.Combine(Directory.GetCurrentDirectory(), "ToolingManifest.json");
        }
        if (!File.Exists(manifestPath))
        {
            _logger.LogWarning("ToolingManifest.json not found");
            return new();
        }

        var json = File.ReadAllText(manifestPath);
        using var doc = JsonDocument.Parse(json);
        var result = new List<(string, string)>();
        if (doc.RootElement.TryGetProperty("mcpServers", out var arr) && arr.ValueKind == JsonValueKind.Array)
        {
            foreach (var server in arr.EnumerateArray())
            {
                var sName = server.TryGetProperty("mcpServerName", out var n) ? n.GetString() ?? "" : "";
                var sUrl = server.TryGetProperty("url", out var u) ? u.GetString() ?? "" : "";
                if (!string.IsNullOrEmpty(sName) && !string.IsNullOrEmpty(sUrl))
                    result.Add((sName, sUrl));
            }
        }
        return result;
    }
}
