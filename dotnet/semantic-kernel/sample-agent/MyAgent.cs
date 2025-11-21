// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System;
using System.Configuration;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using Agent365SemanticKernelSampleAgent.Agents;
using AgentNotification;
using Microsoft.Agents.A365.Notifications.Models;
using Microsoft.Agents.A365.Observability.Caching;
using Microsoft.Agents.A365.Observability.Runtime.Common;
using Microsoft.Agents.A365.Tooling.Extensions.SemanticKernel.Services;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App;
using Microsoft.Agents.Builder.State;
using Microsoft.Agents.Core.Models;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.SemanticKernel;
using Microsoft.SemanticKernel.Agents;
using Microsoft.SemanticKernel.ChatCompletion;

namespace Agent365SemanticKernelSampleAgent;

public class MyAgent : AgentApplication
{
    private const string primaryAuthHandler = "agentic";
    private readonly IConfiguration _configuration;
    private readonly Kernel _kernel;
    private readonly IMcpToolRegistrationService _toolsService;
    private readonly IExporterTokenCache<AgenticTokenStruct> _agentTokenCache;
    private readonly ILogger<MyAgent> _logger;

    public MyAgent(AgentApplicationOptions options, IConfiguration configuration, Kernel kernel, IMcpToolRegistrationService toolService, IExporterTokenCache<AgenticTokenStruct> agentTokenCache, ILogger<MyAgent> logger) : base(options)
    {
        _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
        _kernel = kernel ?? throw new ArgumentNullException(nameof(kernel));
        _toolsService = toolService ?? throw new ArgumentNullException(nameof(toolService));
        _agentTokenCache = agentTokenCache ?? throw new ArgumentNullException(nameof(agentTokenCache));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));

        var autoSignInHandlers = new[] { primaryAuthHandler };

        // Register Agentic specific Activity routes.  These will only be used if the incoming Activity is Agentic.
        this.OnAgentNotification("*", AgentNotificationActivityAsync,RouteRank.Last,  autoSignInHandlers: autoSignInHandlers);

        OnActivity(ActivityTypes.InstallationUpdate, OnHireMessageAsync);
        OnActivity(ActivityTypes.Message, MessageActivityAsync, rank: RouteRank.Last, autoSignInHandlers: autoSignInHandlers);
    }

    internal static bool IsApplicationInstalled { get; set; } = false;
    internal static bool TermsAndConditionsAccepted { get; set; } = false;

    protected async Task MessageActivityAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
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

        // Setup local service connection
        ServiceCollection serviceCollection = [
            new ServiceDescriptor(typeof(ITurnState), turnState),
            new ServiceDescriptor(typeof(ITurnContext), turnContext),
            new ServiceDescriptor(typeof(Kernel), _kernel),
        ];

        if (!IsApplicationInstalled)
        {
            await turnContext.SendActivityAsync(MessageFactory.Text("Please install the application before sending messages."), cancellationToken);
            return;
        }

        var agent365Agent = await this.GetAgent365AgentAsync(serviceCollection, turnContext, primaryAuthHandler);
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

    private async Task AgentNotificationActivityAsync(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity activity, CancellationToken cancellationToken)
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

        // Setup local service connection
        ServiceCollection serviceCollection = [
            new ServiceDescriptor(typeof(ITurnState), turnState),
            new ServiceDescriptor(typeof(ITurnContext), turnContext),
            new ServiceDescriptor(typeof(Kernel), _kernel),
        ];

        if (!IsApplicationInstalled)
        {
            await turnContext.SendActivityAsync(MessageFactory.Text("Please install the application before sending notifications."), cancellationToken);
            return;
        }

        var agent365Agent = await this.GetAgent365AgentAsync(serviceCollection, turnContext, primaryAuthHandler);
        if (!TermsAndConditionsAccepted)
        {
            var response = await agent365Agent.InvokeAgentAsync(turnContext.Activity.Text, new ChatHistory());
            await OutputResponseAsync(turnContext, turnState, response, cancellationToken);
            return;
        }

        switch (activity.NotificationType)
        {
            case NotificationTypeEnum.EmailNotification:
                await turnContext.StreamingResponse.QueueInformativeUpdateAsync($"Thanks for the email notification! Working on a response...");
                if (activity.EmailNotification == null)
                {
                    turnContext.StreamingResponse.QueueTextChunk("I could not find the email notification details.");
                    await turnContext.StreamingResponse.EndStreamAsync(cancellationToken);
                    return;
                }

                var chatHistory = new ChatHistory();
                var emailContent = await agent365Agent.InvokeAgentAsync($"You have a new email from {activity.From.Name} with id '{activity.EmailNotification.Id}', ConversationId '{activity.EmailNotification.ConversationId}'. Please retrieve this message and return it in text format.", chatHistory);
                var response = await agent365Agent.InvokeAgentAsync($"You have received the following email. Please follow any instructions in it. {emailContent.Content}", chatHistory);
                var responseEmailActivity = MessageFactory.Text("");
                responseEmailActivity.Entities.Add(new EmailResponse(response.Content));
                await turnContext.SendActivityAsync(responseEmailActivity, cancellationToken);
                //await OutputResponseAsync(turnContext, turnState, response, cancellationToken);
                return;
            case NotificationTypeEnum.WpxComment:
                await turnContext.StreamingResponse.QueueInformativeUpdateAsync($"Thanks for the Word notification! Working on a response...", cancellationToken);
                if (activity.WpxCommentNotification == null)
                {
                    turnContext.StreamingResponse.QueueTextChunk("I could not find the Word notification details.");
                    await turnContext.StreamingResponse.EndStreamAsync(cancellationToken);
                    return;
                }
                var driveId = "default";
                chatHistory = new ChatHistory();
                var wordContent = await agent365Agent.InvokeAgentAsync($"You have a new comment on the Word document with id '{activity.WpxCommentNotification.DocumentId}', comment id '{activity.WpxCommentNotification.ParentCommentId}', drive id '{driveId}'. Please retrieve the Word document as well as the comments in the Word document and return it in text format.", chatHistory);

                var commentToAgent = activity.Text;
                response = await agent365Agent.InvokeAgentAsync($"You have received the following Word document content and comments. Please follow refer to these when responding to comment '{commentToAgent}'. {wordContent.Content}", chatHistory);
                var responseWpxActivity = MessageFactory.Text(response.Content!);
                await turnContext.SendActivityAsync(responseWpxActivity, cancellationToken);
                //await OutputResponseAsync(turnContext, turnState, response, cancellationToken);
                return;
        }

        throw new NotImplementedException();
    }

    protected async Task TeamsMessageActivityAsync(Agent365Agent agent365Agent, ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {
        // Start a Streaming Process 
        await turnContext.StreamingResponse.QueueInformativeUpdateAsync("Working on a response for you", cancellationToken); 

        ChatHistory chatHistory = turnState.GetValue("conversation.chatHistory", () => new ChatHistory());

        // Invoke the Agent365Agent to process the message
        Agent365AgentResponse response = await agent365Agent.InvokeAgentAsync(turnContext.Activity.Text, chatHistory);
        await OutputResponseAsync(turnContext, turnState, response, cancellationToken);
    }

    protected async Task OutputResponseAsync(ITurnContext turnContext, ITurnState turnState, Agent365AgentResponse response, CancellationToken cancellationToken)
    {
        if (response == null)
        {
            turnContext.StreamingResponse.QueueTextChunk("Sorry, I couldn't get an answer at the moment.");
            await turnContext.StreamingResponse.EndStreamAsync(cancellationToken);
            return;
        }

        // Create a response message based on the response content type from the Agent365Agent
        // Send the response message back to the user. 
        switch (response.ContentType)
        {
            case Agent365AgentResponseContentType.Text:
                turnContext.StreamingResponse.QueueTextChunk(response.Content!);
                break;
            default:
                break;
        }
        await turnContext.StreamingResponse.EndStreamAsync(cancellationToken); // End the streaming response
    }

    protected async Task OnHireMessageAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
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

    /// <summary>
    /// Resolve Tenant and Agent Id from the turn context.
    /// </summary>
    /// <param name="turnContext"></param>
    /// <returns></returns>
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

    private async Task<Agent365Agent> GetAgent365AgentAsync(ServiceCollection serviceCollection, ITurnContext turnContext, string authHandlerName)
    {
        return await Agent365Agent.CreateA365AgentWrapper(
            _kernel,
            serviceCollection.BuildServiceProvider(),
            _toolsService,
            authHandlerName,
            UserAuthorization,
            turnContext,
            _configuration).ConfigureAwait(false);
    }
}
