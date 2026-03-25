namespace ProcurementA365Agent.AgentLogic;

using Azure.AI.OpenAI;
using Azure.Identity;
using ProcurementA365Agent.AgentLogic.Tools;
using ProcurementA365Agent.Models;
using ProcurementA365Agent.Services;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.State;
using Microsoft.Agents.Core.Models;
using Microsoft.Agents.A365.Notifications.Models;
using Microsoft.Agents.A365.Observability.Extensions.OpenAI;
using OpenAI.Chat;
using System.Text.Json;

/// <summary>
/// OpenAI-specific implementation of AgentLogicService using direct OpenAI API calls.
/// </summary>
public class OpenAiAgentLogicService : IAgentLogicService
{
    private readonly AgentMetadata agentMetadataMetadata;
    private readonly ILogger _logger;
    private readonly IConfiguration _config;
    private readonly AzureOpenAIClient _openAIClient;
    private readonly OpenAIEmailTool _emailTool;
    private readonly string _instructions;

    public OpenAiAgentLogicService(AgentMetadata agent, IConfiguration config, IServiceProvider sp, ILogger logger)
    {
        agentMetadataMetadata = agent ?? throw new ArgumentNullException(nameof(agent));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _config = config ?? throw new ArgumentNullException(nameof(config));

        var deployment = config["ModelDeployment"];
        var endpoint = config["AzureOpenAIEndpoint"];
        if (string.IsNullOrWhiteSpace(deployment) || string.IsNullOrWhiteSpace(endpoint))
        {
            throw new InvalidOperationException("ModelDeployment and AzureOpenAIEndpoint must be configured.");
        }

        // Create Azure OpenAI client
        _openAIClient = new AzureOpenAIClient(new Uri(endpoint), new DefaultAzureCredential());

        // Create email tool
        var emailService = sp.CreateScope().ServiceProvider.GetRequiredService<IAgentMessagingService>();
        _emailTool = new OpenAIEmailTool(emailService, agentMetadataMetadata, _logger);

        _instructions = AgentInstructions.GetInstructions(agent);
    }

