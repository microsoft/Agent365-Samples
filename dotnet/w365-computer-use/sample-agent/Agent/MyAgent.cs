// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Net.Http.Headers;
using W365ComputerUseSample.ComputerUse;
using W365ComputerUseSample.Telemetry;
using Microsoft.Agents.A365.Observability.Hosting.Caching;
using Microsoft.Agents.A365.Runtime.Utils;
using Microsoft.Agents.A365.Tooling.Extensions.AgentFramework.Services;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App;
using Microsoft.Agents.Builder.State;
using Microsoft.Agents.Core;
using Microsoft.Agents.Core.Models;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;
using ModelContextProtocol.Client;

namespace W365ComputerUseSample.Agent;

public class MyAgent : AgentApplication
{
    private const string AgentWelcomeMessage = "Hello! I can help you perform tasks on a Windows 365 Cloud PC. Tell me what you'd like to do.";
    private const string AgentHireMessage = "Thank you for hiring me! I can control a Windows desktop to accomplish tasks for you.";
    private const string AgentFarewellMessage = "Thank you for your time, I enjoyed working with you.";

    private readonly IExporterTokenCache<AgenticTokenStruct>? _agentTokenCache;
    private readonly ServiceTokenCache _observabilityTokenCache;
    private readonly Agent365TelemetryOptions _agent365TelemetryOptions;
    private readonly ILogger<MyAgent> _logger;
    private readonly IMcpToolRegistrationService _toolService;
    private readonly ComputerUseOrchestrator _orchestrator;
    private readonly string[] _mcpServerUrls;

    /// <summary>
    /// Subset of <see cref="_mcpServerUrls"/> whose path names the W365 Computer-Use server.
    /// Loaded only when the intent classifier determines CUA is required. Match is by URL
    /// substring; relies on ATG's path convention of keeping the server name in the path.
    /// </summary>
    private readonly string[] _w365McpServerUrls;

    /// <summary>
    /// All non-W365 MCP server URLs (mail, calendar, etc.). Loaded eagerly — these don't
    /// acquire a W365 session.
    /// </summary>
    private readonly string[] _otherMcpServerUrls;
    private readonly string _w365GatewayUrl;

    private readonly string? AgenticAuthHandlerName;
    private readonly string? OboAuthHandlerName;
    private readonly string? W365AuthHandlerName;

    /// <summary>
    /// Check if a bearer token is available in the environment for development/testing.
    /// </summary>
    public static bool TryGetBearerTokenForDevelopment(out string? bearerToken)
    {
        bearerToken = Environment.GetEnvironmentVariable("BEARER_TOKEN");
        return !string.IsNullOrEmpty(bearerToken);
    }

    internal static string BuildLocalSessionKeyForTest(string conversationId, ChannelAccount? fromAccount)
    {
        return BuildLocalSessionKey(conversationId, fromAccount);
    }

    private static string BuildLocalSessionKey(string conversationId, ChannelAccount? fromAccount)
    {
        var userKey = fromAccount?.AadObjectId;
        if (string.IsNullOrWhiteSpace(userKey))
        {
            userKey = fromAccount?.Id;
        }

        if (string.IsNullOrWhiteSpace(userKey))
        {
            userKey = "unknown-user";
        }

        return $"{conversationId}::{userKey}";
    }

    /// <summary>
    /// Checks if graceful fallback is enabled when MCP tools fail to load.
    /// Only allowed in Development + SKIP_TOOLING_ON_ERRORS=true.
    /// </summary>
    private static bool ShouldSkipToolingOnErrors()
    {
        var environment = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") ??
                          Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT") ??
                          "Production";

        var skipToolingOnErrors = Environment.GetEnvironmentVariable("SKIP_TOOLING_ON_ERRORS");

        return environment.Equals("Development", StringComparison.OrdinalIgnoreCase) &&
               !string.IsNullOrEmpty(skipToolingOnErrors) &&
               skipToolingOnErrors.Equals("true", StringComparison.OrdinalIgnoreCase);
    }

