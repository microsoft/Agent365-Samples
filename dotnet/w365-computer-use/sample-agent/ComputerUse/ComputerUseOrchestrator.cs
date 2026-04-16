// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.AI;
using ModelContextProtocol.Client;
using W365ComputerUseSample.ComputerUse.Models;

namespace W365ComputerUseSample.ComputerUse;

/// <summary>
/// Thin protocol adapter between OpenAI's computer-use-preview model and W365 MCP tools.
/// The model emits computer_call actions; this class translates them to MCP tool calls
/// and feeds back screenshots. Supports multiple concurrent sessions keyed by conversation ID.
/// </summary>
public class ComputerUseOrchestrator
{
    private readonly ICuaModelProvider _modelProvider;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly HttpClient _httpClient;
    private readonly ILogger<ComputerUseOrchestrator> _logger;
    private readonly int _maxIterations;
    private readonly string? _screenshotPath;
    private readonly string? _oneDriveFolder;
    private readonly string? _oneDriveUserId;
    private readonly string _toolType;
    private readonly List<object> _tools;

    /// <summary>
    /// Per-conversation session state. Each conversation (user chat) gets its own
    /// W365 session, conversation history, and screenshot counter.
    /// </summary>
    private readonly ConcurrentDictionary<string, ConversationSession> _sessions = new();

    /// <summary>
    /// Primary MCP client (W365 server) — used for direct screenshot calls.
    /// </summary>
    private IMcpClient? _cachedMcpClient;

    /// <summary>
    /// All MCP clients — one per connected server, for cleanup on shutdown.
    /// </summary>
    private readonly List<IMcpClient> _allMcpClients = [];

    /// <summary>
    /// Shared tool list — merged tools from all connected servers.
    /// </summary>
    private IList<AITool>? _cachedTools;

    private const string SystemInstructions = """
        You are a helpful assistant that can also control a Windows desktop computer.
        If the user's message is conversational or doesn't require computer use, respond with a helpful text message.

        ## Function tools (email, calendar, etc.)
        You have access to function tools for tasks like sending email, managing calendar, etc.
        ALWAYS use function tools when available — they are faster and more reliable than computer actions.
        When the user asks you to send an email, search messages, or perform any action that matches a function tool, call that tool directly.
        After calling a function tool, respond with a text message describing what you did and the result.
        Do NOT call OnTaskComplete after using function tools — just respond with text.

        ## Computer use (desktop control)
        Only use computer actions when no function tool can accomplish the task.
        When a task requires computer use, perform the actions and examine screenshots to verify they worked.
        If you see browser setup or sign-in dialogs, dismiss them (Escape, X, or Skip).
        Once you have completed a computer use task, call the OnTaskComplete function.
        Do NOT continue looping after the task is done.
        """;

    public ComputerUseOrchestrator(
        ICuaModelProvider modelProvider,
        IHttpClientFactory httpClientFactory,
        IConfiguration configuration,
        ILogger<ComputerUseOrchestrator> logger)
    {
        _modelProvider = modelProvider;
        _httpClientFactory = httpClientFactory;
        _httpClient = httpClientFactory.CreateClient("WebClient");
        _logger = logger;
        _maxIterations = configuration.GetValue("ComputerUse:MaxIterations", 30);
        _screenshotPath = configuration["Screenshots:LocalPath"];
        _oneDriveFolder = configuration["Screenshots:OneDriveFolder"];
        _oneDriveUserId = configuration["Screenshots:OneDriveUserId"];

        _toolType = configuration["ComputerUse:ToolType"] ?? "";
        if (string.IsNullOrEmpty(_toolType))
        {
            // Auto-derive from model name: gpt-* models use "computer", others use "computer_use_preview"
            var modelName = _modelProvider.ModelName;
            _toolType = modelName.StartsWith("gpt-", StringComparison.OrdinalIgnoreCase) ? "computer" : "computer_use_preview";
        }
        var displayWidth = configuration.GetValue("ComputerUse:DisplayWidth", 1024);
        var displayHeight = configuration.GetValue("ComputerUse:DisplayHeight", 768);

        // Build the computer tool definition based on the tool type:
        //   "computer_use_preview" — computer-use-preview model: display_width, display_height, environment
        //   "computer"            — GPT-5.4+ models (Azure OpenAI): bare type, no params
        object computerTool = _toolType switch
        {
            "computer" => new ComputerToolV2(),
            _ => new ComputerUseTool { DisplayWidth = displayWidth, DisplayHeight = displayHeight }
        };

        _logger.LogInformation("CUA tool type: {ToolType}, display: {Width}x{Height}", _toolType, displayWidth, displayHeight);

        _tools =
        [
            computerTool,
            new FunctionToolDefinition
            {
                Name = "OnTaskComplete",
                Description = "Call this function when the given task has been completed successfully."
            }
        ];
    }

