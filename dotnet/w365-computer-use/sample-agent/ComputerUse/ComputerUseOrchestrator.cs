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
    /// Shared MCP client — one SSE connection reused across all conversations.
    /// </summary>
    private IMcpClient? _cachedMcpClient;

    /// <summary>
    /// Shared tool list — same tools for all conversations.
    /// </summary>
    private IList<AITool>? _cachedTools;

    private const string SystemInstructions = """
        You are a computer-using agent that can control a Windows desktop computer.
        After each action, examine the screenshot to verify it worked.
        If you see browser setup or sign-in dialogs, dismiss them (Escape, X, or Skip).
        Once you have completed the task, call the OnTaskComplete function.
        Do NOT continue looping after the task is done.
        If the user wants to end, quit, or disconnect their session, call the EndSession function.
        If the user sends a casual greeting or question that does not require computer use, reply with a helpful text message.
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
            },
            new FunctionToolDefinition
            {
                Name = "EndSession",
                Description = "Call this function when the user wants to end, quit, disconnect, or release their computer session."
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
        IMcpClient? mcpClient = null,
        string? graphAccessToken = null,
        Action<string>? onStatusUpdate = null,
        Func<string, Task>? onFolderLinkReady = null,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("Starting CUA loop for conversation {ConversationId}: {Message}", conversationId, Truncate(userMessage, 100));
        _cachedTools = w365Tools;
        if (mcpClient != null) _cachedMcpClient = mcpClient;

        var session = _sessions.GetOrAdd(conversationId, _ =>
        {
            // Build a safe subfolder name from date + truncated conversation ID
            var safeId = new string(conversationId.Where(c => char.IsLetterOrDigit(c)).ToArray());
            safeId = safeId.Length > 8 ? safeId[..8] : safeId;
            return new ConversationSession
            {
                ScreenshotSubfolder = $"{DateTime.UtcNow:yyyyMMdd}_{safeId}"
            };
        });

        if (session.SessionStarted)
        {
            _logger.LogInformation("Reusing session for conversation {ConversationId}, W365SessionId={SessionId}", conversationId, session.W365SessionId);
        }

        // Between user messages: keep text context (user messages + model text replies)
        // and the LAST computer_call + computer_call_output pair so the model has visual
        // context for simple follow-ups. Both must be kept together — the API requires
        // a matching computer_call for every computer_call_output (linked by call_id).
        JsonElement? lastCall = null;
        JsonElement? lastCallOutput = null;
        for (var i = session.ConversationHistory.Count - 1; i >= 0; i--)
        {
            var item = session.ConversationHistory[i];
            if (item.TryGetProperty("type", out var t) && t.GetString() == "computer_call_output")
            {
                lastCallOutput = item;
                // Find the matching computer_call by call_id
                var callId = item.TryGetProperty("call_id", out var cid) ? cid.GetString() : null;
                if (callId != null)
                {
                    for (var j = i - 1; j >= 0; j--)
                    {
                        var candidate = session.ConversationHistory[j];
                        if (candidate.TryGetProperty("type", out var ct) && ct.GetString() == "computer_call"
                            && candidate.TryGetProperty("call_id", out var ccid) && ccid.GetString() == callId)
                        {
                            lastCall = candidate;
                            break;
                        }
                    }
                }
                break;
            }
        }
        session.ConversationHistory.RemoveAll(item =>
        {
            var type = item.TryGetProperty("type", out var t) ? t.GetString() : null;
            return type is "computer_call" or "computer_call_output" or "function_call" or "function_call_output";
        });
        if (lastCall.HasValue && lastCallOutput.HasValue)
        {
            session.ConversationHistory.Add(lastCall.Value);
            session.ConversationHistory.Add(lastCallOutput.Value);
        }
        session.NewItems.Clear();
        session.LastResponseId = null;

        var userMsg = CreateUserMessage(userMessage);
        session.ConversationHistory.Add(userMsg);
        session.NewItems.Add(userMsg);

        for (var i = 0; i < _maxIterations; i++)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var response = await CallModelAsync(session, cancellationToken);
            if (response?.Output == null || response.Output.Count == 0)
                break;

            var hasActions = false;

            foreach (var item in response.Output)
            {
                var type = item.GetProperty("type").GetString();
                if (type == "reasoning") continue;

                session.ConversationHistory.Add(item);
                // No need to add model output items to NewItems — the API reconstructs
                // its own output from previous_response_id. We only need to send new
                // user-side items (user messages, computer_call_output, function_call_output).

                switch (type)
                {
                    case "message":
                        return ExtractText(item);

                    case "computer_call":
                        hasActions = true;
                        _logger.LogInformation("CUA iteration {Iteration}: {Action}", i + 1, Truncate(item.GetRawText(), 200));

                        // Lazy session start — only spin up the VM when the model actually needs the computer
                        if (!session.SessionStarted)
                        {
                            _logger.LogInformation("First computer_call for conversation {ConversationId} — starting session", conversationId);
                            onStatusUpdate?.Invoke("Starting W365 computing session...");
                            try
                            {
                                session.W365SessionId = await StartSessionAsync(w365Tools, _logger, cancellationToken);
                                session.SessionStarted = true;
                                // Update subfolder to use session ID instead of conversation ID
                                var safeSessionId = session.W365SessionId != null
                                    ? new string(session.W365SessionId.Where(c => char.IsLetterOrDigit(c) || c == '-').ToArray())
                                    : "unknown";
                                session.ScreenshotSubfolder = $"{DateTime.UtcNow:yyyyMMdd}_{safeSessionId}";
                                _logger.LogInformation("Session started for conversation {ConversationId}, W365SessionId={SessionId}", conversationId, session.W365SessionId);
                            }
                            catch (Exception ex)
                            {
                                _logger.LogError(ex, "QuickStartSession failed for conversation {ConversationId}", conversationId);
                                return "Unable to start a W365 Cloud PC session. This could mean:\n" +
                                       "- No Cloud PC pools are available for your agent user\n" +
                                       "- All sessions in the pool are currently in use\n" +
                                       "- The agent user doesn't have the required permissions\n\n" +
                                       $"Error: {ex.Message}";
                            }

                            // For gpt-5.4+ ("computer" tool type), capture an initial screenshot
                            if (_toolType == "computer")
                            {
                                var initialScreenshot = await CaptureScreenshotCoreAsync(w365Tools, mcpClient, session.W365SessionId, cancellationToken);
                                var initialName = $"{++session.ScreenshotCounter:D3}_initial";
                                SaveScreenshotToDisk(initialScreenshot!, initialName);
                                var folderUrl = await UploadScreenshotToOneDriveAsync(initialScreenshot!, $"{initialName}.png", graphAccessToken, session.ScreenshotSubfolder, session);
                                if (folderUrl != null && onFolderLinkReady != null)
                                    await onFolderLinkReady(folderUrl);
                            }
                        }

                        var callOutput = await HandleComputerCallAsync(item, w365Tools, mcpClient, session, graphAccessToken, onStatusUpdate, onFolderLinkReady, cancellationToken);
                        session.ConversationHistory.Add(callOutput);
                        session.NewItems.Add(callOutput);
                        break;

                    case "function_call":
                        hasActions = true;
                        var funcName = item.GetProperty("name").GetString();
                        _logger.LogInformation("CUA iteration {Iteration}: function_call {Name}", i + 1, funcName);
                        var funcOutput = CreateFunctionOutput(item.GetProperty("call_id").GetString()!);
                        session.ConversationHistory.Add(funcOutput);
                        session.NewItems.Add(funcOutput);
                        if (funcName == "OnTaskComplete")
                        {
                            return "Task completed successfully.";
                        }
                        if (funcName == "EndSession")
                        {
                            if (session.SessionStarted)
                            {
                                _logger.LogInformation("EndSession requested by model for conversation {ConversationId}", conversationId);
                                onStatusUpdate?.Invoke("Ending session...");
                                await EndSessionAsync(w365Tools, _logger, session.W365SessionId, cancellationToken);
                                session.SessionStarted = false;
                                session.W365SessionId = null;
                                _sessions.TryRemove(conversationId, out _);
                            }
                            return "Session ended. The VM has been released back to the pool.";
                        }
                        break;
                }
            }

            if (!hasActions) break;
        }

        return "The task could not be completed within the allowed number of steps.";
    }

    /// <summary>
    /// Check if a conversation has an active W365 session.
    /// </summary>
    public bool HasActiveSession(string conversationId)
    {
        return _sessions.TryGetValue(conversationId, out var session) && session.SessionStarted;
    }

    /// <summary>
    /// End the session for a specific conversation and clean up state.
    /// </summary>
    public async Task EndConversationSessionAsync(string conversationId, IList<AITool> tools, CancellationToken ct)
    {
        if (_sessions.TryRemove(conversationId, out var session) && session.SessionStarted)
        {
            _logger.LogInformation("Ending session for conversation {ConversationId}, W365SessionId={SessionId}", conversationId, session.W365SessionId);
            await EndSessionAsync(tools, _logger, session.W365SessionId, ct);
        }
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
        catch (HttpRequestException httpEx) when (httpEx.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            logger.LogInformation("MCP transport session expired (404) — W365 session will be released by server timeout");
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

        if (_cachedMcpClient != null)
        {
            await _cachedMcpClient.DisposeAsync();
            _cachedMcpClient = null;
        }
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

    private async Task<ComputerUseResponse?> CallModelAsync(ConversationSession session, CancellationToken ct)
    {
        List<JsonElement> input;
        string? previousResponseId = null;

        if (session.LastResponseId != null)
        {
            // Send only the items added since the last model call
            input = session.NewItems;
            previousResponseId = session.LastResponseId;
        }
        else
        {
            // First call — send the full conversation history
            input = session.ConversationHistory;
        }

        var body = JsonSerializer.Serialize(new ComputerUseRequest
        {
            Model = _modelProvider.ModelName,
            Instructions = SystemInstructions,
            PreviousResponseId = previousResponseId,
            Input = input,
            Tools = _tools,
            Truncation = "auto"
        }, new JsonSerializerOptions { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull });

        var responseJson = await _modelProvider.SendAsync(body, ct);
        var response = JsonSerializer.Deserialize<ComputerUseResponse>(responseJson);

        // Store the response ID for the next call and reset new items
        session.LastResponseId = response?.Id;
        session.NewItems.Clear();

        return response;
    }

    /// <summary>
    /// Translate a computer_call into an MCP tool call, capture screenshot, return computer_call_output.
    /// </summary>
    private async Task<JsonElement> HandleComputerCallAsync(
        JsonElement call, IList<AITool> tools, IMcpClient? mcpClient, ConversationSession session, string? graphAccessToken, Action<string>? onStatus, Func<string, Task>? onFolderLinkReady, CancellationToken ct)
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
                    var (_, sessionLost) = await InvokeToolCheckSessionAsync(tools, toolName, args, ct);
                    if (sessionLost)
                    {
                        onStatus?.Invoke("Session lost — recovering...");
                        sessionId = await RecoverSessionAsync(session, tools, _logger, ct);
                        // Re-map with new sessionId and retry
                        (toolName, args) = MapActionToMcpTool(actionType, action, sessionId);
                        await InvokeToolAsync(tools, toolName, args, ct);
                    }
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
                var (_, sessionLost) = await InvokeToolCheckSessionAsync(tools, toolName, args, ct);
                if (sessionLost)
                {
                    onStatus?.Invoke("Session lost — recovering...");
                    sessionId = await RecoverSessionAsync(session, tools, _logger, ct);
                    (toolName, args) = MapActionToMcpTool(actionType, singleAction, sessionId);
                    await InvokeToolAsync(tools, toolName, args, ct);
                }
            }
        }

        // Always capture screenshot after action — with session recovery (same pattern as action tools)
        string screenshot;
        try
        {
            screenshot = await CaptureScreenshotCoreAsync(tools, mcpClient, sessionId, ct);
        }
        catch (InvalidOperationException ex) when (IsSessionNotFoundError(ex.Message))
        {
            onStatus?.Invoke("Session lost — recovering...");
            sessionId = await RecoverSessionAsync(session, tools, _logger, ct);
            screenshot = await CaptureScreenshotCoreAsync(tools, mcpClient, sessionId, ct);
        }

        var stepName = $"{++session.ScreenshotCounter:D3}_step";
        SaveScreenshotToDisk(screenshot!, stepName);
        var folderUrl = await UploadScreenshotToOneDriveAsync(screenshot!, $"{stepName}.png", graphAccessToken, session.ScreenshotSubfolder, session);
        if (folderUrl != null && onFolderLinkReady != null)
            await onFolderLinkReady(folderUrl);

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

    private async Task<string> CaptureScreenshotCoreAsync(IList<AITool> tools, IMcpClient? mcpClient, string? sessionId, CancellationToken ct)
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

            // Check if the error is a session-not-found before throwing
            var contentText = string.Join(" ", result.Content.Select(c => c.Text ?? ""));
            if (IsSessionNotFoundError(contentText))
                throw new InvalidOperationException($"Screenshot failed: no active session. Response: {contentText[..Math.Min(300, contentText.Length)]}");

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

        // Detect session-not-found early so the retry wrapper can recover the session
        if (IsSessionNotFoundError(str))
            throw new InvalidOperationException($"Screenshot failed: no active session. Response: {str[..Math.Min(300, str.Length)]}");

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

    /// <summary>
    /// Invoke a tool and detect session-not-found errors. Returns (result, isSessionLost).
    /// </summary>
    private static async Task<(object? Result, bool IsSessionLost)> InvokeToolCheckSessionAsync(
        IList<AITool> tools, string name, Dictionary<string, object?> args, CancellationToken ct)
    {
        var result = await InvokeToolAsync(tools, name, args, ct);
        var resultStr = result?.ToString() ?? "";
        if (IsSessionNotFoundError(resultStr))
            return (result, true);
        return (result, false);
    }

    /// <summary>
    /// Check if a tool response indicates the session is no longer valid.
    /// </summary>
    private static bool IsSessionNotFoundError(string response)
    {
        if (string.IsNullOrEmpty(response)) return false;
        var lower = response.ToLowerInvariant();
        return lower.Contains("no active session found") ||
               lower.Contains("session not found") ||
               lower.Contains("session expired") ||
               lower.Contains("session has been terminated");
    }

    /// <summary>
    /// Recover from a lost session: end the stale session (best-effort) and start a new one.
    /// </summary>
    private async Task<string?> RecoverSessionAsync(
        ConversationSession session, IList<AITool> tools, ILogger logger, CancellationToken ct)
    {
        logger.LogWarning("Session lost for W365SessionId={SessionId}. Recovering — ending stale session and starting new one.", session.W365SessionId);

        // Best-effort end the stale session
        try
        {
            await EndSessionAsync(tools, logger, session.W365SessionId, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Best-effort EndSession during recovery failed for {SessionId}", session.W365SessionId);
        }

        // Start a fresh session
        var newSessionId = await StartSessionAsync(tools, logger, ct);
        session.W365SessionId = newSessionId;
        session.SessionStarted = true;
        // Update subfolder to use new session ID
        var safeSessionId = newSessionId != null
            ? new string(newSessionId.Where(c => char.IsLetterOrDigit(c) || c == '-').ToArray())
            : "unknown";
        session.ScreenshotSubfolder = $"{DateTime.UtcNow:yyyyMMdd}_{safeSessionId}";
        logger.LogInformation("Session recovered. New W365SessionId={SessionId}", newSessionId);
        return newSessionId;
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
    private async Task<string?> UploadScreenshotToOneDriveAsync(string base64Data, string fileName, string? graphAccessToken, string? subfolder, ConversationSession session)
    {
        if (string.IsNullOrEmpty(graphAccessToken))
        {
            _logger.LogDebug("OneDrive upload skipped: no Graph token");
            return null;
        }
        if (string.IsNullOrEmpty(base64Data))
        {
            _logger.LogDebug("OneDrive upload skipped: no screenshot data");
            return null;
        }
        if (string.IsNullOrEmpty(_oneDriveFolder))
        {
            _logger.LogDebug("OneDrive upload skipped: OneDriveFolder not configured");
            return null;
        }

        try
        {
            // Upload to /CUA-Sessions/{subfolder}/{fileName} — subfolder is per-conversation
            var folderPath = string.IsNullOrEmpty(subfolder)
                ? _oneDriveFolder.TrimStart('/')
                : $"{_oneDriveFolder.TrimStart('/')}/{subfolder}";
            var url = $"https://graph.microsoft.com/v1.0/me/drive/root:/{folderPath}/{fileName}:/content";

            using var request = new HttpRequestMessage(HttpMethod.Put, url);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", graphAccessToken);
            request.Content = new ByteArrayContent(Convert.FromBase64String(base64Data));
            request.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png");

            var response = await _httpClient.SendAsync(request);
            if (response.IsSuccessStatusCode)
            {
                _logger.LogInformation("Screenshot uploaded to OneDrive: {Folder}/{FileName}", folderPath, fileName);

                // On first upload, create an org-scoped sharing link for the folder
                if (!session.FolderShared)
                {
                    var shareUrl = await ShareConversationFolderAsync(folderPath, graphAccessToken);
                    if (shareUrl != null)
                    {
                        session.FolderShared = true;
                        return shareUrl;
                    }
                }
            }
            else
            {
                var content = await response.Content.ReadAsStringAsync();
                _logger.LogWarning("OneDrive upload failed: {Status} {Content}", response.StatusCode, content);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to upload screenshot to OneDrive");
        }

        return null;
    }

    /// <summary>
    /// Create an organization-scoped sharing link for the conversation's screenshot folder.
    /// Returns the web URL that anyone in the org can use to view the folder.
    /// </summary>
    private async Task<string?> ShareConversationFolderAsync(string folderPath, string graphAccessToken)
    {
        try
        {
            // Get the folder's item ID
            var folderUrl = $"https://graph.microsoft.com/v1.0/me/drive/root:/{folderPath}";
            using var getRequest = new HttpRequestMessage(HttpMethod.Get, folderUrl);
            getRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", graphAccessToken);
            var getResponse = await _httpClient.SendAsync(getRequest);

            if (!getResponse.IsSuccessStatusCode)
            {
                _logger.LogWarning("Failed to get folder item for sharing: {Status}", getResponse.StatusCode);
                return null;
            }

            var folderJson = await getResponse.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(folderJson);
            var folderId = doc.RootElement.GetProperty("id").GetString();
            var webUrl = doc.RootElement.TryGetProperty("webUrl", out var wu) ? wu.GetString() : null;

            // Create an organization-scoped view link
            var linkUrl = $"https://graph.microsoft.com/v1.0/me/drive/items/{folderId}/createLink";
            using var linkRequest = new HttpRequestMessage(HttpMethod.Post, linkUrl);
            linkRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", graphAccessToken);
            linkRequest.Content = new StringContent(
                JsonSerializer.Serialize(new { type = "view", scope = "organization" }),
                System.Text.Encoding.UTF8, "application/json");

            var linkResponse = await _httpClient.SendAsync(linkRequest);
            if (linkResponse.IsSuccessStatusCode)
            {
                var linkJson = await linkResponse.Content.ReadAsStringAsync();
                using var linkDoc = JsonDocument.Parse(linkJson);
                var shareUrl = linkDoc.RootElement.GetProperty("link").GetProperty("webUrl").GetString();
                _logger.LogInformation("Folder shared with org: {Url}", shareUrl);
                return shareUrl;
            }
            else
            {
                var errorContent = await linkResponse.Content.ReadAsStringAsync();
                _logger.LogWarning("Failed to create sharing link: {Status} {Content}", linkResponse.StatusCode, errorContent);
                // Fall back to the folder's webUrl (user may not be able to access without sharing)
                return webUrl;
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to share conversation folder");
            return null;
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
        public List<JsonElement> NewItems { get; } = [];
        public string? LastResponseId { get; set; }
        public int ScreenshotCounter { get; set; }
        public bool FolderShared { get; set; }
        public string? ScreenshotSubfolder { get; set; }
    }
}
