using AgentNotification;
using Microsoft.Agents.A365.Notifications.Models;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App;
using Microsoft.Agents.Builder.State;
using Microsoft.Agents.CopilotStudio.Client;
using Microsoft.Agents.Core.Models;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using System;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace OBOAuthorization
{
    public class AgenticRelay : AgentApplication
    {
        private readonly IConfiguration _configuration; 
        private readonly IServiceProvider _serviceProvider;
        private const string MCSConversationPropertyName = "MCSConversationId8";

        public AgenticRelay(AgentApplicationOptions options, IServiceProvider service,  IConfiguration configuration) : base(options)
        {
            _configuration = configuration;
            _serviceProvider = service;
            RegisterExtension(new AgentNotification.AgentNotification(this), a365 =>
            {
                a365.OnAgentNotification("*", OnAgentNotification, autoSignInHandlers: ["agentic"]);
            });
            OnActivity(ActivityTypes.Message, OnGeneralActivity, isAgenticOnly: true, autoSignInHandlers: ["agentic"]);
        }

        private async Task OnAgentNotification(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity agentNotificationActivity, CancellationToken cancellationToken)
        {
            string response = string.Empty;
            switch (agentNotificationActivity.NotificationType)
            {
                case NotificationTypeEnum.WpxComment:
                    // handle Word/PowerPoint/Excel comment notification - relay to MCS. 
                    response = await RelayToMCS(turnContext, turnState, agentNotificationActivity.WpxCommentNotification, cancellationToken);
                    await turnContext.SendActivityAsync(MessageFactory.CreateMessageActivity(response));
                    break;
                case NotificationTypeEnum.EmailNotification:
                    response = await RelayToMCS(turnContext, turnState, agentNotificationActivity.EmailNotification, cancellationToken);
                    if (!string.IsNullOrEmpty(response))
                    {
                        await turnContext.SendActivityAsync(EmailResponse.CreateEmailResponseActivity(response));
                    }
                    break;
                case NotificationTypeEnum.Unknown:
                case NotificationTypeEnum.FederatedKnowledgeServiceNotification:
                case NotificationTypeEnum.AgentLifecycleNotification:
                default:
                    // Not supported notification types.
                    break;
            }
        }

        private async Task OnGeneralActivity(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
        {
            // relaying teams messages to MCS Agent
            await RelayToMCS(turnContext,turnState, turnContext.Activity.Attachments, cancellationToken).ContinueWith(async (t) =>
            { 
                var responseText = t.Result;
                if (!string.IsNullOrEmpty(responseText))
                {
                    var messageActivity = MessageFactory.CreateMessageActivity(responseText);
                    messageActivity.TextFormat = "markdown";
                    await turnContext.SendActivityAsync(messageActivity, cancellationToken);
                }
            }, cancellationToken);
        }

        private async Task<string> RelayToMCS(ITurnContext context, ITurnState turnState, Object? notificationMetadata, CancellationToken cancellationToken)
        {
            var mcsConversationId = turnState.Conversation.GetValue<string>(MCSConversationPropertyName);
            var cpsClient = GetClient(context, "agentic");
            StringBuilder responseText = new();
            if (string.IsNullOrEmpty(mcsConversationId))
            {
                // Regardless of the Activity  Type, start the conversation.
                await foreach (IActivity activity in cpsClient.StartConversationAsync(emitStartConversationEvent: false, cancellationToken: cancellationToken))
                {
                    if (activity.IsType(ActivityTypes.Message))
                    {
                        // await turnContext.SendActivityAsync(activity.Text, cancellationToken: cancellationToken);
                        responseText.AppendLine(activity.Text);
                    }
                }
            }
            if (context.Activity.IsType(ActivityTypes.Message))
            {
                // Set the conversation ID. 
                IActivity activityToSend = context.Activity.Clone();
                activityToSend.Conversation = new ConversationAccount(id: mcsConversationId);

                //serialize and prepend notification metadata if any; wrap the notification metadata in <info></info> tags to indicate it's system info
                if (notificationMetadata != null)
                {
                    var serializedMetadata = System.Text.Json.JsonSerializer.Serialize(notificationMetadata);
                    activityToSend.Text = $"<info>notification metadata:{serializedMetadata}</info>\n{activityToSend.Text}";
                }

                // now do the same for the sender info in the activity by adding it as <info></info> tags
                var serializedSender = System.Text.Json.JsonSerializer.Serialize(context.Activity.From);
                activityToSend.Text = $"<info>sender:{serializedSender}</info>\n{activityToSend.Text}";

                // Send the Copilot Studio Agent whatever the sent and send the responses back.
                await foreach (IActivity activity in cpsClient.SendActivityAsync(activityToSend, cancellationToken))
                {
                    if (activity.IsType(ActivityTypes.Message))
                    {
                        if (activity.Text != null)
                        {
                            responseText.AppendLine(activity.Text);
                        }
                    }

                    if (activity.Conversation != null && !string.IsNullOrEmpty(activity.Conversation.Id))
                    {
                        // Update the conversation ID in case it has changed.
                        turnState.Conversation.SetValue(MCSConversationPropertyName,  activity.Conversation.Id);
                    }
                }
            }
            return responseText.ToString();
        }

        private CopilotClient GetClient(ITurnContext turnContext, string authHandlerName)
        {
            var settings = new ConnectionSettings(_configuration.GetSection("CopilotStudioAgent"));
            string[] scopes = [CopilotClient.ScopeFromSettings(settings)];

            return new CopilotClient(
                settings,
                _serviceProvider.GetService<IHttpClientFactory>()!,
                tokenProviderFunction: async (s) =>
                {
                    return await UserAuthorization.ExchangeTurnTokenAsync(turnContext, authHandlerName, exchangeScopes: scopes);
                },
                NullLogger.Instance,
                "mcs");
        }

    }
}
