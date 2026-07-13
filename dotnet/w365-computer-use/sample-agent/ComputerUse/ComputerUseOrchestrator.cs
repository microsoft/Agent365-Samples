// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Core.Models;
using Microsoft.Extensions.AI;
using ModelContextProtocol.Client;
using W365ComputerUseSample.ComputerUse.Models;
using W365ComputerUseSample.Telemetry;

namespace W365ComputerUseSample.ComputerUse;

/// <summary>
/// Thin protocol adapter between OpenAI's computer-use-preview model and W365 MCP tools.
/// The model emits computer_call actions; this class translates them to MCP tool calls
/// and feeds back screenshots. Supports multiple concurrent sessions keyed by conversation ID.
/// </summary>
public class ComputerUseOrchestrator
{
    /// <summary>
    /// Names of the remote CUA tools exposed by the W365 MCP server, plus ATG's local EndSession
    /// mcptool. Update when W365 adds/renames tools.
    /// </summary>
    internal const string W365StartSessionToolName = "mcp_W365ComputerUse_StartSession";
    internal const string W365GetSessionDetailsToolName = "mcp_W365ComputerUse_GetSessionDetails";
    internal const string W365EndSessionToolName = "mcp_W365ComputerUse_EndSession";
    private static readonly Regex SessionIdRegex = new(
        @"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b",
        RegexOptions.Compiled);

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
        W365StartSessionToolName, W365GetSessionDetailsToolName, W365EndSessionToolName,
    };

    /// <summary>Returns true when <paramref name="toolName"/> identifies a W365 CUA tool.</summary>
    internal static bool IsW365CuaTool(string? toolName)
        => !string.IsNullOrEmpty(toolName) && W365CuaToolNames.Contains(toolName);

    /// <summary>Lifecycle wrappers, never exposed to the model as function tools.</summary>
    private static readonly HashSet<string> W365LifecycleToolNames = new(StringComparer.OrdinalIgnoreCase)
    {
        W365StartSessionToolName, W365GetSessionDetailsToolName, W365EndSessionToolName,
    };

    /// <summary>
    /// W365 tools that duplicate the native CUA actions; excluded from model exposure.
    /// Only actions the native <c>computer</c> tool can actually emit belong here. Query-only tools
    /// such as <c>get_cursor_position</c>/<c>get_screen_size</c> have no native equivalent, so they
    /// are intentionally NOT excluded — excluding them would remove the capability entirely.
    /// </summary>
    private static readonly HashSet<string> W365NativeDuplicateToolNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "click", "type_text", "press_keys", "scroll", "move_mouse", "drag_mouse",
    };

    /// <summary>Returns true when <paramref name="toolName"/> must not be exposed to the model as a function tool.</summary>
    internal static bool IsExcludedFromModelExposure(string? toolName)
        => !string.IsNullOrEmpty(toolName)
           && (W365LifecycleToolNames.Contains(toolName)
               || W365NativeDuplicateToolNames.Contains(toolName));

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

    /// <summary>Base system instructions sent to the model.</summary>
    private readonly string _systemInstructions;

    /// <summary><see cref="SystemInstructions"/> plus <see cref="ToolSteeringAddendum"/>, used only when W365 tools are exposed.</summary>
    private readonly string _systemInstructionsWithToolSteering;

    /// <summary>
    /// Per-conversation session state. Each conversation (user chat) gets its own
    /// W365 session, conversation history, and screenshot counter.
    /// </summary>
    private readonly ConcurrentDictionary<string, ConversationSession> _sessions = new();

    private readonly ConcurrentDictionary<string, IMcpClient> _w365McpClientsBySessionId = new(StringComparer.OrdinalIgnoreCase);

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

    /// <summary>
    /// Tool list from non-W365 MCP servers (mail, calendar, etc.). Cached separately so that
    /// non-CUA messages can be served without loading the W365 server's lifecycle tools.
    /// </summary>
    private IList<AITool>? _cachedNonW365Tools;

    /// <summary>
    /// True when this orchestrator has already loaded lifecycle tools for the W365 MCP server in
    /// the current process. The explicit W365 lifecycle requires StartSession before remote
    /// computer-use tool calls.
    /// </summary>
    public bool HasCachedW365Tools => _cachedTools != null && _cachedTools.Any(t => IsW365CuaTool((t as AIFunction)?.Name));

    private const string SystemInstructions = """
        You are a helpful assistant that can also control a Windows desktop computer.

        ## Function tools first
        If a function tool can accomplish the user's request (email, calendar, etc.),
        prefer it over computer use — faster and more reliable. After calling a function
        tool, reply with a text message describing the result. Do NOT call OnTaskComplete
        after function-tool work.

        ## If nothing fits
        If no function tool matches AND computer use cannot accomplish the request,
        reply with a text message explaining why (e.g. "I don't have an email tool
        available here"). Do NOT call OnTaskComplete.

        ## Computer use
        Use computer actions only when no function tool applies. The agent has already
        acquired a W365 session and attached the sessionId — just issue actions and
        verify with screenshots. Dismiss browser setup or sign-in dialogs (Escape, X,
        or Skip) without asking.

        When the task is complete, call OnTaskComplete and pass the full user-visible
        answer (extracted data, summary, table, etc.) in the `finalAnswer` argument.
        Do NOT continue computer actions after the task is done.

        ## Progress narration
        At meaningful checkpoints (starting a new phase, before a major click,
        recovering from an unexpected state), call `narrate(reason)` with one
        present-tense sentence. Narrate is a live banner only — it does NOT replace
        the final answer.

        ## EndSession (release the Cloud PC)
        Call EndSession ONLY when the user explicitly asks to release, disconnect from,
        or end their Cloud PC / VM itself ("end my session", "release the VM",
        "disconnect from the cloud pc"). Closing applications, windows, or browser
        tabs INSIDE the VM is a normal computer-use task — perform it with
        clicks/keystrokes, then call OnTaskComplete.

        ## Capability queries
        If the user asks what desktop capabilities are available, call
        ListAvailableW365Tools and summarize the returned names and descriptions.
        """;

    private const string ToolSteeringAddendum = """

        ## Direct high-level tools
        In addition to the generic `computer` control tool, you now have direct function tools for
        browser tabs (browser_new_tab, browser_list_tabs, browser_switch_tab, browser_navigate, …),
        code execution (execute_python_code, execute_shell_command), clipboard, accessibility
        (get_accessibility_tree, find_ui_element), and window management (list_windows,
        activate_window, …). These supersede the earlier note that you lack shell/Python/file access.
        Prefer these named tools over manual clicking, typing, or key-pressing whenever one fits the
        goal — they are faster and more reliable. Fall back to `computer` actions only for visual or
        pixel-level tasks that no named tool can accomplish.
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

        // The steering addendum is only included when W365 tools are actually exposed to the model.
        _systemInstructions = SystemInstructions;
        _systemInstructionsWithToolSteering = SystemInstructions + Environment.NewLine + ToolSteeringAddendum;
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
                Description = "Call this function when the given task has been completed successfully. If no separate final message was emitted, include the user-visible answer in finalAnswer.",
                Parameters = new
                {
                    type = "object",
                    properties = new
                    {
                        finalAnswer = new
                        {
                            type = "string",
                            description = "Optional user-visible final answer to return if the model did not emit a separate message before completing."
                        }
                    },
                    required = Array.Empty<string>(),
                    additionalProperties = false
                }
            },
            new FunctionToolDefinition
            {
                Name = "EndSession",
                Description = "Release the Cloud PC / VM back to the pool and terminate the remote desktop session. Use ONLY when the user explicitly asks to end, quit, disconnect from, or release their Cloud PC / remote session itself (e.g. 'end my session', 'release the VM', 'disconnect from the cloud pc'). Do NOT call this when the user asks to close applications, windows, tabs, or files running inside the VM — those are normal computer-use actions that leave the VM running.",
                Parameters = new
                {
                    type = "object",
                    properties = new
                    {
                        sessionId = new
                        {
                            type = "string",
                            description = "Optional W365 sessionId to end. Omit to end the currently selected session."
                        }
                    },
                    required = Array.Empty<string>(),
                    additionalProperties = false
                }
            },
            new FunctionToolDefinition
            {
                Name = "GetSessionDetails",
                Description = "Return details for the current W365 Computer Use session, such as the sessionId and screen share URL. Use when the user asks for session details.",
                Parameters = new
                {
                    type = "object",
                    properties = new
                    {
                        sessionId = new
                        {
                            type = "string",
                            description = "Optional W365 sessionId to inspect. Omit to inspect the currently selected session."
                        }
                    },
                    required = Array.Empty<string>(),
                    additionalProperties = false
                }
            },
            new FunctionToolDefinition
            {
                Name = "ListAvailableW365Tools",
                Description = "List the W365 Computer Use tools currently loaded for this session. Use when the user asks what CUA or W365 tools are available.",
                Parameters = new
                {
                    type = "object",
                    properties = new { },
                    required = Array.Empty<string>(),
                    additionalProperties = false
                }
            },
            new FunctionToolDefinition
            {
                Name = "narrate",
                Description = "Send a short natural-language progress update to the user (one sentence, present tense) at meaningful checkpoints. Use sparingly — roughly every 5-10 actions or at phase transitions. The update appears as a live banner only (no persistent chat content). Do not use as a substitute for the final answer message before OnTaskComplete.",
                Parameters = new
                {
                    type = "object",
                    properties = new
                    {
                        reason = new
                        {
                            type = "string",
                            description = "One-sentence status, present tense (e.g. 'Opening the first trial to extract details')."
                        }
                    },
                    required = new[] { "reason" },
                    additionalProperties = false
                }
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
            Windows desktop / Cloud PC. Answer with a single word: YES or NO.

            Answer YES for any of:
              - clicking, typing, scrolling, dragging, taking screenshots
              - opening or closing programs, files, browser tabs, or windows
              - navigating to a URL, browsing a webpage, filling a web form, downloading a file
              - reading or extracting content from a webpage, document, or app on the desktop
                (e.g. "tell me what's on this page", "what does the screen show", "list the
                results on clinicaltrials.gov", "read the Word doc that's open")
              - any action phrased as "go to <url>", "open <url>", "navigate to <url>",
                "load <url>", or any direct URL the user expects to be visited
              - ending, quitting, disconnecting, or releasing the Cloud PC / VM / remote session

            Answer NO only for:
              - greetings, chit-chat, thanks, "how are you"
              - questions answerable from general knowledge with no reference to the desktop
                or any web URL
              - requests that an available function tool (mail, calendar, Teams) can fulfill
                without touching the desktop

            When uncertain, answer YES.
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

            var firstMessage = response.Output
                .Where(item => item.TryGetProperty("type", out var tProp) && tProp.GetString() == "message")
                .Select(item => ExtractText(item).Trim())
                .FirstOrDefault();

            if (firstMessage != null)
            {
                _logger.LogInformation("CUA intent classifier reply for message {Preview}: {Reply}", Truncate(userMessage, 80), Truncate(firstMessage, 60));
                // Match on the first non-empty token. The router is instructed to emit a single
                // word but may prepend/append fluff; trim to the leading YES/NO.
                var upper = firstMessage.ToUpperInvariant();
                if (upper.StartsWith("NO")) return false;
                // YES or unexpected shape — default to CUA so we don't silently drop a legitimate request.
                return true;
            }

            return true;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex) when (ex is JsonException || ex is HttpRequestException || ex is InvalidOperationException)
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
        IMcpClient? mcpClient = null,
        string? graphAccessToken = null,
        Func<string, Task>? onStatusUpdate = null,
        Func<bool, Task>? onCuaStarting = null,
        Func<string, Task>? onFolderLinkReady = null,
        bool includeCuaTool = true,
        string? prestartedW365SessionId = null,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("Processing message for conversation {ConversationId}: {Message}", conversationId, Truncate(userMessage, 100));

        var session = _sessions.GetOrAdd(conversationId, _ =>
        {
            var safeId = new string(conversationId.Where(c => char.IsLetterOrDigit(c)).ToArray());
            safeId = safeId.Length > 8 ? safeId[..8] : safeId;
            return new ConversationSession
            {
                ScreenshotSubfolder = $"{DateTime.UtcNow:yyyyMMdd}_{safeId}"
            };
        });
        session.ConversationId = conversationId;
        session.ChannelId = "msteams";

        // Serialize turns for the same conversation. Concurrent turns (e.g. Bot Framework
        // redelivering an activity during a slow CUA turn) could each append an input_image to
        // the shared ConversationHistory, producing the Azure OpenAI 400 "Computer tool cannot
        // use multiple image inputs."
        await session.TurnLock.WaitAsync(cancellationToken);
        try
        {
            return await RunTurnAsync(
                session,
                conversationId,
                userMessage,
                w365Tools,
                additionalTools,
                mcpClient,
                graphAccessToken,
                onStatusUpdate,
                onCuaStarting,
                onFolderLinkReady,
                includeCuaTool,
                prestartedW365SessionId,
                cancellationToken);
        }
        finally
        {
            session.TurnLock.Release();
        }
    }

    private async Task<string> RunTurnAsync(
        ConversationSession session,
        string conversationId,
        string userMessage,
        IList<AITool> w365Tools,
        IList<AITool>? additionalTools,
        IMcpClient? mcpClient,
        string? graphAccessToken,
        Func<string, Task>? onStatusUpdate,
        Func<bool, Task>? onCuaStarting,
        Func<string, Task>? onFolderLinkReady,
        bool includeCuaTool,
        string? prestartedW365SessionId,
        CancellationToken cancellationToken)
    {
        if (session.SessionStarted)
        {
            _logger.LogInformation("Reusing session for conversation {ConversationId}, W365SessionId={SessionId}", conversationId, session.W365SessionId);
        }

        if (includeCuaTool && !string.IsNullOrWhiteSpace(prestartedW365SessionId) && string.IsNullOrEmpty(session.W365SessionId))
        {
            session.TrackAndSelectSession(prestartedW365SessionId);
            _logger.LogInformation("Using prestarted W365 session {SessionId} for conversation {ConversationId}", prestartedW365SessionId, conversationId);
        }

        if (includeCuaTool && TryExtractSessionId(userMessage, out var requestedSessionId))
        {
            session.TrackAndSelectSession(requestedSessionId);
            _logger.LogInformation("Selected W365 session {SessionId} from user message for conversation {ConversationId}", requestedSessionId, conversationId);
        }

        // For "computer" tool type (gpt-5.4+), include a screenshot with the FIRST user message if session already active
        if (_toolType == "computer" && session.ConversationHistory.Count == 0 && session.SessionStarted)
        {
            var initialScreenshot = await CaptureScreenshotWithRecoveryAsync(w365Tools, session, additionalTools, mcpClient, onStatusUpdate, cancellationToken);
            var convIdPrefix = conversationId.Length > 8 ? conversationId[..8] : conversationId;
            var initialName = $"{convIdPrefix}_{++session.ScreenshotCounter:D3}_initial";
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

        // Expose W365 tools to the model as callable function tools (all except the excluded ones).
        // Gated behind includeCuaTool so the non-CUA fast path is unaffected. exposedW365Names tracks
        // what was exposed so the function_call handler routes those calls through the W365 path.
        var exposedW365Names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (includeCuaTool && w365Tools is { Count: > 0 })
        {
            foreach (var tool in w365Tools.OfType<AIFunction>())
            {
                if (IsExcludedFromModelExposure(tool.Name))
                {
                    continue;
                }

                modelTools.Add(new FunctionToolDefinition
                {
                    Name = tool.Name,
                    Description = tool.Description ?? string.Empty,
                    Parameters = tool.JsonSchema
                });
                exposedW365Names.Add(tool.Name);
            }

            _logger.LogInformation("Exposed {Count} W365 function tools to the model: {Names}",
                exposedW365Names.Count, Truncate(string.Join(", ", exposedW365Names), 500));
        }

        var cuaAcknowledged = false;
        // Tracks the latest user-facing answer text emitted by the model. Captured (not returned)
        // on every `message` item so that an OnTaskComplete in the same turn — emitted in either
        // order, [message, function_call] or [function_call, message] — still returns the answer
        // instead of the canned "Task completed successfully." string.
        string? finalAnswerText = null;
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
                var cuaOnlyFunctionNames = new HashSet<string>(StringComparer.Ordinal)
                {
                    "OnTaskComplete", "EndSession", "GetSessionDetails", "ListAvailableW365Tools"
                };
                var cuaOnlyCalls = session.ConversationHistory.Where(item =>
                    item.TryGetProperty("type", out var typeProp)
                    && typeProp.GetString() == "function_call"
                    && item.TryGetProperty("name", out var nameProp)
                    && cuaOnlyFunctionNames.Contains(nameProp.GetString() ?? string.Empty));
                var cuaOnlyCallIds = cuaOnlyCalls
                    .Where(item => item.TryGetProperty("call_id", out _))
                    .Select(item =>
                    {
                        item.TryGetProperty("call_id", out var idProp);
                        return idProp.GetString();
                    })
                    .Where(id => !string.IsNullOrEmpty(id))
                    .ToHashSet(StringComparer.Ordinal);

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
                        // Reasoning items are produced by gpt-5.4-family models to pair with the
                        // *next* tool call. In non-CUA mode the computer_call is stripped above,
                        // so the reasoning item would dangle — strip it too.
                        if (type == "reasoning")
                        {
                            return false;
                        }
                        if (type == "function_call" || type == "function_call_output")
                        {
                            if (item.TryGetProperty("call_id", out var idProp)
                                && cuaOnlyCallIds.Contains(idProp.GetString() ?? string.Empty))
                            {
                                return false;
                            }
                        }
                        return true;
                    })
                    .ToList();
            }

            var sanitized = SanitizeConversationHistory(conversation);
            var instructions = exposedW365Names.Count > 0 ? _systemInstructionsWithToolSteering : _systemInstructions;
            var response = await CallModelAsync(sanitized, modelTools, instructions, cancellationToken);
            if (response?.Output == null || response.Output.Count == 0)
                break;

            var hasActions = false;

            foreach (var item in response.Output)
            {
                var type = item.GetProperty("type").GetString();

                // gpt-5.4-family reasoning models (gpt-5.4, gpt-5.4-pro) pair every computer_call /
                // function_call with a preceding reasoning item; the Responses API rejects subsequent
                // turns that include the tool call but not its reasoning ("Item 'cu_…' of type
                // 'computer_call' was provided without its required 'reasoning' item: 'rs_…'.").
                // Persist reasoning items so they accompany their tool call on the next turn.
                // Lighter variants (gpt-5.4-mini, computer-use-preview) don't emit standalone
                // reasoning items, so this branch is a no-op for them.
                if (type == "reasoning")
                {
                    session.ConversationHistory.Add(item);
                    continue;
                }

                session.ConversationHistory.Add(item);

                switch (type)
                {
                    case "message":
                        // Capture but do NOT return: a same-turn function_call(OnTaskComplete)
                        // emitted after this message would otherwise be skipped, losing the
                        // history ack. Loop continues; the captured text is returned later
                        // either by OnTaskComplete or by the post-foreach fallback below.
                        finalAnswerText = ExtractText(item);
                        break;

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
                                if (onStatusUpdate != null)
                                {
                                    await onStatusUpdate("Starting W365 computing session...");
                                }
                                await StartW365SessionAsync(session, w365Tools, additionalTools, mcpClient, cancellationToken);
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
                            session.ConversationHistory.Add(await HandleComputerCallAsync(item, w365Tools, additionalTools, mcpClient, session, graphAccessToken, onStatusUpdate, onFolderLinkReady, cancellationToken));
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
                        if (funcName == "narrate")
                        {
                            // Forward the model-supplied reason to the live informative-update banner.
                            // narrate is non-terminal: ack the call so history stays valid and let the
                            // loop continue to the next iteration (or to the paired computer_call in
                            // the same turn).
                            string reason = "";
                            if (item.TryGetProperty("arguments", out var argsProp))
                            {
                                var argsStr = argsProp.GetString();
                                if (!string.IsNullOrEmpty(argsStr))
                                {
                                    try
                                    {
                                        using var argsDoc = JsonDocument.Parse(argsStr);
                                        if (argsDoc.RootElement.TryGetProperty("reason", out var reasonProp))
                                            reason = reasonProp.GetString() ?? "";
                                    }
                                    catch (JsonException) { /* malformed args — drop this narration */ }
                                }
                            }

                            if (!string.IsNullOrEmpty(reason))
                            {
                                _logger.LogInformation("Model narration: {Reason}", reason);
                                if (onStatusUpdate != null)
                                {
                                    await onStatusUpdate(reason);
                                }
                            }

                            session.ConversationHistory.Add(CreateFunctionOutput(item.GetProperty("call_id").GetString()!));
                            break;
                        }
                        if (funcName == "OnTaskComplete")
                        {
                            session.ConversationHistory.Add(CreateFunctionOutput(item.GetProperty("call_id").GetString()!));
                            return finalAnswerText
                                ?? ExtractFinalAnswerFromFunctionCall(item)
                                ?? $"Task complete, but the model did not include a final answer. Screenshots saved to ./Screenshots/{session.ScreenshotSubfolder}.";
                        }
                        if (funcName == "EndSession")
                        {
                            var callId = item.GetProperty("call_id").GetString()!;
                            session.ConversationHistory.Add(CreateFunctionOutput(callId));
                            _logger.LogInformation("EndSession requested by model for conversation {ConversationId}", conversationId);
                            if (onStatusUpdate != null)
                            {
                                await onStatusUpdate("Ending session...");
                            }

                            var sessionIdToEnd = ExtractSessionIdFromFunctionCall(item) ?? session.W365SessionId;
                            await EndSessionAsync(
                                w365Tools,
                                _logger,
                                sessionIdToEnd,
                                cancellationToken,
                                conversationId: session.ConversationId,
                                channelId: session.ChannelId,
                                toolCallId: callId);
                            await DisposeW365McpClientAsync(sessionIdToEnd);
                            session.RemoveSession(sessionIdToEnd);
                            if (session.W365SessionIds.Count == 0)
                            {
                                _sessions.TryRemove(conversationId, out _);
                            }

                            return string.IsNullOrEmpty(sessionIdToEnd)
                                ? "Session ended. The VM has been released back to the pool."
                                : $"Session {sessionIdToEnd} ended. The VM has been released back to the pool.";
                        }
                        if (funcName == "GetSessionDetails")
                        {
                            var callId = item.GetProperty("call_id").GetString()!;
                            var args = new Dictionary<string, object?>();
                            var sessionIdToInspect = ExtractSessionIdFromFunctionCall(item) ?? session.W365SessionId;
                            if (!string.IsNullOrEmpty(sessionIdToInspect))
                            {
                                args["sessionId"] = sessionIdToInspect;
                            }

                            var (detailsResult, detailsSessionLost) = await InvokeW365ToolCheckSessionAsync(
                                w365Tools,
                                mcpClient,
                                W365GetSessionDetailsToolName,
                                args,
                                session,
                                cancellationToken,
                                toolCallId: callId);
                            if (detailsSessionLost)
                            {
                                if (onStatusUpdate != null)
                                {
                                    await onStatusUpdate("Session expired — starting a new W365 session...");
                                }

                                detailsResult = await RecoverAndRetryToolAsync(
                                    session,
                                    w365Tools,
                                    additionalTools,
                                    mcpClient,
                                    W365GetSessionDetailsToolName,
                                    args,
                                    cancellationToken,
                                    toolCallId: callId);
                            }

                            session.ConversationHistory.Add(CreateFunctionOutput(
                                callId,
                                string.IsNullOrEmpty(detailsResult) ? "success" : detailsResult));
                            break;
                        }
                        if (funcName == "ListAvailableW365Tools")
                        {
                            var toolSummaries = w365Tools
                                .OfType<AIFunction>()
                                .Select(tool => new
                                {
                                    name = tool.Name,
                                    description = tool.Description ?? string.Empty
                                })
                                .OrderBy(tool => tool.name, StringComparer.OrdinalIgnoreCase)
                                .ToArray();
                            var output = JsonSerializer.Serialize(new { tools = toolSummaries });
                            session.ConversationHistory.Add(CreateFunctionOutput(item.GetProperty("call_id").GetString()!, output));
                            break;
                        }

                        // Route a model function_call for an exposed W365 tool through the W365 path.
                        if (exposedW365Names.Contains(funcName ?? string.Empty))
                        {
                            var w365CallId = item.GetProperty("call_id").GetString()!;
                            var w365Result = await InvokeExposedW365ToolAsync(
                                item, funcName!, w365Tools, additionalTools, mcpClient,
                                session, onStatusUpdate, cancellationToken);
                            session.ConversationHistory.Add(CreateFunctionOutput(w365CallId, w365Result));
                            break;
                        }

                        // Invoke additional MCP function tool
                        if (additionalTools != null)
                        {
                            var callResult = await InvokeFunctionCallAsync(item, additionalTools, session, cancellationToken);
                            session.ConversationHistory.Add(callResult);
                        }

                        break;
                }
            }

            if (!hasActions) break;
        }

        // Loop exited without an explicit return: either the model produced a message-only turn
        // (no actions, no OnTaskComplete) — preserve the historical "message terminates the turn"
        // behavior by returning the captured text — or it exhausted iterations.
        return finalAnswerText
            ?? "The task could not be completed within the allowed number of steps.";
    }

    /// <summary>
    /// Start an explicit W365 session and cache the returned sessionId for this conversation.
    /// </summary>
    private async Task StartW365SessionAsync(
        ConversationSession session,
        IList<AITool> w365Tools,
        IList<AITool>? additionalTools,
        IMcpClient? mcpClient,
        CancellationToken ct,
        string? toolCallId = null)
    {
        if (!string.IsNullOrEmpty(session.W365SessionId))
        {
            session.SessionStarted = true;
            return;
        }

        var lifecycleTools = new List<AITool>(w365Tools);
        if (additionalTools != null)
        {
            lifecycleTools.AddRange(additionalTools);
        }

        string resultStr;
        var startArgs = new Dictionary<string, object?>();
        if (mcpClient != null)
        {
            resultStr = await ToolTelemetry.InvokeAsync(
                toolName: W365StartSessionToolName,
                arguments: startArgs,
                toolCallId: toolCallId,
                toolServerName: "w365",
                endpoint: null,
                conversationId: session.ConversationId,
                channelId: session.ChannelId,
                invokeAsync: async () =>
                {
                    var result = await mcpClient.CallToolAsync(W365StartSessionToolName, startArgs, cancellationToken: ct);
                    return JsonSerializer.Serialize(result);
                }).ConfigureAwait(false);
        }
        else
        {
            resultStr = await ToolTelemetry.InvokeAsync(
                toolName: W365StartSessionToolName,
                arguments: startArgs,
                toolCallId: toolCallId,
                toolServerName: "w365",
                endpoint: null,
                conversationId: session.ConversationId,
                channelId: session.ChannelId,
                invokeAsync: async () =>
                {
                    var result = await RawInvokeToolThrowOnErrorAsync(
                        lifecycleTools,
                        W365StartSessionToolName,
                        startArgs,
                        ct);
                    return result?.ToString() ?? string.Empty;
                }).ConfigureAwait(false);
        }

        if (TryExtractToolError(resultStr, out var errorText))
        {
            throw new InvalidOperationException($"Error calling tool '{W365StartSessionToolName}': {errorText}");
        }

        if (!TryExtractStringProperty(resultStr, "sessionId", out var sessionId))
        {
            throw new InvalidOperationException($"Tool '{W365StartSessionToolName}' did not return a sessionId.");
        }

        session.TrackAndSelectSession(sessionId);
        _logger.LogInformation("Started explicit W365 session {SessionId}", sessionId);
    }

    /// <summary>
    /// End the W365 session. Called by the agent on shutdown or explicit end.
    /// </summary>
    public static async Task EndSessionAsync(
        IList<AITool> tools,
        ILogger logger,
        string? sessionId,
        CancellationToken ct,
        string? conversationId = null,
        string? channelId = null,
        string? toolCallId = null)
    {
        try
        {
            var args = new Dictionary<string, object?>();
            if (!string.IsNullOrEmpty(sessionId))
            {
                args["sessionId"] = sessionId;
            }

            await ToolTelemetry.InvokeAsync(
                toolName: W365EndSessionToolName,
                arguments: args,
                toolCallId: toolCallId,
                toolServerName: "w365",
                endpoint: null,
                conversationId: conversationId,
                channelId: channelId,
                invokeAsync: async () =>
                {
                    var result = await RawInvokeToolAsync(tools, W365EndSessionToolName, args, ct);
                    return result?.ToString() ?? string.Empty;
                }).ConfigureAwait(false);
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
        catch (Exception ex) when (ex is not OperationCanceledException)
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
            foreach (var sessionId in session.W365SessionIds.ToArray())
            {
                _logger.LogInformation("Ending session for conversation {ConversationId}, W365SessionId={SessionId}", convId, sessionId);
                await EndSessionAsync(
                    _cachedTools,
                    _logger,
                    sessionId,
                    CancellationToken.None,
                    conversationId: session.ConversationId,
                    channelId: session.ChannelId);
            }
        }

        _sessions.Clear();
        _cachedTools = null;
        _w365McpClientsBySessionId.Clear();

        foreach (var client in _allMcpClients)
        {
            try { await client.DisposeAsync(); }
            catch (Exception ex) { _logger.LogWarning(ex, "Failed to dispose MCP client"); }
        }

        _allMcpClients.Clear();
        _cachedMcpClient = null;
    }

    /// <summary>
    /// Get or create MCP clients and merged tool list. Connects to each server URL once on first call,
    /// then returns the cached result on subsequent calls. The SSE connections stay alive across
    /// messages (MyAgent is transient, but this orchestrator is singleton).
    /// The primary MCP client (for W365 screenshot calls) is the one whose tools match the W365 CUA set (<see cref="W365CuaToolNames"/>).
    /// </summary>
    public async Task<(IList<AITool> Tools, IMcpClient? Client)> GetOrCreateMcpConnectionAsync(
        IList<string> mcpUrls, string accessToken)
    {
        // Only reuse the cache if it actually contains W365 CUA tools. If the previous attempt landed
        // on ATG's synthetic "Error" tool (W365 session acquisition failed upstream), a subsequent
        // message should re-hit ATG rather than silently reuse the failure. Otherwise the sample
        // agent becomes permanently wedged on a single bad connect.
        if (_cachedTools != null && _cachedTools.Any(t => IsW365CuaTool((t as AIFunction)?.Name)))
            return (_cachedTools, _cachedMcpClient);

        // Stale caches from a failed prior attempt — clear before reconnecting.
        if (_cachedTools != null)
        {
            _cachedTools = null;
            _cachedMcpClient = null;
        }

        var allTools = await LoadToolsFromUrlsAsync(mcpUrls, accessToken);

        // Only cache when we got at least one W365 CUA tool. Otherwise leave _cachedTools null so
        // the next message retries the MCP connection and gives ATG another shot at session acquisition.
        var cachingIsSafe = allTools.Any(t => IsW365CuaTool((t as AIFunction)?.Name));
        if (cachingIsSafe)
        {
            _cachedTools = allTools;
        }
        else
        {
            _logger.LogWarning("Not caching MCP tool list — no W365 CUA tools found (total {Count}). Next message will reconnect.", allTools.Count);
        }

        _logger.LogInformation("Total tools from {ServerCount} MCP server(s): {ToolCount}", mcpUrls.Count, allTools.Count);
        return (allTools, _cachedMcpClient);
    }

    /// <summary>
    /// Connects to non-W365 MCP servers (mail, calendar, etc.) and returns their merged tool
    /// list. Unlike <see cref="GetOrCreateMcpConnectionAsync"/>, this path caches unconditionally
    /// because non-W365 servers don't have the "Error-tool-after-failed-session-acquisition"
    /// problem — if mail/calendar can't load, we just proceed without those tools.
    /// </summary>
    public async Task<IList<AITool>> GetOrCreateNonW365McpConnectionAsync(
        IList<string> mcpUrls, string accessToken)
    {
        if (_cachedNonW365Tools != null)
        {
            return _cachedNonW365Tools;
        }

        if (mcpUrls.Count == 0)
        {
            _cachedNonW365Tools = [];
            return _cachedNonW365Tools;
        }

        var tools = await LoadToolsFromUrlsAsync(mcpUrls, accessToken);
        _cachedNonW365Tools = tools;
        _logger.LogInformation("Loaded {Count} non-W365 MCP tools from {ServerCount} server(s).", tools.Count, mcpUrls.Count);
        return tools;
    }

    /// <summary>
    /// Opens SSE connections to each MCP server URL and merges their tools/list responses.
    /// Side effects: adds each connected client to <see cref="_allMcpClients"/> for shutdown
    /// cleanup, and sets <see cref="_cachedMcpClient"/> to the first client whose tools match
    /// the W365 CUA set (used for direct screenshot calls in the CUA loop).
    /// </summary>
    private async Task<List<AITool>> LoadToolsFromUrlsAsync(IList<string> mcpUrls, string accessToken)
    {
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

                // Use the W365 server's client for direct screenshot calls.
                var hasW365Tools = tools.Any(t => IsW365CuaTool((t as AIFunction)?.Name));
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

        return allTools;
    }

    internal string? GetSelectedW365SessionId(string? conversationId)
    {
        return !string.IsNullOrWhiteSpace(conversationId)
            && _sessions.TryGetValue(conversationId, out var session)
            ? session.W365SessionId
            : null;
    }

    internal async Task<W365McpToolListResult> StartDirectW365SessionAndListToolsAsync(
        string url,
        string accessToken,
        string agentId,
        ITurnContext turnContext,
        string? existingSessionId,
        CancellationToken cancellationToken)
    {
        if (!string.IsNullOrWhiteSpace(existingSessionId)
            && _cachedMcpClient != null
            && _w365McpClientsBySessionId.TryGetValue(existingSessionId, out var sessionMcpClient))
        {
            try
            {
                var cachedSessionClient = new W365McpSessionClient(sessionMcpClient);
                var cachedResult = await cachedSessionClient.ListToolsAsync(existingSessionId, cancellationToken);
                _cachedTools = cachedResult.Tools;
                _cachedMcpClient = cachedResult.Client;
                _logger.LogInformation("Reused W365 MCP client for session {SessionId} and loaded {ToolCount} tools.", cachedResult.SessionId, cachedResult.Tools.Count);
                return cachedResult;
            }
            catch (Exception ex) when (IsUnauthorizedMcpTransportFailure(ex))
            {
                _logger.LogWarning(ex, "Cached W365 MCP client for session {SessionId} was unauthorized. Disposing it and reconnecting with a fresh token.", existingSessionId);
                await DisposeW365McpClientAsync(existingSessionId);
            }
        }

        var httpClient = _httpClientFactory.CreateClient();
        var transport = new SseClientTransport(
            CreateW365TransportOptions(url, accessToken, agentId, turnContext.Activity),
            httpClient);
        var mcpClient = await McpClientFactory.CreateAsync(transport, cancellationToken: cancellationToken);
        try
        {
            var directClient = new W365McpSessionClient(mcpClient);
            var result = string.IsNullOrWhiteSpace(existingSessionId)
                ? await directClient.StartSessionAndListToolsAsync(cancellationToken)
                : await directClient.ListToolsAsync(existingSessionId, cancellationToken);
            _cachedTools = result.Tools;
            _cachedMcpClient = result.Client;
            _w365McpClientsBySessionId[result.SessionId] = result.Client;
            _allMcpClients.Add(result.Client);
            _logger.LogInformation("Started direct W365 session {SessionId} and loaded {ToolCount} tools via MCP transport.", result.SessionId, result.Tools.Count);
            return result;
        }
        catch
        {
            await mcpClient.DisposeAsync();
            throw;
        }
    }

    private static void AddHeaderIfPresent(HttpClient httpClient, string name, string? value)
    {
        if (!string.IsNullOrWhiteSpace(value))
        {
            httpClient.DefaultRequestHeaders.TryAddWithoutValidation(name, value);
        }
    }

    internal static bool IsUnauthorizedMcpTransportFailureForTest(Exception exception)
    {
        return IsUnauthorizedMcpTransportFailure(exception);
    }

    private static bool IsUnauthorizedMcpTransportFailure(Exception exception)
    {
        if (exception is HttpRequestException httpRequestException
            && httpRequestException.StatusCode == System.Net.HttpStatusCode.Unauthorized)
        {
            return true;
        }

        return exception.InnerException != null && IsUnauthorizedMcpTransportFailure(exception.InnerException);
    }

    private static bool IsEmptyJsonMcpResponse(Exception exception)
    {
        for (var ex = exception; ex != null; ex = ex.InnerException)
        {
            var msg = ex.Message ?? string.Empty;
            if (msg.Contains("does not contain any JSON tokens", StringComparison.OrdinalIgnoreCase)
                || msg.Contains("Invalid JSON response from remote MCP server", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }

    internal static SseClientTransportOptions CreateW365TransportOptionsForTest(
        string url,
        string accessToken,
        string agentId,
        IActivity activity)
    {
        return CreateW365TransportOptions(url, accessToken, agentId, activity);
    }

    private static SseClientTransportOptions CreateW365TransportOptions(
        string url,
        string accessToken,
        string agentId,
        IActivity activity)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Authorization"] = $"Bearer {accessToken}",
            ["x-ms-agentid"] = agentId,
        };

        AddHeaderIfPresent(headers, "x-ms-conversation-id", activity.Conversation?.Id);
        AddHeaderIfPresent(headers, "x-ms-channel-id", activity.ChannelId);
        AddHeaderIfPresent(headers, "x-ms-user-message-id", activity.Id);

        if (!string.IsNullOrWhiteSpace(activity.From?.Name))
        {
            AddHeaderIfPresent(headers, "x-ms-user-agent", activity.From.Name);
        }

        return new SseClientTransportOptions
        {
            Endpoint = new Uri(url),
            TransportMode = HttpTransportMode.AutoDetect,
            AdditionalHeaders = headers,
        };
    }

    private static void AddHeaderIfPresent(IDictionary<string, string> headers, string name, string? value)
    {
        if (!string.IsNullOrWhiteSpace(value))
        {
            headers[name] = value;
        }
    }

    private async Task DisposeW365McpClientAsync(string? sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return;
        }

        if (!_w365McpClientsBySessionId.TryRemove(sessionId, out var client))
        {
            return;
        }

        _allMcpClients.Remove(client);
        if (ReferenceEquals(_cachedMcpClient, client))
        {
            _cachedMcpClient = _w365McpClientsBySessionId.Values.FirstOrDefault();
        }

        try
        {
            await client.DisposeAsync();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to dispose W365 MCP client for session {SessionId}", sessionId);
        }
    }

    private async Task<ComputerUseResponse?> CallModelAsync(List<JsonElement> conversation, List<object> tools, string instructions, CancellationToken ct)
    {
        var body = JsonSerializer.Serialize(new ComputerUseRequest
        {
            Model = _modelProvider.ModelName,
            Instructions = instructions,
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
        JsonElement call, IList<AITool> tools, IList<AITool>? additionalTools, IMcpClient? mcpClient, ConversationSession session, string? graphAccessToken, Func<string, Task>? onStatus, Func<string, Task>? onFolderLinkReady, CancellationToken ct)
    {
        var callId = call.GetProperty("call_id").GetString()!;
        if (string.IsNullOrEmpty(session.W365SessionId))
        {
            await StartW365SessionAsync(session, tools, additionalTools, mcpClient, ct);
        }
        // GPT-5.4 uses "actions" (non-empty array), older models use "action" (singular).
        if (call.TryGetProperty("actions", out var actionsArray)
            && actionsArray.ValueKind == JsonValueKind.Array
            && actionsArray.GetArrayLength() > 0)
        {
            foreach (var action in actionsArray.EnumerateArray())
            {
                var actionType = action.GetProperty("type").GetString()!;
                // Per-action banners ("Performing: click...") are suppressed — the live banner is
                // reserved for model-driven narrate() calls so demo footage isn't dominated by
                // mechanical tool-use updates. Session-lifecycle banners (acquire / end / recover)
                // still fire below.

                if (actionType != "screenshot")
                {
                    var (toolName, args) = MapActionToMcpTool(actionType, action, session.W365SessionId);
                    var (result, sessionLost) = await InvokeW365ToolCheckSessionAsync(
                        tools,
                        mcpClient,
                        toolName,
                        args,
                        session,
                        ct);
                    if (sessionLost)
                    {
                        if (onStatus != null) { await onStatus("Session lost — recovering..."); }
                        await RecoverAndRetryToolAsync(session, tools, additionalTools, mcpClient, toolName, args, ct);
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
            // Per-action banner suppressed — see comment in the actions-array branch above.

            if (actionType != "screenshot")
            {
                var (toolName, args) = MapActionToMcpTool(actionType, singleAction, session.W365SessionId);
                var (result, sessionLost) = await InvokeW365ToolCheckSessionAsync(
                    tools,
                    mcpClient,
                    toolName,
                    args,
                    session,
                    ct);
                if (sessionLost)
                {
                    if (onStatus != null) { await onStatus("Session lost — recovering..."); }
                    await RecoverAndRetryToolAsync(session, tools, additionalTools, mcpClient, toolName, args, ct);
                }
                else if (TryExtractToolError(result?.ToString(), out var errorText))
                {
                    throw new InvalidOperationException($"Error calling tool '{toolName}': {errorText}");
                }
            }
        }

        // Always capture screenshot after action
        var screenshot = await CaptureScreenshotWithRecoveryAsync(tools, session, additionalTools, mcpClient, onStatus, ct);

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
    /// Map OpenAI computer_call action types to W365 MCP tool names and arguments.
    /// The gateway requires the explicit sessionId returned by StartSession on every remote
    /// W365 computer-use tool call.
    /// </summary>
    private static (string ToolName, Dictionary<string, object?> Args) MapActionToMcpTool(string actionType, JsonElement action, string? sessionId)
    {
        var mapped = actionType.ToLowerInvariant() switch
        {
            "click" => ("click", new Dictionary<string, object?>
            {
                ["x"] = action.GetProperty("x").GetInt32(),
                ["y"] = action.GetProperty("y").GetInt32(),
                ["button"] = CuaActionNormalization.NormalizeMouseButton(
                    action.TryGetProperty("button", out var b) ? b.GetString() : null),
                ["clickCount"] = 1
            }),
            "double_click" => ("click", new Dictionary<string, object?>
            {
                ["x"] = action.GetProperty("x").GetInt32(),
                ["y"] = action.GetProperty("y").GetInt32(),
                ["button"] = CuaActionNormalization.NormalizeMouseButton(
                    action.TryGetProperty("button", out var dcb) ? dcb.GetString() : null),
                ["clickCount"] = 2
            }),
            "triple_click" => ("click", new Dictionary<string, object?>
            {
                ["x"] = action.GetProperty("x").GetInt32(),
                ["y"] = action.GetProperty("y").GetInt32(),
                ["button"] = CuaActionNormalization.NormalizeMouseButton(
                    action.TryGetProperty("button", out var tcb) ? tcb.GetString() : null),
                ["clickCount"] = 3
            }),
            "type" => ("type_text", new Dictionary<string, object?>
            {
                ["text"] = action.GetProperty("text").GetString()
            }),
            "key" or "keys" or "keypress" => ("press_keys", new Dictionary<string, object?>
            {
                // The OpenAI CUA model emits W3C-flavored key names (e.g. "ArrowDown",
                // "Control", "Escape"). W365's press_keys rejects those with "Unknown key
                // name" — see CuaActionNormalization for the alias map. This is exactly the
                // client-side normalization OpenAI's docs recommend:
                // https://developers.openai.com/api/docs/guides/tools-computer-use#3-run-every-returned-action
                ["keys"] = CuaActionNormalization.NormalizeKeys(ExtractKeys(action))
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
                ["button"] = CuaActionNormalization.NormalizeMouseButton(
                    action.TryGetProperty("button", out var dragB) ? dragB.GetString() : null)
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

        AddSessionId(mapped.Item2, sessionId);
        return mapped;
    }

    private async Task<string> CaptureScreenshotAsync(
        IList<AITool> tools,
        IMcpClient? mcpClient,
        ConversationSession session,
        CancellationToken ct)
    {
        var screenshotArgs = new Dictionary<string, object?>();
        AddSessionId(screenshotArgs, session.W365SessionId);

        // Use direct MCP client when available — AIFunction wrappers drop image content blocks
        if (mcpClient != null)
        {
            var rawResultJson = await ToolTelemetry.InvokeAsync(
                toolName: "take_screenshot",
                arguments: screenshotArgs,
                toolCallId: null,
                toolServerName: "w365",
                endpoint: null,
                conversationId: session.ConversationId,
                channelId: session.ChannelId,
                invokeAsync: async () =>
                {
                    var result = await mcpClient.CallToolAsync("take_screenshot", screenshotArgs, cancellationToken: ct);
                    return JsonSerializer.Serialize(result);
                }).ConfigureAwait(false);

            // Log full raw content on entry so we can diagnose new/unexpected shapes.
            var contentBlockCount = 0;
            try
            {
                using var rawResultDocument = JsonDocument.Parse(rawResultJson);
                if (TryGetProperty(rawResultDocument.RootElement, "content", out var content)
                    && content.ValueKind == JsonValueKind.Array)
                {
                    contentBlockCount = content.GetArrayLength();
                }

                _logger.LogDebug("take_screenshot returned {Count} content blocks. Raw JSON (truncated): {Raw}",
                    contentBlockCount, rawResultJson[..Math.Min(2000, rawResultJson.Length)]);
            }
            catch (Exception logEx)
            {
                _logger.LogWarning(logEx, "Failed to serialize take_screenshot response for logging.");
            }

            // Detect MCP error responses and surface the real reason (e.g. "no pool with an available
            // session was found") instead of falling through to the image-extractor and reporting the
            // misleading "no extractable image data" message.
            if (TryExtractToolError(rawResultJson, out var toolErrorText))
            {
                throw new InvalidOperationException($"Error calling tool 'take_screenshot': {toolErrorText}");
            }

            // Fallback: serialize to JSON and hunt for any base64-looking PNG payload in string fields.
            // Covers MCP "resource" blocks (blob), embedded data URLs, or other unexpected shapes.
            try
            {
                var extracted = ExtractPngBase64FromJson(rawResultJson);
                if (!string.IsNullOrEmpty(extracted))
                {
                    _logger.LogInformation("Extracted PNG base64 from take_screenshot via JSON scan ({Length} chars).", extracted.Length);
                    return extracted;
                }
            }
            catch (Exception scanEx)
            {
                _logger.LogWarning(scanEx, "JSON-scan fallback for take_screenshot threw.");
            }

            throw new InvalidOperationException($"Screenshot MCP response had {contentBlockCount} content blocks but no extractable image data. See preceding log lines for the raw shape.");
        }

        // Fallback: AIFunction wrapper (may lose image content)
        var str = await ToolTelemetry.InvokeAsync(
            toolName: "take_screenshot",
            arguments: screenshotArgs,
            toolCallId: null,
            toolServerName: "w365",
            endpoint: null,
            conversationId: session.ConversationId,
            channelId: session.ChannelId,
            invokeAsync: async () =>
            {
                var aiResult = await RawInvokeToolAsync(tools, "take_screenshot", screenshotArgs, ct);
                return aiResult?.ToString() ?? "";
            }).ConfigureAwait(false);

        _logger.LogInformation("Screenshot fallback: result type={Type}, length={Length}, preview={Preview}",
            "string", str.Length, str[..Math.Min(200, str.Length)]);

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
        catch (JsonException ex)
        {
            _logger.LogDebug(ex, "ExtractScreenshot: response was not valid JSON, will try last-resort raw base64 detection");
        }

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
        catch (JsonException)
        {
            // Not valid JSON — fall through to returning null.
        }
        return null;
    }

    /// <summary>
    /// Last-resort extractor that walks arbitrary JSON for the first string value that looks
    /// like a PNG base64 payload. Checks for the PNG magic prefix (<c>iVBORw0KGgo</c>) or a
    /// <c>data:image/png;base64,</c> data URL inside any string field. Used when <c>take_screenshot</c>
    /// returns a content block shape we don't explicitly handle (e.g. MCP resource.blob).
    /// </summary>
    private static string? ExtractPngBase64FromJson(string json)
    {
        if (string.IsNullOrEmpty(json)) return null;
        try
        {
            using var doc = JsonDocument.Parse(json);
            return Walk(doc.RootElement);
        }
        catch (JsonException) { return null; }

        static string? Walk(JsonElement el)
        {
            switch (el.ValueKind)
            {
                case JsonValueKind.Object:
                    return el.EnumerateObject()
                        .Select(prop => Walk(prop.Value))
                        .FirstOrDefault(found => !string.IsNullOrEmpty(found));
                case JsonValueKind.Array:
                    return el.EnumerateArray()
                        .Select(item => Walk(item))
                        .FirstOrDefault(found => !string.IsNullOrEmpty(found));
                case JsonValueKind.String:
                    var s = el.GetString();
                    if (string.IsNullOrEmpty(s)) break;
                    var nested = ExtractBase64FromText(s);
                    if (!string.IsNullOrEmpty(nested)) return nested;
                    // Data URL form: strip the prefix, return the base64 body.
                    var dataPrefix = "data:image/png;base64,";
                    var dataIdx = s.IndexOf(dataPrefix, StringComparison.OrdinalIgnoreCase);
                    if (dataIdx >= 0) return s.Substring(dataIdx + dataPrefix.Length);
                    // Raw PNG base64 — starts with the PNG magic encoded as "iVBORw0KGgo".
                    if (s.Length >= 16 && s.StartsWith("iVBORw0KGgo", StringComparison.Ordinal)) return s;
                    break;
            }
            return null;
        }
    }

    internal static async Task<object?> InvokeToolAsync(
        IList<AITool> tools, string name, Dictionary<string, object?> args, CancellationToken ct)
    {
        var result = await ToolTelemetry.InvokeAsync(
            toolName: name,
            arguments: args,
            toolCallId: null,
            toolServerName: "mcp",
            endpoint: null,
            conversationId: null,
            channelId: null,
            invokeAsync: async () =>
            {
                var raw = await RawInvokeToolAsync(tools, name, args, ct).ConfigureAwait(false);
                return raw?.ToString() ?? string.Empty;
            }).ConfigureAwait(false);

        return result;
    }

    private static async Task<object?> RawInvokeToolAsync(
        IList<AITool> tools, string name, Dictionary<string, object?> args, CancellationToken ct)
    {
        var tool = tools.OfType<AIFunction>().FirstOrDefault(t => t.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
            ?? throw new InvalidOperationException($"Tool '{name}' not found.");
        return await tool.InvokeAsync(new AIFunctionArguments(args), ct);
    }

    private async Task<string> InvokeW365ToolAsync(
        IList<AITool> tools,
        IMcpClient? mcpClient,
        string name,
        Dictionary<string, object?> args,
        ConversationSession session,
        CancellationToken ct,
        string? toolCallId = null)
    {
        string resultStr;
        try
        {
            if (mcpClient != null)
            {
                resultStr = await ToolTelemetry.InvokeAsync(
                    toolName: name,
                    arguments: args,
                    toolCallId: toolCallId,
                    toolServerName: "w365",
                    endpoint: null,
                    conversationId: session.ConversationId,
                    channelId: session.ChannelId,
                    invokeAsync: async () =>
                    {
                        var result = await mcpClient.CallToolAsync(name, args, cancellationToken: ct);
                        return JsonSerializer.Serialize(result);
                    }).ConfigureAwait(false);
            }
            else
            {
                resultStr = await ToolTelemetry.InvokeAsync(
                    toolName: name,
                    arguments: args,
                    toolCallId: toolCallId,
                    toolServerName: "w365",
                    endpoint: null,
                    conversationId: session.ConversationId,
                    channelId: session.ChannelId,
                    invokeAsync: async () =>
                    {
                        var raw = await RawInvokeToolAsync(tools, name, args, ct).ConfigureAwait(false);
                        return raw?.ToString() ?? string.Empty;
                    }).ConfigureAwait(false);
            }
        }
        catch (Exception ex) when (name == "wait_milliseconds" && IsEmptyJsonMcpResponse(ex))
        {
            // The W365 CUA backend occasionally returns an empty body for wait_milliseconds.
            // The wait is purely a pacing aid, so fall back to an in-process delay and report
            // success so the model keeps progressing instead of failing the whole turn.
            var ms = args.TryGetValue("ms", out var msObj) && msObj is int n ? n : 500;
            _logger.LogWarning("wait_milliseconds returned an invalid JSON response from W365; falling back to local Task.Delay({Ms}).", ms);
            await Task.Delay(Math.Clamp(ms, 0, 5000), ct);
            return "{\"isError\":false,\"content\":[{\"type\":\"text\",\"text\":\"waited locally\"}]}";
        }

        if (TryExtractToolError(resultStr, out var errorText))
        {
            throw new InvalidOperationException($"Error calling tool '{name}': {errorText}");
        }

        return resultStr;
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

    private static async Task<object?> RawInvokeToolThrowOnErrorAsync(
        IList<AITool> tools, string name, Dictionary<string, object?> args, CancellationToken ct)
    {
        var result = await RawInvokeToolAsync(tools, name, args, ct);
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
            if (!TryGetProperty(doc.RootElement, "isError", out var isErr) || isErr.ValueKind != JsonValueKind.True)
            {
                return false;
            }

            if (TryGetProperty(doc.RootElement, "content", out var content) && content.ValueKind == JsonValueKind.Array)
            {
                var textBlocks = content.EnumerateArray().Where(b => TryGetProperty(b, "text", out _));
                foreach (var block in textBlocks)
                {
                    TryGetProperty(block, "text", out var text);
                    message = text.GetString() ?? "(unknown error)";
                    return true;
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

    private static void AddSessionId(Dictionary<string, object?> args, string? sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            throw new InvalidOperationException("A W365 session has not been started. Call StartSession before using remote W365 tools.");
        }

        args["sessionId"] = sessionId;
    }

    private static bool TryExtractStringProperty(string? response, string propertyName, out string value)
    {
        value = string.Empty;
        if (string.IsNullOrWhiteSpace(response))
        {
            return false;
        }

        try
        {
            using var doc = JsonDocument.Parse(response);
            return TryExtractStringProperty(doc.RootElement, propertyName, out value);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool TryExtractStringProperty(JsonElement element, string propertyName, out string value)
    {
        value = string.Empty;
        if (element.ValueKind == JsonValueKind.Object)
        {
            if (TryGetProperty(element, propertyName, out var property)
                && property.ValueKind == JsonValueKind.String)
            {
                value = property.GetString() ?? string.Empty;
                return !string.IsNullOrEmpty(value);
            }

            if (TryGetProperty(element, "content", out var content)
                && content.ValueKind == JsonValueKind.Array)
            {
                var stringTextBlocks = content.EnumerateArray()
                    .Where(b => TryGetProperty(b, "text", out var t) && t.ValueKind == JsonValueKind.String);
                foreach (var block in stringTextBlocks)
                {
                    TryGetProperty(block, "text", out var text);
                    var nestedText = text.GetString();
                    if (TryExtractStringProperty(nestedText, propertyName, out value))
                    {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    private static bool TryGetProperty(JsonElement element, string propertyName, out JsonElement property)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var match = element.EnumerateObject()
                .FirstOrDefault(candidate => string.Equals(candidate.Name, propertyName, StringComparison.OrdinalIgnoreCase));
            if (match.Value.ValueKind != JsonValueKind.Undefined)
            {
                property = match.Value;
                return true;
            }
        }

        property = default;
        return false;
    }

    /// <summary>
    /// Invoke a tool and detect session-not-found errors. Returns (result, isSessionLost).
    /// </summary>
    private async Task<(string Result, bool IsSessionLost)> InvokeW365ToolCheckSessionAsync(
        IList<AITool> tools,
        IMcpClient? mcpClient,
        string name,
        Dictionary<string, object?> args,
        ConversationSession session,
        CancellationToken ct,
        string? toolCallId = null)
    {
        string resultStr;
        try
        {
            resultStr = await InvokeW365ToolAsync(
                tools,
                mcpClient,
                name,
                args,
                session,
                ct,
                toolCallId: toolCallId);
        }
        catch (InvalidOperationException ex) when (IsSessionNotFoundError(ex.Message))
        {
            return (ex.Message, true);
        }

        if (IsSessionNotFoundError(resultStr))
            return (resultStr, true);
        return (resultStr, false);
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
    /// session-state flags so the next computer-use action starts a fresh explicit session.
    /// </summary>
    private async Task RecoverSessionAsync(
        ConversationSession session, IList<AITool> tools, ILogger logger, CancellationToken ct)
    {
        logger.LogWarning("Session lost. Recovering — releasing stale session before starting a new one.");

        try
        {
            await EndSessionAsync(
                tools,
                logger,
                session.W365SessionId,
                ct,
                conversationId: session.ConversationId,
                channelId: session.ChannelId);
            await DisposeW365McpClientAsync(session.W365SessionId);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Best-effort EndSession during recovery failed");
        }

        session.RemoveSession(session.W365SessionId);
        logger.LogInformation("Session state cleared; the next computer-use action will start a new session.");
    }

    /// <summary>
    /// Recovers from a lost W365 session by releasing the stale session and starting a fresh one on
    /// the existing MCP client. Clears the active selection first so a leftover tracked session id
    /// can't short-circuit <see cref="StartW365SessionAsync"/>.
    /// </summary>
    private async Task RecoverAndStartFreshSessionAsync(
        ConversationSession session,
        IList<AITool> w365Tools,
        IList<AITool>? additionalTools,
        IMcpClient? mcpClient,
        CancellationToken ct)
    {
        await RecoverSessionAsync(session, w365Tools, _logger, ct);
        session.ClearActiveSession();
        await StartW365SessionAsync(session, w365Tools, additionalTools, mcpClient, ct);
    }

    /// <summary>Recovers from an in-turn session loss and retries the failed tool call against a fresh session.</summary>
    private async Task<string> RecoverAndRetryToolAsync(
        ConversationSession session,
        IList<AITool> w365Tools,
        IList<AITool>? additionalTools,
        IMcpClient? mcpClient,
        string toolName,
        Dictionary<string, object?> args,
        CancellationToken ct,
        string? toolCallId = null)
    {
        await RecoverAndStartFreshSessionAsync(session, w365Tools, additionalTools, mcpClient, ct);
        AddSessionId(args, session.W365SessionId);
        return await InvokeW365ToolAsync(
            w365Tools,
            mcpClient,
            toolName,
            args,
            session,
            ct,
            toolCallId: toolCallId);
    }

    /// <summary>
    /// Invokes an exposed W365 tool requested by the model via a function_call, returning the tool's
    /// result string for the model's function_call_output. Starts a session if needed, injects the
    /// sessionId, and recovers on a lost session. Tool errors are returned as text (not thrown) so a
    /// single bad call does not abort the turn.
    /// </summary>
    private async Task<string> InvokeExposedW365ToolAsync(
        JsonElement functionCall,
        string toolName,
        IList<AITool> w365Tools,
        IList<AITool>? additionalTools,
        IMcpClient? mcpClient,
        ConversationSession session,
        Func<string, Task>? onStatusUpdate,
        CancellationToken ct)
    {
        var callId = functionCall.GetProperty("call_id").GetString();
        var argsStr = "{}";
        if (functionCall.TryGetProperty("arguments", out var argsProp))
        {
            argsStr = argsProp.ValueKind switch
            {
                JsonValueKind.String => argsProp.GetString() ?? "{}",
                JsonValueKind.Object or JsonValueKind.Array => argsProp.GetRawText(),
                _ => "{}"
            };
        }
        Dictionary<string, object?> args;
        try
        {
            args = JsonSerializer.Deserialize<Dictionary<string, object?>>(argsStr) ?? [];
        }
        catch (JsonException)
        {
            args = [];
        }

        try
        {
            if (string.IsNullOrEmpty(session.W365SessionId))
            {
                await StartW365SessionAsync(session, w365Tools, additionalTools, mcpClient, ct);
            }

            AddSessionId(args, session.W365SessionId);

            var (result, sessionLost) = await InvokeW365ToolCheckSessionAsync(
                w365Tools,
                mcpClient,
                toolName,
                args,
                session,
                ct,
                toolCallId: callId);
            if (sessionLost)
            {
                if (onStatusUpdate != null) await onStatusUpdate("Session lost — recovering...");
                return await RecoverAndRetryToolAsync(
                    session,
                    w365Tools,
                    additionalTools,
                    mcpClient,
                    toolName,
                    args,
                    ct,
                    toolCallId: callId);
            }

            return result;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Exposed W365 tool '{Tool}' failed", toolName);
            return $"Error calling tool '{toolName}': {ex.Message}";
        }
    }

    /// <summary>True when an exception (or any inner exception) indicates a recoverable lost session.</summary>
    private static bool IsRecoverableSessionLoss(Exception exception)
    {
        for (var ex = exception; ex != null; ex = ex.InnerException)
        {
            if (IsSessionNotFoundError(ex.Message))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Captures a screenshot and, on a lost/expired W365 session, starts a fresh session and retries
    /// once so a pure screenshot action can't abort the turn when the session has expired.
    /// </summary>
    private async Task<string> CaptureScreenshotWithRecoveryAsync(
        IList<AITool> w365Tools,
        ConversationSession session,
        IList<AITool>? additionalTools,
        IMcpClient? mcpClient,
        Func<string, Task>? onStatusUpdate,
        CancellationToken ct)
    {
        try
        {
            return await CaptureScreenshotAsync(w365Tools, mcpClient, session, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException && IsRecoverableSessionLoss(ex))
        {
            _logger.LogWarning(ex, "Screenshot failed because the W365 session was lost — starting a new session and retrying.");
            if (onStatusUpdate != null) await onStatusUpdate("Session expired — starting a new W365 session...");
            await RecoverAndStartFreshSessionAsync(session, w365Tools, additionalTools, mcpClient, ct);
            return await CaptureScreenshotAsync(w365Tools, mcpClient, session, ct);
        }
    }

    /// <summary>
    /// Removes conversation items that would make the next model call invalid: function/computer
    /// calls without their paired output, orphan outputs, and reasoning items that don't precede a
    /// surviving tool call. Returns a new list; the caller's history is left intact.
    /// </summary>
    internal static List<JsonElement> SanitizeConversationHistory(IReadOnlyList<JsonElement> conversation)
    {
        var functionCallIds = new HashSet<string>(StringComparer.Ordinal);
        var functionOutputIds = new HashSet<string>(StringComparer.Ordinal);
        var computerCallIds = new HashSet<string>(StringComparer.Ordinal);
        var computerOutputIds = new HashSet<string>(StringComparer.Ordinal);

        foreach (var item in conversation)
        {
            if (!item.TryGetProperty("type", out var typeProp)) continue;
            if (!item.TryGetProperty("call_id", out var idProp)) continue;
            var id = idProp.GetString();
            if (string.IsNullOrEmpty(id)) continue;
            switch (typeProp.GetString())
            {
                case "function_call": functionCallIds.Add(id); break;
                case "function_call_output": functionOutputIds.Add(id); break;
                case "computer_call": computerCallIds.Add(id); break;
                case "computer_call_output": computerOutputIds.Add(id); break;
            }
        }

        static string CallId(JsonElement item)
            => item.TryGetProperty("call_id", out var p) ? p.GetString() ?? string.Empty : string.Empty;

        var result = new List<JsonElement>(conversation.Count);
        // Reasoning items are only valid when the tool call they precede survives, so buffer them.
        var pendingReasoning = new List<JsonElement>();

        foreach (var item in conversation)
        {
            var type = item.TryGetProperty("type", out var typeProp) ? typeProp.GetString() : null;

            if (type == "reasoning")
            {
                pendingReasoning.Add(item);
                continue;
            }

            var drop = type switch
            {
                "function_call" => !functionOutputIds.Contains(CallId(item)),
                "computer_call" => !computerOutputIds.Contains(CallId(item)),
                "function_call_output" => !functionCallIds.Contains(CallId(item)),
                "computer_call_output" => !computerCallIds.Contains(CallId(item)),
                _ => false
            };

            if (drop)
            {
                // A dropped computer_call / function_call takes its buffered reasoning with it.
                if (type is "function_call" or "computer_call") pendingReasoning.Clear();
                continue;
            }

            // Buffered reasoning is only valid immediately before its paired tool call; emit it only
            // when the surviving item is a tool call, otherwise discard it so it can't dangle.
            if (type is "function_call" or "computer_call")
            {
                result.AddRange(pendingReasoning);
            }
            pendingReasoning.Clear();
            result.Add(item);
        }

        // Trailing reasoning with no following tool call is dangling — never flush it.
        return result;
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
        {
            return c.EnumerateArray()
                .Where(item => item.TryGetProperty("text", out _))
                .Select(item =>
                {
                    item.TryGetProperty("text", out var t);
                    return t.GetString() ?? string.Empty;
                })
                .FirstOrDefault() ?? string.Empty;
        }
        return string.Empty;
    }

    private static bool TryExtractSessionId(string text, out string sessionId)
    {
        sessionId = string.Empty;
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        var match = SessionIdRegex.Match(text);
        if (!match.Success)
        {
            return false;
        }

        sessionId = match.Value;
        return true;
    }

    private static string? ExtractSessionIdFromFunctionCall(JsonElement functionCall)
    {
        if (!functionCall.TryGetProperty("arguments", out var argsProperty))
        {
            return null;
        }

        var args = argsProperty.GetString();
        if (string.IsNullOrWhiteSpace(args))
        {
            return null;
        }

        try
        {
            using var argsDoc = JsonDocument.Parse(args);
            return TryExtractStringProperty(argsDoc.RootElement, "sessionId", out var sessionId)
                ? sessionId
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string? ExtractFinalAnswerFromFunctionCall(JsonElement functionCall)
    {
        if (!functionCall.TryGetProperty("arguments", out var argsProperty))
        {
            return null;
        }

        var args = argsProperty.GetString();
        if (string.IsNullOrWhiteSpace(args))
        {
            return null;
        }

        try
        {
            using var argsDoc = JsonDocument.Parse(args);
            return TryExtractStringProperty(argsDoc.RootElement, "finalAnswer", out var finalAnswer)
                ? finalAnswer
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
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
    private async Task<JsonElement> InvokeFunctionCallAsync(JsonElement functionCall, IList<AITool> tools, ConversationSession session, CancellationToken ct)
    {
        var callId = functionCall.GetProperty("call_id").GetString()!;
        var name = functionCall.GetProperty("name").GetString()!;
        var argsStr = functionCall.GetProperty("arguments").GetString() ?? "{}";

        _logger.LogInformation("Function call {Name} invoked. call_id={CallId}, args={Args}",
            name, callId, Truncate(argsStr, 1000));

        try
        {
            var args = JsonSerializer.Deserialize<Dictionary<string, object?>>(argsStr) ?? [];
            if (string.Equals(name, W365GetSessionDetailsToolName, StringComparison.OrdinalIgnoreCase)
                && !string.IsNullOrEmpty(session.W365SessionId)
                && !args.ContainsKey("sessionId"))
            {
                args["sessionId"] = session.W365SessionId;
            }

            var resultStr = await ToolTelemetry.InvokeAsync(
                toolName: name,
                arguments: args,
                toolCallId: callId,
                toolServerName: "mcp",
                endpoint: null,
                conversationId: session.ConversationId,
                channelId: session.ChannelId,
                invokeAsync: async () =>
                {
                    var result = await RawInvokeToolAsync(tools, name, args, ct);
                    return result?.ToString() ?? "success";
                }).ConfigureAwait(false);
            _logger.LogInformation("Function call {Name} returned ({Length} chars): {Result}",
                name, resultStr.Length, Truncate(resultStr, 2000));

            if (string.Equals(name, W365StartSessionToolName, StringComparison.OrdinalIgnoreCase))
            {
                if (TryExtractToolError(resultStr, out var startError))
                {
                    return CreateFunctionOutput(callId, $"Error: {startError}");
                }

                if (TryExtractStringProperty(resultStr, "sessionId", out var sessionId))
                {
                    session.TrackAndSelectSession(sessionId);
                    _logger.LogInformation("Stored explicit W365 session {SessionId} from model-requested StartSession", sessionId);
                }
            }

            return CreateFunctionOutput(callId, resultStr);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Function call {Name} threw. call_id={CallId}", name, callId);
            return CreateFunctionOutput(callId, $"Error: {ex.Message}");
        }
    }

    private static JsonElement ToJsonElement(object obj) =>
        JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(obj));

    private static string Truncate(string v, int max) => v.Length <= max ? v : v[..max] + "...";

    private void SaveScreenshotToDisk(string base64Data, string name, string? subfolder = null)
    {
        if (string.IsNullOrEmpty(base64Data) || string.IsNullOrEmpty(_screenshotPath)) return;
        try
        {
            // Match the OneDrive folder layout — per-session subfolder under ./Screenshots so
            // counters from concurrent or sequential conversations don't clobber each other.
            // Normalize subfolder to a leaf name so a rooted/parent-traversal segment can't
            // make Path.Combine drop _screenshotPath or escape it.
            string? safeSubfolder = string.IsNullOrEmpty(subfolder) ? null : Path.GetFileName(subfolder.Trim());
            var dir = string.IsNullOrEmpty(safeSubfolder)
                ? _screenshotPath
                : Path.Combine(_screenshotPath, safeSubfolder);
            Directory.CreateDirectory(dir);
            var safeName = Path.GetFileName(name);
            var path = Path.Combine(dir, $"{safeName}.png");
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
    private async Task<string?> UploadScreenshotToOneDriveAsync(string base64Data, string fileName, string? graphAccessToken, string? subfolder, ConversationSession session, CancellationToken cancellationToken = default)
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
            // URL-encode the user id so UPNs (which contain '@') produce a valid Graph URL.
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
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex) when (ex is HttpRequestException || ex is FormatException || ex is JsonException)
        {
            _logger.LogWarning(ex, "Failed to upload screenshot to OneDrive");
        }

        return null;
    }

    /// <summary>
    /// Create an organization-scoped sharing link for the conversation's screenshot folder.
    /// Returns the web URL that anyone in the org can use to view the folder.
    /// </summary>
    private async Task<string?> ShareConversationFolderAsync(string folderPath, string graphAccessToken, CancellationToken cancellationToken = default)
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
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex) when (ex is HttpRequestException || ex is JsonException || ex is KeyNotFoundException)
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
        public string? W365SessionId { get; private set; }
        public HashSet<string> W365SessionIds { get; } = new(StringComparer.OrdinalIgnoreCase);
        public List<JsonElement> ConversationHistory { get; } = [];
        public int ScreenshotCounter { get; set; }
        public string? ScreenshotSubfolder { get; set; }
        public string? ConversationId { get; set; }
        public string? ChannelId { get; set; }
        public bool FolderShared { get; set; }

        /// <summary>
        /// Serializes turns for this conversation so two concurrent turns cannot both append a
        /// user image to <see cref="ConversationHistory"/> (which the computer-use tool rejects).
        /// </summary>
        public SemaphoreSlim TurnLock { get; } = new(1, 1);

        public void TrackAndSelectSession(string? sessionId)
        {
            if (string.IsNullOrWhiteSpace(sessionId))
            {
                return;
            }

            W365SessionId = sessionId.Trim();
            W365SessionIds.Add(W365SessionId);
            SessionStarted = true;
        }

        public void RemoveSession(string? sessionId)
        {
            if (!string.IsNullOrWhiteSpace(sessionId))
            {
                W365SessionIds.Remove(sessionId);
            }

            if (string.Equals(W365SessionId, sessionId, StringComparison.OrdinalIgnoreCase))
            {
                W365SessionId = W365SessionIds.LastOrDefault();
            }

            SessionStarted = !string.IsNullOrEmpty(W365SessionId);
        }

        public void ClearActiveSession()
        {
            W365SessionId = null;
            SessionStarted = false;
        }
    }
}
