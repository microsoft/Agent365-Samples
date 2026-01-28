// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using NotificationAgent.Tools;
using Microsoft.Agents.A365.Notifications.Models;
using AgentNotification;
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

namespace NotificationAgent.Agent
{
    public class MyAgent : AgentApplication
    {
        private readonly string AgentInstructions = """
        You are a helpful assistant. 
        """;

        private readonly IChatClient? _chatClient = null;
        private readonly IConfiguration? _configuration = null;
        private readonly ILogger<MyAgent>? _logger = null;
        private readonly IMcpToolRegistrationService? _toolService = null;
        private readonly IHttpClientFactory _httpClientFactory;

        // Setup reusable auto sign-in handler for agentic requests
        private readonly string AgenticIdAuthHandler = "agentic";

        private static readonly ConcurrentDictionary<string, List<AITool>> _agentToolCache = new();

        public MyAgent(AgentApplicationOptions options,
            IChatClient chatClient,
            IConfiguration configuration,
            IMcpToolRegistrationService toolService,
            IHttpClientFactory httpClientFactory,
            ILogger<MyAgent> logger) : base(options)
        {
            _chatClient = chatClient;
            _configuration = configuration;
            _logger = logger;
            _toolService = toolService;
            _httpClientFactory = httpClientFactory;

            // Handle A365 Notification Messages. 
            this.OnAgenticWordNotification(HandleWordCommentNotificationAsync, autoSignInHandlers: new[] { AgenticIdAuthHandler });
            this.OnAgenticEmailNotification(HandleEmailNotificationAsync, autoSignInHandlers: new[] { AgenticIdAuthHandler });

            // Handles all messages, regardless of channel - needs to be the last route in order not to hijack A365 nofification handlers.
            this.OnActivity(ActivityTypes.Message, OnMessageAsync, autoSignInHandlers: new[] { AgenticIdAuthHandler });
        }

        private async Task HandleEmailNotificationAsync(
   ITurnContext turnContext,
   ITurnState turnState,
   AgentNotificationActivity activity,
   CancellationToken cancellationToken)
        {
            var email = activity.EmailNotification;

            if (email == null)
            {
                await turnContext.SendActivityAsync("No email data found",
                    cancellationToken: cancellationToken);
                return;
            }

            if (string.IsNullOrEmpty(email.Id))
            {
                await turnContext.SendActivityAsync("Email ID is missing",
                    cancellationToken: cancellationToken);
                return;
            }

            var userText = turnContext.Activity.Text?.Trim() ?? string.Empty;
            var agent = await GetClientAgent(turnContext, turnState, _toolService, AgenticIdAuthHandler, "You are a helpful assistant.");

            if (agent == null)
            {
                await turnContext.SendActivityAsync("Failed to initialize agent",
                    cancellationToken: cancellationToken);
                return;
            }

            var response = await agent.RunAsync(
                $"""
                You have received a mail and your task is to reply to it. Please respond to the
                mail using the ReplyToMessageAsync tool using HTML formatted content. The ID of
                the email is {email.Id}. This is the content of the mail you received: {userText}
                """);

            _logger?.LogInformation("Agent response: {Response}", response.ToString());
        }

        private async Task HandleWordCommentNotificationAsync(
           ITurnContext turnContext,
           ITurnState turnState,
           AgentNotificationActivity activity,
           CancellationToken cancellationToken)
        {
            var comment = activity.WpxCommentNotification;

            var attachments = turnContext.Activity.Attachments;
            if (attachments == null || attachments.Count == 0)
            {
                await turnContext.SendActivityAsync("No attachments found",
                    cancellationToken: cancellationToken);
                return;
            }

            var contentUrl = attachments[0].ContentUrl;
            if (string.IsNullOrEmpty(contentUrl))
            {
                await turnContext.SendActivityAsync("No content URL found in attachment",
                    cancellationToken: cancellationToken);
                return;
            }

            if (comment == null)
            {
                await turnContext.SendActivityAsync("No comment data found",
                    cancellationToken: cancellationToken);
                return;
            }

            var userText = turnContext.Activity.Text?.Trim() ?? string.Empty;
            var agent = await GetClientAgent(turnContext, turnState, _toolService, AgenticIdAuthHandler);

            if (agent == null)
            {
                await turnContext.SendActivityAsync("Failed to initialize agent",
                    cancellationToken: cancellationToken);
                return;
            }

            var response = await agent.RunAsync(
                $"""
                Your task is to respond to a comment in a word file. First, get the full content
                of the word file to understand the context and find out what the comment is
                referring to. Use the tool WordGetDocumentContent for this purpose. The URL to
                the document is {contentUrl}. Then find the text the comment with id
                {comment.CommentId} is referring to and respond with an answer.
                """);

            _logger?.LogInformation("Agent response: {Response}", response.ToString());

            //Note that we don't respond at the end of this method - we instead let the Word MCP Server handle the reply to the comment.

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

            var userText = turnContext.Activity.Text?.Trim() ?? string.Empty;
            var agent = await GetClientAgent(turnContext, turnState, _toolService, AgenticIdAuthHandler);

            // Read or Create the conversation thread for this conversation.
            AgentThread? thread = GetConversationThread(agent, turnState);

            var response = await agent!.RunAsync(userText, thread, cancellationToken: cancellationToken);

            await turnContext.SendActivityAsync(response.ToString());

            turnState.Conversation.SetValue("conversation.threadInfo", ProtocolJsonSerializer.ToJson(thread.Serialize()));
        }

        /// <summary>
        /// Resolve the ChatClientAgent with tools and options for this turn operation. 
        /// This will use the IChatClient registered in DI.
        /// </summary>
        /// <param name="context"></param>
        /// <returns></returns>
        private async Task<AIAgent?> GetClientAgent(ITurnContext context, ITurnState turnState, IMcpToolRegistrationService? toolService, string authHandlerName, string agentInstructions = null)
        {
            AssertionHelpers.ThrowIfNull(_configuration!, nameof(_configuration));
            AssertionHelpers.ThrowIfNull(context, nameof(context));
            AssertionHelpers.ThrowIfNull(_chatClient!, nameof(_chatClient));

            // Create the local tools we want to register with the agent:
            var toolList = new List<AITool>();

            // Setup the tools for the agent:
            toolList.Add(AIFunctionFactory.Create(DateTimeFunctionTool.getDate));    

            if (toolService != null)
            {
                try
                {
                    string toolCacheKey = GetToolCacheKey(turnState);
                    if (_agentToolCache.TryGetValue(toolCacheKey, out var cachedTools) && cachedTools?.Count > 0)
                    {
                        toolList.AddRange(cachedTools);
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
                Tools = toolList
            };

            if(agentInstructions == null)
            {
                agentInstructions = AgentInstructions;
            }

            // Create the chat Client passing in agent instructions and tools: 
            var chatClientAgent = new ChatClientAgent(_chatClient!,
                    new ChatClientAgentOptions
                    {           
                        ChatOptions = toolOptions,
                        ChatMessageStoreFactory = ctx =>
                        {
#pragma warning disable MEAI001 // MessageCountingChatReducer is for evaluation purposes only and is subject to change or removal in future updates
                            return new InMemoryChatMessageStore(new MessageCountingChatReducer(10), ctx.SerializedState, ctx.JsonSerializerOptions);
#pragma warning restore MEAI001 // MessageCountingChatReducer is for evaluation purposes only and is subject to change or removal in future updates
                        }
                    })
                .AsBuilder()
                .Build();

            return chatClientAgent;
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
