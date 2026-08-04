// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Agent365ClaudeSampleAgent.telemetry;
using Agent365ClaudeSampleAgent.Tools;
using Microsoft.Agents.A365.Observability.Caching;
using Microsoft.Agents.A365.Runtime.Utils;
using Microsoft.Agents.A365.Tooling.Extensions.AgentFramework.Services;
using Microsoft.Agents.AI;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App;
using Microsoft.Agents.Builder.State;
using Microsoft.Agents.Core;
using Microsoft.Agents.Core.Models;
using Microsoft.Agents.Core.Serialization;
using Microsoft.Extensions.AI;
using System.Collections.Concurrent;
using System.Text.Json;

namespace Agent365ClaudeSampleAgent.Agent
{
    public class MyAgent : AgentApplication
    {
        private const string AgentWelcomeMessage = "Hello! I'm a Claude-powered agent. I can help you find information based on what I can access.";
        private const string AgentHireMessage = "Thank you for hiring me! I'm powered by Claude and ready to assist you.";
        private const string AgentFarewellMessage = "Thank you for your time, I enjoyed working with you.";

        // Non-interpolated raw string so {{ToolName}} placeholders are preserved as literal text.
        // {userName} is the only dynamic token and is injected via string.Replace in GetAgentInstructions.
        private static readonly string AgentInstructionsTemplate = """
        You will speak like a friendly and professional virtual assistant.

        The user's name is {userName}. Use their name naturally where appropriate — for example when greeting them, confirming actions, or making responses feel personal. Do not overuse it.

        For questions about yourself, you should use one of the tools: {{mcp_graph_getMyProfile}}, {{mcp_graph_getUserProfile}}, {{mcp_graph_getMyManager}}, {{mcp_graph_getUsersManager}}.

        You should use the {{DateTimeFunctionTool.getDate}} to get the current date and time when needed.

        Otherwise you should use the tools available to you to help answer the user's questions.
        """;

        private static string GetAgentInstructions(string? userName)
        {
            // Sanitize the display name before injecting into the system prompt to prevent prompt injection.
            string safe = string.IsNullOrWhiteSpace(userName) ? "unknown" : userName.Trim();
            safe = System.Text.RegularExpressions.Regex.Replace(safe, @"[\p{Cc}\p{Cf}]", " ").Trim();
            if (safe.Length > 64) safe = safe[..64].TrimEnd();
            if (string.IsNullOrWhiteSpace(safe)) safe = "unknown";
            return AgentInstructionsTemplate.Replace("{userName}", safe, StringComparison.Ordinal);
        }

        private readonly IChatClient? _chatClient = null;
        private readonly IConfiguration? _configuration = null;
        private readonly IExporterTokenCache<AgenticTokenStruct>? _agentTokenCache = null;
        private readonly ILogger<MyAgent>? _logger = null;
        private readonly IMcpToolRegistrationService? _toolService = null;
        private readonly string? AgenticAuthHandlerName;
        private readonly string? OboAuthHandlerName;
        private static readonly ConcurrentDictionary<string, List<AITool>> _agentToolCache = new();

        /// <summary>
        /// Check if a bearer token is available in the environment for development/testing.
        /// </summary>
        public static bool TryGetBearerTokenForDevelopment(out string? bearerToken)
        {
            bearerToken = Environment.GetEnvironmentVariable("BEARER_TOKEN");
            return !string.IsNullOrEmpty(bearerToken);
        }

        /// <summary>
        /// Checks if graceful fallback to bare LLM mode is enabled when MCP tools fail to load.
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

