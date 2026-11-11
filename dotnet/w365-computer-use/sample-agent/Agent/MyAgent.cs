// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.IdentityModel.Tokens.Jwt;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using W365ComputerUseSample.Authentication;
using W365ComputerUseSample.ComputerUse;
using W365ComputerUseSample.ScreenShare;
using W365ComputerUseSample.Telemetry;
using Microsoft.Agents.A365.Runtime.Utils;
using Microsoft.Agents.A365.Tooling.Extensions.AgentFramework.Services;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App;
using Microsoft.Agents.Builder.State;
using Microsoft.Agents.Core;
using Microsoft.Agents.Core.Models;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;
using ModelContextProtocol.Client;

namespace W365ComputerUseSample.Agent;

public class MyAgent : AgentApplication
{
    private const string AgentWelcomeMessage = "Hello! I can help you perform tasks on a Windows 365 Cloud PC. Tell me what you'd like to do.";
    private const string AgentHireMessage = "Thank you for hiring me! I can control a Windows desktop to accomplish tasks for you.";
    private const string AgentFarewellMessage = "Thank you for your time, I enjoyed working with you.";
    private const string HumanResourceLimitation = "Human W365 sessions do not yet support this sample's agent-authenticated screen-share links or OneDrive screenshot uploads. The separate W365 sign-in link is still available when required.";
    private const string HumanIdentityGuidance = "Human W365 sign-in requires a verified chat sender. Enable TokenValidation and use an authenticated channel that supplies GUID Activity.Conversation.TenantId and Activity.From.AadObjectId. A validated Bot Framework channel or allowlisted Agent 365 Teams delivery caller can attest the sender; direct-user JWTs must carry matching tid and oid claims. Ask your administrator to verify the channel's sender attribution; unsupported channel mappings cannot be inferred. No W365 connection was attempted.";
    private const string TurnIntentCacheKey = "W365ComputerUseSample.TurnIntent";

    private readonly Agent365TelemetryOptions _telemetryOptions;
    private readonly ILogger<MyAgent> _logger;
    private readonly IMcpToolRegistrationService _toolService;
    private readonly ComputerUseOrchestrator _orchestrator;
    private readonly string[] _mcpServerUrls;
    private readonly ScreenShareOptions _screenShareOptions;
    private readonly HandoffStore _handoffStore;
    private readonly bool _incomingJwtEnabled;
    private readonly Guid[] _incomingJwtAudiences;

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
    private readonly string? W365AuthHandlerName;

