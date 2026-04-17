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
                await turnContext.SendActivityAsync(Activity.CreateTypingActivity(), cancellationToken).ConfigureAwait(false);

                using var typingCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                var typingTask = Task.Run(async () =>
                {
                    try
                    {
                        while (!typingCts.IsCancellationRequested)
                        {
                            await Task.Delay(TimeSpan.FromSeconds(4), typingCts.Token).ConfigureAwait(false);
                            await turnContext.SendActivityAsync(Activity.CreateTypingActivity(), typingCts.Token).ConfigureAwait(false);
                        }
                    }
                    catch (OperationCanceledException) { /* expected */ }
                    catch (ObjectDisposedException) { /* CTS disposed before task finished */ }
                }, typingCts.Token);

                try
                {
                    var userText = turnContext.Activity.Text?.Trim() ?? string.Empty;

                    // Get MCP tools — direct connection in Dev, SDK in Production
                    var (w365Tools, additionalTools, mcpClient) = await GetToolsAsync(turnContext, ToolAuthHandlerName);

                    try
                    {
                        if (w365Tools == null || w365Tools.Count == 0)
                        {
                            await turnContext.SendActivityAsync(
                                MessageFactory.Text("Unable to connect to the W365 Computer Use service. Please check your configuration."),
                                cancellationToken);
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
                        var conversationId = turnContext.Activity.Conversation?.Id ?? Guid.NewGuid().ToString();
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
                                await turnContext.SendActivityAsync(MessageFactory.Text("Got it — working on it…"), cancellationToken).ConfigureAwait(false);
                                if (isNewSession)
                                {
                                    await turnContext.StreamingResponse.QueueInformativeUpdateAsync("Starting a session to a Windows 365 Cloud PC…");
                                }
                            },
                            onFolderLinkReady: async url => await turnContext.SendActivityAsync(
                                MessageFactory.Text($"📸 Screenshots for this session: [View folder]({url})"), cancellationToken),
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
                    try { typingCts.Cancel(); } catch (ObjectDisposedException) { }
                    try { await typingTask.ConfigureAwait(false); }
                    catch (OperationCanceledException) { /* expected */ }
                    catch (ObjectDisposedException) { /* expected */ }
                    try { await turnContext.StreamingResponse.EndStreamAsync(cancellationToken).ConfigureAwait(false); }
                    catch (ObjectDisposedException) { /* stream already disposed */ }
                }
            });
    }

    /// <summary>
    /// Get MCP tools, separated into W365 (CUA) and additional (function) tools.
    /// In Development mode with a bearer token, connects directly to the MCP server URL.
    /// In Production, uses the A365 SDK to discover servers via the Tooling Gateway.
    /// </summary>
    private async Task<(IList<AITool>? W365Tools, IList<AITool>? AdditionalTools, IMcpClient? Client)> GetToolsAsync(ITurnContext context, string? authHandlerName)
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
                (allTools, mcpClient) = await _orchestrator.GetOrCreateMcpConnectionAsync(_mcpServerUrls, accessToken!);
            }
            else
            {
                // Production: use the A365 SDK's tooling gateway for server discovery
                var handlerForMcp = !string.IsNullOrEmpty(authHandlerName)
                    ? authHandlerName
                    : OboAuthHandlerName ?? AgenticAuthHandlerName ?? string.Empty;
                var tokenOverride = string.IsNullOrEmpty(authHandlerName) ? accessToken : null;

                allTools = await _toolService.GetMcpToolsAsync(agentId, UserAuthorization, handlerForMcp, context, tokenOverride).ConfigureAwait(false);
            }

            var w365Tools = FilterW365Tools(allTools);
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
            return name.StartsWith("W365_", StringComparison.OrdinalIgnoreCase);
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
            return !name.StartsWith("W365_", StringComparison.OrdinalIgnoreCase);
        }).ToList();

        if (additionalTools != null && additionalTools.Count > 0)
        {
            _logger.LogInformation("Found {ToolCount} additional function tools: {Names}",
                additionalTools.Count,
                string.Join(", ", additionalTools.Select(t => (t as AIFunction)?.Name ?? "?")));
        }

        return additionalTools;
    }
}
