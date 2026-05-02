// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Net.Http.Headers;
using W365ComputerUseSample.ComputerUse;
using W365ComputerUseSample.Telemetry;
using Microsoft.Agents.A365.Observability.Caching;
using Microsoft.Agents.A365.Runtime.Utils;
using Microsoft.Agents.A365.Tooling.Extensions.AgentFramework.Services;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App;
using Microsoft.Agents.Builder.State;
using Microsoft.Agents.Core;
using Microsoft.Agents.Core.Models;
using Microsoft.Extensions.AI;
using ModelContextProtocol.Client;

namespace W365ComputerUseSample.Agent;

public class MyAgent : AgentApplication
{
    private const string AgentWelcomeMessage = "Hello! I can help you perform tasks on a Windows 365 Cloud PC. Tell me what you'd like to do.";
    private const string AgentHireMessage = "Thank you for hiring me! I can control a Windows desktop to accomplish tasks for you.";
    private const string AgentFarewellMessage = "Thank you for your time, I enjoyed working with you.";

    private readonly IExporterTokenCache<AgenticTokenStruct>? _agentTokenCache;
    private readonly ILogger<MyAgent> _logger;
    private readonly IMcpToolRegistrationService _toolService;
    private readonly ComputerUseOrchestrator _orchestrator;
    private readonly string[] _mcpServerUrls;

    /// <summary>
    /// Subset of <see cref="_mcpServerUrls"/> whose path names the W365 Computer-Use server.
    /// Loaded only when the intent classifier determines CUA is required — otherwise the
    /// tools/list call on this URL triggers ATG's hostname discovery and acquires a Cloud PC
    /// session (10-30s). Match is by URL substring; relies on ATG's path convention of
    /// keeping the server name in the path.
    /// </summary>
    private readonly string[] _w365McpServerUrls;

    /// <summary>
    /// All non-W365 MCP server URLs (mail, calendar, etc.). Loaded eagerly — these don't
    /// acquire a W365 session.
    /// </summary>
    private readonly string[] _otherMcpServerUrls;

    private readonly string? AgenticAuthHandlerName;
    private readonly string? OboAuthHandlerName;

    /// <summary>
    /// Check if a bearer token is available in the environment for development/testing.
    /// </summary>
    public static bool TryGetBearerTokenForDevelopment(out string? bearerToken)
    {
        bearerToken = Environment.GetEnvironmentVariable("BEARER_TOKEN");
        return !string.IsNullOrEmpty(bearerToken);
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
        IMcpToolRegistrationService toolService,
        ComputerUseOrchestrator orchestrator,
        ILogger<MyAgent> logger) : base(options)
    {
        _agentTokenCache = agentTokenCache;
        _logger = logger;
        _toolService = toolService;
        _orchestrator = orchestrator;

        // Support multiple MCP server URLs; fall back to single McpServer:Url for backward compat
        _mcpServerUrls = configuration.GetSection("McpServers").Get<string[]>() ?? [];
        if (_mcpServerUrls.Length == 0)
        {
            var singleUrl = configuration["McpServer:Url"];
            if (!string.IsNullOrEmpty(singleUrl))
                _mcpServerUrls = [singleUrl];
        }

        // Split into W365 vs other servers by URL path — W365 load is deferred until the
        // intent classifier decides CUA is needed. Avoids paying the 10-30s session
        // acquisition cost on chit-chat / mail-only messages.
        _w365McpServerUrls = _mcpServerUrls.Where(u => u.Contains("/mcp_W365ComputerUse", StringComparison.OrdinalIgnoreCase)).ToArray();
        _otherMcpServerUrls = _mcpServerUrls.Where(u => !u.Contains("/mcp_W365ComputerUse", StringComparison.OrdinalIgnoreCase)).ToArray();

        AgenticAuthHandlerName = configuration.GetValue<string>("AgentApplication:AgenticAuthHandlerName");
        OboAuthHandlerName = configuration.GetValue<string>("AgentApplication:OboAuthHandlerName");

        // Greet when members are added
        OnConversationUpdate(ConversationUpdateEvents.MembersAdded, WelcomeMessageAsync);

        // Compute auth handler arrays once
        var agenticHandlers = !string.IsNullOrEmpty(AgenticAuthHandlerName) ? [AgenticAuthHandlerName] : Array.Empty<string>();
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
        await AgentMetrics.InvokeObservedAgentOperation(
            "WelcomeMessage",
            turnContext,
            async () =>
            {
                foreach (ChannelAccount member in turnContext.Activity.MembersAdded)
                {
                    if (member.Id != turnContext.Activity.Recipient.Id)
                    {
                        await turnContext.SendActivityAsync(AgentWelcomeMessage);
                    }
                }
            });
    }