        public MyAgent(AgentApplicationOptions options,
            IChatClient chatClient,
            IConfiguration configuration,
            IExporterTokenCache<AgenticTokenStruct> agentTokenCache,
            IMcpToolRegistrationService toolService,
            ILogger<MyAgent> logger) : base(options)
        {
            _chatClient = chatClient;
            _configuration = configuration;
            _agentTokenCache = agentTokenCache;
            _logger = logger;
            _toolService = toolService;

            AgenticAuthHandlerName = _configuration.GetValue<string>("AgentApplication:AgenticAuthHandlerName");
            OboAuthHandlerName = _configuration.GetValue<string>("AgentApplication:OboAuthHandlerName");

            OnConversationUpdate(ConversationUpdateEvents.MembersAdded, WelcomeMessageAsync);

            var agenticHandlers = !string.IsNullOrEmpty(AgenticAuthHandlerName) ? [AgenticAuthHandlerName] : Array.Empty<string>();
            var oboHandlers = !string.IsNullOrEmpty(OboAuthHandlerName) ? [OboAuthHandlerName] : Array.Empty<string>();

            // Handle agent install / uninstall events
            OnActivity(ActivityTypes.InstallationUpdate, OnInstallationUpdateAsync, isAgenticOnly: true, autoSignInHandlers: agenticHandlers);
            OnActivity(ActivityTypes.InstallationUpdate, OnInstallationUpdateAsync, isAgenticOnly: false);

            // Listen for messages — agentic and non-agentic paths
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
                _logger?.LogInformation(
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
            _logger?.LogDebug(
                "Turn received from user — DisplayName: '{Name}', UserId: '{Id}', AadObjectId: '{AadObjectId}'",
                fromAccount?.Name ?? "(unknown)",
                fromAccount?.Id ?? "(unknown)",
                fromAccount?.AadObjectId ?? "(none)");

            // Select appropriate auth handler based on request type
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
                // Send immediate acknowledgment
                await turnContext.SendActivityAsync(MessageFactory.Text("Got it — working on it…"), cancellationToken).ConfigureAwait(false);

                // Send typing indicator
                await turnContext.SendActivityAsync(Activity.CreateTypingActivity(), cancellationToken).ConfigureAwait(false);

                // Background typing loop
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
                    catch (OperationCanceledException) { /* expected on cancel */ }
                }, typingCts.Token);

