// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Agent365AgentFrameworkSampleAgent.Tools;
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
using System.Text;
using System.Text.Json;

namespace Agent365AgentFrameworkSampleAgent.Agent
{
    public class MyAgent : AgentApplication
    {
        private const string AgentWelcomeMessage = "Hello! I can help you find information based on what I can access.";
        private const string AgentHireMessage = "Thank you for hiring me! Looking forward to assisting you in your professional journey!";
        private const string AgentFarewellMessage = "Thank you for your time, I enjoyed working with you.";

        // Non-interpolated raw string so {{ToolName}} placeholders are preserved as literal text.
        // {userName} is the only dynamic token and is injected via string.Replace in GetAgentInstructions.
        private static readonly string AgentInstructionsTemplate = """
        You will speak like a friendly and professional virtual assistant.

        The user's name is {userName}. Use their name naturally where appropriate — for example when greeting them, confirming actions, or making responses feel personal. Do not overuse it.

        For questions about yourself, you should use the one of the tools: {{mcp_graph_getMyProfile}}, {{mcp_graph_getUserProfile}}, {{mcp_graph_getMyManager}}, {{mcp_graph_getUsersManager}}.

        If you are working with weather information, the following instructions apply:
        Location is a city name, 2 letter US state codes should be resolved to the full name of the United States State.
        You may ask follow up questions until you have enough information to answer the customers question, but once you have the current weather or a forecast, make sure to format it nicely in text.
        - For current weather, Use the {{WeatherLookupTool.GetCurrentWeatherForLocation}}, you should include the current temperature, low and high temperatures, wind speed, humidity, and a short description of the weather.
        - For forecast's, Use the {{WeatherLookupTool.GetWeatherForecastForLocation}}, you should report on the next 5 days, including the current day, and include the date, high and low temperatures, and a short description of the weather.
        - You should use the {{DateTimePlugin.GetDateTime}} to get the current date and time.

        Otherwise you should use the tools available to you to help answer the user's questions.
        """;

        private static string GetAgentInstructions(string? userName)
        {
            // Sanitize the display name before injecting into the system prompt to prevent prompt injection.
            // Activity.From.Name is channel-provided and therefore untrusted user-controlled text.
            string safe = string.IsNullOrWhiteSpace(userName) ? "unknown" : userName.Trim();
            // Strip control characters (newlines, tabs, etc.) that could break prompt structure
            safe = System.Text.RegularExpressions.Regex.Replace(safe, @"[\p{Cc}\p{Cf}]", " ").Trim();
            // Enforce a reasonable max length
            if (safe.Length > 64) safe = safe[..64].TrimEnd();
            if (string.IsNullOrWhiteSpace(safe)) safe = "unknown";
            return AgentInstructionsTemplate.Replace("{userName}", safe, StringComparison.Ordinal);
        }

        private readonly IChatClient? _chatClient = null;
        private readonly IConfiguration? _configuration = null;
        private readonly ILogger<MyAgent>? _logger = null;
        private readonly IMcpToolRegistrationService? _toolService = null;
        // Setup reusable auto sign-in handlers for user authorization (configurable via appsettings.json)
        private readonly string? AgenticAuthHandlerName;
        private readonly string? OboAuthHandlerName;
        // Temp
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
        /// This is only allowed in Development environment AND when SKIP_TOOLING_ON_ERRORS is explicitly set to "true".
        /// </summary>
        private static bool ShouldSkipToolingOnErrors()
        {
            var environment = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") ?? 
                              Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT") ?? 
                              "Production";
            
            var skipToolingOnErrors = Environment.GetEnvironmentVariable("SKIP_TOOLING_ON_ERRORS");
            
            // Only allow skipping tooling errors in Development mode AND when explicitly enabled
            return environment.Equals("Development", StringComparison.OrdinalIgnoreCase) && 
                   !string.IsNullOrEmpty(skipToolingOnErrors) && 
                   skipToolingOnErrors.Equals("true", StringComparison.OrdinalIgnoreCase);
        }

