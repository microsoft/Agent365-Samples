// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Agent365SemanticKernelSampleAgent.Agents;
using Agent365SemanticKernelSampleAgent.telemetry;
using AgentNotification;
using Microsoft.Agents.A365.Notifications.Models;
using Microsoft.Agents.A365.Observability.Hosting.Caching;
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
using Microsoft.SemanticKernel.ChatCompletion;
using System;
using System.Threading;
using System.Threading.Tasks;

namespace Agent365SemanticKernelSampleAgent.Agents;

public class MyAgent : AgentApplication
{
    private readonly Kernel _kernel;
    private readonly IMcpToolRegistrationService _toolsService;
    private readonly IExporterTokenCache<AgenticTokenStruct> _agentTokenCache;
    private readonly ILogger<MyAgent> _logger;
    private readonly IConfiguration _configuration;
    // Setup reusable auto sign-in handlers
    private readonly string AgenticIdAuthHandler = "agentic";
    private readonly string MyAuthHandler = "me";


    internal static bool IsApplicationInstalled { get; set; } = false;
    internal static bool TermsAndConditionsAccepted { get; set; } = false;

    public MyAgent(AgentApplicationOptions options, IConfiguration configuration, Kernel kernel, IMcpToolRegistrationService toolService, IExporterTokenCache<AgenticTokenStruct> agentTokenCache, ILogger<MyAgent> logger) : base(options)
    {
        _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
        _kernel = kernel ?? throw new ArgumentNullException(nameof(kernel));
        _toolsService = toolService ?? throw new ArgumentNullException(nameof(toolService));
        _agentTokenCache = agentTokenCache ?? throw new ArgumentNullException(nameof(agentTokenCache));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));

        // Disable for development purpose. In production, you would typically want to have the user accept the terms and conditions on first use and then store that in a retrievable location. 
        // TermsAndConditionsAccepted = true;

        bool useBearerToken = Agent365Agent.TryGetBearerTokenForDevelopment(out var bearerToken);
        string[] autoSignInHandlersForNotAgenticAuth = useBearerToken ? [] : new[] { MyAuthHandler };

        // Register Agentic specific Activity routes.  These will only be used if the incoming Activity is Agentic.
        this.OnAgentNotification("*", AgentNotificationActivityAsync, RouteRank.Last, autoSignInHandlers: new[] { AgenticIdAuthHandler });
        OnActivity(ActivityTypes.InstallationUpdate, OnHireMessageAsync, isAgenticOnly: true, autoSignInHandlers: new[] { AgenticIdAuthHandler });
        OnActivity(ActivityTypes.Message, MessageActivityAsync, rank: RouteRank.Last, isAgenticOnly: true, autoSignInHandlers: new[] { AgenticIdAuthHandler });
        OnActivity(ActivityTypes.Message, MessageActivityAsync, rank: RouteRank.Last, isAgenticOnly: false, autoSignInHandlers: autoSignInHandlersForNotAgenticAuth);
    }

    /// <summary>
    /// This processes messages sent to the agent from chat clients.
    /// </summary>
    /// <param name="turnContext"></param>
    /// <param name="turnState"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    protected async Task MessageActivityAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {
        string ObservabilityAuthHandlerName = "";
        string ToolAuthHandlerName = "";
        if (turnContext.IsAgenticRequest())
        {
            ObservabilityAuthHandlerName = AgenticIdAuthHandler;
            ToolAuthHandlerName = AgenticIdAuthHandler;
        }
        else
        {
            ObservabilityAuthHandlerName = MyAuthHandler;
            ToolAuthHandlerName = MyAuthHandler;
        }
        // Init the activity for observability

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

             // Setup local service connection
             ServiceCollection serviceCollection = [
                        new ServiceDescriptor(typeof(ITurnState), turnState),
                            new ServiceDescriptor(typeof(ITurnContext), turnContext),
                            new ServiceDescriptor(typeof(Kernel), _kernel),
             ];

             // Disabled for development purposes. 
             //if (!IsApplicationInstalled)
             //{
             //    await turnContext.SendActivityAsync(MessageFactory.Text("Please install the application before sending messages."), cancellationToken);
             //    return;
             //}

             var agent365Agent = await GetAgent365Agent(serviceCollection, turnContext, ToolAuthHandlerName);
             if (!TermsAndConditionsAccepted)
             {
                 if (turnContext.Activity.ChannelId.Channel == Channels.Msteams)
                 {
                     var response = await agent365Agent.InvokeAgentAsync(turnContext.Activity.Text, new ChatHistory());
                     await OutputResponseAsync(turnContext, turnState, response, cancellationToken);
                     return;
                 }
             }

             if (turnContext.Activity.ChannelId.IsParentChannel(Channels.Msteams))
             {
                 await TeamsMessageActivityAsync(agent365Agent, turnContext, turnState, cancellationToken);
             }
             else
             {
                 await turnContext.SendActivityAsync(MessageFactory.Text($"Sorry, I do not know how to respond to messages from channel '{turnContext.Activity.ChannelId}'."), cancellationToken);
             }
         }).ConfigureAwait(false);
    }

    /// <summary>
    /// This processes A365 Agent Notification Activities sent to the agent.
    /// </summary>
    /// <param name="turnContext"></param>
    /// <param name="turnState"></param>
    /// <param name="agentNotificationActivity"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    private async Task AgentNotificationActivityAsync(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity agentNotificationActivity, CancellationToken cancellationToken)
    {

        string ObservabilityAuthHandlerName = "";
        string ToolAuthHandlerName = "";
        if (turnContext.IsAgenticRequest())
        {
            ObservabilityAuthHandlerName = AgenticIdAuthHandler;
            ToolAuthHandlerName = AgenticIdAuthHandler;
        }
        else
        {
            ObservabilityAuthHandlerName = MyAuthHandler;
            ToolAuthHandlerName = MyAuthHandler;
        }
        // Init the activity for observability
        await A365OtelWrapper.InvokeObservedAgentOperation(
         "AgentNotificationActivityAsync",
         turnContext,
         turnState,
         _agentTokenCache,
         UserAuthorization,
         ObservabilityAuthHandlerName,
         _logger,
         async () =>
         {
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

             var agent365Agent = await GetAgent365Agent(serviceCollection, turnContext, ToolAuthHandlerName);
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
                         response ??= new Agent365AgentResponse
                             {
                                 Content = "I have processed your email but do not have a response at this time.",
                                 ContentType = Agent365AgentResponseContentType.Text
                             };
                         var responseEmailActivity = EmailResponse.CreateEmailResponseActivity(response.Content!);
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
         }).ConfigureAwait(false);
    }


    /// <summary>
    /// Process Agent Onboard Event.
    /// </summary>
    /// <param name="turnContext"></param>
    /// <param name="turnState"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    protected async Task OnHireMessageAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {
        string ObservabilityAuthHandlerName = "";
        if (turnContext.IsAgenticRequest())
        {
            ObservabilityAuthHandlerName = AgenticIdAuthHandler;
        }
        else
        {
            ObservabilityAuthHandlerName = MyAuthHandler;
        }
        // Init the activity for observability
        await A365OtelWrapper.InvokeObservedAgentOperation(
         "OnHireMessageAsync",
         turnContext,
         turnState,
         _agentTokenCache,
         UserAuthorization,
         ObservabilityAuthHandlerName,
         _logger,
         async () =>
         {

             if (turnContext.Activity.Action == InstallationUpdateActionTypes.Add)
             {
                 IsApplicationInstalled = true;
                 TermsAndConditionsAccepted = turnContext.IsAgenticRequest() ? true : false;

                 string message = $"Thank you for hiring me! Looking forward to assisting you in your professional journey!";
                 if (!turnContext.IsAgenticRequest())
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
         }).ConfigureAwait(false);
    }

    /// <summary>
    /// This is the specific handler for teams messages sent to the agent from Teams chat clients.
    /// </summary>
    /// <param name="agent365Agent"></param>
    /// <param name="turnContext"></param>
    /// <param name="turnState"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    protected async Task TeamsMessageActivityAsync(Agent365Agent agent365Agent, ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {

        // Start a Streaming Process 
        await turnContext.StreamingResponse.QueueInformativeUpdateAsync("Working on a response for you", cancellationToken);
        try
        {
            ChatHistory chatHistory = turnState.GetValue("conversation.chatHistory", () => new ChatHistory());

            // Invoke the Agent365Agent to process the message
            Agent365AgentResponse response = await agent365Agent.InvokeAgentAsync(turnContext.Activity.Text, chatHistory, turnContext);
        }
        finally
        {
            await turnContext.StreamingResponse.EndStreamAsync(cancellationToken);
        }
    }

    protected async Task OutputResponseAsync(ITurnContext turnContext, ITurnState turnState, Agent365AgentResponse response, CancellationToken cancellationToken)
    {
        if (response == null)
        {
            await turnContext.SendActivityAsync("Sorry, I couldn't get an answer at the moment.");
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
    }

    /// <summary>
    /// Sets up an in context instance of the Agent365Agent.. 
    /// </summary>
    /// <param name="serviceCollection"></param>
    /// <param name="turnContext"></param>
    /// <param name="authHandlerName"></param>
    /// <returns></returns>
    private async Task<Agent365Agent> GetAgent365Agent(ServiceCollection serviceCollection, ITurnContext turnContext, string authHandlerName)
    {
        return await Agent365Agent.CreateA365AgentWrapper(_kernel, serviceCollection.BuildServiceProvider(), _toolsService, authHandlerName, UserAuthorization, turnContext, _configuration).ConfigureAwait(false);
    }
}
