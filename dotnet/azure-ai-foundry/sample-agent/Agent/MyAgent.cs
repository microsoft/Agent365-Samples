// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using AgentNotification;
using Azure;
using Azure.AI.Agents.Persistent;
using AzureAIFoundrySampleAgent.Telemetry;
using Microsoft.Agents.A365.Notifications.Models;
using Microsoft.Agents.A365.Tooling.Extensions.AzureFoundry.Services;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App;
using Microsoft.Agents.Builder.App.UserAuth;
using Microsoft.Agents.Builder.State;
using Microsoft.Agents.Core.Models;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace AzureAIFoundrySampleAgent.Agent
{
    public class MyAgent : AgentApplication
    {
        private readonly PersistentAgentsClient _agentClient;
        private readonly IMcpToolRegistrationService _toolsService;
        private readonly ILogger<MyAgent> _logger;
        private readonly IConfiguration _configuration;
        private readonly string _modelDeploymentName;
        
        // Setup reusable auto sign-in handlers
        private readonly string AgenticIdAuthHandler = "agentic";

        // Cached tool resources for reuse across runs
        private ToolResources? _cachedToolResources = null;
        private bool _toolResourcesRetrieved = false;

        internal static bool IsApplicationInstalled { get; set; } = false;
        internal static bool TermsAndConditionsAccepted { get; set; } = false;

        public MyAgent(
            AgentApplicationOptions options, 
            IConfiguration configuration, 
            PersistentAgentsClient agentClient,
            IMcpToolRegistrationService toolService, 
            ILogger<MyAgent> logger) : base(options)
        {
            _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
            _agentClient = agentClient ?? throw new ArgumentNullException(nameof(agentClient));
            _toolsService = toolService ?? throw new ArgumentNullException(nameof(toolService));
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));

            _modelDeploymentName = _configuration["AzureAIFoundry:ModelDeploymentName"] 
                ?? throw new ArgumentException("AzureAIFoundry:ModelDeploymentName configuration is required");

            // Disable for development purpose
            TermsAndConditionsAccepted = true;

            // Register Activity routes
            this.OnAgentNotification("*", AgentNotificationActivityAsync, RouteRank.Last, autoSignInHandlers: new[] { AgenticIdAuthHandler });
            OnActivity(ActivityTypes.InstallationUpdate, OnHireMessageAsync, isAgenticOnly: true, autoSignInHandlers: new[] { AgenticIdAuthHandler });
            OnActivity(ActivityTypes.ConversationUpdate, OnConversationUpdateAsync); // Welcome message when conversation starts
            OnActivity(ActivityTypes.Message, MessageActivityAsync, rank: RouteRank.Last, isAgenticOnly: true, autoSignInHandlers: new[] { AgenticIdAuthHandler });
            OnActivity(ActivityTypes.Message, MessageActivityAsync, rank: RouteRank.Last, isAgenticOnly: false); // For playground testing without auth
        }


        /// <summary>
        /// Process messages sent to the agent
        /// </summary>
        protected async Task MessageActivityAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
        {
            await turnContext.StreamingResponse.QueueInformativeUpdateAsync("Processing your message...", cancellationToken);

            try
            {
                var userText = turnContext.Activity.Text?.Trim() ?? string.Empty;
                
                // Create agent with MCP tools
                var agent = await GetOrCreateAgentAsync(AgenticIdAuthHandler, turnContext);
                
                // Create thread for communication
                Response<PersistentAgentThread> threadResponse = _agentClient.Threads.CreateThread();
                PersistentAgentThread thread = threadResponse.Value;

                // Create message to thread
                _agentClient.Messages.CreateMessage(
                    thread.Id,
                    MessageRole.User,
                    userText);

                // Execute run with cached tool resources
                ThreadRun run = CreateRunWithToolResources(thread, agent);

                // Wait for completion and display results
                await ExecuteAndDisplayRunAsync(run, thread, turnContext, cancellationToken);

                // Clean up resources for this thread
                _agentClient.Threads.DeleteThread(thread.Id);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Error processing message: {ex.Message}");
                await turnContext.SendActivityAsync($"Sorry, I encountered an error: {ex.Message}", cancellationToken: cancellationToken);
            }
            finally
            {
                await turnContext.StreamingResponse.EndStreamAsync(cancellationToken);
            }
        }




        /// <summary>
        /// Process agent notification activities
        /// </summary>
        private async Task AgentNotificationActivityAsync(
            ITurnContext turnContext, 
            ITurnState turnState, 
            AgentNotificationActivity agentNotificationActivity, 
            CancellationToken cancellationToken)
        {
            switch (agentNotificationActivity.NotificationType)
            {
                case NotificationTypeEnum.EmailNotification:
                    await HandleEmailNotificationAsync(turnContext, agentNotificationActivity, cancellationToken);
                    break;
                case NotificationTypeEnum.WpxComment:
                    await HandleWordCommentAsync(turnContext, agentNotificationActivity, cancellationToken);
                    break;
                default:
                    await turnContext.SendActivityAsync("Notification type not supported.", cancellationToken: cancellationToken);
                    break;
            }
        }

        /// <summary>
        /// Process agent onboard event
        /// </summary>
        protected async Task OnHireMessageAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
        {
            if (turnContext.Activity.Action == InstallationUpdateActionTypes.Add)
            {
                IsApplicationInstalled = true;
                TermsAndConditionsAccepted = turnContext.IsAgenticRequest();
                await turnContext.SendActivityAsync(MessageFactory.Text("Thank you for hiring me! Looking forward to assisting you!"), cancellationToken);
            }
            else if (turnContext.Activity.Action == InstallationUpdateActionTypes.Remove)
            {
                IsApplicationInstalled = false;
                TermsAndConditionsAccepted = false;
                await turnContext.SendActivityAsync(MessageFactory.Text("Thank you for your time!"), cancellationToken);
            }
        }

        /// <summary>
        /// Handle conversation update events (e.g., when user joins conversation)
        /// </summary>
        protected async Task OnConversationUpdateAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
        {
            // Check if members were added to the conversation
            if (turnContext.Activity.MembersAdded != null)
            {
                foreach (var member in turnContext.Activity.MembersAdded)
                {
                    // Don't greet the bot itself
                    if (member.Id != turnContext.Activity.Recipient.Id)
                    {
                        var welcomeMessage = "👋 Welcome! I'm your Azure AI Foundry Agent.\n\n" +
                                           "I can help you with various tasks using Azure AI capabilities. " +
                                           "Feel free to ask me anything!";
                        await turnContext.SendActivityAsync(MessageFactory.Text(welcomeMessage), cancellationToken);
                    }
                }
            }
        }

        /// <summary>
        /// Get or create Azure AI Foundry agent with MCP tools configured
        /// </summary>
        private async Task<PersistentAgent> GetOrCreateAgentAsync(string authHandlerName, ITurnContext turnContext)
        {
            // Step 1: Create the agent without tools first
            Response<PersistentAgent> agentResponse = _agentClient.Administration.CreateAgent(
                model: _modelDeploymentName,
                name: "AzureAIFoundryAgent",
                instructions: "You are a helpful assistant with access to MCP tools. Use the available tools to help answer user questions.");

            PersistentAgent agent = agentResponse.Value;
            _logger.LogInformation($"Created agent {agent.Id}");

            // Step 2: Initialize tool resources once for reuse in runs
            await InitializeToolResourcesAsync(agent.Id, turnContext);

            // Step 3: Add MCP tools to the agent using AddToolServersToAgentAsync
            // Pass agent.Id as the agentInstanceId parameter
            try
            {
                await _toolsService.AddToolServersToAgentAsync(
                    agentClient: _agentClient,
                    userAuthorization: UserAuthorization,
                    authHandlerName: authHandlerName,
                    turnContext: turnContext,
                    authToken: null);

                _logger.LogInformation("Successfully configured MCP tools for agent");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to configure MCP tools for agent");
                throw;
            }

            // Step 4: Get the updated agent to see the configured tools
            var updatedAgentResponse = _agentClient.Administration.GetAgent(agent.Id);
            return updatedAgentResponse.Value;
        }

        /// <summary>
        /// Initialize tool resources once for reuse in runs
        /// </summary>
        private async Task InitializeToolResourcesAsync(string agentInstanceId, ITurnContext turnContext)
        {
            if (_toolResourcesRetrieved)
                return;

            try
            {
                _logger.LogInformation("Initializing tool resources...");
                
                var (_, resources) = await _toolsService.GetMcpToolDefinitionsAndResourcesAsync(
                    agentInstanceId: agentInstanceId,
                    authToken: null,
                    turnContext: turnContext);

                _cachedToolResources = resources;
                _toolResourcesRetrieved = true;
                _logger.LogInformation($"Tool resources initialized: {_cachedToolResources != null}");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to initialize tool resources");
                _toolResourcesRetrieved = true; // Don't keep retrying
            }
        }

        /// <summary>
        /// Create a run for the agent
        /// </summary>
        private ThreadRun CreateRunWithToolResources(PersistentAgentThread thread, PersistentAgent agent)
        {
            return _agentClient.Runs.CreateRun(thread, agent);
        }

        /// <summary>
        /// Execute run and stream results to user
        /// </summary>
        private async Task ExecuteAndDisplayRunAsync(
            ThreadRun run, 
            PersistentAgentThread thread,
            ITurnContext turnContext,
            CancellationToken cancellationToken)
        {
            while (run.Status != RunStatus.Completed &&
                   run.Status != RunStatus.Failed &&
                   run.Status != RunStatus.Cancelled &&
                   run.Status != RunStatus.Expired)
            {
                await Task.Delay(1000, cancellationToken);
                run = _agentClient.Runs.GetRun(thread.Id, run.Id);
            }

            if (run.Status == RunStatus.Completed)
            {
                AsyncPageable<PersistentThreadMessage> messages = _agentClient.Messages.GetMessagesAsync(threadId: thread.Id, order: ListSortOrder.Descending);
                
                await foreach (PersistentThreadMessage message in messages)
                {
                    if (message.Role == "assistant")
                    {
                        foreach (MessageContent contentItem in message.ContentItems)
                        {
                            if (contentItem is MessageTextContent textItem)
                            {
                                turnContext.StreamingResponse.QueueTextChunk(textItem.Text);
                            }
                        }
                    }
                }
            }
            else
            {
                var errorMsg = $"Run failed with status: {run.Status}";
                if (run.LastError != null)
                {
                    errorMsg += $" - {run.LastError.Message}";
                }
                turnContext.StreamingResponse.QueueTextChunk(errorMsg);
            }
        }

        /// <summary>
        /// Handle email notification
        /// </summary>
        private async Task HandleEmailNotificationAsync(
            ITurnContext turnContext, 
            AgentNotificationActivity notification,
            CancellationToken cancellationToken)
        {
            if (notification.EmailNotification == null)
            {
                var responseActivity = EmailResponse.CreateEmailResponseActivity("I could not find the email notification details.");
                await turnContext.SendActivityAsync(responseActivity, cancellationToken);
                return;
            }

            try
            {
                var agent = await GetOrCreateAgentAsync(AgenticIdAuthHandler, turnContext);
                Response<PersistentAgentThread> threadResponse = _agentClient.Threads.CreateThread();
                PersistentAgentThread thread = threadResponse.Value;
                
                var emailContent = $"You have a new email from {notification.From.Name} with id '{notification.EmailNotification.Id}'. Please retrieve and process this message.";
                
                _agentClient.Messages.CreateMessage(thread.Id, MessageRole.User, emailContent);
                ThreadRun run = CreateRunWithToolResources(thread, agent);
                
                await ExecuteAndDisplayRunAsync(run, thread, turnContext, cancellationToken);
                
                _agentClient.Threads.DeleteThread(thread.Id);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Error processing email notification: {ex.Message}");
                var responseActivity = EmailResponse.CreateEmailResponseActivity("Unable to process your email at this time.");
                await turnContext.SendActivityAsync(responseActivity, cancellationToken);
            }
        }

        /// <summary>
        /// Handle Word comment notification
        /// </summary>
        private async Task HandleWordCommentAsync(
            ITurnContext turnContext,
            AgentNotificationActivity notification,
            CancellationToken cancellationToken)
        {
            if (notification.WpxCommentNotification == null)
            {
                await turnContext.SendActivityAsync("I could not find the Word notification details.", cancellationToken: cancellationToken);
                return;
            }

            try
            {
                await turnContext.StreamingResponse.QueueInformativeUpdateAsync("Processing Word comment...", cancellationToken);
                
                var agent = await GetOrCreateAgentAsync(AgenticIdAuthHandler, turnContext);
                Response<PersistentAgentThread> threadResponse = _agentClient.Threads.CreateThread();
                PersistentAgentThread thread = threadResponse.Value;
                
                var commentText = $"You have a new comment on a Word document. Comment: {notification.Text}";
                
                _agentClient.Messages.CreateMessage(thread.Id, MessageRole.User, commentText);
                ThreadRun run = CreateRunWithToolResources(thread, agent);
                
                await ExecuteAndDisplayRunAsync(run, thread, turnContext, cancellationToken);
                
                _agentClient.Threads.DeleteThread(thread.Id);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Error processing Word comment: {ex.Message}");
                await turnContext.SendActivityAsync("Unable to process your comment at this time.", cancellationToken: cancellationToken);
            }
            finally
            {
                await turnContext.StreamingResponse.EndStreamAsync(cancellationToken);
            }
        }
    }
}