    /// <summary>
    /// Run the CUA loop for a specific conversation.
    /// </summary>
    public async Task<string> RunAsync(
        string conversationId,
        string userMessage,
        IList<AITool> w365Tools,
        IList<AITool>? additionalTools = null,
        IMcpClient? mcpClient = null,
        string? graphAccessToken = null,
        Action<string>? onStatusUpdate = null,
        Func<bool, Task>? onCuaStarting = null,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("Processing message for conversation {ConversationId}: {Message}", conversationId, Truncate(userMessage, 100));

        var session = _sessions.GetOrAdd(conversationId, _ => new ConversationSession());

        if (session.SessionStarted)
        {
            _logger.LogInformation("Reusing session for conversation {ConversationId}, W365SessionId={SessionId}", conversationId, session.W365SessionId);
        }

        // For "computer" tool type (gpt-5.4+), include a screenshot with the FIRST user message if session already active
        if (_toolType == "computer" && session.ConversationHistory.Count == 0 && session.SessionStarted)
        {
            var initialScreenshot = await CaptureScreenshotAsync(w365Tools, mcpClient, session.W365SessionId, cancellationToken);
            var initialName = $"{conversationId[..8]}_{++session.ScreenshotCounter:D3}_initial";
            SaveScreenshotToDisk(initialScreenshot!, initialName);
            await UploadScreenshotToOneDriveAsync(initialScreenshot!, $"{initialName}.png", graphAccessToken);
            session.ConversationHistory.Add(ToJsonElement(new
            {
                type = "message",
                role = "user",
                content = new object[]
                {
                    new { type = "input_text", text = userMessage },
                    new { type = "input_image", image_url = $"data:image/png;base64,{initialScreenshot}" }
                }
            }));
        }
        else
        {
            session.ConversationHistory.Add(CreateUserMessage(userMessage));
        }

        // Build the model's tools list — computer + OnTaskComplete + any additional function tools
        var modelTools = new List<object>(_tools);
        if (additionalTools?.Count > 0)
        {
            foreach (var tool in additionalTools.OfType<AIFunction>())
            {
                modelTools.Add(new FunctionToolDefinition
                {
                    Name = tool.Name,
                    Description = tool.Description ?? string.Empty,
                    Parameters = tool.JsonSchema
                });
            }

            _logger.LogInformation("Added {Count} additional function tools to model", additionalTools.Count);
            foreach (var tool in additionalTools.OfType<AIFunction>())
            {
                var schemaStr = tool.JsonSchema.GetRawText();
                _logger.LogInformation("Function tool: {Name}, Description: {Desc}, Schema: {Schema}",
                    tool.Name, Truncate(tool.Description ?? "", 80), Truncate(schemaStr, 200));
            }
        }

        var cuaAcknowledged = false;
        for (var i = 0; i < _maxIterations; i++)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var response = await CallModelAsync(session.ConversationHistory, modelTools, cancellationToken);
            if (response?.Output == null || response.Output.Count == 0)
                break;

            var hasActions = false;

            foreach (var item in response.Output)
            {
                var type = item.GetProperty("type").GetString();
                if (type == "reasoning") continue;

                session.ConversationHistory.Add(item);

                switch (type)
                {
                    case "message":
                        return ExtractText(item);

                    case "computer_call":
                        hasActions = true;
                        // Lazy session start: only start when CUA is actually needed
                        if (!cuaAcknowledged)
                        {
                            if (!session.SessionStarted)
                            {
                                _logger.LogInformation("CUA needed for conversation {ConversationId} — starting session", conversationId);
                                if (onCuaStarting != null)
                                    await onCuaStarting(true);
                                onStatusUpdate?.Invoke("Starting W365 computing session...");
                                session.W365SessionId = await StartSessionAsync(w365Tools, _logger, cancellationToken);
                                session.SessionStarted = true;
                                _logger.LogInformation("Session started for conversation {ConversationId}, W365SessionId={SessionId}", conversationId, session.W365SessionId);
                            }
                            else if (onCuaStarting != null)
                            {
                                await onCuaStarting(false);
                            }

                            cuaAcknowledged = true;
                        }

                        _logger.LogInformation("CUA iteration {Iteration}: {Action}", i + 1, Truncate(item.GetRawText(), 200));
                        session.ConversationHistory.Add(await HandleComputerCallAsync(item, w365Tools, mcpClient, session, graphAccessToken, onStatusUpdate, cancellationToken));
                        break;

                    case "function_call":
                        hasActions = true;
                        var funcName = item.GetProperty("name").GetString();
                        _logger.LogInformation("CUA iteration {Iteration}: function_call {Name}", i + 1, funcName);
                        if (funcName == "OnTaskComplete")
                        {
                            session.ConversationHistory.Add(CreateFunctionOutput(item.GetProperty("call_id").GetString()!));
                            return "Task completed successfully.";
                        }

                        // Invoke additional MCP function tool
                        if (additionalTools != null)
                        {
                            var callResult = await InvokeFunctionCallAsync(item, additionalTools, cancellationToken);
                            session.ConversationHistory.Add(callResult);
                        }

                        break;
                }
            }

            if (!hasActions) break;
        }

