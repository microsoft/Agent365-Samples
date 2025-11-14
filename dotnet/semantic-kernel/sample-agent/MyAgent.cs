// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Agent365SemanticKernelSampleAgent.Agents;
using AgentNotification;
using Azure;
using Microsoft.Agents.A365.Notifications.Models;
using Microsoft.Agents.A365.Observability.Caching;
using Microsoft.Agents.A365.Observability.Runtime.Common;
using Microsoft.Agents.A365.Tooling.Extensions.SemanticKernel.Services;
using Microsoft.Agents.Authentication;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App;
using Microsoft.Agents.Builder.State;
using Microsoft.Agents.Core.Models;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.SemanticKernel;
using Microsoft.SemanticKernel.ChatCompletion;
using SemanticKernelSampleAgent;
using System;
using System.Configuration;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;

namespace Agent365SemanticKernelSampleAgent;

public class MyAgent : AgentApplication
{
    private readonly Kernel _kernel;
    private readonly IMcpToolRegistrationService _toolsService;
    private readonly IExporterTokenCache<AgenticTokenStruct> _agentTokenCache;
    private readonly ILogger<MyAgent> _logger;
    private readonly IConfiguration _configuration;
    private const string primaryAuthHandler = "agentic";

    internal static bool IsApplicationInstalled { get; set; } = false;
    internal static bool TermsAndConditionsAccepted { get; set; } = false;

