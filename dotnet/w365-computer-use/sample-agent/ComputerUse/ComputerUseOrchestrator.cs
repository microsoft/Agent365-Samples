// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.AI;
using ModelContextProtocol.Client;
using W365ComputerUseSample.ComputerUse.Models;

namespace W365ComputerUseSample.ComputerUse;

/// <summary>
/// Thin protocol adapter between OpenAI's computer-use-preview model and W365 MCP tools.
/// The model emits computer_call actions; this class translates them to MCP tool calls
/// and feeds back screenshots. The MCP server manages sessions automatically.
/// </summary>
public class ComputerUseOrchestrator
{
    private readonly ICuaModelProvider _modelProvider;
    private readonly HttpClient _httpClient;
    private readonly ILogger<ComputerUseOrchestrator> _logger;
    private readonly int _maxIterations;
    private readonly string? _screenshotPath;
    private readonly string? _oneDriveFolder;
    private readonly string? _oneDriveUserId;
    private readonly string _toolType;
    private readonly List<object> _tools;

    /// <summary>
    /// Conversation history persisted across user messages.
    /// This allows the model to maintain context across multiple turns
    /// (e.g., "now save the file" after a previous "type hello" command).
    /// </summary>
    private readonly List<JsonElement> _conversationHistory = [];

    /// <summary>
    /// Whether a W365 session has been started. Tracked here (singleton) because
    /// MyAgent is transient — a new agent instance is created per HTTP request.
    /// </summary>
    private bool _sessionStarted;

    /// <summary>
    /// Cached reference to the last-used W365 tools, used for shutdown cleanup.
    /// </summary>
    private IList<AITool>? _cachedTools;

    /// <summary>
    /// Cached MCP client reference — kept alive for the app lifetime so EndSession
    /// can be called on shutdown. Disposed when the app stops.
    /// </summary>
    private IMcpClient? _cachedMcpClient;

    private const string SystemInstructions = """
        You are a computer-using agent that can control a Windows desktop computer.
        After each action, examine the screenshot to verify it worked.
        If you see browser setup or sign-in dialogs, dismiss them (Escape, X, or Skip).
        Once you have completed the task, call the OnTaskComplete function.
        Do NOT continue looping after the task is done.
        """;