        return "The task could not be completed within the allowed number of steps.";
    }

    /// <summary>
    /// End the W365 session. Called by the agent on shutdown or explicit end.
    /// </summary>
    public static async Task EndSessionAsync(IList<AITool> tools, ILogger logger, string? sessionId, CancellationToken ct)
    {
        try
        {
            var args = new Dictionary<string, object?>();
            if (!string.IsNullOrEmpty(sessionId))
                args["sessionId"] = sessionId;
            await InvokeToolAsync(tools, "W365_EndSession", args, ct);
            logger.LogInformation("W365 session ended (sessionId={SessionId})", sessionId);
        }
        catch (ObjectDisposedException)
        {
            logger.LogInformation("MCP client already disposed — W365 session will be released by server timeout");
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to end W365 session");
        }
    }

    /// <summary>
    /// End all active sessions on shutdown.
    /// </summary>
    public async Task EndSessionOnShutdownAsync()
    {
        if (_cachedTools == null)
        {
            _logger.LogInformation("No tools cached — nothing to clean up on shutdown");
            return;
        }

        foreach (var (convId, session) in _sessions)
        {
            if (session.SessionStarted)
            {
                _logger.LogInformation("Ending session for conversation {ConversationId}, W365SessionId={SessionId}", convId, session.W365SessionId);
                await EndSessionAsync(_cachedTools, _logger, session.W365SessionId, CancellationToken.None);
            }
        }

        _sessions.Clear();
        _cachedTools = null;

        foreach (var client in _allMcpClients)
        {
            try { await client.DisposeAsync(); }
            catch (Exception ex) { _logger.LogWarning(ex, "Failed to dispose MCP client"); }
        }

        _allMcpClients.Clear();
        _cachedMcpClient = null;
    }

    /// <summary>
    /// Start a W365 session and return the sessionId.
    /// </summary>
    public static async Task<string?> StartSessionAsync(IList<AITool> tools, ILogger logger, CancellationToken ct)
    {
        logger.LogInformation("Starting W365 session via QuickStartSession...");
        try
        {
            var result = await InvokeToolAsync(tools, "W365_QuickStartSession", new Dictionary<string, object?>(), ct);
            var resultStr = result?.ToString() ?? "";
            logger.LogInformation("W365 QuickStartSession result: {Result}", resultStr[..Math.Min(500, resultStr.Length)]);

            // Parse sessionId from response
            try
            {
                using var doc = JsonDocument.Parse(resultStr);
                if (doc.RootElement.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
                {
                    foreach (var block in content.EnumerateArray())
                    {
                        if (block.TryGetProperty("text", out var text))
                        {
                            var textStr = text.GetString() ?? "";
                            try
                            {
                                using var innerDoc = JsonDocument.Parse(textStr);
                                if (innerDoc.RootElement.TryGetProperty("sessionId", out var sid))
                                    return sid.GetString();
                            }
                            catch (JsonException) { }
                        }
                    }
                }
            }
            catch (JsonException) { }

            logger.LogWarning("Could not parse sessionId from QuickStartSession response — using default session");
            return null;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "W365 QuickStartSession FAILED");
            throw;
        }
    }

    /// <summary>
    /// Get or create MCP clients and merged tool list. Connects to each server URL once on first call,
    /// then returns the cached result on subsequent calls. The SSE connections stay alive across
    /// messages (MyAgent is transient, but this orchestrator is singleton).
    /// The primary MCP client (for W365 screenshot calls) is the one whose tools start with "W365_".
    /// </summary>
    public async Task<(IList<AITool> Tools, IMcpClient? Client)> GetOrCreateMcpConnectionAsync(
        IList<string> mcpUrls, string accessToken)
    {
        if (_cachedTools != null)
            return (_cachedTools, _cachedMcpClient);

        var allTools = new List<AITool>();

        foreach (var url in mcpUrls)
        {
            try
            {
                // Each MCP server needs its own HttpClient — the auto-detect transport
                // manages internal state that conflicts when shared across connections.
                var httpClient = _httpClientFactory.CreateClient("McpConnection");
                httpClient.DefaultRequestHeaders.Authorization =
                    new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", accessToken);

                var transport = new SseClientTransport(new SseClientTransportOptions
                {
                    Endpoint = new Uri(url),
                    TransportMode = HttpTransportMode.AutoDetect,
                }, httpClient);

                var client = await McpClientFactory.CreateAsync(transport);
                var tools = (await client.ListToolsAsync()).Cast<AITool>().ToList();

                _allMcpClients.Add(client);
                allTools.AddRange(tools);

                // Use the W365 server's client for direct screenshot calls
                var hasW365Tools = tools.Any(t => (t as AIFunction)?.Name?.StartsWith("W365_", StringComparison.OrdinalIgnoreCase) == true);
                if (hasW365Tools)
                    _cachedMcpClient = client;

                _logger.LogInformation("Connected to MCP server at {Url}, loaded {Count} tools: {Names}",
                    url, tools.Count, string.Join(", ", tools.Select(t => (t as AIFunction)?.Name ?? "?")));
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to connect to MCP server at {Url}. Skipping.", url);
            }
        }

        // Fallback: use first client if no W365 server found
        _cachedMcpClient ??= _allMcpClients.FirstOrDefault();

        _cachedTools = allTools;
        _logger.LogInformation("Total tools from {ServerCount} MCP server(s): {ToolCount}", mcpUrls.Count, allTools.Count);
        return (_cachedTools, _cachedMcpClient);
    }

    private async Task<ComputerUseResponse?> CallModelAsync(List<JsonElement> conversation, List<object> tools, CancellationToken ct)
    {
        var body = JsonSerializer.Serialize(new ComputerUseRequest
        {
            Model = _modelProvider.ModelName,
            Instructions = SystemInstructions,
            Input = conversation,
            Tools = tools,
            Truncation = "auto"
        }, new JsonSerializerOptions { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull });

        _logger.LogInformation("Model request (first 2000 chars): {Body}", body[..Math.Min(2000, body.Length)]);

        var responseJson = await _modelProvider.SendAsync(body, ct);
        _logger.LogInformation("Model response (first 2000 chars): {Response}", responseJson[..Math.Min(2000, responseJson.Length)]);
        return JsonSerializer.Deserialize<ComputerUseResponse>(responseJson);
    }

    /// <summary>
    /// Translate a computer_call into an MCP tool call, capture screenshot, return computer_call_output.
    /// </summary>
    private async Task<JsonElement> HandleComputerCallAsync(
        JsonElement call, IList<AITool> tools, IMcpClient? mcpClient, ConversationSession session, string? graphAccessToken, Action<string>? onStatus, CancellationToken ct)
    {
        var callId = call.GetProperty("call_id").GetString()!;
        var sessionId = session.W365SessionId;

        // GPT-5.4 uses "actions" (non-empty array), older models use "action" (singular).
        if (call.TryGetProperty("actions", out var actionsArray)
            && actionsArray.ValueKind == JsonValueKind.Array
            && actionsArray.GetArrayLength() > 0)
        {
            foreach (var action in actionsArray.EnumerateArray())
            {
                var actionType = action.GetProperty("type").GetString()!;
                onStatus?.Invoke($"Performing: {actionType}...");

                if (actionType != "screenshot")
                {
                    var (toolName, args) = MapActionToMcpTool(actionType, action, sessionId);
                    await InvokeToolAsync(tools, toolName, args, ct);
                }
            }
        }
        else if (call.TryGetProperty("action", out var singleAction))
        {
            var actionType = singleAction.GetProperty("type").GetString()!;
            onStatus?.Invoke($"Performing: {actionType}...");

            if (actionType != "screenshot")
            {
                var (toolName, args) = MapActionToMcpTool(actionType, singleAction, sessionId);
                await InvokeToolAsync(tools, toolName, args, ct);
            }
        }

        // Always capture screenshot after action
        var screenshot = await CaptureScreenshotAsync(tools, mcpClient, sessionId, ct);

        var stepName = $"{++session.ScreenshotCounter:D3}_step";
        SaveScreenshotToDisk(screenshot!, stepName);
        await UploadScreenshotToOneDriveAsync(screenshot!, $"{stepName}.png", graphAccessToken);

        var safetyChecks = call.TryGetProperty("pending_safety_checks", out var sc)
            ? sc : JsonSerializer.Deserialize<JsonElement>("[]");

        // "computer" tool type (gpt-5.4+) doesn't support acknowledged_safety_checks
        if (_toolType == "computer")
        {
            return ToJsonElement(new
            {
                type = "computer_call_output",
                call_id = callId,
                output = new { type = "computer_screenshot", image_url = $"data:image/png;base64,{screenshot}" }
            });
        }

        return ToJsonElement(new
        {
            type = "computer_call_output",
            call_id = callId,
            acknowledged_safety_checks = safetyChecks,
            output = new { type = "computer_screenshot", image_url = $"data:image/png;base64,{screenshot}" }
        });
    }

    /// <summary>
    /// Map OpenAI computer_call action types to W365 MCP tool names and arguments.
    /// Includes sessionId so the MCP server uses the correct session.
    /// </summary>
    private static (string ToolName, Dictionary<string, object?> Args) MapActionToMcpTool(string actionType, JsonElement action, string? sessionId)
    {
        var (toolName, args) = actionType.ToLowerInvariant() switch
        {
            "click" => ("W365_Click2", new Dictionary<string, object?>
            {
                ["x"] = action.GetProperty("x").GetInt32(),
                ["y"] = action.GetProperty("y").GetInt32(),
                ["button"] = action.TryGetProperty("button", out var b) ? b.GetString() : "left"
            }),
            "double_click" => ("W365_DoubleClick", new Dictionary<string, object?>
            {
                ["x"] = action.GetProperty("x").GetInt32(),
                ["y"] = action.GetProperty("y").GetInt32()
            }),
            "type" => ("W365_WriteText", new Dictionary<string, object?>
            {
                ["text"] = action.GetProperty("text").GetString()
            }),
            "key" or "keys" or "keypress" => ("W365_MultiKeyPress", new Dictionary<string, object?>
            {
                ["keys"] = ExtractKeys(action)
            }),
            "scroll" => ("W365_Scroll", new Dictionary<string, object?>
            {
                ["atX"] = action.GetProperty("x").GetInt32(),
                ["atY"] = action.GetProperty("y").GetInt32(),
                ["deltaX"] = action.TryGetProperty("scroll_x", out var sx) ? sx.GetInt32() : 0,
                ["deltaY"] = action.TryGetProperty("scroll_y", out var sy) ? sy.GetInt32() : 0
            }),
            "move" => ("W365_MoveMouse", new Dictionary<string, object?>
            {
                ["toX"] = action.GetProperty("x").GetInt32(),
                ["toY"] = action.GetProperty("y").GetInt32()
            }),
            "wait" => ("W365_Wait", new Dictionary<string, object?>
            {
                ["milliseconds"] = action.TryGetProperty("ms", out var ms) ? ms.GetInt32() : 500
            }),
            "open_url" => ("W365_OpenUrl", new Dictionary<string, object?>
            {
                ["url"] = action.GetProperty("url").GetString()
            }),
            _ => throw new NotSupportedException($"Unsupported action: {actionType}")
        };

        // Add sessionId to all tool calls so the MCP server routes to the correct session
        if (!string.IsNullOrEmpty(sessionId))
            args["sessionId"] = sessionId;

        return (toolName, args);
    }

    private async Task<string> CaptureScreenshotAsync(IList<AITool> tools, IMcpClient? mcpClient, string? sessionId, CancellationToken ct)
    {
        var screenshotArgs = new Dictionary<string, object?>();
        if (!string.IsNullOrEmpty(sessionId))
            screenshotArgs["sessionId"] = sessionId;

        // Use direct MCP client when available — AIFunction wrappers drop image content blocks
        if (mcpClient != null)
        {
            var result = await mcpClient.CallToolAsync("W365_CaptureScreenshot", screenshotArgs, cancellationToken: ct);
            foreach (var item in result.Content)
            {
                _logger.LogDebug("Screenshot content block: Type={Type}, DataLen={DataLen}, TextLen={TextLen}, MimeType={Mime}",
                    item.Type, item.Data?.Length ?? 0, item.Text?.Length ?? 0, item.MimeType);

                if (item.Type == "image" && !string.IsNullOrEmpty(item.Data))
                    return item.Data;
                if (!string.IsNullOrEmpty(item.Data))
                    return item.Data;
                if (item.Type == "text" && !string.IsNullOrEmpty(item.Text))
                {
                    var nested = ExtractBase64FromText(item.Text);
                    if (!string.IsNullOrEmpty(nested)) return nested;
                }
            }

            // Log full content for debugging
            foreach (var item in result.Content)
                _logger.LogWarning("Unhandled screenshot block: Type={Type}, Text={Preview}", item.Type, item.Text?[..Math.Min(200, item.Text.Length)]);

            throw new InvalidOperationException($"Screenshot MCP response had {result.Content.Count} content blocks but no extractable image data.");
        }

        // Fallback: AIFunction wrapper (may lose image content)
        var aiResult = await InvokeToolAsync(tools, "W365_CaptureScreenshot", screenshotArgs, ct);
        var str = aiResult?.ToString() ?? "";

        _logger.LogInformation("Screenshot fallback: result type={Type}, length={Length}, preview={Preview}",
            aiResult?.GetType().Name ?? "null", str.Length, str[..Math.Min(200, str.Length)]);

        try
        {
            using var doc = JsonDocument.Parse(str);
            var root = doc.RootElement;
            if (root.TryGetProperty("screenshotData", out var sd)) return sd.GetString() ?? "";
            if (root.TryGetProperty("image", out var img)) return img.GetString() ?? "";
            if (root.TryGetProperty("data", out var d)) return d.GetString() ?? "";

            // Try nested content array (SDK gateway format)
            if (root.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
            {
                foreach (var block in content.EnumerateArray())
                {
                    if (block.TryGetProperty("data", out var blockData) && !string.IsNullOrEmpty(blockData.GetString()))
                        return blockData.GetString();
                    if (block.TryGetProperty("text", out var blockText))
                    {
                        var extracted = ExtractBase64FromText(blockText.GetString());
                        if (!string.IsNullOrEmpty(extracted)) return extracted;
                    }
                }
            }
        }
        catch (JsonException) { }

        // Last resort: if it looks like raw base64 (long string, no JSON), use it directly
        if (str.Length > 1000 && !str.StartsWith("{") && !str.StartsWith("["))
            return str;

        throw new InvalidOperationException($"Failed to extract screenshot. Response length: {str.Length}");
    }

    private static string? ExtractBase64FromText(string? text)
    {
        if (string.IsNullOrEmpty(text)) return null;
        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            if (root.TryGetProperty("screenshotData", out var sd)) return sd.GetString();
            if (root.TryGetProperty("image", out var img)) return img.GetString();
            if (root.TryGetProperty("data", out var d)) return d.GetString();
        }
        catch (JsonException) { }
        return null;
    }

    internal static async Task<object?> InvokeToolAsync(
        IList<AITool> tools, string name, Dictionary<string, object?> args, CancellationToken ct)
    {
        var tool = tools.OfType<AIFunction>().FirstOrDefault(t => t.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
            ?? throw new InvalidOperationException($"Tool '{name}' not found.");
        return await tool.InvokeAsync(new AIFunctionArguments(args), ct);
    }

    private static string[] ExtractKeys(JsonElement action)
    {
        if (action.TryGetProperty("keys", out var k))
        {
            if (k.ValueKind == JsonValueKind.Array)
                return k.EnumerateArray().Select(e => e.GetString() ?? "").ToArray();
            if (k.ValueKind == JsonValueKind.String)
                return [k.GetString() ?? ""];
        }
        if (action.TryGetProperty("key", out var single) && single.ValueKind == JsonValueKind.String)
            return [single.GetString() ?? ""];
        return [];
    }

    private static string ExtractText(JsonElement msg)
    {
        if (msg.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.Array)
            foreach (var item in c.EnumerateArray())
                if (item.TryGetProperty("text", out var t))
                    return t.GetString() ?? "";
        return "";
    }

    private static JsonElement CreateUserMessage(string text) => ToJsonElement(new
    {
        type = "message", role = "user",
        content = new[] { new { type = "input_text", text } }
    });

    private static JsonElement CreateFunctionOutput(string callId, string output = "success") => ToJsonElement(new
    {
        type = "function_call_output", call_id = callId, output
    });

    /// <summary>
    /// Invoke an MCP function tool from a model function_call and return the function_call_output.
    /// </summary>
    private async Task<JsonElement> InvokeFunctionCallAsync(JsonElement functionCall, IList<AITool> tools, CancellationToken ct)
    {
        var callId = functionCall.GetProperty("call_id").GetString()!;
        var name = functionCall.GetProperty("name").GetString()!;
        var argsStr = functionCall.GetProperty("arguments").GetString() ?? "{}";

        try
        {
            var args = JsonSerializer.Deserialize<Dictionary<string, object?>>(argsStr) ?? [];
            var result = await InvokeToolAsync(tools, name, args, ct);
            var resultStr = result?.ToString() ?? "success";
            return CreateFunctionOutput(callId, resultStr);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Function call {Name} failed", name);
            return CreateFunctionOutput(callId, $"Error: {ex.Message}");
        }
    }

    private static JsonElement ToJsonElement(object obj) =>
        JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(obj));

    private static string Truncate(string v, int max) => v.Length <= max ? v : v[..max] + "...";

    private void SaveScreenshotToDisk(string base64Data, string name)
    {
        if (string.IsNullOrEmpty(base64Data) || string.IsNullOrEmpty(_screenshotPath)) return;
        try
        {
            Directory.CreateDirectory(_screenshotPath);
            var path = Path.Combine(_screenshotPath, $"{name}.png");
            File.WriteAllBytes(path, Convert.FromBase64String(base64Data));
            _logger.LogInformation("Screenshot saved: {Path}", path);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to save screenshot");
        }
    }

    /// <summary>
    /// Upload a screenshot to the user's OneDrive via Microsoft Graph.
    /// Requires a Graph access token with Files.ReadWrite scope.
    /// Files are uploaded to /CUA-Sessions/{date}/ folder.
    /// </summary>
    private async Task UploadScreenshotToOneDriveAsync(string base64Data, string fileName, string? graphAccessToken)
    {
        if (string.IsNullOrEmpty(graphAccessToken))
        {
            _logger.LogDebug("OneDrive upload skipped: no Graph token");
            return;
        }
        if (string.IsNullOrEmpty(base64Data))
        {
            _logger.LogDebug("OneDrive upload skipped: no screenshot data");
            return;
        }
        if (string.IsNullOrEmpty(_oneDriveFolder))
        {
            _logger.LogDebug("OneDrive upload skipped: OneDriveFolder not configured");
            return;
        }

        try
        {
            // Use /me/drive for token owner, or /users/{id}/drive for a specific user
            var driveBase = string.IsNullOrEmpty(_oneDriveUserId)
                ? "https://graph.microsoft.com/v1.0/me/drive"
                : $"https://graph.microsoft.com/v1.0/users/{_oneDriveUserId}/drive";
            var url = $"{driveBase}/root:/{_oneDriveFolder.TrimStart('/')}/{fileName}:/content";

            using var request = new HttpRequestMessage(HttpMethod.Put, url);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", graphAccessToken);
            request.Content = new ByteArrayContent(Convert.FromBase64String(base64Data));
            request.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png");

            var response = await _httpClient.SendAsync(request);
            if (response.IsSuccessStatusCode)
            {
                _logger.LogInformation("Screenshot uploaded to OneDrive: {Folder}/{FileName}", _oneDriveFolder, fileName);
            }
            else
            {
                _logger.LogWarning("OneDrive upload failed: {Status}", response.StatusCode);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to upload screenshot to OneDrive");
        }
    }

    /// <summary>
    /// Per-conversation session state. Holds the W365 session ID, conversation history,
    /// and screenshot counter for a single user conversation.
    /// </summary>
    private sealed class ConversationSession
    {
        public bool SessionStarted { get; set; }
        public string? W365SessionId { get; set; }
        public List<JsonElement> ConversationHistory { get; } = [];
        public int ScreenshotCounter { get; set; }
    }
}
