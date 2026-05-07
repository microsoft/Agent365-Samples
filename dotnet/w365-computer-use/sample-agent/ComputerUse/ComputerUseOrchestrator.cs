// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Collections.Concurrent;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.AI;
using W365ComputerUseSample.ComputerUse.Models;

namespace W365ComputerUseSample.ComputerUse;

/// <summary>
/// Thin protocol adapter between OpenAI's computer-use-preview model and W365 MCP tools.
/// The model emits computer_call actions; this class translates them to MCP tool calls
/// and feeds back screenshots. Supports multiple concurrent sessions keyed by conversation ID.
/// </summary>
public class ComputerUseOrchestrator
{
    /// <summary>
    /// Names of the CUA tools exposed by the W365 remote MCP server (as returned by its
    /// tools/list). Used to identify which tools came from the W365 server vs other MCP servers
    /// (mail, calendar, etc.) without per-server tracking. Includes ATG's local EndSession
    /// mcptool. Update when W365 adds/renames tools.
    /// </summary>
    internal static readonly HashSet<string> W365CuaToolNames = new(StringComparer.OrdinalIgnoreCase)
    {
        // Desktop interaction
        "take_screenshot", "click", "type_text", "press_keys", "scroll", "move_mouse",
        "drag_mouse", "wait_milliseconds", "get_cursor_position", "get_screen_size",
        // Window management
        "list_windows", "activate_window", "close_window",
        // Accessibility / OCR
        "get_accessibility_tree", "find_ui_element", "analyze_screen",
        // Browser
        "browser_navigate", "browser_click", "browser_type", "browser_get_html",
        "browser_get_text", "browser_get_url", "browser_get_title", "browser_query_text",
        "browser_list_tabs", "browser_switch_tab", "browser_close_tab", "browser_new_tab",
        "browser_back", "browser_forward", "browser_reload", "browser_wait_for",
        "browser_eval_js", "browser_screenshot", "focus_browser",
        // Code / shell execution
        "execute_python_code", "execute_shell_command",
        // ATG-local tool
        "mcp_W365ComputerUse_EndSession",
    };

    /// <summary>Returns true when <paramref name="toolName"/> identifies a W365 CUA tool.</summary>
    internal static bool IsW365CuaTool(string? toolName)
        => !string.IsNullOrEmpty(toolName) && W365CuaToolNames.Contains(toolName);

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

