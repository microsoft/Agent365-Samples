namespace ProcurementA365Agent.Services;

using ProcurementA365Agent.Models;
using Microsoft.Graph.Models;

public class EmailMessage
{
    public string Id { get; set; } = string.Empty;
    public string From { get; set; } = string.Empty;
    public string Subject { get; set; } = string.Empty;
    public string Body { get; set; } = string.Empty;
    public DateTime ReceivedDateTime { get; set; }
    public bool IsRead { get; set; }
    public string ConversationId { get; set; } = string.Empty;
}

public interface IAgentMessagingService
{
    Task<EmailMessage[]> CheckForNewEmailAsync(
        AgentMetadata agentMetadata, DateTime dateTime, CancellationToken cancellationToken = default);
    Task SendEmailAsync(AgentMetadata agentMetadata, string toEmail, string subject, string body);
    Task<ChatMessageWithContext[]> CheckForNewTeamsMessagesAsync(
        AgentMetadata agentMetadata, DateTime dateTime, CancellationToken cancellationToken = default);
    Task<ChatMessage?> SendChatMessageAsync(AgentMetadata agentMetadata, string chatId, string messageBody);
}

public class AgentMessagingService(ILogger<AgentMessagingService> logger, GraphService graphService)
    : IAgentMessagingService
{
    /// <summary>
    /// Check for new emails for a agent since the specified date/time
    /// </summary>
    /// <param name="agentMetadata">The agent to check emails for</param>
    /// <param name="dateTime">The date/time to check for new emails since</param>
    /// <returns>Array of new messages</returns>
    public async Task<EmailMessage[]> CheckForNewEmailAsync(
        AgentMetadata agentMetadata, DateTime dateTime, CancellationToken cancellationToken = default)
    {
        logger.LogDebug("Checking for new emails for agent {AgentId} since {DateTime}", agentMetadata.AgentId, dateTime);

        try
        {
            // Use the agent ID as the user ID to get messages from Graph
            var graphMessages = await graphService.GetMessagesSinceAsync(
                agentMetadata, agentMetadata.EmailId, dateTime, cancellationToken);

            EmailMessage[] messages;

            if (!graphMessages.Any())
            {
                logger.LogDebug("No messages returned from Graph service for agent {AgentId}, mail id {MailId}", agentMetadata.AgentId, agentMetadata.EmailId);
                messages = [];
            }
            else
            {
                // Convert Graph messages to our Message model and remove any sent by the agent themselves so we dont get in an infinite loop.
                messages = graphMessages
                    .Where(m => !string.Equals(m.From?.EmailAddress?.Address, agentMetadata.EmailId, StringComparison.OrdinalIgnoreCase))
                    .Select(ConvertGraphMessageToMessage).ToArray();

                logger.LogDebug("Found {MessageCount} new emails for agent {AgentId} since {DateTime}, mail id {MailId}",
                    messages.Length, agentMetadata.AgentId, dateTime, agentMetadata.EmailId);
            }

            return messages;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error checking for new emails for agent {AgentId}", agentMetadata.AgentId);
            return [];
        }
    }

    /// <summary>
    /// Check for new Teams messages for a agent since the specified date/time
    /// </summary>
    /// <param name="agentMetadata">The agent to check Teams messages for</param>
    /// <param name="dateTime">The date/time to check for new Teams messages since</param>
    /// <returns>Array of new chat messages with context</returns>
    public async Task<ChatMessageWithContext[]> CheckForNewTeamsMessagesAsync(
        AgentMetadata agentMetadata, DateTime dateTime, CancellationToken cancellationToken = default)
    {
        logger.LogDebug("Checking for new Teams messages for agent {AgentId} since {DateTime}", agentMetadata.AgentId, dateTime);

        try
        {
            if (agentMetadata.SkipAgentIdAuth)
            {
                // Use the agent's user ID to get Teams messages from Graph
                var graphChatMessages = await graphService.GetTeamsMessagesSinceAsync(
                    agentMetadata, agentMetadata.UserId.ToString(), dateTime, cancellationToken);

                ChatMessageWithContext[] messages;
                if (!graphChatMessages.Any())
                {
                    logger.LogDebug("No Teams messages returned from Graph service for agent {AgentId}, mail id {MailId}", agentMetadata.AgentId, agentMetadata.EmailId);
                    messages = [];
                }
                else
                {
                    // Convert Graph chat messages to ChatMessageWithContext and remove any sent by the agent themselves
                    messages = graphChatMessages
                        .Where(m => m.From?.User?.Id != agentMetadata.UserId.ToString())
                        .Select(msg => new ChatMessageWithContext
                        {
                            Message = msg,
                            ChatType = ChatType.OneOnOne, // Default since we don't have chat context from getAllMessages
                            ChatId = msg.ChatId ?? string.Empty,
                            ChatTopic = null // Not available from getAllMessages
                        }).ToArray();

                    logger.LogDebug("Found {MessageCount} new Teams messages for agent {AgentId} since {DateTime}, mail id {MailId}",
                        messages.Length, agentMetadata.AgentId, dateTime, agentMetadata.EmailId);
                }

                return messages;
            }
            else
            {
                var chats = await graphService.GetUserChatsAsync(agentMetadata, cancellationToken);
                if (!chats.Any())
                {
                    logger.LogDebug("No Teams chats found for agent {AgentId}, mail id {MailId}", agentMetadata.AgentId, agentMetadata.EmailId);
                    return [];
                }
                var groupChatMessagesWithContext = await graphService.GetChatMessagesFromOthersAsync(
                    agentMetadata, chats, dateTime, cancellationToken);

                if (!groupChatMessagesWithContext.Any())
                {
                    logger.LogDebug("No new Teams messages found for agent {AgentId} since {DateTime}, mail id {MailId}",
                        agentMetadata.AgentId, dateTime, agentMetadata.EmailId);
                    return [];
                }

                logger.LogDebug("Found {MessageCount} new Teams messages for agent {AgentId} since {DateTime}, mail id {MailId}",
                    groupChatMessagesWithContext.Count(), agentMetadata.AgentId, dateTime, agentMetadata.EmailId);
                    
                return groupChatMessagesWithContext.ToArray();
            }
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error checking for new Teams messages for agent {AgentId}", agentMetadata.AgentId);
            return [];
        }
    }

    /// <summary>
    /// Send an email on behalf of a agent
    /// </summary>
    /// <param name="agentMetadata">The agent sending the email</param>
    /// <param name="toEmail">The recipient email address</param>
    /// <param name="subject">The email subject</param>
    /// <param name="body">The email body</param>
    public async Task SendEmailAsync(AgentMetadata agentMetadata, string toEmail, string subject, string body)
    {
        logger.LogInformation("Sending email from agent {AgentId} to {ToEmail} with subject '{Subject}'",
            agentMetadata.AgentId, toEmail, subject);

        try
        {
            await graphService.SendEmailAsync(agentMetadata, agentMetadata.EmailId, toEmail, subject, body);

            logger.LogInformation("Email sent successfully from agent {AgentId} to {ToEmail} with subject '{Subject}'",
                agentMetadata.AgentId, toEmail, subject);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error sending email from agent {AgentId} to {ToEmail}", 
                agentMetadata.AgentId, toEmail);
            throw;
        }
    }

    /// <summary>
    /// Send a chat message to a specific chat on behalf of a agent
    /// </summary>
    /// <param name="agentMetadata">The agent sending the message</param>
    /// <param name="chatId">The chat ID to send the message to</param>
    /// <param name="messageBody">The message body/content</param>
    /// <returns>The sent chat message</returns>
    public async Task<ChatMessage?> SendChatMessageAsync(AgentMetadata agentMetadata, string chatId, string messageBody)
    {
        if (string.IsNullOrEmpty(chatId))
        {
            throw new ArgumentException("Chat ID cannot be null or empty", nameof(chatId));
        }

        logger.LogInformation("Sending chat message from agent {AgentId} to chat {ChatId}",
            agentMetadata.AgentId, chatId);

        try
        {
            var sentMessage = await graphService.ReplyChatMessageAsync(agentMetadata, chatId, messageBody);

            logger.LogInformation("Chat message sent successfully from agent {AgentId} to chat {ChatId} with message ID {MessageId}",
                agentMetadata.AgentId, chatId, sentMessage?.Id);

            return sentMessage;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error sending chat message from agent {AgentId} to chat {ChatId}", 
                agentMetadata.AgentId, chatId);
            throw;
        }
    }

    /// <summary>
    /// Convert a Microsoft Graph Message to our local Message model
    /// </summary>
    /// <param name="graphMessage">The Graph message to convert</param>
    /// <returns>Converted Message</returns>
    private static EmailMessage ConvertGraphMessageToMessage(Message graphMessage) => new()
    {
        Id = graphMessage.Id ?? string.Empty,
        From = graphMessage.From?.EmailAddress?.Address ?? string.Empty,
        Subject = graphMessage.Subject ?? string.Empty,
        Body = graphMessage.BodyPreview ?? string.Empty,
        ReceivedDateTime = graphMessage.ReceivedDateTime?.DateTime ?? DateTime.MinValue,
        IsRead = graphMessage.IsRead ?? false,
        ConversationId = graphMessage.ConversationId ?? string.Empty,
    };
}