    protected async Task OnInstallationUpdateAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {
        await AgentMetrics.InvokeObservedAgentOperation(
            "InstallationUpdate",
            turnContext,
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
        string? ObservabilityAuthHandlerName;
        string? ToolAuthHandlerName;
        if (turnContext.IsAgenticRequest())
        {
            ObservabilityAuthHandlerName = ToolAuthHandlerName = AgenticAuthHandlerName;
        }
        else
        {
            ObservabilityAuthHandlerName = ToolAuthHandlerName = OboAuthHandlerName;
        }

        await A365OtelWrapper.InvokeObservedAgentOperation(
            "MessageProcessor",
            turnContext,
            turnState,
            _agentTokenCache,
            UserAuthorization,
            ObservabilityAuthHandlerName ?? string.Empty,
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

                    // Step 1: classify intent with a cheap tool-less LLM call. If the message
                    // doesn't need desktop control ("hi", "summarize my inbox", etc.) we skip
                    // W365 tool loading entirely so ATG never acquires a Cloud PC session.
                    var needsCua = await _orchestrator.ClassifyNeedsCuaAsync(userText, cancellationToken);

                    if (!needsCua)
                    {
                        // Non-CUA fast path: load only non-W365 tools, run orchestrator with the
                        // computer tool withheld. Supports function-tool paths (mail/calendar/etc.)
                        // without touching W365.
                        var (_, nonCuaAdditionalTools, _) = await GetToolsAsync(turnContext, ToolAuthHandlerName, includeW365: false);
                        var directResponse = await _orchestrator.RunAsync(
                            conversationId,
                            userText,
                            w365Tools: [],
                            additionalTools: nonCuaAdditionalTools,
                            mcpClient: null,
                            graphAccessToken: null,
                            onStatusUpdate: status => turnContext.StreamingResponse.QueueInformativeUpdateAsync(status).ConfigureAwait(false),
                            onCuaStarting: null,
                            onFolderLinkReady: null,
                            includeCuaTool: false,
                            cancellationToken: cancellationToken);
                        turnContext.StreamingResponse.QueueTextChunk(directResponse);
                        return;
                    }

                    // CUA path: SendActivity the "Got it" acknowledgment FIRST, before the streaming
                    // response begins. If we send it later (e.g. from inside onCuaStarting), Teams/
                    // Emulator orders it visually AFTER the streaming activity's final text since
                    // the streaming activity was created earlier in the turn — the user sees the
                    // result before the acknowledgment. SendActivity here gets an earlier ID than
                    // the streaming activity that starts on the next line.
                    await turnContext.SendActivityAsync(MessageFactory.Text("Got it — working on it…"), cancellationToken).ConfigureAwait(false);

                    // Get MCP tools — direct connection in Dev, SDK in Production.
                    //
                    // No "Acquiring…" bubble: GetToolsAsync may take >2s even on cache reuse
                    // (OBO token + headers + S2S add up), and the agent has no reliable way to
                    // distinguish reuse from fresh checkout in advance. A misleading bubble on
                    // every reuse was worse than no bubble at all. The "Got it — working on it…"
                    // bubble already provides feedback that the agent is working.
                    var (w365Tools, additionalTools, mcpClient) = await GetToolsAsync(turnContext, ToolAuthHandlerName, includeW365: true);

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
                            return;
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
                            conversationId,
                            userText,
                            w365Tools,
                            additionalTools: additionalTools,
                            mcpClient: mcpClient,
                            graphAccessToken: graphToken,
                            onStatusUpdate: status => turnContext.StreamingResponse.QueueInformativeUpdateAsync(status).ConfigureAwait(false),
                            onCuaStarting: async (isNewSession) =>
                            {
                                if (isNewSession)
                                {
                                    await turnContext.StreamingResponse.QueueInformativeUpdateAsync("Starting a session to a Windows 365 Cloud PC…");
                                }
                            },
                            onFolderLinkReady: async url => await turnContext.SendActivityAsync(
                                MessageFactory.Text($"📸 Screenshots for this request: [View folder]({url})"), cancellationToken),
                            cancellationToken: cancellationToken);

                        // Send the response
                        turnContext.StreamingResponse.QueueTextChunk(response);
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

    /// <summary>
    /// Get MCP tools, separated into W365 (CUA) and additional (function) tools.
    /// In Development mode with a bearer token, connects directly to the MCP server URL.
    /// In Production, uses the A365 SDK to discover servers via the Tooling Gateway.
    /// When <paramref name="includeW365"/> is <c>false</c>, the W365 server(s) are skipped —
    /// used on the non-CUA fast path so ATG never acquires a Cloud PC session for chit-chat.
    /// </summary>
    private async Task<(IList<AITool>? W365Tools, IList<AITool>? AdditionalTools, IMcpClient? Client)> GetToolsAsync(ITurnContext context, string? authHandlerName, bool includeW365)
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

        if (string.IsNullOrEmpty(accessToken) || string.IsNullOrEmpty(agentId))
        {
            _logger.LogWarning("No auth token or agent identity available. Cannot connect to MCP.");
            return (null, null, null);
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
                // Production: use the A365 SDK's tooling gateway for server discovery.
                // NOTE: The SDK loads all registered servers' tools in one call, including W365.
                // The includeW365 flag can't suppress the W365 load in prod today — the SDK has
                // no per-server loading API. The CUA gate still saves compute on the non-CUA
                // branch (no CUA loop, no screenshots), but not the Cloud PC session.
                var handlerForMcp = !string.IsNullOrEmpty(authHandlerName)
                    ? authHandlerName
                    : OboAuthHandlerName ?? AgenticAuthHandlerName ?? string.Empty;
                var tokenOverride = string.IsNullOrEmpty(authHandlerName) ? accessToken : null;

                allTools = await _toolService.GetMcpToolsAsync(agentId, UserAuthorization, handlerForMcp, context, tokenOverride).ConfigureAwait(false);
            }

            var w365Tools = includeW365 ? FilterW365Tools(allTools) : null;
            var additionalTools = FilterAdditionalTools(allTools);
            return (w365Tools, additionalTools, mcpClient);
        }
        catch (Exception ex)
        {
            if (ShouldSkipToolingOnErrors())
            {
                _logger.LogWarning(ex, "Failed to connect to MCP servers. Continuing without tools (SKIP_TOOLING_ON_ERRORS=true).");
                return (null, null, null);
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

        foreach (var tool in additionalTools)
        {
            if (tool is not AIFunction fn) continue;
            if (!string.Equals(fn.Name, "Error", StringComparison.OrdinalIgnoreCase)) continue;

            var description = fn.Description ?? string.Empty;
            var extracted = ExtractQuotedField(description, "ExceptionMessage=")
                ?? ExtractQuotedField(description, "Message=")
                ?? (string.IsNullOrWhiteSpace(description) ? null : description);
            return extracted;
        }

        return null;
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