    public MyAgent(
        AgentApplicationOptions options,
        IConfiguration configuration,
        IExporterTokenCache<AgenticTokenStruct> agentTokenCache,
        ServiceTokenCache observabilityTokenCache,
        IMcpToolRegistrationService toolService,
        ComputerUseOrchestrator orchestrator,
        IOptions<Agent365TelemetryOptions> agent365TelemetryOptions,
        ILogger<MyAgent> logger) : base(options)
    {
        _agentTokenCache = agentTokenCache;
        _observabilityTokenCache = observabilityTokenCache;
        _logger = logger;
        _toolService = toolService;
        _orchestrator = orchestrator;
        _agent365TelemetryOptions = agent365TelemetryOptions.Value;

        // Support multiple MCP server URLs; fall back to single McpServer:Url for backward compat
        _mcpServerUrls = configuration.GetSection("McpServers").Get<string[]>() ?? [];
        if (_mcpServerUrls.Length == 0)
        {
            var singleUrl = configuration["McpServer:Url"];
            if (!string.IsNullOrEmpty(singleUrl))
                _mcpServerUrls = [singleUrl];
        }

        // Split into W365 vs other servers by URL path — W365 load is deferred until the
        // intent classifier decides CUA is needed. Avoids loading W365 lifecycle tools on
        // chit-chat / mail-only messages.
        _w365McpServerUrls = _mcpServerUrls.Where(u => u.Contains("/mcp_W365ComputerUse", StringComparison.OrdinalIgnoreCase)).ToArray();
        _otherMcpServerUrls = _mcpServerUrls.Where(u => !u.Contains("/mcp_W365ComputerUse", StringComparison.OrdinalIgnoreCase)).ToArray();
        _w365GatewayUrl = configuration.GetValue<string>("W365:GatewayUrl")
            ?? "https://agent365.svc.cloud.microsoft/agents/servers/mcp_W365ComputerUse";

        AgenticAuthHandlerName = configuration.GetValue<string>("AgentApplication:AgenticAuthHandlerName");
        OboAuthHandlerName = configuration.GetValue<string>("AgentApplication:OboAuthHandlerName");
        W365AuthHandlerName = configuration.GetValue<string>("AgentApplication:W365AuthHandlerName");

        // Greet when members are added
        OnConversationUpdate(ConversationUpdateEvents.MembersAdded, WelcomeMessageAsync);

        // Compute auth handler arrays once
        var agenticHandlers = new[] { AgenticAuthHandlerName, W365AuthHandlerName }
            .OfType<string>()
            .Where(handler => !string.IsNullOrEmpty(handler))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var oboHandlers = !string.IsNullOrEmpty(OboAuthHandlerName) ? [OboAuthHandlerName] : Array.Empty<string>();

        // Handle install/uninstall
        OnActivity(ActivityTypes.InstallationUpdate, OnInstallationUpdateAsync, isAgenticOnly: true, autoSignInHandlers: agenticHandlers);
        OnActivity(ActivityTypes.InstallationUpdate, OnInstallationUpdateAsync, isAgenticOnly: false);

        // Handle messages — MUST BE AFTER any other message handlers
        OnActivity(ActivityTypes.Message, OnMessageAsync, isAgenticOnly: true, autoSignInHandlers: agenticHandlers);
        OnActivity(ActivityTypes.Message, OnMessageAsync, isAgenticOnly: false, autoSignInHandlers: oboHandlers);
    }

    protected async Task WelcomeMessageAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {
        await A365OtelWrapper.InvokeObservedAgentOperation(
            "WelcomeMessage",
            turnContext,
            turnState,
            _agentTokenCache,
            _observabilityTokenCache,
            _agent365TelemetryOptions,
            UserAuthorization,
            GetObservabilityAuthHandlerName(turnContext),
            _logger,
            async () =>
            {
                var membersToWelcome = turnContext.Activity.MembersAdded
                    .Where(m => m.Id != turnContext.Activity.Recipient.Id);
                foreach (var member in membersToWelcome)
                {
                    await turnContext.SendActivityAsync(AgentWelcomeMessage);
                }
            });
    }

