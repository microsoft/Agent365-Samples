// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Agent365AgentFrameworkSampleAgent.telemetry;
using Agent365AgentFrameworkSampleAgent.Tools;
using Microsoft.Agents.A365.Observability.Hosting.Caching;
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

namespace Agent365AgentFrameworkSampleAgent.Agent
{
    public class MyAgent : AgentApplication
    {
        private readonly string AgentWelcomeMessage = "Hello! I can help you find information based on what I can access";

        private readonly string AgentInstructions = """
        You will speak like a friendly and professional virtual assistant.

        For questions about yourself, you should use the one of the tools: {{mcp_graph_getMyProfile}}, {{mcp_graph_getUserProfile}}, {{mcp_graph_getMyManager}}, {{mcp_graph_getUsersManager}}.

        If you are working with weather information, the following instructions apply:
        Location is a city name, 2 letter US state codes should be resolved to the full name of the United States State.
        You may ask follow up questions until you have enough information to answer the customers question, but once you have the current weather or a forecast, make sure to format it nicely in text.
        - For current weather, Use the {{WeatherLookupTool.GetCurrentWeatherForLocation}}, you should include the current temperature, low and high temperatures, wind speed, humidity, and a short description of the weather.
        - For forecast's, Use the {{WeatherLookupTool.GetWeatherForecastForLocation}}, you should report on the next 5 days, including the current day, and include the date, high and low temperatures, and a short description of the weather.
        - You should use the {{DateTimePlugin.GetDateTime}} to get the current date and time.

        Otherwise you should use the tools available to you to help answer the user's questions.
        """;

        private readonly IChatClient? _chatClient = null;
        private readonly IConfiguration? _configuration = null;
        private readonly IExporterTokenCache<AgenticTokenStruct>? _agentTokenCache = null;
        private readonly ILogger<MyAgent>? _logger = null;
        private readonly IMcpToolRegistrationService? _toolService = null;
        // Setup reusable auto sign-in handlers
        // Setup reusable auto sign-in handler for agentic requests
        private readonly string AgenticIdAuthHandler = "agentic";
        // Setup reusable auto sign-in handler for OBO (On-Behalf-Of) authentication
        private readonly string MyAuthHandler = "me";
        // Temp
        private static readonly ConcurrentDictionary<string, List<AITool>> _agentToolCache = new();

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

            // Greet when members are added to the conversation
            OnConversationUpdate(ConversationUpdateEvents.MembersAdded, WelcomeMessageAsync);

            // Handle A365 Notification Messages. 

            // Listen for ANY message to be received. MUST BE AFTER ANY OTHER MESSAGE HANDLERS
            // Agentic requests require the "agentic" handler for user authorization
            OnActivity(ActivityTypes.Message, OnMessageAsync, isAgenticOnly: true, autoSignInHandlers: new[] { AgenticIdAuthHandler });
            // Non-agentic requests use OBO authentication via the "me" handler
            OnActivity(ActivityTypes.Message, OnMessageAsync, isAgenticOnly: false, autoSignInHandlers: new[] { MyAuthHandler });
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

        /// <summary>
        /// General Message process for Teams and other channels. 
        /// </summary>
        /// <param name="turnContext"></param>
        /// <param name="turnState"></param>
        /// <param name="cancellationToken"></param>
        /// <returns></returns>
        protected async Task OnMessageAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
        {
            // Select the appropriate auth handler based on request type
            string ObservabilityAuthHandlerName = "";
            string ToolAuthHandlerName = "";
            if (turnContext.IsAgenticRequest())
                ObservabilityAuthHandlerName = ToolAuthHandlerName = AgenticIdAuthHandler;
            else
                ObservabilityAuthHandlerName = ToolAuthHandlerName = MyAuthHandler;


            await A365OtelWrapper.InvokeObservedAgentOperation(
                "MessageProcessor",
                turnContext,
                turnState,
                _agentTokenCache,
                UserAuthorization,
                ObservabilityAuthHandlerName,
                _logger,
                async () =>
            {
                // Start a Streaming Process to let clients that support streaming know that we are processing the request. 
                await turnContext.StreamingResponse.QueueInformativeUpdateAsync("Just a moment please..").ConfigureAwait(false);
                try
                {
                    var userText = turnContext.Activity.Text?.Trim() ?? string.Empty;
                    var _agent = await GetClientAgent(turnContext, turnState, _toolService, ToolAuthHandlerName);

                    // Read or Create the conversation thread for this conversation.
                    AgentThread? thread = GetConversationThread(_agent, turnState);

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

                    // Stream the response back to the user as we receive it from the agent.
                    await foreach (var response in _agent!.RunStreamingAsync(userText, thread, cancellationToken: cancellationToken))
                    {
                        if (response.Role == ChatRole.Assistant && !string.IsNullOrEmpty(response.Text))
                        {
                            turnContext?.StreamingResponse.QueueTextChunk(response.Text);
                        }
                    }
                    turnState.Conversation.SetValue("conversation.threadInfo", ProtocolJsonSerializer.ToJson(thread.Serialize()));
                }
                finally
                {
                    await turnContext.StreamingResponse.EndStreamAsync(cancellationToken).ConfigureAwait(false); // End the streaming response
                }
            });
        }