    public MyAgent(AgentApplicationOptions options, IConfiguration configuration, Kernel kernel, IMcpToolRegistrationService toolService, IExporterTokenCache<AgenticTokenStruct> agentTokenCache, ILogger<MyAgent> logger) : base(options)
    {
        _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
        _kernel = kernel ?? throw new ArgumentNullException(nameof(kernel));
        _toolsService = toolService ?? throw new ArgumentNullException(nameof(toolService));
        _agentTokenCache = agentTokenCache ?? throw new ArgumentNullException(nameof(agentTokenCache));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));


        bool useAgenticAuth = true;//Environment.GetEnvironmentVariable("USE_AGENTIC_AUTH") == "true";
        var autoSignInHandlers = useAgenticAuth ? new[] { primaryAuthHandler } : null;

        MyAgent.TermsAndConditionsAccepted = true;

        // Register Agentic specific Activity routes.  These will only be used if the incoming Activity is Agentic.
        this.OnAgentNotification("*", AgentNotificationActivityAsync, RouteRank.Last, autoSignInHandlers: autoSignInHandlers);
        OnMessage("--SignOut", OnSignOut, isAgenticOnly: false, autoSignInHandlers: autoSignInHandlers);
        OnActivity(ActivityTypes.InstallationUpdate, OnHireMessageAsync);
        OnActivity(ActivityTypes.Message, MessageActivityAsync, rank: RouteRank.Last, autoSignInHandlers: autoSignInHandlers);
    }

    private async Task OnSignOut(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {
        await UserAuthorization.SignOutUserAsync(turnContext, turnState);
    }

    protected async Task MessageActivityAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {
        // Init the activity for observability
        var activity = AgentMetrics.InitializeMessageHandlingActivity("MessageActivityAsync", turnContext);
        var routeStopwatch = Stopwatch.StartNew();

        // Resolve the tenant and agent id being used to communicate with A365 services. 
        (string agentId, string tenantId) = await ResolveTenantAndAgentId(turnContext).ConfigureAwait(false);

        try
        {
            using var baggageScope = new BaggageBuilder()
                .TenantId(tenantId)
                .AgentId(agentId)
                .Build();

            try
            {
                _agentTokenCache.RegisterObservability(agentId, tenantId, new AgenticTokenStruct
                {
                    UserAuthorization = UserAuthorization,
                    TurnContext = turnContext,
                    AuthHandlerName = primaryAuthHandler
                }, EnvironmentUtils.GetObservabilityAuthenticationScope());
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"There was an error registering for observability: {ex.Message}");
            }

            // Setup local service connection
            ServiceCollection serviceCollection = [
                            new ServiceDescriptor(typeof(ITurnState), turnState),
                            new ServiceDescriptor(typeof(ITurnContext), turnContext),
                            new ServiceDescriptor(typeof(Kernel), _kernel),
                        ];

            //if (!IsApplicationInstalled)
            //{
            //    await turnContext.SendActivityAsync(MessageFactory.Text("Please install the application before sending messages."), cancellationToken);
            //    return;
            //}

            var agent365Agent = await this.GetAgent365Agent(serviceCollection, turnContext, primaryAuthHandler);
            if (!TermsAndConditionsAccepted)
            {
                if (turnContext.Activity.ChannelId.Channel == Channels.Msteams)
                {
                    var response = await agent365Agent.InvokeAgentAsync(turnContext.Activity.Text, new ChatHistory());
                    await OutputResponseAsync(turnContext, turnState, response, cancellationToken);
                    return;
                }
            }
            if (turnContext.Activity.ChannelId.Channel == Channels.Msteams)
            {
                await TeamsMessageActivityAsync(agent365Agent, turnContext, turnState, cancellationToken);
            }
            else
            {
                await turnContext.SendActivityAsync(MessageFactory.Text($"Sorry, I do not know how to respond to messages from channel '{turnContext.Activity.ChannelId}'."), cancellationToken);
            }
        }
        finally
        {
            routeStopwatch.Stop();
            AgentMetrics.FinalizeMessageHandlingActivity(activity, turnContext, routeStopwatch.ElapsedMilliseconds, true);
        }
    }

    private async Task AgentNotificationActivityAsync(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity agentNotificationActivity, CancellationToken cancellationToken)
    {
        // Init the activity for observability
        var activity = AgentMetrics.InitializeMessageHandlingActivity("AgentNotificationActivityAsync", turnContext);
        var routeStopwatch = Stopwatch.StartNew();

        // Resolve the tenant and agent id being used to communicate with A365 services. 
        (string agentId, string tenantId) = await ResolveTenantAndAgentId(turnContext).ConfigureAwait(false);

        try
        {
            using var baggageScope = new BaggageBuilder()
            .TenantId(tenantId)
            .AgentId(agentId)
            .Build();

            try
            {
                _agentTokenCache.RegisterObservability(agentId, tenantId, new AgenticTokenStruct
                {
                    UserAuthorization = UserAuthorization,
                    TurnContext = turnContext, 
                    AuthHandlerName = primaryAuthHandler
                }, EnvironmentUtils.GetObservabilityAuthenticationScope());
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"There was an error registering for observability: {ex.Message}");
            }

            // Setup local service connection
            ServiceCollection serviceCollection = [
                            new ServiceDescriptor(typeof(ITurnState), turnState),
                            new ServiceDescriptor(typeof(ITurnContext), turnContext),
                            new ServiceDescriptor(typeof(Kernel), _kernel),
                        ];

            //if (!IsApplicationInstalled)
            //{
            //    await turnContext.SendActivityAsync(MessageFactory.Text("Please install the application before sending notifications."), cancellationToken);
            //    return;
            //}

            var agent365Agent = await this.GetAgent365Agent(serviceCollection, turnContext, primaryAuthHandler);
            if (!TermsAndConditionsAccepted)
            {
                var response = await agent365Agent.InvokeAgentAsync(turnContext.Activity.Text, new ChatHistory());
                await OutputResponseAsync(turnContext, turnState, response, cancellationToken);
                return;
            }

            switch (agentNotificationActivity.NotificationType)
            {
                case NotificationTypeEnum.EmailNotification:
                    // Streaming response is not useful for this as this is a notification

                    if (agentNotificationActivity.EmailNotification == null)
                    {
                        var responseEmailActivity = EmailResponse.CreateEmailResponseActivity("I could not find the email notification details.");
                        await turnContext.SendActivityAsync(responseEmailActivity, cancellationToken);
                        return;
                    }

                    try
                    {
                        var chatHistory = new ChatHistory();
                        var emailContent = await agent365Agent.InvokeAgentAsync($"You have a new email from {agentNotificationActivity.From.Name} with id '{agentNotificationActivity.EmailNotification.Id}', ConversationId '{agentNotificationActivity.EmailNotification.ConversationId}'. Please retrieve this message and return it in text format.", chatHistory);
                        var response = await agent365Agent.InvokeAgentAsync($"You have received the following email. Please follow any instructions in it. {emailContent.Content}", chatHistory);
                        var responseEmailActivity = EmailResponse.CreateEmailResponseActivity(response.Content);
                        await turnContext.SendActivityAsync(responseEmailActivity, cancellationToken);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError($"There was an error processing the email notification: {ex.Message}");
                        var responseEmailActivity = EmailResponse.CreateEmailResponseActivity("Unable to process your email at this time.");
                        await turnContext.SendActivityAsync(responseEmailActivity, cancellationToken);
                    }
                    return;
                case NotificationTypeEnum.WpxComment:
                    try
                    {
                        await turnContext.StreamingResponse.QueueInformativeUpdateAsync($"Thanks for the Word notification! Working on a response...", cancellationToken);
                        if (agentNotificationActivity.WpxCommentNotification == null)
                        {
                            turnContext.StreamingResponse.QueueTextChunk("I could not find the Word notification details.");
                            await turnContext.StreamingResponse.EndStreamAsync(cancellationToken);
                            return;
                        }
                        var driveId = "default";
                        var chatHistory = new ChatHistory();
                        var wordContent = await agent365Agent.InvokeAgentAsync($"You have a new comment on the Word document with id '{agentNotificationActivity.WpxCommentNotification.DocumentId}', comment id '{agentNotificationActivity.WpxCommentNotification.ParentCommentId}', drive id '{driveId}'. Please retrieve the Word document as well as the comments in the Word document and return it in text format.", chatHistory);

                        var commentToAgent = agentNotificationActivity.Text;
                        var response = await agent365Agent.InvokeAgentAsync($"You have received the following Word document content and comments. Please follow refer to these when responding to comment '{commentToAgent}'. {wordContent.Content}", chatHistory);
                        var responseWpxActivity = MessageFactory.Text(response.Content!);
                        await turnContext.SendActivityAsync(responseWpxActivity, cancellationToken);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError($"There was an error processing the mention notification: {ex.Message}");
                        var responseWpxActivity = MessageFactory.Text("Unable to process your mention comment at this time.");
                        await turnContext.SendActivityAsync(responseWpxActivity, cancellationToken);
                    }
                    return;
            }
        }
        finally
        {
            routeStopwatch.Stop();
            AgentMetrics.FinalizeMessageHandlingActivity(activity, turnContext, routeStopwatch.ElapsedMilliseconds, true);
        }

    }

    protected async Task TeamsMessageActivityAsync(Agent365Agent agent365Agent, ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {
        // Init the activity for observability
        var activity = AgentMetrics.InitializeMessageHandlingActivity("TeamsMessageActivityAsync", turnContext);
        var routeStopwatch = Stopwatch.StartNew();

        try
        {
            // Start a Streaming Process 
            //await turnContext.StreamingResponse.QueueInformativeUpdateAsync("Working on a response for you", cancellationToken);

            ChatHistory chatHistory = turnState.GetValue("conversation.chatHistory", () => new ChatHistory());

            // Invoke the Agent365Agent to process the message
            Agent365AgentResponse response = await agent365Agent.InvokeAgentAsync(turnContext.Activity.Text, chatHistory);
            await OutputResponseAsync(turnContext, turnState, response, cancellationToken);
        }
        finally
        {
            routeStopwatch.Stop();
            AgentMetrics.FinalizeMessageHandlingActivity(activity, turnContext, routeStopwatch.ElapsedMilliseconds, true);
        }
    }

    protected async Task OutputResponseAsync(ITurnContext turnContext, ITurnState turnState, Agent365AgentResponse response, CancellationToken cancellationToken)
    {
        if (response == null)
        {
            await turnContext.SendActivityAsync("Sorry, I couldn't get an answer at the moment.");
            //await turnContext.StreamingResponse.EndStreamAsync(cancellationToken);
            return;
        }

        // Create a response message based on the response content type from the Agent365Agent
        // Send the response message back to the user. 
        switch (response.ContentType)
        {
            case Agent365AgentResponseContentType.Text:
                await turnContext.SendActivityAsync(response.Content!);
                break;
            default:
                break;
        }
        //await turnContext.StreamingResponse.EndStreamAsync(cancellationToken); // End the streaming response
    }

    protected async Task OnHireMessageAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {
        // Init the activity for observability
        var activity = AgentMetrics.InitializeMessageHandlingActivity("TeamsMessageActivityAsync", turnContext);
        var routeStopwatch = Stopwatch.StartNew();

        try
        {
            // Resolve the tenant and agent id being used to communicate with A365 services. 
            (string agentId, string tenantId) = await ResolveTenantAndAgentId(turnContext).ConfigureAwait(false);


            using var baggageScope = new BaggageBuilder()
                .TenantId(tenantId)
                .AgentId(agentId)
                .Build();

            try
            {
                _agentTokenCache.RegisterObservability(agentId, tenantId, new AgenticTokenStruct
                {
                    UserAuthorization = UserAuthorization,
                    TurnContext = turnContext, 
                    AuthHandlerName = primaryAuthHandler
                }, EnvironmentUtils.GetObservabilityAuthenticationScope());
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"There was an error registering for observability: {ex.Message}");
            }

            if (turnContext.Activity.Action == InstallationUpdateActionTypes.Add)
            {
                bool useAgenticAuth = Environment.GetEnvironmentVariable("USE_AGENTIC_AUTH") == "true";

                IsApplicationInstalled = true;
                TermsAndConditionsAccepted = useAgenticAuth ? true : false;

                string message = $"Thank you for hiring me! Looking forward to assisting you in your professional journey!";
                if (!useAgenticAuth)
                {
                    message += "Before I begin, could you please confirm that you accept the terms and conditions?";
                }

                await turnContext.SendActivityAsync(MessageFactory.Text(message), cancellationToken);
            }
            else if (turnContext.Activity.Action == InstallationUpdateActionTypes.Remove)
            {
                IsApplicationInstalled = false;
                TermsAndConditionsAccepted = false;
                await turnContext.SendActivityAsync(MessageFactory.Text("Thank you for your time, I enjoyed working with you."), cancellationToken);
            }
        }
        finally
        {
            routeStopwatch.Stop();
            AgentMetrics.FinalizeMessageHandlingActivity(activity, turnContext, routeStopwatch.ElapsedMilliseconds, true);
        }
    }


    private async Task<(string agentId, string tenantId)> ResolveTenantAndAgentId(ITurnContext turnContext)
    {
        string agentId = "";
        if (turnContext.Activity.IsAgenticRequest())
        {
            agentId = turnContext.Activity.GetAgenticInstanceId();
        }
        else
        {
            agentId = Microsoft.Agents.A365.Runtime.Utils.Utility.GetAppIdFromToken(await UserAuthorization.GetTurnTokenAsync(turnContext, primaryAuthHandler));
        }
        string tenantId = turnContext.Activity.Conversation.TenantId ?? turnContext.Activity.Recipient.TenantId;
        return (agentId, tenantId);
    }
    private async Task<Agent365Agent> GetAgent365Agent(ServiceCollection serviceCollection, ITurnContext turnContext, string authHandlerName)
    {
        return await Agent365Agent.CreateA365AgentWrapper(_kernel, serviceCollection.BuildServiceProvider(), _toolsService, authHandlerName, UserAuthorization, turnContext, _configuration).ConfigureAwait(false);
    }
}