    protected async Task OnInstallationUpdateAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {
        await A365OtelWrapper.InvokeObservedAgentOperation(
            "InstallationUpdate",
            turnContext,
            turnState,
            _agentTokenCache,
            _observabilityTokenCache,
            _agent365TelemetryOptions,
            UserAuthorization,
            GetObservabilityAuthHandlerName(turnContext),
            _logger,
            async () =>
            {
                _logger.LogInformation(
                    "InstallationUpdate received — Action: '{Action}', DisplayName: '{Name}', UserId: '{Id}'",
                    turnContext.Activity.Action ?? "(none)",
                    turnContext.Activity.From?.Name ?? "(unknown)",
                    turnContext.Activity.From?.Id ?? "(unknown)");

                if (turnContext.Activity.Action == InstallationUpdateActionTypes.Add)
                {
                    await turnContext.SendActivityAsync(MessageFactory.Text(AgentHireMessage), cancellationToken);
                }
                else if (turnContext.Activity.Action == InstallationUpdateActionTypes.Remove)
                {
                    await turnContext.SendActivityAsync(MessageFactory.Text(AgentFarewellMessage), cancellationToken);
                }
            });
    }

    protected async Task OnMessageAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {
        if (turnContext is null)
        {
            throw new ArgumentNullException(nameof(turnContext));
        }

        var fromAccount = turnContext.Activity.From;
        _logger.LogDebug(
            "Turn received from user — DisplayName: '{Name}', UserId: '{Id}', AadObjectId: '{AadObjectId}'",
            fromAccount?.Name ?? "(unknown)",
            fromAccount?.Id ?? "(unknown)",
            fromAccount?.AadObjectId ?? "(none)");

        // Select auth handler based on request type
        string? ToolAuthHandlerName;
        var ObservabilityAuthHandlerName = GetObservabilityAuthHandlerName(turnContext);
        if (turnContext.IsAgenticRequest())
        {
            ToolAuthHandlerName = AgenticAuthHandlerName;
        }
        else
        {
            ToolAuthHandlerName = OboAuthHandlerName;
        }

        await A365OtelWrapper.InvokeObservedAgentOperation(
            "MessageProcessor",
            turnContext,
            turnState,
            _agentTokenCache,
            _observabilityTokenCache,
            _agent365TelemetryOptions,
            UserAuthorization,
            ObservabilityAuthHandlerName,
            _logger,
            async () =>
            {
                // Typing indicator
                // Single typing indicator. A background refresh loop was removed because it
                // raced with the main reply path and triggered Kestrel request-body
                // "Reading is already in progress" → ObjectDisposedException crashes post-response.
                // Informative updates via onStatusUpdate keep the UI feedback flowing.
                await turnContext.SendActivityAsync(Activity.CreateTypingActivity(), cancellationToken).ConfigureAwait(false);

                try
                {
                    var userText = turnContext.Activity.Text?.Trim() ?? string.Empty;
                    var conversationId = turnContext.Activity.Conversation?.Id ?? Guid.NewGuid().ToString();
                    var localSessionKey = BuildLocalSessionKey(conversationId, fromAccount);

                    // Step 1: classify intent with a cheap tool-less LLM call. If the message
                    // doesn't need desktop control ("hi", "summarize my inbox", etc.) we skip
                    // W365 tool loading and explicit session startup entirely.
                    //
                    // Short-circuit when a W365 session is already active on this conversation:
                    // the classifier sees the user's message in isolation, so short follow-ups
                    // like "fix it!", "yes", "do it", "same session" carry no W365 keywords and
                    // get misclassified as non-CUA. The LLM then runs without the computer-use
                    // tool and silently no-ops (says "I'll fix it" but has no tool to act).
                    // Once a session is live the cost of classifying is no longer worth the
                    // risk of dropping a legitimate continuation.
                    var hasActiveSession = _orchestrator.HasActiveW365Session(localSessionKey);
                    var needsCua = hasActiveSession
                        || await _orchestrator.ClassifyNeedsCuaAsync(userText, cancellationToken);

                    if (!needsCua)
                    {
                        // Non-CUA fast path: with the current CUA-only ToolingManifest, skip MCP
                        // discovery entirely so chit-chat never touches W365.
                        var (_, nonCuaAdditionalTools, _, _) = await GetToolsAsync(turnContext, ToolAuthHandlerName, includeW365: false, localSessionKey, cancellationToken);
                        var directResponse = await _orchestrator.RunAsync(
                            localSessionKey,
                            userText,
                            w365Tools: [],
                            additionalTools: nonCuaAdditionalTools,
                            mcpClient: null,
                            graphAccessToken: null,
                            onStatusUpdate: status => turnContext.StreamingResponse.QueueInformativeUpdateAsync(status),
                            onCuaStarting: null,
                            onFolderLinkReady: null,
                            includeCuaTool: false,
                            cancellationToken: cancellationToken);
                        turnContext.StreamingResponse.QueueTextChunk(directResponse);
                        return directResponse;
                    }

                    // CUA path: SendActivity the "Got it" acknowledgment FIRST, before the streaming
                    // response begins. If we send it later (e.g. from inside onCuaStarting), Teams/
                    // Emulator orders it visually AFTER the streaming activity's final text since
                    // the streaming activity was created earlier in the turn — the user sees the
                    // result before the acknowledgment. SendActivity here gets an earlier ID than
                    // the streaming activity that starts on the next line.
                    await turnContext.SendActivityAsync(MessageFactory.Text("Got it — working on it…"), cancellationToken).ConfigureAwait(false);

                    // Announce first W365 connection setup only when we don't already have W365 tools cached.
                    // Explicit session startup is announced separately from the CUA loop.
                    var willAcquireFreshSession = !_orchestrator.HasCachedW365Tools;
                    if (willAcquireFreshSession)
                    {
                        await turnContext.StreamingResponse.QueueInformativeUpdateAsync("Connecting to Windows 365 Computer Use tools…");
                    }

                    // Get MCP tools — direct connection in Dev, SDK in Production
                    var (w365Tools, additionalTools, mcpClient, prestartedW365SessionId) = await GetToolsAsync(turnContext, ToolAuthHandlerName, includeW365: true, localSessionKey, cancellationToken);

                    try
                    {
                        if (w365Tools == null || w365Tools.Count == 0)
                        {
                            // ATG wraps tools/list failures into a synthetic "Error" tool whose Description
                            // carries the real reason (e.g. "no pool with an available session was found").
                            // Extract it so the user sees the actionable message instead of the generic
                            // "Unable to connect" placeholder.
                            var errorMessage = ExtractW365ToolListError(additionalTools)
                                ?? "Unable to connect to the W365 Computer Use service. Please check your configuration.";
                            // Write the error into the streaming response so EndStreamAsync doesn't
                            // emit a confusing 'No text was streamed' alongside the real message.
                            turnContext.StreamingResponse.QueueTextChunk(errorMessage);
                            return errorMessage;
                        }

                        // Get Graph token for OneDrive screenshot upload.
                        // In production: acquired via agentic auth (UserAuthorization).
                        // In development: set GRAPH_TOKEN env var with a token that has Files.ReadWrite scope.
                        string? graphToken = null;
                        if (!string.IsNullOrEmpty(ToolAuthHandlerName))
                        {
                            graphToken = await UserAuthorization.GetTurnTokenAsync(turnContext, ToolAuthHandlerName);
                        }
                        if (string.IsNullOrEmpty(graphToken))
                        {
                            graphToken = Environment.GetEnvironmentVariable("GRAPH_TOKEN");
                        }

                        // Run the CUA loop — session is managed per conversation
                        var response = await _orchestrator.RunAsync(
                            localSessionKey,
                            userText,
                            w365Tools,
                            additionalTools: additionalTools,
                            mcpClient: mcpClient,
                            graphAccessToken: graphToken,
                            onStatusUpdate: status => turnContext.StreamingResponse.QueueInformativeUpdateAsync(status),
                            onCuaStarting: async (isNewSession) =>
                            {
                                if (isNewSession)
                                {
                                    await turnContext.StreamingResponse.QueueInformativeUpdateAsync("Starting a session to a Windows 365 Cloud PC…");
                                }
                            },
                            onFolderLinkReady: async url => await turnContext.SendActivityAsync(
                                MessageFactory.Text($"📸 Screenshots for this session: [View folder]({url})"), cancellationToken),
                            prestartedW365SessionId: prestartedW365SessionId,
                            cancellationToken: cancellationToken);

                        // Send the response
                        turnContext.StreamingResponse.QueueTextChunk(response);
                        return response;
                    }
                    finally
                    {
                        // Don't dispose the MCP client — it's reused across messages and
                        // needed for EndSession on shutdown. It will be disposed with the app.
                    }
                }
                finally
                {
                    try { await turnContext.StreamingResponse.EndStreamAsync(cancellationToken).ConfigureAwait(false); }
                    catch (ObjectDisposedException) { /* stream already disposed */ }
                }
            });
    }