    public ComputerUseOrchestrator(
        ICuaModelProvider modelProvider,
        IHttpClientFactory httpClientFactory,
        IConfiguration configuration,
        ILogger<ComputerUseOrchestrator> logger)
    {
        _modelProvider = modelProvider;
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
    /// Run the CUA loop. Session must already be started by the caller.
    /// </summary>
    public async Task<string> RunAsync(
        string userMessage,
        IList<AITool> w365Tools,
        IMcpClient? mcpClient = null,
        string? graphAccessToken = null,
        Action<string>? onStatusUpdate = null,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("Starting CUA loop for: {Message}", Truncate(userMessage, 100));
        _cachedTools = w365Tools;
        if (mcpClient != null) _cachedMcpClient = mcpClient;

        // Start session once — reuse across all messages
        if (!_sessionStarted)
        {
            onStatusUpdate?.Invoke("Starting W365 computing session...");
            await StartSessionAsync(w365Tools, _logger, cancellationToken);
            _sessionStarted = true;
        }

        // For "computer" tool type (gpt-5.4+), include a screenshot with the FIRST user message
        // so the model can see the screen. On subsequent messages, the history already has
        // computer_call_output screenshots, so adding another input_image would cause a 400 error.
        if (_toolType == "computer" && _conversationHistory.Count == 0)
        {
            var initialScreenshot = await CaptureScreenshotAsync(w365Tools, mcpClient, cancellationToken);
            var initialName = $"{++_screenshotCounter:D3}_initial";
            SaveScreenshotToDisk(initialScreenshot!, initialName);
            await UploadScreenshotToOneDriveAsync(initialScreenshot!, $"{initialName}.png", graphAccessToken);
            _conversationHistory.Add(ToJsonElement(new
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
            _conversationHistory.Add(CreateUserMessage(userMessage));
        }

        for (var i = 0; i < _maxIterations; i++)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var response = await CallModelAsync(_conversationHistory, cancellationToken);
            if (response?.Output == null || response.Output.Count == 0)
                break;

            var hasActions = false;

            foreach (var item in response.Output)
            {
                var type = item.GetProperty("type").GetString();
                if (type == "reasoning") continue;

                _conversationHistory.Add(item);

                switch (type)
                {
                    case "message":
                        return ExtractText(item);

                    case "computer_call":
                        hasActions = true;
                        _logger.LogInformation("CUA iteration {Iteration}: {Action}", i + 1, Truncate(item.GetRawText(), 200));
                        _conversationHistory.Add(await HandleComputerCallAsync(item, w365Tools, mcpClient, graphAccessToken, onStatusUpdate, cancellationToken));
                        break;

                    case "function_call":
                        hasActions = true;
                        var funcName = item.GetProperty("name").GetString();
                        _logger.LogInformation("CUA iteration {Iteration}: function_call {Name}", i + 1, funcName);
                        _conversationHistory.Add(CreateFunctionOutput(item.GetProperty("call_id").GetString()!));
                        if (funcName == "OnTaskComplete")
                        {
                            return "Task completed successfully.";
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
    public static async Task EndSessionAsync(IList<AITool> tools, ILogger logger, CancellationToken ct)
    {
        try
        {
            await InvokeToolAsync(tools, "W365_EndSession", new Dictionary<string, object?>(), ct);
            logger.LogInformation("W365 session ended");
        }
        catch (ObjectDisposedException)
        {
            // MCP client already disposed (dev mode SSE connection closed) — session will time out on server
            logger.LogInformation("MCP client already disposed — W365 session will be released by server timeout");
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to end W365 session");
        }
    }

    /// <summary>
    /// End the session using cached tools. Called from app shutdown hook.
    /// </summary>
    public async Task EndSessionOnShutdownAsync()
    {
        if (_cachedTools == null || !_sessionStarted)
        {
            _logger.LogInformation("No active session to end on shutdown");
            return;
        }

        await EndSessionAsync(_cachedTools, _logger, CancellationToken.None);
        _cachedTools = null;
        _sessionStarted = false;

        // Dispose the MCP client if we own it
        if (_cachedMcpClient != null)
        {
            await _cachedMcpClient.DisposeAsync();
            _cachedMcpClient = null;
        }
    }

    /// <summary>
    /// Start a W365 session. Called by the agent on first message.
    /// </summary>
    public static async Task StartSessionAsync(IList<AITool> tools, ILogger logger, CancellationToken ct)
    {
        await InvokeToolAsync(tools, "W365_QuickStartSession", new Dictionary<string, object?>(), ct);
        logger.LogInformation("W365 session started via QuickStartSession");
    }

    /// <summary>
    /// Get or create the MCP client and tool list. Creates the connection once on first call,
    /// then returns the cached result on subsequent calls. This ensures the SSE connection
    /// stays alive across messages (MyAgent is transient, but this orchestrator is singleton).
    /// </summary>
    public async Task<(IList<AITool> Tools, IMcpClient? Client)> GetOrCreateMcpConnectionAsync(
        string mcpUrl, string accessToken)
    {
        if (_cachedTools != null)
            return (_cachedTools, _cachedMcpClient);

        var httpClient = _httpClient;
        httpClient.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", accessToken);

        var transport = new SseClientTransport(new SseClientTransportOptions
        {
            Endpoint = new Uri(mcpUrl),
            TransportMode = HttpTransportMode.AutoDetect,
        }, httpClient);

        _cachedMcpClient = await McpClientFactory.CreateAsync(transport);
        var allTools = (await _cachedMcpClient.ListToolsAsync()).Cast<AITool>().ToList();

        // Filter to W365 tools only
        _cachedTools = allTools.Where(t =>
        {
            var name = (t as AIFunction)?.Name ?? t.ToString() ?? string.Empty;
            return name.StartsWith("W365_", StringComparison.OrdinalIgnoreCase);
        }).ToList();

        _logger.LogInformation("Connected to MCP server at {Url}, loaded {Count} W365 tools", mcpUrl, _cachedTools.Count);
        return (_cachedTools, _cachedMcpClient);
    }

    private async Task<ComputerUseResponse?> CallModelAsync(List<JsonElement> conversation, CancellationToken ct)
    {
        var body = JsonSerializer.Serialize(new ComputerUseRequest
        {
            Model = _modelProvider.ModelName,
            Instructions = SystemInstructions,
            Input = conversation,
            Tools = _tools,
            Truncation = "auto"
        }, new JsonSerializerOptions { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull });

        var responseJson = await _modelProvider.SendAsync(body, ct);
        return JsonSerializer.Deserialize<ComputerUseResponse>(responseJson);
    }

    /// <summary>
    /// Translate a computer_call into an MCP tool call, capture screenshot, return computer_call_output.
    /// </summary>
    private async Task<JsonElement> HandleComputerCallAsync(
        JsonElement call, IList<AITool> tools, IMcpClient? mcpClient, string? graphAccessToken, Action<string>? onStatus, CancellationToken ct)
    {
        var callId = call.GetProperty("call_id").GetString()!;

        // GPT-5.4 uses "actions" (non-empty array), older models use "action" (singular).
        // Some models return both: "action": {...}, "actions": [] — so we must check the array is non-empty.
        if (call.TryGetProperty("actions", out var actionsArray)
            && actionsArray.ValueKind == JsonValueKind.Array
            && actionsArray.GetArrayLength() > 0)
        {
            // Process batch actions (GPT-5.4 format)
            foreach (var action in actionsArray.EnumerateArray())
            {
                var actionType = action.GetProperty("type").GetString()!;
                onStatus?.Invoke($"Performing: {actionType}...");

                if (actionType != "screenshot")
                {
                    var (toolName, args) = MapActionToMcpTool(actionType, action);
                    await InvokeToolAsync(tools, toolName, args, ct);
                }
            }
        }
        else if (call.TryGetProperty("action", out var singleAction))
        {
            // Single action (computer-use-preview format)
            var actionType = singleAction.GetProperty("type").GetString()!;
            onStatus?.Invoke($"Performing: {actionType}...");

            if (actionType != "screenshot")
            {
                var (toolName, args) = MapActionToMcpTool(actionType, singleAction);
                await InvokeToolAsync(tools, toolName, args, ct);
            }
        }

        // Always capture screenshot after action
        var screenshot = await CaptureScreenshotAsync(tools, mcpClient, ct);

        // Save screenshot locally and/or upload to OneDrive
        var stepName = $"{++_screenshotCounter:D3}_step";
        SaveScreenshotToDisk(screenshot!, stepName);
        await UploadScreenshotToOneDriveAsync(screenshot!, $"{stepName}.png", graphAccessToken);

        var safetyChecks = call.TryGetProperty("pending_safety_checks", out var sc)
            ? sc : JsonSerializer.Deserialize<JsonElement>("[]");

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
    /// sessionId is omitted — the MCP server resolves sessions by user context.
    /// </summary>
    private static (string ToolName, Dictionary<string, object?> Args) MapActionToMcpTool(string actionType, JsonElement action)
    {
        return actionType.ToLowerInvariant() switch
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
    }

    private async Task<string> CaptureScreenshotAsync(IList<AITool> tools, IMcpClient? mcpClient, CancellationToken ct)
    {
        // Use direct MCP client when available — AIFunction wrappers drop image content blocks
        if (mcpClient != null)
        {
            var result = await mcpClient.CallToolAsync("W365_CaptureScreenshot", new Dictionary<string, object?>(), cancellationToken: ct);
            foreach (var item in result.Content)
            {
                if (item.Type == "image" && !string.IsNullOrEmpty(item.Data))
                    return item.Data;
                if (item.Type == "text" && !string.IsNullOrEmpty(item.Text))
                {
                    var nested = ExtractBase64FromText(item.Text);
                    if (!string.IsNullOrEmpty(nested)) return nested;
                }
            }

            throw new InvalidOperationException($"Screenshot MCP response had {result.Content.Count} content blocks but no extractable image data.");
        }

        // Fallback: AIFunction wrapper (may lose image content)
        var aiResult = await InvokeToolAsync(tools, "W365_CaptureScreenshot", new Dictionary<string, object?>(), ct);
        var str = aiResult?.ToString() ?? "";

        try
        {
            using var doc = JsonDocument.Parse(str);
            var root = doc.RootElement;
            if (root.TryGetProperty("screenshotData", out var sd)) return sd.GetString() ?? "";
            if (root.TryGetProperty("image", out var img)) return img.GetString() ?? "";
            if (root.TryGetProperty("data", out var d)) return d.GetString() ?? "";
        }
        catch (JsonException) { }

        if (str.Length > 100) return str;
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

    private static JsonElement CreateFunctionOutput(string callId) => ToJsonElement(new
    {
        type = "function_call_output", call_id = callId, output = "success"
    });

    private static JsonElement ToJsonElement(object obj) =>
        JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(obj));

    private static string Truncate(string v, int max) => v.Length <= max ? v : v[..max] + "...";

    private int _screenshotCounter;

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
}