    public async Task NewActivityReceived(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {
        var incomingText = turnContext.Activity.Text;
        _logger.LogInformation("New activity received (OpenAI): {IncomingText}", incomingText);

        // Log target recipient
        var recipient = turnContext.Activity.Recipient;
        var json = recipient != null ? JsonSerializer.Serialize(recipient) : "null";
        _logger.LogInformation("Target Recipient: {Recipient}", json);

        // Log sender information
        var sender = turnContext.Activity.From;
        var jsonSender = sender != null ? JsonSerializer.Serialize(sender) : "null";
        _logger.LogInformation("Sender: {Sender}", jsonSender);

        var messages = CreateInitialMessages(incomingText);
        var finalResult = await ProcessChatCompletionWithTools(messages);

        // Send the final response back to the user
        if (!string.IsNullOrEmpty(finalResult))
        {
            _logger.LogInformation("Sending response (OpenAI): {ResponseText}", finalResult);
            try
            {
                await turnContext.SendActivityAsync(MessageFactory.Text(finalResult), cancellationToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error sending response: {ResponseText}", finalResult);
            }
        }
    }

    public async Task NewAgentCreatedAsync(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity agentNotificationActivity,  CancellationToken cancellationToken)
    {
        throw new NotImplementedException("NewAgentCreatedAsync");
    }

    public Task NotifyManagerAboutNewAgentAsync(AgentMetadata agentMetadata, CancellationToken cancellationToken)
    {
        _logger.LogWarning("NotifyManagerAboutNewAgentAsync is not implemented for OpenAI logic service.");
        return Task.CompletedTask;
    }

    public async Task<string> NewEmailReceived(string fromEmail, string subject, string messageBody)
    {
        try
        {
            // Combine the email information into a structured message
            string formattedMessage = $"Please respond to this email From: {fromEmail}\nSubject: {subject}\nMessage: {messageBody}";

            var messages = CreateInitialMessages(formattedMessage);
            var finalResult = await ProcessChatCompletionWithTools(messages);

            _logger.LogInformation("OpenAI response: {ResponseText}", finalResult);
            return finalResult;
        }
        catch (Exception ex)
        {
            throw new Exception($"Error processing message: {ex.Message}", ex);
        }
    }

    public async Task<string> NewChatReceived(string chatId, string fromUser, string messageBody)
    {
        try
        {
            // Combine the chat information into a structured message
            string formattedMessage = $"Please respond to this chat message with chat id {chatId} From: {fromUser}\nMessage: {messageBody}";

            var messages = CreateInitialMessages(formattedMessage);
            var finalResult = await ProcessChatCompletionWithTools(messages);

            _logger.LogInformation("OpenAI chat response: {ResponseText}", finalResult);
            return finalResult;
        }
        catch (Exception ex)
        {
            throw new Exception($"Error processing chat message: {ex.Message}", ex);
        }
    }

    private List<ChatMessage> CreateInitialMessages(string userMessage)
    {
        return new List<ChatMessage>
        {
            new SystemChatMessage(_instructions),
            new UserChatMessage(userMessage)
        };
    }

    private async Task<string> ProcessChatCompletionWithTools(List<ChatMessage> messages)
    {
        var deployment = _config["ModelDeployment"];
        var chatClient = _openAIClient.GetChatClient(deployment);

        // Use the EmailTool's ChatTool and PingTool
        var emailTool = OpenAIEmailTool.CreateChatTool();
        var pingTool = OpenAIPingTool.CreateChatTool();

        var chatOptions = new ChatCompletionOptions
        {
            Tools = { emailTool, pingTool }
        };

        bool requiresAction;
        string finalResult = string.Empty;

        do
        {
            requiresAction = false;
            var response = await chatClient.CompleteChatAsync(messages, chatOptions);

            switch (response.Value.FinishReason)
            {
                case ChatFinishReason.Stop:
                {
                    // Add the assistant message to the conversation history.
                    messages.Add(new AssistantChatMessage(response.Value));
                    finalResult = response.Value.Content[0].Text;
                    break;
                }

                case ChatFinishReason.ToolCalls:
                {
                    // First, add the assistant message with tool calls to the conversation history.
                    messages.Add(new AssistantChatMessage(response.Value));

                    // Process each tool call
                    await ProcessToolCalls(response.Value.ToolCalls, messages);
                    requiresAction = true;
                    break;
                }

                case ChatFinishReason.Length:
                    throw new NotImplementedException("Incomplete model output due to MaxTokens parameter or token limit exceeded.");

                case ChatFinishReason.ContentFilter:
                    throw new NotImplementedException("Omitted content due to a content filter flag.");

                case ChatFinishReason.FunctionCall:
                    throw new NotImplementedException("Deprecated in favor of tool calls.");

                default:
                    throw new NotImplementedException(response.Value.FinishReason.ToString());
            }
        } while (requiresAction);

        return finalResult;
    }

    private async Task ProcessToolCalls(IReadOnlyList<ChatToolCall> toolCalls, List<ChatMessage> messages)
    {
        foreach (var toolCall in toolCalls)
        {
            if (toolCall.FunctionName == nameof(OpenAIEmailTool.SendEmailAsync))
            {
                // Parse function arguments
                var args = JsonSerializer.Deserialize<SendEmailArgs>(toolCall.FunctionArguments, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                if (args != null)
                {
                    var result = await _emailTool.SendEmailAsync(args.ToEmail, args.Subject, args.Body);
                    messages.Add(new ToolChatMessage(toolCall.Id, [ChatMessageContentPart.CreateTextPart(result)]));
                }
            }
            else if (toolCall.FunctionName == nameof(OpenAIPingTool.Ping))
            {
                using var scope = toolCall.Trace(agentId: agentMetadataMetadata.AgentId.ToString(), agentMetadataMetadata.TenantId);
                // Parse argument for Ping
                var pingArgs = JsonSerializer.Deserialize<PingArgs>(toolCall.FunctionArguments, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                var result = OpenAIPingTool.Ping(pingArgs?.Message ?? string.Empty);
                messages.Add(new ToolChatMessage(toolCall.Id, [ChatMessageContentPart.CreateTextPart(result)]));
            }
            else
            {
                // Handle other unexpected calls.
                throw new NotImplementedException($"Unknown tool call: {toolCall.FunctionName}");
            }
        }
    }

    // Helper class for function call arguments
    private class SendEmailArgs
    {
        public string ToEmail { get; set; } = string.Empty;
        public string Subject { get; set; } = string.Empty;
        public string Body { get; set; } = string.Empty;
    }
    // Helper class for Ping tool arguments
    private class PingArgs
    {
        public string Message { get; set; } = string.Empty;
    }


    #region IAgentLogicService Event Handler Methods

    /// <summary>
    /// Handles email notification events
    /// </summary>
    public async Task HandleEmailNotificationAsync(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity emailEvent)
    {
        _logger.LogInformation("Processing email notification - NotificationType: {NotificationType}",
            emailEvent.NotificationType);

        // Extract email data and process
        var fromEmail = emailEvent.From?.Id ?? "unknown";
        var subject = "TBD"; // emailEvent.EmailNotification?.Subject ?? "No Subject";
        var messageBody = emailEvent.Text ?? string.Empty;

        var response = await NewEmailReceived(fromEmail, subject, messageBody);
    }

    /// <summary>
    /// Handles document comment notification events (Word, Excel, PowerPoint)
    /// </summary>
    public async Task HandleCommentNotificationAsync(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity commentEvent)
    {
        _logger.LogInformation("Processing comment notification - NotificationType: {NotificationType}",
            commentEvent.NotificationType);

        // Extract comment data if available
        //if (commentEvent.WpxCommentNotification != null)
        //{
        //    _logger.LogInformation("WPX Comment details - DocumentType: {DocumentType}, CommentId: {CommentId}", 
        //        commentEvent.WpxCommentNotification.DocumentType, commentEvent.WpxCommentNotification.CommentId);
        //}

        // Process the comment
        var commentText = commentEvent.Text ?? string.Empty;
        var formattedMessage = $"Please respond to this document comment: {commentText}";

        var messages = CreateInitialMessages(formattedMessage);
        var response = await ProcessChatCompletionWithTools(messages);

    }

    /// <summary>
    /// Handles Teams message events
    /// </summary>
    public async Task HandleTeamsMessageAsync(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity teamsEvent)
    {
        _logger.LogInformation("Processing Teams message event - From: {FromUser}",
            teamsEvent.From?.Name);

        // Extract Teams message data and process
        var chatId = teamsEvent.Conversation?.Id ?? "unknown";
        var fromUser = teamsEvent.From?.Name ?? teamsEvent.From?.Id ?? "unknown";
        var messageBody = teamsEvent.Text ?? string.Empty;

        var response = await NewChatReceived(chatId, fromUser, messageBody);

    }

    /// <summary>
    /// Handles installation update events
    /// </summary>
    public async Task HandleInstallationUpdateAsync(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity installationEvent)
    {
        _logger.LogInformation("Processing installation update event for {SenderId}", installationEvent.From?.Id);

        var formattedMessage = $"You were just added as a digital worker. Please send an email to {installationEvent.From?.Id} with information on what you can do.";

        var messages = CreateInitialMessages(formattedMessage);
        var response = await ProcessChatCompletionWithTools(messages);

        _logger.LogInformation("Installation update response prepared: {ResponseText}", response);
    }

    /// <summary>
    /// Handles generic activity events that don't fit other categories
    /// </summary>
    public async Task NewActivityReceived(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity genericEvent)
    {
        _logger.LogInformation("Processing generic activity event - NotificationType: {NotificationType}",
            genericEvent.NotificationType);

        // For generic events, provide basic processing
        var formattedMessage = $"Process this activity: {genericEvent.Text}";

        var messages = CreateInitialMessages(formattedMessage);
        var response = await ProcessChatCompletionWithTools(messages);

    }

    #endregion
}