    private string GetObservabilityAuthHandlerName(ITurnContext turnContext)
    {
        return turnContext.IsAgenticRequest()
            ? AgenticAuthHandlerName ?? string.Empty
            : OboAuthHandlerName ?? string.Empty;
    }

    /// <summary>
    /// Get MCP tools, separated into W365 (CUA) and additional (function) tools.
    /// In Development mode with a bearer token, connects directly to the MCP server URL.
    /// In Production, uses the A365 SDK to discover servers via the Tooling Gateway.
    /// When <paramref name="includeW365"/> is <c>false</c>, the W365 server(s) are skipped —
    /// used on the non-CUA fast path so chit-chat never starts a Cloud PC session.
    /// </summary>
    private async Task<(IList<AITool>? W365Tools, IList<AITool>? AdditionalTools, IMcpClient? Client, string? PrestartedW365SessionId)> GetToolsAsync(
        ITurnContext context,
        string? authHandlerName,
        bool includeW365,
        string? localSessionKey,
        CancellationToken cancellationToken)
    {
        // Acquire access token
        string? accessToken = null;
        string? agentId = null;

        if (!string.IsNullOrEmpty(authHandlerName))
        {
            accessToken = await UserAuthorization.GetTurnTokenAsync(context, authHandlerName);
            agentId = Utility.ResolveAgentIdentity(context, accessToken);
        }
        else if (TryGetBearerTokenForDevelopment(out var bearerToken))
        {
            _logger.LogInformation("Using bearer token from environment.");
            accessToken = bearerToken;
            agentId = Utility.ResolveAgentIdentity(context, accessToken!);
        }

        if (includeW365 && !IsDevelopment())
        {
            var w365AuthHandlerName = W365AuthHandlerName ?? authHandlerName;
            if (!string.IsNullOrEmpty(w365AuthHandlerName))
            {
                accessToken = await UserAuthorization.GetTurnTokenAsync(context, w365AuthHandlerName);
                agentId = Utility.ResolveAgentIdentity(context, accessToken);
            }
        }

        if (string.IsNullOrEmpty(accessToken) || string.IsNullOrEmpty(agentId))
        {
            _logger.LogWarning("No auth token or agent identity available. Cannot connect to MCP.");
            return (null, null, null, null);
        }

        try
        {
            IList<AITool>? allTools;
            IMcpClient? mcpClient = null;

            // Development with bearer token: use orchestrator's cached MCP connection
            if (TryGetBearerTokenForDevelopment(out _) && IsDevelopment())
            {
                if (_mcpServerUrls.Length == 0)
                    throw new InvalidOperationException("McpServers (or McpServer:Url) is required in appsettings for Development mode.");

                if (includeW365)
                {
                    // Full load: W365 + everything else. The orchestrator's cache covers both.
                    (allTools, mcpClient) = await _orchestrator.GetOrCreateMcpConnectionAsync(_mcpServerUrls, accessToken!);
                }
                else
                {
                    // Non-CUA fast path: skip W365 entirely. Non-W365 tools have their own cache
                    // in the orchestrator so we don't reconnect on every non-CUA message.
                    allTools = await _orchestrator.GetOrCreateNonW365McpConnectionAsync(_otherMcpServerUrls, accessToken!);
                }
            }
            else
            {
                if (includeW365)
                {
                    var existingSessionId = _orchestrator.GetSelectedW365SessionId(localSessionKey);
                    var w365Result = await _orchestrator.StartDirectW365SessionAndListToolsAsync(
                        _w365GatewayUrl,
                        accessToken!,
                        agentId,
                        context,
                        existingSessionId,
                        cancellationToken);
                    var additionalToolsForCua = Array.Empty<AITool>();

                    // Reconnect delegate for in-turn session recovery: re-run the prod prestart path
                    // with existingSessionId=null to mint a fresh session + client + bound tools.
                    // Captures the turn's freshly-acquired access token (recovery happens within the
                    // same turn, so the token is still valid).
                    var capturedAccessToken = accessToken!;
                    var capturedAgentId = agentId;
                    ComputerUseOrchestrator.ReconnectW365Async reconnect = reconnectCt =>
                        _orchestrator.StartDirectW365SessionAndListToolsAsync(
                            _w365GatewayUrl,
                            capturedAccessToken,
                            capturedAgentId,
                            context,
                            existingSessionId: null,
                            reconnectCt);
                        
                    return (w365Result.Tools, additionalToolsForCua, w365Result.Client, w365Result.SessionId);
                }

                _logger.LogInformation("Skipping production MCP tool discovery for non-CUA turn while ToolingManifest is restricted to W365 CUA.");
                return (null, Array.Empty<AITool>(), null, null);
            }

            var w365Tools = includeW365 ? FilterW365Tools(allTools) : null;
            var additionalTools = FilterAdditionalTools(allTools);
            return (w365Tools, additionalTools, mcpClient, null);
        }
        catch (Exception ex)
        {
            if (ShouldSkipToolingOnErrors())
            {
                _logger.LogWarning(ex, "Failed to connect to MCP servers. Continuing without tools (SKIP_TOOLING_ON_ERRORS=true).");
                return (null, null, null, null);
            }

            _logger.LogError(ex, "Failed to connect to MCP servers.");
            throw;
        }
    }