        /// <summary>
        /// Resolve the ChatClientAgent with tools and options for this turn operation. 
        /// This will use the IChatClient registered in DI.
        /// </summary>
        /// <param name="context"></param>
        /// <returns></returns>
        private async Task<AIAgent?> GetClientAgent(ITurnContext context, ITurnState turnState, IMcpToolRegistrationService? toolService, string authHandlerName)
        {
            AssertionHelpers.ThrowIfNull(_configuration!, nameof(_configuration));
            AssertionHelpers.ThrowIfNull(context, nameof(context));
            AssertionHelpers.ThrowIfNull(_chatClient!, nameof(_chatClient));

            // Create the local tools we want to register with the agent:
            var toolList = new List<AITool>();

            // Setup the local tool to be able to access the AgentSDK current context,UserAuthorization and other services can be accessed from here as well.
            WeatherLookupTool weatherLookupTool = new(context, _configuration!);

            // Setup the tools for the agent:
            toolList.Add(AIFunctionFactory.Create(DateTimeFunctionTool.getDate));
            toolList.Add(AIFunctionFactory.Create(weatherLookupTool.GetCurrentWeatherForLocation));
            toolList.Add(AIFunctionFactory.Create(weatherLookupTool.GetWeatherForecastForLocation));

            if (toolService != null)
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
                        // Notify the user we are loading tools
                        await context.StreamingResponse.QueueInformativeUpdateAsync("Loading tools...");

                        string agentId = Utility.ResolveAgentIdentity(context, await UserAuthorization.GetTurnTokenAsync(context, authHandlerName));
                        var a365Tools = await toolService.GetMcpToolsAsync(agentId, UserAuthorization, authHandlerName, context).ConfigureAwait(false);

                        // Add the A365 tools to the tool options
                        if (a365Tools != null && a365Tools.Count > 0)
                        {
                            toolList.AddRange(a365Tools);
                            _agentToolCache.TryAdd(toolCacheKey, [.. a365Tools]);
                        }
                    }
                }
                catch (Exception ex)
                {
                    // Log error and rethrow - MCP tool registration is required
                    _logger?.LogError(ex, "Failed to register MCP tool servers. Ensure MCP servers are configured correctly or use mock MCP servers for local testing.");
                    throw;
                }
            }

            // Create Chat Options with tools:
            var toolOptions = new ChatOptions
            {
                Temperature = (float?)0.2,
                Tools = toolList
            };

            // Create the chat Client passing in agent instructions and tools: 
            return new ChatClientAgent(_chatClient!,
                    new ChatClientAgentOptions
                    {
                        Instructions = AgentInstructions,
                        ChatOptions = toolOptions,
                        ChatMessageStoreFactory = ctx =>
                        {
#pragma warning disable MEAI001 // MessageCountingChatReducer is for evaluation purposes only and is subject to change or removal in future updates
                            return new InMemoryChatMessageStore(new MessageCountingChatReducer(10), ctx.SerializedState, ctx.JsonSerializerOptions);
#pragma warning restore MEAI001 // MessageCountingChatReducer is for evaluation purposes only and is subject to change or removal in future updates
                        }
                    })
                .AsBuilder()
                .UseOpenTelemetry(sourceName: AgentMetrics.SourceName, (cfg) => cfg.EnableSensitiveData = true)
                .Build();
        }

        /// <summary>
        /// Manage Agent threads against the conversation state.
        /// </summary>
        /// <param name="agent">ChatAgent</param>
        /// <param name="turnState">State Manager for the Agent.</param>
        /// <returns></returns>
        private static AgentThread GetConversationThread(AIAgent? agent, ITurnState turnState)
        {
            ArgumentNullException.ThrowIfNull(agent);
            AgentThread thread;
            string? agentThreadInfo = turnState.Conversation.GetValue<string?>("conversation.threadInfo", () => null);
            if (string.IsNullOrEmpty(agentThreadInfo))
            {
                thread = agent.GetNewThread();
            }
            else
            {
                JsonElement ele = ProtocolJsonSerializer.ToObject<JsonElement>(agentThreadInfo);
                thread = agent.DeserializeThread(ele);
            }
            return thread;
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