    private const string SystemInstructions = """
        You are a helpful assistant that can also control a Windows desktop computer.
        If the user's message is conversational or doesn't require computer use, respond with a helpful text message.

        ## Function tools (email, calendar, etc.)
        You may have access to function tools for tasks like sending email, managing calendar, etc.
        Prefer function tools over computer use when a matching one is available — they are faster and more reliable.
        After calling a function tool, respond with a text message describing what you did and the result.
        Do NOT call OnTaskComplete after using function tools — just respond with text.

        ## When no tool can accomplish the request
        If the user asks for something and no function tool matches AND computer use cannot accomplish it either,
        respond with a text message explaining clearly that you are unable to perform that task and why
        (e.g. "I don't have an email tool available in this environment").
        Do NOT call OnTaskComplete in this case — only call OnTaskComplete when you have actually completed a computer-use task.

        ## Computer use (desktop control)
        Only use computer actions when no function tool can accomplish the task.
        When a task requires computer use, perform the actions and examine screenshots to verify they worked.
        If you see browser setup or sign-in dialogs, dismiss them (Escape, X, or Skip).
        Once you have completed a computer use task, call the OnTaskComplete function.
        Do NOT continue looping after the task is done.
        If the user sends a casual greeting or question that does not require computer use, reply with a helpful text message.

        ## Ending the Cloud PC session
        Call the EndSession function ONLY when the user explicitly asks to end, close,
        disconnect, release, or quit the session, or otherwise says they are done with
        all work on the Cloud PC. Trigger phrases include: "end session", "close session",
        "disconnect", "release the VM", "I'm done", "quit", "shut it down", "log off".

        Do NOT call EndSession in any of these situations:
          - The user is starting a new task (e.g. "go to bbc.com", "open Word", "navigate to ...").
          - The user is switching topics or apps within the same session.
          - You just completed a previous task — call OnTaskComplete instead, which keeps the session open for the next request.
          - The user sends a casual greeting, question, or anything that's not an explicit request to end the session.

        Switching tasks inside one session is normal and expected. The session should
        remain open across many user requests until the user explicitly asks to end it.
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
            },
            new FunctionToolDefinition
            {
                Name = "EndSession",
                Description = "Call this function when the user wants to end, quit, disconnect, or release their computer session."
            }
        ];
    }

    /// <summary>
    /// Lightweight intent classifier: decides whether a user message needs computer-use (CUA).
    /// Runs a single tool-less model call and parses a strict YES/NO answer. On any parse error
    /// or exception, returns <c>true</c> so we fall back to the full CUA loop — safer to pay
    /// the W365 session cost than miss a legitimate computer-use request.
    /// </summary>
    public async Task<bool> ClassifyNeedsCuaAsync(string userMessage, CancellationToken cancellationToken = default)
    {
        const string ClassifierInstructions = """
            You are a router. Decide whether the user's message requires controlling or managing a
            Windows desktop: clicking, typing into apps, taking screenshots, opening programs,
            interacting with the GUI, OR ending/releasing a Cloud PC session.
            Answer with a single word:
              YES  — if it needs desktop control or session management
              NO   — if it is chit-chat, a question answerable from knowledge, or a request that can
                     be fulfilled with mail/calendar/Teams/other function tools only
            When uncertain, prefer YES.
            """;

        try
        {
            var body = JsonSerializer.Serialize(new ComputerUseRequest
            {
                Model = _modelProvider.ModelName,
                Instructions = ClassifierInstructions,
                Input = [CreateUserMessage(userMessage)],
                Tools = [],
                Truncation = "auto"
            }, new JsonSerializerOptions { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull });

            var responseJson = await _modelProvider.SendAsync(body, cancellationToken);
            var response = JsonSerializer.Deserialize<ComputerUseResponse>(responseJson);
            if (response?.Output == null)
            {
                return true;
            }

            foreach (var item in response.Output)
            {
                if (item.TryGetProperty("type", out var tProp) && tProp.GetString() == "message")
                {
                    var replyText = ExtractText(item).Trim();
                    _logger.LogInformation("CUA intent classifier reply for message {Preview}: {Reply}", Truncate(userMessage, 80), Truncate(replyText, 60));
                    // Match on the first non-empty token. The router is instructed to emit a single
                    // word but may prepend/append fluff; trim to the leading YES/NO.
                    var upper = replyText.ToUpperInvariant();
                    if (upper.StartsWith("NO")) return false;
                    if (upper.StartsWith("YES")) return true;
                    // Unexpected shape — default to CUA so we don't silently drop a legitimate request.
                    return true;
                }
            }

            return true;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is JsonException || ex is HttpRequestException || ex is TaskCanceledException)
        {
            _logger.LogWarning(ex, "CUA intent classifier threw — defaulting to needsCua=true.");
            return true;
        }
    }

    /// <summary>
    /// Run the CUA loop for a specific conversation. When <paramref name="includeCuaTool"/> is
    /// <c>false</c>, the <c>computer</c> tool is withheld from the model's tool list so it
    /// cannot emit <c>computer_call</c> actions — used on the non-CUA fast path where the
    /// router decided the message doesn't need desktop control, so no W365 session is acquired.
    /// </summary>
    public async Task<string> RunAsync(
        string conversationId,
        string userMessage,
        IList<AITool> w365Tools,
        IList<AITool>? additionalTools = null,
        string? graphAccessToken = null,
        Func<string, Task>? onStatusUpdate = null,
        Func<bool, Task>? onCuaStarting = null,
        Func<string, Task>? onFolderLinkReady = null,
        bool includeCuaTool = true,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("Processing message for conversation {ConversationId}: {Message}", conversationId, Truncate(userMessage, 100));

        var session = _sessions.GetOrAdd(conversationId, _ => new ConversationSession());

        if (session.SessionStarted)
        {
            _logger.LogInformation("Reusing session for conversation {ConversationId}, W365SessionId={SessionId}", conversationId, session.W365SessionId);
        }

        // Two-level screenshot folder layout: {yyyy-MM-dd}/{HHmmss}_{prompt-slug}.
        // Set it here on every CUA-bound turn so each user prompt that triggers the CUA loop
        // gets its own subfolder. Reset FolderShared so the new folder gets a fresh share
        // link surfaced via onFolderLinkReady. Non-CUA turns keep the existing folder (or
        // null) — they don't take screenshots, so the value is irrelevant.
        if (includeCuaTool)
        {
            var promptSlug = SanitizeForPath(userMessage, maxLen: 30);
            session.ScreenshotSubfolder = $"{DateTime.UtcNow:yyyy-MM-dd}/{DateTime.UtcNow:HHmmss}_{promptSlug}";
            session.FolderShared = false;
            _logger.LogInformation("CUA turn folder for conversation {ConversationId}: {Folder}", conversationId, session.ScreenshotSubfolder);
        }

        // For "computer" tool type (gpt-5.4+), include a screenshot with the FIRST user message if session already active
        if (_toolType == "computer" && session.ConversationHistory.Count == 0 && session.SessionStarted)
        {
            var initialScreenshot = await CaptureScreenshotAsync(w365Tools, session.W365SessionId, cancellationToken);
            var convPrefix = conversationId.Length > 8 ? conversationId[..8] : conversationId;
            var initialName = $"{convPrefix}_{++session.ScreenshotCounter:D3}_initial";
            SaveScreenshotToDisk(initialScreenshot!, initialName, session.ScreenshotSubfolder);
            var folderUrlReuse = await UploadScreenshotToOneDriveAsync(initialScreenshot!, $"{initialName}.png", graphAccessToken, session.ScreenshotSubfolder, session, cancellationToken);
            if (folderUrlReuse != null && onFolderLinkReady != null)
                await onFolderLinkReady(folderUrlReuse);
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

        // Build the model's tools list — computer + OnTaskComplete + any additional function tools.
        // When includeCuaTool is false (non-CUA fast path), skip all CUA-specific tools entirely
        // (computer, OnTaskComplete, EndSession). Those require an active W365 session, and the
        // classifier has already decided we don't need one. Only the caller-provided additional
        // tools (mail/calendar/etc.) remain visible to the model.
        var modelTools = includeCuaTool
            ? new List<object>(_tools)
            : new List<object>();
        if (additionalTools?.Count > 0)
        {
            // ATG injects a synthetic "Error" sentinel tool when any MCP server's tools/list
            // fails (e.g. W365 session acquisition error). Its parameters schema is `{}` with
            // no properties — Azure OpenAI rejects that with `invalid_function_parameters`.
            // MyAgent reads the Error description for user-facing messaging before getting
            // here, so it's safe to drop from the LLM call.
            var llmTools = additionalTools.OfType<AIFunction>()
                .Where(t => !string.Equals(t.Name, "Error", StringComparison.OrdinalIgnoreCase))
                .ToList();

            foreach (var tool in llmTools)
            {
                modelTools.Add(new FunctionToolDefinition
                {
                    Name = tool.Name,
                    Description = tool.Description ?? string.Empty,
                    Parameters = tool.JsonSchema
                });
            }

            _logger.LogInformation("Added {Count} additional function tools to model", llmTools.Count);
            foreach (var tool in llmTools)
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

            // When running without the computer tool, strip past CUA-only turns from the history.
            // Azure OpenAI 400s when an item references a tool that isn't declared in this turn:
            //   - `computer_call` / `computer_call_output` need `computer` or `computer_use_preview`
            //   - `function_call` / `function_call_output` for OnTaskComplete or EndSession need
            //     those CUA-only function tools declared (we strip them in non-CUA modelTools).
            // Two-pass: first identify the call_ids of CUA-only function_calls so we can also
            // drop their paired function_call_outputs (which carry only call_id, not the name).
            // session.ConversationHistory itself is left intact so a later CUA turn still sees
            // the full record.
            var conversation = session.ConversationHistory;
            if (!includeCuaTool)
            {
                var cuaOnlyCallIds = new HashSet<string>(StringComparer.Ordinal);
                foreach (var item in session.ConversationHistory)
                {
                    if (!item.TryGetProperty("type", out var typeProp)) continue;
                    if (typeProp.GetString() != "function_call") continue;
                    if (!item.TryGetProperty("name", out var nameProp)) continue;
                    var name = nameProp.GetString();
                    if (name != "OnTaskComplete" && name != "EndSession") continue;
                    if (item.TryGetProperty("call_id", out var idProp))
                    {
                        var id = idProp.GetString();
                        if (!string.IsNullOrEmpty(id)) cuaOnlyCallIds.Add(id);
                    }
                }

                conversation = session.ConversationHistory
                    .Where(item =>
                    {
                        if (!item.TryGetProperty("type", out var typeProp))
                        {
                            return true;
                        }
                        var type = typeProp.GetString();
                        if (type == "computer_call" || type == "computer_call_output")
                        {
                            return false;
                        }
                        if ((type == "function_call" || type == "function_call_output")
                            && item.TryGetProperty("call_id", out var idProp)
                            && cuaOnlyCallIds.Contains(idProp.GetString() ?? string.Empty))
                        {
                            return false;
                        }
                        return true;
                    })
                    .ToList();
            }

            var response = await CallModelAsync(conversation, modelTools, cancellationToken);
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
                                if (onStatusUpdate != null) await onStatusUpdate("Starting W365 computing session...");
                                session.SessionStarted = true;
                                _logger.LogInformation("Session marked started for conversation {ConversationId}", conversationId);
                            }
                            else if (onCuaStarting != null)
                            {
                                await onCuaStarting(false);
                            }

                            cuaAcknowledged = true;
                        }

                        _logger.LogInformation("CUA iteration {Iteration}: {Action}", i + 1, Truncate(item.GetRawText(), 200));
                        try
                        {
                            session.ConversationHistory.Add(await HandleComputerCallAsync(item, w365Tools, session, graphAccessToken, onStatusUpdate, onFolderLinkReady, cancellationToken));
                        }
                        catch (InvalidOperationException toolEx)
                        {
                            _logger.LogError(toolEx, "Tool call in CUA iteration failed for conversation {ConversationId}", conversationId);
                            // Pop the unpaired computer_call we added above so the next turn's conversation
                            // history isn't malformed (Azure OpenAI 400s on "No tool output found for …").
                            if (session.ConversationHistory.Count > 0)
                            {
                                session.ConversationHistory.RemoveAt(session.ConversationHistory.Count - 1);
                            }
                            return toolEx.Message;
                        }
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
                        if (funcName == "EndSession")
                        {
                            session.ConversationHistory.Add(CreateFunctionOutput(item.GetProperty("call_id").GetString()!));
                            _logger.LogInformation("EndSession requested by model for conversation {ConversationId}", conversationId);
                            if (onStatusUpdate != null) await onStatusUpdate("Ending session...");

                            // Always delegate to ATG regardless of session.SessionStarted: in V2 the
                            // session can be acquired by ATG's hostname-discovery when the sample agent
                            // calls tools/list at startup — before any computer_call flips SessionStarted.
                            // Gating on SessionStarted would leak the pool slot. ATG's handler is
                            // idempotent and returns "No active W365 session found." when there's nothing
                            // to release, so this is safe on fresh conversations too.
                            await EndSessionAsync(w365Tools, _logger, session.W365SessionId, cancellationToken);
                            session.SessionStarted = false;
                            session.W365SessionId = null;
                            session.ScreenshotSubfolder = null;
                            _sessions.TryRemove(conversationId, out _);
                            return "Session ended. The VM has been released back to the pool.";
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
            // The ATG-local mcptool resolves the active W365 session via the v2: context key
            // — no sessionId arg needed (session routing is transparent).
            var args = new Dictionary<string, object?>();
            await InvokeToolAsync(tools, "mcp_W365ComputerUse_EndSession", args, ct);
            logger.LogInformation("W365 session ended");
        }
        catch (ObjectDisposedException)
        {
            logger.LogInformation("MCP client already disposed — W365 session will be released by server timeout");
        }
        catch (HttpRequestException httpEx) when (httpEx.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            logger.LogInformation("MCP transport session expired (404) — W365 session will be released by server timeout");
        }
        catch (Exception ex) when (ex is HttpRequestException || ex is InvalidOperationException || ex is TaskCanceledException)
        {
            logger.LogWarning(ex, "Failed to end W365 session");
        }
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

        _logger.LogDebug("Model request (first 2000 chars): {Body}", body[..Math.Min(2000, body.Length)]);

        var responseJson = await _modelProvider.SendAsync(body, ct);
        _logger.LogDebug("Model response (first 2000 chars): {Response}", responseJson[..Math.Min(2000, responseJson.Length)]);
        return JsonSerializer.Deserialize<ComputerUseResponse>(responseJson);
    }

    /// <summary>
    /// Translate a computer_call into an MCP tool call, capture screenshot, return computer_call_output.
    /// </summary>
    private async Task<JsonElement> HandleComputerCallAsync(
        JsonElement call, IList<AITool> tools, ConversationSession session, string? graphAccessToken, Func<string, Task>? onStatus, Func<string, Task>? onFolderLinkReady, CancellationToken ct)
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
                if (onStatus != null) await onStatus($"Performing: {actionType}...");

                if (actionType != "screenshot")
                {
                    var (toolName, args) = MapActionToMcpTool(actionType, action, sessionId);
                    var (result, sessionLost) = await InvokeToolCheckSessionAsync(tools, toolName, args, ct);
                    if (sessionLost)
                    {
                        if (onStatus != null) await onStatus("Session lost — recovering...");
                        await RecoverSessionAsync(session, tools, _logger, ct);
                        // Re-invoke with the same args; ATG re-acquires the session transparently
                        // on this retry via the hostname-discovery handler.
                        await InvokeToolThrowOnErrorAsync(tools, toolName, args, ct);
                    }
                    else if (TryExtractToolError(result?.ToString(), out var errorText))
                    {
                        // Surface tool errors to the bot reply rather than silently continuing with
                        // a no-op result. The model can otherwise loop or end with "No text was streamed".
                        throw new InvalidOperationException($"Error calling tool '{toolName}': {errorText}");
                    }
                }
            }
        }
        else if (call.TryGetProperty("action", out var singleAction))
        {
            var actionType = singleAction.GetProperty("type").GetString()!;
            if (onStatus != null) await onStatus($"Performing: {actionType}...");

            if (actionType != "screenshot")
            {
                var (toolName, args) = MapActionToMcpTool(actionType, singleAction, sessionId);
                var (result, sessionLost) = await InvokeToolCheckSessionAsync(tools, toolName, args, ct);
                if (sessionLost)
                {
                    if (onStatus != null) await onStatus("Session lost — recovering...");
                    await RecoverSessionAsync(session, tools, _logger, ct);
                    // Re-invoke with the same args; ATG re-acquires the session transparently
                    // on this retry via the hostname-discovery handler.
                    await InvokeToolThrowOnErrorAsync(tools, toolName, args, ct);
                }
                else if (TryExtractToolError(result?.ToString(), out var errorText))
                {
                    throw new InvalidOperationException($"Error calling tool '{toolName}': {errorText}");
                }
            }
        }

        // Always capture screenshot after action
        var screenshot = await CaptureScreenshotAsync(tools, sessionId, ct);

        var stepName = $"{++session.ScreenshotCounter:D3}_step";
        SaveScreenshotToDisk(screenshot!, stepName, session.ScreenshotSubfolder);
        var folderUrl = await UploadScreenshotToOneDriveAsync(screenshot!, $"{stepName}.png", graphAccessToken, session.ScreenshotSubfolder, session, ct);
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
    /// Map OpenAI computer_call action types to W365 V2 MCP tool names and arguments.
    /// V2 tool names/schemas come from the in-VM MCP server (as returned by its tools/list).
    /// No sessionId arg is passed — V2 session routing is handled transparently by ATG's
    /// hostname-discovery handler via the x-ms-computerId header.
    /// </summary>
    private static (string ToolName, Dictionary<string, object?> Args) MapActionToMcpTool(string actionType, JsonElement action, string? sessionId)
    {
        // CUA model emits button names in lowercase ("left"/"right"); V2 click accepts PascalCase enum values.
        static string NormalizeButton(string? button) => string.IsNullOrEmpty(button)
            ? "Left"
            : char.ToUpperInvariant(button[0]) + button.Substring(1).ToLowerInvariant();

        return actionType.ToLowerInvariant() switch
        {
            "click" => ("click", new Dictionary<string, object?>
            {
                ["x"] = action.GetProperty("x").GetInt32(),
                ["y"] = action.GetProperty("y").GetInt32(),
                ["button"] = NormalizeButton(action.TryGetProperty("button", out var b) ? b.GetString() : null),
                ["clickCount"] = 1
            }),
            "double_click" => ("click", new Dictionary<string, object?>
            {
                ["x"] = action.GetProperty("x").GetInt32(),
                ["y"] = action.GetProperty("y").GetInt32(),
                ["button"] = "Left",
                ["clickCount"] = 2
            }),
            "type" => ("type_text", new Dictionary<string, object?>
            {
                ["text"] = action.GetProperty("text").GetString()
            }),
            "key" or "keys" or "keypress" => ("press_keys", new Dictionary<string, object?>
            {
                // Lowercase the key names — W365's press_keys tool rejects uppercase variants
                // like "CTRL"/"ESC" that the model sometimes emits.
                ["keys"] = ExtractKeys(action).Select(k => k.ToLowerInvariant()).ToArray()
            }),
            "scroll" => ("scroll", new Dictionary<string, object?>
            {
                ["x"] = action.GetProperty("x").GetInt32(),
                ["y"] = action.GetProperty("y").GetInt32(),
                ["deltaX"] = action.TryGetProperty("scroll_x", out var sx) ? sx.GetInt32() : 0,
                ["deltaY"] = action.TryGetProperty("scroll_y", out var sy) ? sy.GetInt32() : 0
            }),
            "move" => ("move_mouse", new Dictionary<string, object?>
            {
                ["x"] = action.GetProperty("x").GetInt32(),
                ["y"] = action.GetProperty("y").GetInt32()
            }),
            "drag" => ("drag_mouse", new Dictionary<string, object?>
            {
                ["startX"] = action.GetProperty("path")[0].GetProperty("x").GetInt32(),
                ["startY"] = action.GetProperty("path")[0].GetProperty("y").GetInt32(),
                ["endX"] = action.GetProperty("path")[action.GetProperty("path").GetArrayLength() - 1].GetProperty("x").GetInt32(),
                ["endY"] = action.GetProperty("path")[action.GetProperty("path").GetArrayLength() - 1].GetProperty("y").GetInt32(),
                ["button"] = "Left"
            }),
            "wait" => ("wait_milliseconds", new Dictionary<string, object?>
            {
                ["ms"] = action.TryGetProperty("ms", out var ms) ? ms.GetInt32() : 500
            }),
            "open_url" => ("browser_navigate", new Dictionary<string, object?>
            {
                ["url"] = action.GetProperty("url").GetString()
            }),
            _ => throw new NotSupportedException($"Unsupported action: {actionType}")
        };
    }

    private async Task<string> CaptureScreenshotAsync(IList<AITool> tools, string? sessionId, CancellationToken ct)
    {
        // take_screenshot takes optional crop args; empty dictionary = full screen.
        // No sessionId — session routing is handled by ATG's hostname-discovery handler.
        var screenshotArgs = new Dictionary<string, object?>();


        // Fallback: AIFunction wrapper (may lose image content)
        var aiResult = await InvokeToolAsync(tools, "take_screenshot", screenshotArgs, ct);
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
                    if (block.TryGetProperty("data", out var blockData))
                    {
                        var data = blockData.GetString();
                        if (!string.IsNullOrEmpty(data)) return data;
                    }
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
    /// Invokes a tool and throws <see cref="InvalidOperationException"/> if the MCP result reports
    /// <c>isError: true</c>. The exception message format is <c>"Error calling tool '{name}': {detail}"</c>
    /// so the CUA loop can bubble a readable reason up to the bot reply instead of silently proceeding
    /// with a bad state.
    /// </summary>
    internal static async Task<object?> InvokeToolThrowOnErrorAsync(
        IList<AITool> tools, string name, Dictionary<string, object?> args, CancellationToken ct)
    {
        var result = await InvokeToolAsync(tools, name, args, ct);
        if (TryExtractToolError(result?.ToString(), out var errorText))
        {
            throw new InvalidOperationException($"Error calling tool '{name}': {errorText}");
        }

        return result;
    }

    /// <summary>
    /// Parses an MCP <c>CallToolResult</c>-shaped JSON payload and extracts the error text when
    /// <c>isError</c> is <c>true</c>. Returns <c>true</c> if an error was found, <c>false</c> otherwise.
    /// </summary>
    private static bool TryExtractToolError(string? response, out string message)
    {
        message = string.Empty;
        if (string.IsNullOrEmpty(response)) return false;
        try
        {
            using var doc = JsonDocument.Parse(response);
            if (!doc.RootElement.TryGetProperty("isError", out var isErr) || isErr.ValueKind != JsonValueKind.True)
            {
                return false;
            }

            if (doc.RootElement.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
            {
                foreach (var block in content.EnumerateArray())
                {
                    if (block.TryGetProperty("text", out var text))
                    {
                        message = text.GetString() ?? "(unknown error)";
                        return true;
                    }
                }
            }

            message = "(unknown error)";
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
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
    /// Recover from a lost session: release the stale session (best-effort) and reset the
    /// session-state flags so the next MCP tool call triggers a fresh checkout via ATG's
    /// hostname-discovery handler. There is no explicit "start" step in V2 — the session
    /// is acquired transparently when the orchestrator's next computer_call goes through.
    /// </summary>
    private async Task RecoverSessionAsync(
        ConversationSession session, IList<AITool> tools, ILogger logger, CancellationToken ct)
    {
        logger.LogWarning("Session lost. Recovering — releasing stale session; ATG will re-acquire on next MCP call.");

        try
        {
            await EndSessionAsync(tools, logger, session.W365SessionId, ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is HttpRequestException || ex is InvalidOperationException || ex is TaskCanceledException)
        {
            logger.LogWarning(ex, "Best-effort EndSession during recovery failed");
        }

        session.W365SessionId = null;
        session.SessionStarted = false;
        session.ScreenshotSubfolder = null;
        logger.LogInformation("Session state cleared; awaiting transparent re-acquisition.");
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

        _logger.LogInformation("Function call {Name} invoked. call_id={CallId}, args={Args}",
            name, callId, Truncate(argsStr, 1000));

        try
        {
            var args = JsonSerializer.Deserialize<Dictionary<string, object?>>(argsStr) ?? [];
            var result = await InvokeToolAsync(tools, name, args, ct);
            var resultStr = result?.ToString() ?? "success";
            _logger.LogInformation("Function call {Name} returned ({Length} chars): {Result}",
                name, resultStr.Length, Truncate(resultStr, 2000));
            return CreateFunctionOutput(callId, resultStr);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is JsonException || ex is InvalidOperationException || ex is ArgumentException)
        {
            _logger.LogError(ex, "Function call {Name} threw. call_id={CallId}", name, callId);
            return CreateFunctionOutput(callId, $"Error: {ex.Message}");
        }
    }

    private static JsonElement ToJsonElement(object obj) =>
        JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(obj));

    private static string Truncate(string v, int max) => v.Length <= max ? v : v[..max] + "...";

    /// <summary>
    /// Convert a user-supplied string into a filesystem-safe slug for a folder name.
    /// Letters and digits are kept; everything else collapses into single underscores.
    /// Trailing underscores are trimmed, the result is lower-cased, and trimmed to
    /// <paramref name="maxLen"/> characters. Empty/whitespace inputs yield "untitled".
    /// </summary>
    private static string SanitizeForPath(string? input, int maxLen)
    {
        if (string.IsNullOrWhiteSpace(input)) return "untitled";
        var sb = new System.Text.StringBuilder(maxLen);
        foreach (var c in input)
        {
            if (sb.Length >= maxLen) break;
            if (char.IsLetterOrDigit(c)) sb.Append(char.ToLowerInvariant(c));
            else if (sb.Length > 0 && sb[sb.Length - 1] != '_') sb.Append('_');
        }
        while (sb.Length > 0 && sb[sb.Length - 1] == '_') sb.Length--;
        return sb.Length == 0 ? "untitled" : sb.ToString();
    }

    private void SaveScreenshotToDisk(string base64Data, string name, string? subfolder = null)
    {
        if (string.IsNullOrEmpty(base64Data) || string.IsNullOrEmpty(_screenshotPath)) return;
        try
        {
            // Match the OneDrive folder layout — per-session subfolder under ./Screenshots so
            // counters from concurrent or sequential conversations don't clobber each other.
            var dir = string.IsNullOrEmpty(subfolder)
                ? _screenshotPath
                : Path.Combine(_screenshotPath, subfolder);
            Directory.CreateDirectory(dir);
            var path = Path.Combine(dir, $"{name}.png");
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
    private async Task<string?> UploadScreenshotToOneDriveAsync(string base64Data, string fileName, string? graphAccessToken, string? subfolder, ConversationSession session, CancellationToken cancellationToken)
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
            // Use /me/drive for token owner, or /users/{id}/drive for a specific user.
            // Encode the user identifier — UPNs contain '@' and may contain '#' which both need escaping.
            var driveBase = string.IsNullOrEmpty(_oneDriveUserId)
                ? "https://graph.microsoft.com/v1.0/me/drive"
                : $"https://graph.microsoft.com/v1.0/users/{Uri.EscapeDataString(_oneDriveUserId)}/drive";
            var folderPath = string.IsNullOrEmpty(subfolder)
                ? _oneDriveFolder.TrimStart('/')
                : $"{_oneDriveFolder.TrimStart('/')}/{subfolder}";
            var url = $"{driveBase}/root:/{folderPath}/{fileName}:/content";

            using var request = new HttpRequestMessage(HttpMethod.Put, url);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", graphAccessToken);
            request.Content = new ByteArrayContent(Convert.FromBase64String(base64Data));
            request.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png");

            var response = await _httpClient.SendAsync(request, cancellationToken);
            if (response.IsSuccessStatusCode)
            {
                _logger.LogInformation("Screenshot uploaded to OneDrive: {Folder}/{FileName}", folderPath, fileName);

                // On first upload, create an org-scoped sharing link for the folder
                if (!session.FolderShared)
                {
                    var shareUrl = await ShareConversationFolderAsync(folderPath, graphAccessToken, cancellationToken);
                    if (shareUrl != null)
                    {
                        session.FolderShared = true;
                        return shareUrl;
                    }
                }
            }
            else
            {
                var content = await response.Content.ReadAsStringAsync(cancellationToken);
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
    private async Task<string?> ShareConversationFolderAsync(string folderPath, string graphAccessToken, CancellationToken cancellationToken)
    {
        try
        {
            var driveBase = string.IsNullOrEmpty(_oneDriveUserId)
                ? "https://graph.microsoft.com/v1.0/me/drive"
                : $"https://graph.microsoft.com/v1.0/users/{Uri.EscapeDataString(_oneDriveUserId)}/drive";

            using var getRequest = new HttpRequestMessage(HttpMethod.Get, $"{driveBase}/root:/{folderPath}");
            getRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", graphAccessToken);
            var getResponse = await _httpClient.SendAsync(getRequest, cancellationToken);

            if (!getResponse.IsSuccessStatusCode)
            {
                _logger.LogWarning("Failed to get folder item for sharing: {Status}", getResponse.StatusCode);
                return null;
            }

            var folderJson = await getResponse.Content.ReadAsStringAsync(cancellationToken);
            using var doc = JsonDocument.Parse(folderJson);
            var folderId = doc.RootElement.GetProperty("id").GetString();
            var webUrl = doc.RootElement.TryGetProperty("webUrl", out var wu) ? wu.GetString() : null;

            using var linkRequest = new HttpRequestMessage(HttpMethod.Post, $"{driveBase}/items/{folderId}/createLink");
            linkRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", graphAccessToken);
            linkRequest.Content = new StringContent(
                JsonSerializer.Serialize(new { type = "view", scope = "organization" }),
                System.Text.Encoding.UTF8, "application/json");

            var linkResponse = await _httpClient.SendAsync(linkRequest, cancellationToken);
            if (linkResponse.IsSuccessStatusCode)
            {
                var linkJson = await linkResponse.Content.ReadAsStringAsync(cancellationToken);
                using var linkDoc = JsonDocument.Parse(linkJson);
                var shareUrl = linkDoc.RootElement.GetProperty("link").GetProperty("webUrl").GetString();
                _logger.LogInformation("Folder shared with org: {Url}", shareUrl);
                return shareUrl;
            }
            else
            {
                var errorContent = await linkResponse.Content.ReadAsStringAsync(cancellationToken);
                _logger.LogWarning("Failed to create sharing link: {Status} {Content}", linkResponse.StatusCode, errorContent);
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
        public int ScreenshotCounter { get; set; }
        public string? ScreenshotSubfolder { get; set; }
        public bool FolderShared { get; set; }
    }
}