    private static bool IsDevelopment()
    {
        var env = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT")
               ?? Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT")
               ?? "Production";
        return env.Equals("Development", StringComparison.OrdinalIgnoreCase);
    }

    private IList<AITool>? FilterW365Tools(IList<AITool>? allTools)
    {
        var w365Tools = allTools?.Where(t =>
        {
            var name = (t as AIFunction)?.Name ?? t.ToString() ?? string.Empty;
            return ComputerUseOrchestrator.IsW365CuaTool(name);
        }).ToList();

        if (w365Tools != null && w365Tools.Count > 0)
        {
            _logger.LogInformation("Found {ToolCount} W365 Computer Use tools", w365Tools.Count);
        }
        else
        {
            _logger.LogWarning("No W365 tools found among {TotalCount} MCP tools", allTools?.Count ?? 0);
        }

        return w365Tools;
    }

    private IList<AITool>? FilterAdditionalTools(IList<AITool>? allTools)
    {
        var additionalTools = allTools?.Where(t =>
        {
            var name = (t as AIFunction)?.Name ?? t.ToString() ?? string.Empty;
            return !ComputerUseOrchestrator.IsW365CuaTool(name);
        }).ToList();

        if (additionalTools != null && additionalTools.Count > 0)
        {
            _logger.LogInformation("Found {ToolCount} additional function tools: {Names}",
                additionalTools.Count,
                string.Join(", ", additionalTools.Select(t => (t as AIFunction)?.Name ?? "?")));
        }

        return additionalTools;
    }