                await turnContext.StreamingResponse.QueueInformativeUpdateAsync("Just a moment please..").ConfigureAwait(false);
                try
                {
                    var userText = turnContext.Activity.Text?.Trim() ?? string.Empty;
                    var _agent = await GetClientAgent(turnContext, turnState, _toolService, ToolAuthHandlerName);

                    // Read or create the conversation session for this conversation.
                    AgentSession session = await GetConversationSessionAsync(_agent, turnState, cancellationToken).ConfigureAwait(false);

                    if (turnContext?.Activity?.Attachments?.Count > 0)
                    {
                        foreach (var attachment in turnContext.Activity.Attachments)
                        {
                            if (attachment.ContentType == "application/vnd.microsoft.teams.file.download.info" && !string.IsNullOrEmpty(attachment.ContentUrl))
                            {
                                userText += $"\n\n[User has attached a file: {attachment.Name}. The file can be downloaded from {attachment.ContentUrl}]";
                            }
                        }
                    }

                    // Stream the response back to the user
                    await foreach (var response in _agent!.RunStreamingAsync(userText, session, cancellationToken: cancellationToken))
                    {
                        if (response.Role == ChatRole.Assistant && !string.IsNullOrEmpty(response.Text))
                        {
                            turnContext?.StreamingResponse.QueueTextChunk(response.Text);
                        }
                    }
                    JsonElement serializedSession = await _agent!.SerializeSessionAsync(session, cancellationToken: cancellationToken).ConfigureAwait(false);
                    turnState.Conversation.SetValue("conversation.threadInfo", ProtocolJsonSerializer.ToJson(serializedSession));
                }
                finally
                {
                    typingCts.Cancel();
                    try
                    {
                        await typingTask.ConfigureAwait(false);
                    }
                    catch (OperationCanceledException)
                    {
                        // Expected
                    }
                    await turnContext.StreamingResponse.EndStreamAsync(cancellationToken).ConfigureAwait(false);
                }
            });
        }

        /// <summary>
        /// Resolve the ChatClientAgent with tools and options for this turn.
        /// Uses the IChatClient backed by Anthropic.SDK registered in DI.
        /// </summary>
        private async Task<AIAgent?> GetClientAgent(ITurnContext context, ITurnState turnState, IMcpToolRegistrationService? toolService, string? authHandlerName)
        {
            AssertionHelpers.ThrowIfNull(_configuration!, nameof(_configuration));
            AssertionHelpers.ThrowIfNull(context, nameof(context));
            AssertionHelpers.ThrowIfNull(_chatClient!, nameof(_chatClient));

            // Acquire the access token once for this turn — used for MCP tool loading.
            string? accessToken = null;
            string? agentId = null;
            if (!string.IsNullOrEmpty(authHandlerName))
            {
                accessToken = await UserAuthorization.GetTurnTokenAsync(context, authHandlerName);
                agentId = Utility.ResolveAgentIdentity(context, accessToken);
            }
            else if (TryGetBearerTokenForDevelopment(out var bearerToken))
            {
                _logger?.LogInformation("Using bearer token from environment. Length: {Length}", bearerToken?.Length ?? 0);
                accessToken = bearerToken;
                agentId = Utility.ResolveAgentIdentity(context, accessToken!);
                _logger?.LogInformation("Resolved agentId: '{AgentId}'", agentId ?? "(null)");
            }
            else
            {
                _logger?.LogWarning("No auth handler or bearer token available. MCP tools will not be loaded.");
            }

            if (!string.IsNullOrEmpty(accessToken) && string.IsNullOrEmpty(agentId))
            {
                _logger?.LogWarning("Access token was acquired but agent identity could not be resolved. MCP tools will not be loaded.");
            }

            var displayName = context.Activity.From?.Name;

            // Create local tools
            var toolList = new List<AITool>();
            toolList.Add(AIFunctionFactory.Create(DateTimeFunctionTool.getDate));

            // Load MCP tools from A365 platform
            if (toolService != null && !string.IsNullOrEmpty(agentId))
            {
                try
                {
                    string toolCacheKey = GetToolCacheKey(turnState);
                    if (_agentToolCache.ContainsKey(toolCacheKey))
                    {
                        var cachedTools = _agentToolCache[toolCacheKey];
                        if (cachedTools != null && cachedTools.Count > 0)
                        {
                            toolList.AddRange(cachedTools);
                        }
                    }
                    else
                    {
                        await context.StreamingResponse.QueueInformativeUpdateAsync("Loading tools...");

                        var handlerForMcp = !string.IsNullOrEmpty(authHandlerName)
                            ? authHandlerName
                            : OboAuthHandlerName ?? AgenticAuthHandlerName ?? string.Empty;
                        var tokenOverride = string.IsNullOrEmpty(authHandlerName) ? accessToken : null;

                        var a365Tools = await toolService.GetMcpToolsAsync(agentId, UserAuthorization, handlerForMcp, context, tokenOverride).ConfigureAwait(false);

                        if (a365Tools != null && a365Tools.Count > 0)
                        {
                            toolList.AddRange(a365Tools);
                            _agentToolCache.TryAdd(toolCacheKey, [.. a365Tools]);
                        }
                    }
                }
                catch (Exception ex)
                {
                    if (ShouldSkipToolingOnErrors())
                    {
                        _logger?.LogWarning(ex, "Failed to register MCP tool servers. Continuing without MCP tools (SKIP_TOOLING_ON_ERRORS=true).");
                    }
                    else
                    {
                        _logger?.LogError(ex, "Failed to register MCP tool servers.");
                        throw;
                    }
                }
            }

            // Create Chat Options with tools. In Microsoft.Agents.AI 1.0.0-rc4 the
            // ChatClientAgentOptions no longer exposes an "Instructions" property;
            // the system instructions are supplied via ChatOptions.Instructions.
            // ModelId is required by Anthropic.SDK — it maps to the "model" field
            // in the Anthropic Messages API request (e.g. "claude-sonnet-4-20250514").
            var modelId = _configuration?["AIServices:Anthropic:ModelId"] ?? "claude-sonnet-4-20250514";
            var toolOptions = new ChatOptions
            {
                ModelId = modelId,
                Temperature = (float?)0.2,
                Tools = toolList,
                Instructions = GetAgentInstructions(displayName)
            };

            // Create the ChatClientAgent with Claude-backed IChatClient.
            // In rc4 the former ChatMessageStoreFactory was replaced by ChatHistoryProvider;
            // conversation state is driven by AgentSession (serialized by the agent).
            return new ChatClientAgent(_chatClient!,
                    new ChatClientAgentOptions
                    {
                        ChatOptions = toolOptions,
                        ChatHistoryProvider = new InMemoryChatHistoryProvider()
                    })
                .AsBuilder()
                .UseOpenTelemetry(sourceName: AgentMetrics.SourceName, (cfg) => cfg.EnableSensitiveData = true)
                .Build();
        }

        private static async Task<AgentSession> GetConversationSessionAsync(AIAgent? agent, ITurnState turnState, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(agent);
            string? agentThreadInfo = turnState.Conversation.GetValue<string?>("conversation.threadInfo", () => null);
            if (string.IsNullOrEmpty(agentThreadInfo))
            {
                return await agent.CreateSessionAsync(cancellationToken).ConfigureAwait(false);
            }

            JsonElement ele = ProtocolJsonSerializer.ToObject<JsonElement>(agentThreadInfo);
            return await agent.DeserializeSessionAsync(ele, cancellationToken: cancellationToken).ConfigureAwait(false);
        }

        private static string GetToolCacheKey(ITurnState turnState)
        {
            string userToolCacheKey = turnState.User.GetValue<string?>("user.toolCacheKey", () => null) ?? "";
            if (string.IsNullOrEmpty(userToolCacheKey))
            {
                userToolCacheKey = Guid.NewGuid().ToString();
                turnState.User.SetValue("user.toolCacheKey", userToolCacheKey);
            }
            return userToolCacheKey;
        }

    }
}