    /// <summary>
    /// ARI (screenshare) agentic handler. Defaults to "ari" but is only wired in when a matching
    /// handler is configured under AgentApplication:UserAuthorization:Handlers — otherwise it stays
    /// null and screenshare link emission is skipped (no ARI token available).
    /// </summary>
    private readonly string? ScreenShareAuthHandlerName;

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
        IMcpToolRegistrationService toolService,
        ComputerUseOrchestrator orchestrator,
        IOptions<ScreenShareOptions> screenShareOptions,
        IOptions<Agent365TelemetryOptions> telemetryOptions,
        HandoffStore handoffStore,
        ILogger<MyAgent> logger) : base(options)
    {
        _logger = logger;
        _toolService = toolService;
        _orchestrator = orchestrator;
        _screenShareOptions = screenShareOptions.Value;
        _telemetryOptions = telemetryOptions.Value;
        _handoffStore = handoffStore;
        var tokenValidation = configuration.GetSection("TokenValidation");
        _incomingJwtEnabled = tokenValidation.Exists() && tokenValidation.GetValue("Enabled", true);
        _incomingJwtAudiences = (tokenValidation.GetSection("Audiences").Get<string[]>() ?? [])
            .Select(value => Guid.TryParse(value, out var id) ? id : Guid.Empty)
            .Where(id => id != Guid.Empty).ToArray();

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
        W365AuthHandlerName = configuration.GetValue<string>("AgentApplication:W365AuthHandlerName");

        // ARI (screenshare) agentic handler. Only wired in when a matching handler section exists;
        // otherwise it stays null and no screenshare link is emitted.
        var ariHandlerName = configuration.GetValue<string>("AgentApplication:ScreenShareAuthHandlerName") ?? "ari";
        ScreenShareAuthHandlerName =
            configuration.GetSection($"AgentApplication:UserAuthorization:Handlers:{ariHandlerName}").Exists()
                ? ariHandlerName
                : null;

        // Greet when members are added
        OnConversationUpdate(ConversationUpdateEvents.MembersAdded, WelcomeMessageAsync);

        // Compute auth handler arrays once
        var agenticHandlers = new[] { AgenticAuthHandlerName, W365AuthHandlerName, ScreenShareAuthHandlerName }
            .OfType<string>()
            .Where(handler => !string.IsNullOrEmpty(handler))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        // Handle install/uninstall
        OnActivity(ActivityTypes.InstallationUpdate, OnInstallationUpdateAsync, isAgenticOnly: true, autoSignInHandlers: agenticHandlers);
        OnActivity(ActivityTypes.InstallationUpdate, OnInstallationUpdateAsync, isAgenticOnly: false);

        // Handle messages — MUST BE AFTER any other message handlers
        // SDK route auto-sign-in runs before the handler. Select hosted human turns first,
        // without agent resource sign-in; keep the existing automatic auth on all other routes.
        OnMessage(ShouldDeferAgenticSignInAsync, OnMessageAsync, isAgenticOnly: true);
        OnActivity(ActivityTypes.Message, OnMessageAsync, isAgenticOnly: true, autoSignInHandlers: agenticHandlers);
        OnActivity(ActivityTypes.Message, OnMessageAsync, isAgenticOnly: false);
    }

    private async Task<bool> ShouldDeferAgenticSignInAsync(ITurnContext turnContext, CancellationToken cancellationToken)
    {
        if (HumanW365ChatActions.TryRead(turnContext.Activity.Value, out _))
            return true;
        if (IsDevelopment())
            return false;

        var localSessionKey = BuildLocalSessionKey(
            turnContext.Activity.Conversation?.Id ?? string.Empty, turnContext.Activity.From);
        if (_orchestrator.UsesHumanW365Authentication(localSessionKey))
            return true;

        try
        {
            var intent = await ClassifyTurnOnceAsync(turnContext, localSessionKey,
                turnContext.Activity.Text?.Trim() ?? string.Empty, cancellationToken);
            return intent.SessionOptions.SessionKind == "human"
                || _orchestrator.UsesHumanW365Authentication(localSessionKey);
        }
        catch (InvalidOperationException)
        {
            // Let OnMessageAsync report the cached routing error without acquiring resources.
            return true;
        }
    }

    private Task<ComputerUseOrchestrator.TurnIntent> ClassifyTurnOnceAsync(
        ITurnContext turnContext, string localSessionKey, string userText, CancellationToken cancellationToken)
    {
        HumanW365Owner? humanOwner = null;
        if (_orchestrator.UsesHumanW365Authentication(localSessionKey))
        {
            var (owner, failureReason) = TryGetHumanW365Owner(turnContext);
            if (owner == null)
                throw new InvalidOperationException($"{HumanIdentityGuidance} Diagnostic code: `{failureReason}`.");
            humanOwner = owner;
        }
        var intent = turnContext.Services.Get<Task<ComputerUseOrchestrator.TurnIntent>>(TurnIntentCacheKey);
        if (intent == null)
        {
            intent = _orchestrator.ClassifyTurnAsync(localSessionKey, userText, cancellationToken, humanOwner);
            turnContext.Services.Set(TurnIntentCacheKey, intent);
        }
        return intent;
    }

    protected async Task WelcomeMessageAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {
        var observabilityAuthHandlerName = turnContext.IsAgenticRequest() ? AgenticAuthHandlerName : null;
        await A365OtelWrapper.InvokeObservedAgentOperation(
            "WelcomeMessage",
            turnContext,
            turnState,
            cancellationToken,
            _telemetryOptions,
            UserAuthorization,
            observabilityAuthHandlerName ?? string.Empty,
            _logger,
            async () =>
            {
                var recipientId = turnContext.Activity.Recipient.Id;
                var newMembers = turnContext.Activity.MembersAdded.Where(m => m.Id != recipientId);
                var sentWelcomeMessage = false;
                foreach (var _ in newMembers)
                {
                    await turnContext.SendActivityAsync(AgentWelcomeMessage);
                    sentWelcomeMessage = true;
                }

                return sentWelcomeMessage ? AgentWelcomeMessage : null;
            });
    }

    protected async Task OnInstallationUpdateAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {
        var observabilityAuthHandlerName = turnContext.IsAgenticRequest() ? AgenticAuthHandlerName : null;
        await A365OtelWrapper.InvokeObservedAgentOperation(
            "InstallationUpdate",
            turnContext,
            turnState,
            cancellationToken,
            _telemetryOptions,
            UserAuthorization,
            observabilityAuthHandlerName ?? string.Empty,
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
                    return AgentHireMessage;
                }
                else if (turnContext.Activity.Action == InstallationUpdateActionTypes.Remove)
                {
                    await turnContext.SendActivityAsync(MessageFactory.Text(AgentFarewellMessage), cancellationToken);
                    return AgentFarewellMessage;
                }

                return null;
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

        // Agentic observability uses the agentic handler. Hosted human W365 authentication
        // is selected after classification, before legacy tool/token acquisition.
        var ObservabilityAuthHandlerName = turnContext.IsAgenticRequest() ? AgenticAuthHandlerName : null;
        var ToolAuthHandlerName = ObservabilityAuthHandlerName;

        await A365OtelWrapper.InvokeObservedAgentOperation(
            "MessageProcessor",
            turnContext,
            turnState,
            cancellationToken,
            _telemetryOptions,
            UserAuthorization,
            ObservabilityAuthHandlerName ?? string.Empty,
            _logger,
            async () =>
            {
                var followUpActivities = new List<IActivity>();
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
                    if (HumanW365ChatActions.TryRead(turnContext.Activity.Value, out var chatAction))
                    {
                        var actionResponse = chatAction == null
                            ? "This request action is invalid. Use the latest card in the original chat, or reply \"continue\" or \"end my session\"."
                            : await RunHumanW365TurnAsync(turnContext, localSessionKey, conversationId, userText,
                                new ComputerUseOrchestrator.TurnIntent(true, ComputerUseOrchestrator.PendingTaskAction.Resume, new()),
                                false, cancellationToken, followUpActivities, chatAction);
                        turnContext.StreamingResponse.QueueTextChunk(actionResponse);
                        return actionResponse;
                    }
                    var screenShareRequest = IsScreenShareLinkRequest(userText);
                    var wasHumanRequest = _orchestrator.UsesHumanW365Authentication(localSessionKey);
                    if (screenShareRequest && wasHumanRequest)
                    {
                        turnContext.StreamingResponse.QueueTextChunk(HumanResourceLimitation);
                        return HumanResourceLimitation;
                    }

                    // Step 1: classify intent with a cheap tool-less LLM call. If the message
                    // doesn't need desktop control ("hi", "summarize my inbox", etc.) we skip
                    // W365 tool loading and explicit session startup entirely. Classify even a
                    // new screenshare request so an explicit human kind cannot reach agent APIs.
                    ComputerUseOrchestrator.TurnIntent intent;
                    try
                    {
                        intent = await ClassifyTurnOnceAsync(turnContext, localSessionKey, userText, cancellationToken);
                    }
                    catch (InvalidOperationException ex)
                    {
                        turnContext.StreamingResponse.QueueTextChunk(ex.Message);
                        return ex.Message;
                    }

                    wasHumanRequest = _orchestrator.UsesHumanW365Authentication(localSessionKey);
                    var hostedHumanRequest = !IsDevelopment()
                        && (intent.SessionOptions.SessionKind == "human" || wasHumanRequest);
                    if (screenShareRequest)
                    {
                        string reply;
                        if (wasHumanRequest || hostedHumanRequest)
                        {
                            reply = HumanResourceLimitation;
                        }
                        else
                        {
                            var (ssFound, ssSessionId, ssUrl) = await _orchestrator
                                .TryGetActiveScreenShareAsync(localSessionKey, cancellationToken)
                                .ConfigureAwait(false);
                            if (ssFound)
                            {
                                var freshLink = await BuildScreenSharePageUrlAsync(turnContext, ssSessionId, ssUrl)
                                    .ConfigureAwait(false);
                                reply = freshLink != null
                                    ? $"🖥️ Watch this session live: [Open screen share]({freshLink})"
                                    : "I couldn't generate a screen share link right now. Please try again in a moment.";
                            }
                            else
                            {
                                reply = "There's no active Windows 365 session yet. Ask me to do something on the desktop first, then I can share a live link.";
                            }
                        }
                        turnContext.StreamingResponse.QueueTextChunk(reply);
                        return reply;
                    }

                    if (!intent.NeedsCua)
                    {
                        HumanW365Turn? humanTurn = null;
                        if (_orchestrator.UsesHumanW365Authentication(localSessionKey))
                        {
                            var (owner, failureReason) = TryGetHumanW365Owner(turnContext);
                            if (owner == null)
                            {
                                var guidance = $"{HumanIdentityGuidance} Diagnostic code: `{failureReason}`.";
                                turnContext.StreamingResponse.QueueTextChunk(guidance);
                                return guidance;
                            }
                            humanTurn = new HumanW365Turn(owner, _w365GatewayUrl, turnContext);
                        }
                        // Non-CUA fast path: with the current CUA-only ToolingManifest, skip MCP
                        // discovery entirely so chit-chat never touches W365.
                        var (_, nonCuaAdditionalTools, _, _, _) = await GetToolsAsync(turnContext, ToolAuthHandlerName, includeW365: false, localSessionKey, cancellationToken);
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
                            humanTurn: humanTurn,
                            telemetryConversationId: conversationId,
                            telemetryChannelId: turnContext.Activity.ChannelId,
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

                    if (hostedHumanRequest)
                    {
                        var humanResponse = await RunHumanW365TurnAsync(
                            turnContext, localSessionKey, conversationId, userText, intent,
                            !wasHumanRequest, cancellationToken, followUpActivities);
                        turnContext.StreamingResponse.QueueTextChunk(humanResponse);
                        return humanResponse;
                    }

                    // Announce first W365 connection setup only when we don't already have W365 tools cached.
                    // Explicit session startup is announced separately from the CUA loop.
                    var willAcquireFreshSession = _orchestrator.GetSelectedW365SessionId(localSessionKey) == null;
                    if (willAcquireFreshSession)
                    {
                        await turnContext.StreamingResponse.QueueInformativeUpdateAsync("Connecting to Windows 365 Computer Use tools…");
                    }

                    // Get MCP tools — direct connection in Dev, SDK in Production
                    var (w365Tools, additionalTools, mcpClient, prestartedW365SessionId, prestartedScreenShareUrl) = await GetToolsAsync(turnContext, ToolAuthHandlerName, includeW365: true, localSessionKey, cancellationToken);

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
                        string? cloudPcSignInUrl = null;
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
                            onScreenShareLinkReady: async (sessionId, screenShareUrl) =>
                            {
                                var link = await BuildScreenSharePageUrlAsync(turnContext, sessionId, screenShareUrl)
                                    .ConfigureAwait(false);
                                if (link != null)
                                {
                                    await turnContext.SendActivityAsync(
                                        MessageFactory.Text($"🖥️ Watch this session live: [Open screen share]({link})"),
                                        cancellationToken);
                                }
                            },
                            prestartedW365SessionId: prestartedW365SessionId,
                            prestartedScreenShareUrl: prestartedScreenShareUrl,
                            telemetryConversationId: conversationId,
                            telemetryChannelId: turnContext.Activity.ChannelId,
                            cancellationToken: cancellationToken,
                            pendingTaskAction: intent.TaskAction,
                            sessionOptions: intent.SessionOptions,
                            onCloudPcSignInRequired: url => cloudPcSignInUrl = url);

                        if (cloudPcSignInUrl != null)
                        {
                            var message = MessageFactory.Text(response);
                            message.Attachments = [HumanW365ChatActions.CreateSignInCard(cloudPcSignInUrl, cloudPc: true)];
                            turnContext.StreamingResponse.FinalMessage = message;
                        }
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
                    await CompleteResponseAsync(turnContext, followUpActivities, cancellationToken).ConfigureAwait(false);
                }
            });
    }

    private static async Task CompleteResponseAsync(
        ITurnContext turnContext, IReadOnlyCollection<IActivity> followUpActivities, CancellationToken cancellationToken)
    {
        StreamingResponseResult? result = null;
        try { result = await turnContext.StreamingResponse.EndStreamAsync(cancellationToken).ConfigureAwait(false); }
        catch (ObjectDisposedException) { /* stream already disposed */ }
        if (followUpActivities.Count > 0 && result != StreamingResponseResult.Success)
            throw new InvalidOperationException($"The sign-in message could not be completed ({result?.ToString() ?? "disposed"}). Request controls were not sent.");
        // Finalize the sign-in activity before sending independent request controls.
        foreach (var activity in followUpActivities)
            await turnContext.SendActivityAsync(activity, cancellationToken).ConfigureAwait(false);
    }

    private async Task<string> RunHumanW365TurnAsync(
        ITurnContext turnContext, string localSessionKey, string conversationId, string userText,
        ComputerUseOrchestrator.TurnIntent intent, bool includeResourceLimitation,
        CancellationToken cancellationToken, ICollection<IActivity> followUpActivities, HumanW365ChatAction? chatAction = null)
    {
        var (owner, failureReason) = TryGetHumanW365Owner(turnContext);
        if (owner == null)
            return $"{HumanIdentityGuidance} Diagnostic code: `{failureReason}`.";

        string? actionRequestId = null;
        string? signInUrl = null;
        string? cloudPcSignInUrl = null;
        // No agent resource authentication on this route. State and action binding are
        // checked under the orchestrator's existing turn lock before transport is used.
        var response = await _orchestrator.RunAsync(
            localSessionKey,
            userText,
            w365Tools: [],
            graphAccessToken: null,
            onStatusUpdate: status => turnContext.StreamingResponse.QueueInformativeUpdateAsync(status),
            telemetryConversationId: conversationId,
            telemetryChannelId: turnContext.Activity.ChannelId,
            cancellationToken: cancellationToken,
            pendingTaskAction: intent.TaskAction,
            sessionOptions: intent.SessionOptions,
            humanTurn: new HumanW365Turn(owner, _w365GatewayUrl, turnContext, chatAction, (id, link) =>
            {
                actionRequestId = id;
                signInUrl = link;
            }),
            onCloudPcSignInRequired: url => cloudPcSignInUrl = url);
        if (includeResourceLimitation && _orchestrator.UsesHumanW365Authentication(localSessionKey))
            response += "\n\n" + HumanResourceLimitation;
        if (actionRequestId != null && signInUrl != null)
        {
            var message = MessageFactory.Text(response);
            message.Attachments = [HumanW365ChatActions.CreateSignInCard(signInUrl)];
            turnContext.StreamingResponse.FinalMessage = message;
            var controls = MessageFactory.Text("Continue your saved request after signing in, or cancel it. Cancel request clears the saved request or ends its existing Cloud PC session.");
            controls.Attachments = [HumanW365ChatActions.CreateControlsCard(actionRequestId)];
            followUpActivities.Add(controls);
        }
        else if (cloudPcSignInUrl != null)
        {
            var message = MessageFactory.Text(response);
            message.Attachments = [HumanW365ChatActions.CreateSignInCard(cloudPcSignInUrl, cloudPc: true)];
            turnContext.StreamingResponse.FinalMessage = message;
        }
        return response;
    }

    private (HumanW365Owner? Owner, string? FailureReason) TryGetHumanW365Owner(ITurnContext turnContext)
    {
        (HumanW365Owner?, string?) Reject(string reason)
        {
            _logger.LogWarning("Human W365 sender verification rejected. ReasonCode={ReasonCode}", reason);
            return (null, reason);
        }

        if (!_incomingJwtEnabled)
            return Reject("incoming_jwt_validation_disabled");
        if (!Guid.TryParse(turnContext.Activity.Conversation?.TenantId, out var tenantId) || tenantId == Guid.Empty)
            return Reject("activity_tenant_id_missing_or_invalid");
        if (!Guid.TryParse(turnContext.Activity.From?.AadObjectId, out var objectId) || objectId == Guid.Empty)
            return Reject("activity_sender_object_id_missing_or_invalid");

        if (turnContext.Identity is not HumanW365IncomingIdentity { IsAuthenticated: true } identity)
            return Reject("incoming_jwt_identity_unavailable");

        var issuers = identity.ValidatedClaims.Where(c => c.Type == "iss")
            .Select(c => c.Value).Distinct(StringComparer.Ordinal).ToArray();
        if (issuers.Length != 1 || string.IsNullOrWhiteSpace(issuers[0]))
            return Reject("jwt_issuer_missing_or_ambiguous");
        if (issuers[0] == "https://api.botframework.com")
            return (new HumanW365Owner(tenantId, objectId), null);

        // JwtBearer can map the Entra claims to their schema names. Require one unambiguous
        // GUID value across both spellings; never infer identity from display name or email.
        bool MatchesClaim(Guid expected, string name, string mappedName)
        {
            var claims = identity.ValidatedClaims.Where(c => c.Type == name || c.Type == mappedName).ToArray();
            if (claims.Length > 0 && claims.All(c => Guid.TryParse(c.Value, out var id) && id == expected))
                return true;

            var status = claims.Length == 0 ? "missing"
                : claims.Any(c => !Guid.TryParse(c.Value, out _)) ? "malformed"
                : claims.Select(c => Guid.Parse(c.Value)).Distinct().Skip(1).Any() ? "conflicting"
                : "mismatch";
            _logger.LogWarning(
                "Human W365 validated sender claim check failed. ClaimKind={ClaimKind}; ClaimStatus={ClaimStatus}",
                name, status);
            return false;
        }
        if (!MatchesClaim(tenantId, "tid", "http://schemas.microsoft.com/identity/claims/tenantid"))
            return Reject("jwt_tenant_does_not_match_activity");
        // Agent365 authenticates the delivery caller, not the human in Activity.From.
        // EasyAuth still independently verifies that human before binding W365 credentials.
        if (identity.AttestsTeamsSender(issuers[0], tenantId, turnContext.Activity.ChannelId))
            return (new HumanW365Owner(tenantId, objectId), null);
        if (!MatchesClaim(objectId, "oid", "http://schemas.microsoft.com/identity/claims/objectidentifier"))
        {
            identity.LogSubjectDiagnostics(_logger, _incomingJwtAudiences);
            return Reject("jwt_sender_does_not_match_activity");
        }
        return (new HumanW365Owner(tenantId, objectId), null);
    }

    /// <summary>
    /// Get MCP tools, separated into W365 (CUA) and additional (function) tools.
    /// In Development mode with a bearer token, connects directly to the MCP server URL.
    /// In Production, uses the A365 SDK to discover servers via the Tooling Gateway.
    /// When <paramref name="includeW365"/> is <c>false</c>, the W365 server(s) are skipped —
    /// used on the non-CUA fast path so chit-chat never starts a Cloud PC session.
    /// </summary>
    private async Task<(IList<AITool>? W365Tools, IList<AITool>? AdditionalTools, IMcpClient? Client, string? PrestartedW365SessionId, string? PrestartedScreenShareUrl)> GetToolsAsync(
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
            agentId = !includeW365 || context.IsAgenticRequest() ? Utility.ResolveAgentIdentity(context, accessToken) : null;
        }
        else if (TryGetBearerTokenForDevelopment(out var bearerToken))
        {
            _logger.LogInformation("Using bearer token from environment.");
            accessToken = bearerToken;
            agentId = !includeW365 || context.IsAgenticRequest() ? Utility.ResolveAgentIdentity(context, accessToken!) : null;
        }

        if (includeW365 && !IsDevelopment())
        {
            var w365AuthHandlerName = W365AuthHandlerName ?? authHandlerName;
            if (!string.IsNullOrEmpty(w365AuthHandlerName))
            {
                accessToken = await UserAuthorization.GetTurnTokenAsync(context, w365AuthHandlerName);
                agentId = context.IsAgenticRequest() ? Utility.ResolveAgentIdentity(context, accessToken) : null;
            }
        }

        if (string.IsNullOrEmpty(accessToken) || (!includeW365 && string.IsNullOrEmpty(agentId)))
        {
            _logger.LogWarning("No compatible auth token or required identity available. Cannot connect to MCP.");
            return (null, null, null, null, null);
        }

        try
        {
            IList<AITool>? allTools;
            IMcpClient? mcpClient = null;

            if (includeW365)
            {
                var development = IsDevelopment() && TryGetBearerTokenForDevelopment(out _);
                var endpoint = development
                    ? _w365McpServerUrls.FirstOrDefault()
                        ?? throw new InvalidOperationException("Configure a W365 MCP endpoint in McpServers or McpServer:Url for Development mode.")
                    : _w365GatewayUrl;
                var result = await _orchestrator.ConnectDirectW365Async(
                    endpoint, accessToken!, agentId, context,
                    localSessionKey ?? throw new InvalidOperationException("A conversation key is required for W365."),
                    cancellationToken);
                var otherTools = development
                    ? await _orchestrator.GetOrCreateNonW365McpConnectionAsync(_otherMcpServerUrls, accessToken!)
                    : Array.Empty<AITool>();
                return (result.Tools, otherTools, result.Client, null, null);
            }

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
                _logger.LogInformation("Skipping production MCP tool discovery for non-CUA turn while ToolingManifest is restricted to W365 CUA.");
                return (null, Array.Empty<AITool>(), null, null, null);
            }

            var w365Tools = includeW365 ? FilterW365Tools(allTools) : null;
            var additionalTools = FilterAdditionalTools(allTools);
            return (w365Tools, additionalTools, mcpClient, null, null);
        }
        catch (Exception ex)
        {
            if (ShouldSkipToolingOnErrors())
            {
                _logger.LogWarning(ex, "Failed to connect to MCP servers. Continuing without tools (SKIP_TOOLING_ON_ERRORS=true).");
                return (null, null, null, null, null);
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

    /// <summary>
    /// True when the user is asking for a (fresh) screen-share link. Requires an explicit
    /// "screen share" mention plus an intent word so it doesn't swallow normal desktop tasks.
    /// </summary>
    private static bool IsScreenShareLinkRequest(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return false;
        var t = text.ToLowerInvariant();

        var mentionsScreenShare = t.Contains("screen share")
            || t.Contains("screenshare")
            || t.Contains("screen-share");
        if (!mentionsScreenShare) return false;

        return t.Contains("link")
            || t.Contains("again")
            || t.Contains("new")
            || t.Contains("another")
            || t.Contains("fresh")
            || t.Contains("resend")
            || t.Contains("re-send")
            || t.Contains("regenerate")
            || t.Contains("watch");
    }

    /// <summary>
    /// Mints the ARI bearer token in-turn, stores a one-time <see cref="HandoffRecord"/> keyed by
    /// <paramref name="sessionId"/>, and returns the chat link (which carries only an opaque
    /// <c>sid</c>+<c>hc</c>, never the token). Returns <c>null</c> when <c>ScreenShare:PageBaseUrl</c>
    /// is unconfigured or no token/URL is available.
    /// </summary>
    private async Task<string?> BuildScreenSharePageUrlAsync(ITurnContext turnContext, string sessionId, string screenShareUrl)
    {
        if (string.IsNullOrWhiteSpace(screenShareUrl))
        {
            _logger.LogDebug("No screenShareUrl on platform response — skipping screenshare link emission");
            return null;
        }

        // PageBaseUrl precedence: explicit config > WEBSITE_HOSTNAME (Azure App Service
        // auto-populates this) > null (skip).
        var pageBaseUrl = _screenShareOptions.PageBaseUrl;
        if (string.IsNullOrWhiteSpace(pageBaseUrl) || pageBaseUrl.Contains("<<", StringComparison.Ordinal))
        {
            var hostname = Environment.GetEnvironmentVariable("WEBSITE_HOSTNAME");
            pageBaseUrl = string.IsNullOrWhiteSpace(hostname) ? null : $"https://{hostname}";
        }
        if (string.IsNullOrWhiteSpace(pageBaseUrl))
        {
            _logger.LogWarning("ScreenShare:PageBaseUrl not configured and WEBSITE_HOSTNAME not set — skipping screenshare link emission");
            return null;
        }

        // 1. Mint the ARI bearer token. The ARI_BEARER_TOKEN env override mirrors the existing
        //    BEARER_TOKEN dev pattern for local testing.
        var ariToken = Environment.GetEnvironmentVariable("ARI_BEARER_TOKEN");
        if (string.IsNullOrEmpty(ariToken))
        {
            // No ARI handler configured and no token override — nothing to mint.
            if (string.IsNullOrEmpty(ScreenShareAuthHandlerName))
            {
                _logger.LogDebug("No ARI auth handler configured and ARI_BEARER_TOKEN not set — skipping screenshare link");
                return null;
            }

            try
            {
                ariToken = await UserAuthorization.GetTurnTokenAsync(turnContext, ScreenShareAuthHandlerName).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to acquire ARI token via UserAuthorization '{Handler}' handler — skipping screenshare link", ScreenShareAuthHandlerName);
                return null;
            }
        }
        if (string.IsNullOrEmpty(ariToken))
        {
            _logger.LogWarning("ARI token not available (GetTurnTokenAsync '{Handler}' returned empty) — skipping screenshare link", ScreenShareAuthHandlerName ?? "ari");
            return null;
        }

        // 2. Parse the JWT expiry; -5 min keeps the SDK off the expiry boundary.
        DateTime safeExp;
        try
        {
            var parsed = new JwtSecurityTokenHandler().ReadJwtToken(ariToken);
            // ValidTo is DateTime.MinValue when the token has no/unparsable exp claim — require a
            // usable, still-valid expiry rather than emitting an already-expired link.
            if (parsed.ValidTo == DateTime.MinValue || parsed.ValidTo <= DateTime.UtcNow)
            {
                _logger.LogWarning("ARI token has no usable expiry (ValidTo={ValidTo:o}) — skipping screenshare link", parsed.ValidTo);
                return null;
            }
            safeExp = parsed.ValidTo.AddMinutes(-5);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to parse ARI token JWT — skipping screenshare link");
            return null;
        }

        // 3. Generate a one-time handoff code (256-bit). The raw value travels in the chat link;
        //    only its SHA-256 hash is kept server-side.
        var rawHc = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var hcHash = SHA256.HashData(Encoding.UTF8.GetBytes(rawHc));

        // 4. Capture owner identity (fail-closed: oid must be present).
        var ownerOid = turnContext.Activity.From?.AadObjectId;
        if (string.IsNullOrEmpty(ownerOid))
        {
            _logger.LogWarning("Activity.From.AadObjectId is missing — cannot bind screenshare link to a user; skipping");
            return null;
        }

        // 5. Persist the record with a 5-minute handoff TTL.
        _handoffStore.Set(sessionId, new HandoffRecord
        {
            ScreenShareUrl = screenShareUrl,
            OwnerAadObjectId = ownerOid,
            HandoffCodeHash = hcHash,
            HandoffExpiresAtUtc = DateTime.UtcNow.AddMinutes(5),
            AriToken = ariToken,
            AriTokenExpiresAtUtc = safeExp
        });

        // 6. Build the link — sid + hc only, never the token or the screenShareUrl.
        var baseUrl = pageBaseUrl!.TrimEnd('/');
        var qs = $"sid={Uri.EscapeDataString(sessionId)}&hc={Uri.EscapeDataString(rawHc)}";
        return $"{baseUrl}/screenshare.html?{qs}";
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
        return ExtractQuotedField(description, "ExceptionMessage=")
            ?? ExtractQuotedField(description, "Message=")
            ?? (string.IsNullOrWhiteSpace(description) ? null : description);
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