        public MyAgent(AgentApplicationOptions options,
            IChatClient chatClient,
            IConfiguration configuration,
            IMcpToolRegistrationService toolService,
            ILogger<MyAgent> logger) : base(options)
        {
            _chatClient = chatClient;
            _configuration = configuration;
            _logger = logger;
            _toolService = toolService;

            // Read auth handler names from configuration (can be empty/null to disable)
            AgenticAuthHandlerName = _configuration.GetValue<string>("AgentApplication:AgenticAuthHandlerName");
            OboAuthHandlerName = _configuration.GetValue<string>("AgentApplication:OboAuthHandlerName");

            // Greet when members are added to the conversation
            OnConversationUpdate(ConversationUpdateEvents.MembersAdded, WelcomeMessageAsync);

            // Compute auth handler arrays once; reused for all agentic/OBO activity registrations below.
            var agenticHandlers = !string.IsNullOrEmpty(AgenticAuthHandlerName) ? [AgenticAuthHandlerName] : Array.Empty<string>();
            var oboHandlers = !string.IsNullOrEmpty(OboAuthHandlerName) ? [OboAuthHandlerName] : Array.Empty<string>();

            // Handle agent install / uninstall events (agentInstanceCreated / InstallationUpdate).
            // Dual registration: agentic (A365 production) and non-agentic (Playground / WebChat).
            OnActivity(ActivityTypes.InstallationUpdate, OnInstallationUpdateAsync, isAgenticOnly: true, autoSignInHandlers: agenticHandlers);
            OnActivity(ActivityTypes.InstallationUpdate, OnInstallationUpdateAsync, isAgenticOnly: false);

            // Listen for ANY message to be received. MUST BE AFTER ANY OTHER MESSAGE HANDLERS
            // Agentic requests use the agentic auth handler (if configured)
            OnActivity(ActivityTypes.Message, OnMessageAsync, isAgenticOnly: true, autoSignInHandlers: agenticHandlers);
            // Non-agentic requests (Playground, WebChat) use OBO auth handler (if configured)
            OnActivity(ActivityTypes.Message, OnMessageAsync, isAgenticOnly: false, autoSignInHandlers: oboHandlers);
        }

        protected async Task WelcomeMessageAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
        {
            foreach (ChannelAccount member in (turnContext.Activity.MembersAdded ?? [])
                .Where(m => m.Id != turnContext.Activity.Recipient.Id))
            {
                await turnContext.SendActivityAsync(AgentWelcomeMessage);
            }
        }

        /// <summary>
        /// Handles agent install and uninstall events (agentInstanceCreated / InstallationUpdate).
        /// Sends a welcome message on install and a farewell on uninstall.
        /// </summary>
        protected async Task OnInstallationUpdateAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
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
        }