    /// <summary>
    /// Looks for ATG's synthetic <c>Error</c> tool in the non-CUA tool list and extracts a
    /// user-facing error reason from its description. ATG formats the description as:
    /// <c>"Tool list retrieval failed. Message='...'. ExceptionType='...'. ExceptionMessage='...'. CorrelationId=..., TimeStamp=..."</c>.
    /// We prefer the <c>ExceptionMessage</c> field because it carries the specific reason
    /// (e.g. "Failed to acquire a W365 session: no pool with an available session was found.").
    /// Returns null if no error tool is present or the description can't be parsed.
    /// </summary>
    private static string? ExtractW365ToolListError(IList<AITool>? additionalTools)
    {
        if (additionalTools == null || additionalTools.Count == 0)
        {
            return null;
        }

        var errorTool = additionalTools
            .OfType<AIFunction>()
            .FirstOrDefault(fn => string.Equals(fn.Name, "Error", StringComparison.OrdinalIgnoreCase));
        
        if (errorTool == null)
        {
            return null;
        }

        var description = errorTool.Description ?? string.Empty;
        var extracted = ExtractQuotedField(description, "ExceptionMessage=")
            ?? ExtractQuotedField(description, "Message=")
            ?? (string.IsNullOrWhiteSpace(description) ? null : description);
        return extracted;
    }

    private static string? ExtractQuotedField(string source, string fieldPrefix)
    {
        var startMarker = fieldPrefix + "'";
        var start = source.IndexOf(startMarker, StringComparison.Ordinal);
        if (start < 0) return null;
        start += startMarker.Length;
        var end = source.IndexOf("'.", start, StringComparison.Ordinal);
        if (end < 0) end = source.IndexOf('\'', start);
        if (end < start) return null;
        var value = source.Substring(start, end - start);
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }
}
