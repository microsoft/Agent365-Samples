// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

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

    private readonly string? AgenticAuthHandlerName;
    private readonly string? OboAuthHandlerName;

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
                        // Non-CUA fast path: load tools, run orchestrator with the computer tool
                        // withheld. Supports function-tool paths (mail/calendar/etc.) without
                        // engaging the CUA loop.
                        var (_, nonCuaAdditionalTools) = await GetToolsAsync(turnContext, ToolAuthHandlerName);
                        var directResponse = await _orchestrator.RunAsync(
                            conversationId,
                            userText,
                            w365Tools: [],
                            additionalTools: nonCuaAdditionalTools,
                            graphAccessToken: null,
                            onStatusUpdate: status => turnContext.StreamingResponse.QueueInformativeUpdateAsync(status),
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
                    // result before the acknowledgment.
                    await turnContext.SendActivityAsync(MessageFactory.Text("Got it — working on it…"), cancellationToken).ConfigureAwait(false);

                    var (w365Tools, additionalTools) = await GetToolsAsync(turnContext, ToolAuthHandlerName);

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

                    // Get Graph token for OneDrive screenshot upload via the agentic auth handler.
                    string? graphToken = null;
                    if (!string.IsNullOrEmpty(ToolAuthHandlerName))
                    {
                        graphToken = await UserAuthorization.GetTurnTokenAsync(turnContext, ToolAuthHandlerName);
                    }

                    // Run the CUA loop — session is managed per conversation
                    var response = await _orchestrator.RunAsync(
                        conversationId,
                        userText,
                        w365Tools,
                        additionalTools: additionalTools,
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
                            MessageFactory.Text($"📸 Screenshots for this request: [View folder]({url})"), cancellationToken),
                        cancellationToken: cancellationToken);

                    // Send the response
                    turnContext.StreamingResponse.QueueTextChunk(response);
                }
                finally
                {
                    try { await turnContext.StreamingResponse.EndStreamAsync(cancellationToken).ConfigureAwait(false); }
                    catch (ObjectDisposedException) { /* stream already disposed */ }
                }
            });
    }

    /// <summary>
    /// Get MCP tools from the A365 SDK's tooling gateway, separated into W365 (CUA) and
    /// additional (function) tools by name. The SDK loads all tools registered to the
    /// agent's blueprint in a single call.
    /// </summary>
    private async Task<(IList<AITool>? W365Tools, IList<AITool>? AdditionalTools)> GetToolsAsync(ITurnContext context, string? authHandlerName)
    {
        string? accessToken = null;
        string? agentId = null;

        if (!string.IsNullOrEmpty(authHandlerName))
        {
            accessToken = await UserAuthorization.GetTurnTokenAsync(context, authHandlerName);
            agentId = Utility.ResolveAgentIdentity(context, accessToken);
        }

        if (string.IsNullOrEmpty(accessToken) || string.IsNullOrEmpty(agentId))
        {
            _logger.LogWarning("No auth token or agent identity available. Cannot connect to MCP.");
            return (null, null);
        }

        try
        {
            var handlerForMcp = !string.IsNullOrEmpty(authHandlerName)
                ? authHandlerName
                : OboAuthHandlerName ?? AgenticAuthHandlerName ?? string.Empty;

            var allTools = await _toolService.GetMcpToolsAsync(agentId, UserAuthorization, handlerForMcp, context).ConfigureAwait(false);

            return (FilterW365Tools(allTools), FilterAdditionalTools(allTools));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to connect to MCP servers.");
            throw;
        }
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