        /// <summary>
        /// General Message process for Teams and other channels.
        /// </summary>
        /// <param name="turnContext"></param>
        /// <param name="turnState"></param>
        /// <param name="cancellationToken"></param>
        /// <returns></returns>
        protected async Task OnMessageAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
        {
            if (turnContext is null)
            {
                throw new ArgumentNullException(nameof(turnContext));
            }

            // Log the user identity from Activity.From — set by the A365 platform on every message.
            var fromAccount = turnContext.Activity.From;
            _logger?.LogDebug(
                "Turn received from user — DisplayName: '{Name}', UserId: '{Id}', AadObjectId: '{AadObjectId}'",
                fromAccount?.Name ?? "(unknown)",
                fromAccount?.Id ?? "(unknown)",
                fromAccount?.AadObjectId ?? "(none)");

            // Select the appropriate auth handler based on request type
            // For agentic requests, use the agentic auth handler
            // For non-agentic requests, use OBO auth handler (supports bearer token or configured auth)
            string? ToolAuthHandlerName;
            if (turnContext.IsAgenticRequest())
            {
                ToolAuthHandlerName = AgenticAuthHandlerName;
            }
            else
            {
                // Non-agentic: use OBO auth handler if configured
                ToolAuthHandlerName = OboAuthHandlerName;
            }

            // Send an immediate acknowledgment — this arrives as a separate message before the LLM response.
            // Each SendActivityAsync call produces a discrete Teams message, enabling the multiple-messages pattern.
            // NOTE: For Teams agentic identities, streaming is buffered into a single message by the SDK;
            //       use SendActivityAsync for any messages that must arrive immediately.
            await turnContext.SendActivityAsync(MessageFactory.Text("Got it — working on it…"), cancellationToken).ConfigureAwait(false);

            // Send typing indicator immediately on the main thread (awaited so it arrives before the LLM call starts).
            await turnContext.SendActivityAsync(Activity.CreateTypingActivity(), cancellationToken).ConfigureAwait(false);

            // Background loop refreshes the "..." animation every ~4s (it times out after ~5s).
            // Only visible in 1:1 and small group chats.
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

            // StreamingResponse is best-effort: in Teams with agentic identity the SDK may buffer/downscale it.
            // The ack + typing loop above handle the immediate UX; streaming remains for non-Teams / WebChat clients.
            await turnContext.StreamingResponse.QueueInformativeUpdateAsync("Just a moment please..").ConfigureAwait(false);
            try
            {
                var userTextBuilder = new StringBuilder(turnContext.Activity.Text?.Trim() ?? string.Empty);
                var _agent = await GetClientAgent(turnContext, turnState, _toolService, ToolAuthHandlerName);

                // Read or Create the conversation session for this conversation.
                AgentSession? session = await GetConversationSessionAsync(_agent, turnState, cancellationToken);

                if (turnContext.Activity?.Attachments?.Count > 0)
                {
                    foreach (var attachment in turnContext.Activity.Attachments)
                    {
                        if (attachment.ContentType == "application/vnd.microsoft.teams.file.download.info" && !string.IsNullOrEmpty(attachment.ContentUrl))
                        {
                            userTextBuilder.Append($"\n\n[User has attached a file: {attachment.Name}. The file can be downloaded from {attachment.ContentUrl}]");
                        }
                    }
                }
                var userText = userTextBuilder.ToString();

                // Stream the response back to the user as we receive it from the agent.
                await foreach (var response in _agent!.RunStreamingAsync(userText, session, cancellationToken: cancellationToken))
                {
                    if (response.Role == ChatRole.Assistant && !string.IsNullOrEmpty(response.Text))
                    {
                        turnContext.StreamingResponse.QueueTextChunk(response.Text);
                    }
                }
                var serializedSession = await _agent!.SerializeSessionAsync(session!);
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
                    // Expected: typingTask is canceled when typingCts is canceled; no further action required.
                }
                await turnContext.StreamingResponse.EndStreamAsync(cancellationToken).ConfigureAwait(false);
            }
        }


        /// <summary>
        /// Resolve the ChatClientAgent with tools and options for this turn operation. 
        /// This will use the IChatClient registered in DI.
        /// </summary>
        /// <param name="context"></param>
        /// <returns></returns>
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

            // Activity.From.Name is always available — no API call needed.
            var displayName = context.Activity.From?.Name;

            // Create the local tools:
            var toolList = new List<AITool>();
            WeatherLookupTool weatherLookupTool = new(context, _configuration!);
            DateTimeFunctionTool dateTimeTool = new();
            toolList.Add(AIFunctionFactory.Create(dateTimeTool.GetCurrentDateTime));
            toolList.Add(AIFunctionFactory.Create(weatherLookupTool.GetCurrentWeatherForLocation));
            toolList.Add(AIFunctionFactory.Create(weatherLookupTool.GetWeatherForecastForLocation));

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

                        // For the bearer token (development) flow, pass the token as an override and
                        // use OboAuthHandlerName (or fall back to AgenticAuthHandlerName) as the handler.
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

            // Create Chat Options with tools and instructions:
            var toolOptions = new ChatOptions
            {
                Temperature = (float?)0.2,
                Tools = toolList,
                Instructions = GetAgentInstructions(displayName)
            };

            // Create the chat Client passing in agent instructions and tools:
            return new ChatClientAgent(_chatClient!,
                    new ChatClientAgentOptions
                    {
                        ChatOptions = toolOptions,
                        ChatHistoryProvider = new InMemoryChatHistoryProvider(new InMemoryChatHistoryProviderOptions
                        {
#pragma warning disable MEAI001 // MessageCountingChatReducer is for evaluation purposes only and is subject to change or removal in future updates
                            ChatReducer = new MessageCountingChatReducer(10)
#pragma warning restore MEAI001 // MessageCountingChatReducer is for evaluation purposes only and is subject to change or removal in future updates
                        })
                    })
                .AsBuilder()
                .UseOpenTelemetry(sourceName: null, (cfg) => cfg.EnableSensitiveData = true)
                .Build();
        }

        /// <summary>
        /// Manage Agent threads against the conversation state.
        /// </summary>
        /// <param name="agent">ChatAgent</param>
        /// <param name="turnState">State Manager for the Agent.</param>
        /// <returns></returns>
        private static async Task<AgentSession> GetConversationSessionAsync(AIAgent? agent, ITurnState turnState, CancellationToken cancellationToken = default)
        {
            ArgumentNullException.ThrowIfNull(agent);
            string? agentThreadInfo = turnState.Conversation.GetValue<string?>("conversation.threadInfo", () => null);
            if (string.IsNullOrEmpty(agentThreadInfo))
            {
                return await agent.CreateSessionAsync(cancellationToken);
            }
            else
            {
                JsonElement ele = ProtocolJsonSerializer.ToObject<JsonElement>(agentThreadInfo);
                return await agent.DeserializeSessionAsync(ele, cancellationToken: cancellationToken);
            }
        }

        private string GetToolCacheKey(ITurnState turnState)
        {
            string userToolCacheKey = turnState.User.GetValue<string?>("user.toolCacheKey", () => null) ?? "";
            if (string.IsNullOrEmpty(userToolCacheKey))
            {
                userToolCacheKey = Guid.NewGuid().ToString();
                turnState.User.SetValue("user.toolCacheKey", userToolCacheKey);
                return userToolCacheKey;
            }
            return userToolCacheKey;
        }

    }
}
