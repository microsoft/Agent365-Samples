namespace ProcurementA365Agent.Services;

using System.Text;
using System.Text.Json;
using ProcurementA365Agent.Models;
using Microsoft.Graph.Models;

public interface IActivitySenderService
{
    Task<bool> SendActivityToWebhookAsync(AgentMetadata agent, EmailMessage message, string webhookUrl);
    Task<bool> SendActivityToWebhookAsync(AgentMetadata agent, ChatMessageWithContext chatMessage, string webhookUrl);
    Task<bool> SendInstallationActivityToWebhookAsync(AgentMetadata agent, AgentUser agentUser, string managerChatId);
}

public class ActivitySenderService(
    ILogger<ActivitySenderService> logger,
    HttpClient httpClient,
    IConfiguration configuration)
    : IActivitySenderService
{
    /// <summary>
    /// Send a message to a webhook URL in Activity Protocol format
    /// </summary>
    /// <param name="agent">The agent metadata</param>
    /// <param name="message">The email message to convert and send</param>
    /// <param name="webhookUrl">The webhook URL to send to</param>
    /// <returns>True if successful, false otherwise</returns>
    public async Task<bool> SendActivityToWebhookAsync(AgentMetadata agent, EmailMessage message, string webhookUrl)
    {
        var activity = ConvertEmailToActivity(agent, message);
        return await SendActivityToWebhookInternalAsync(agent, activity, webhookUrl, message.Id, "message");
    }

    /// <summary>
    /// Send a Teams chat message to a webhook URL in Activity Protocol format
    /// </summary>
    /// <param name="agent">The agent metadata</param>
    /// <param name="chatMessage">The Teams chat message to convert and send</param>
    /// <param name="webhookUrl">The webhook URL to send to</param>
    /// <returns>True if successful, false otherwise</returns>
    public async Task<bool> SendActivityToWebhookAsync(AgentMetadata agent, ChatMessageWithContext chatMessage, string webhookUrl)
    {
        var activity = ConvertChatMessageToActivity(agent, chatMessage);
        return await SendActivityToWebhookInternalAsync(agent, activity, webhookUrl, chatMessage.ChatId ?? "unknown", "Teams message");
    }

    /// <summary>
    /// Internal method to send an activity object to a webhook URL
    /// </summary>
    /// <param name="agent">The agent metadata</param>
    /// <param name="activity">The activity object to send</param>
    /// <param name="webhookUrl">The webhook URL to send to</param>
    /// <param name="messageId">The message ID for logging</param>
    /// <param name="messageType">The message type for logging (e.g., "message", "Teams message")</param>
    /// <returns>True if successful, false otherwise</returns>
    private async Task<bool> SendActivityToWebhookInternalAsync(AgentMetadata agent, object activity, string webhookUrl, string messageId, string messageType)
    {
        try
        {
            logger.LogInformation("Sending {MessageType} {MessageId} to webhook for agent {AgentId}", messageType, messageId, agent.AgentId);

            // Serialize to JSON
            var json = JsonSerializer.Serialize(activity, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                WriteIndented = false
            });

            // Create HTTP content
            var content = new StringContent(json, Encoding.UTF8, "application/json");

            // Set timeout for webhook requests
            var timeout = configuration.GetValue<int>("Webhook:TimeoutSeconds", 90);
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(timeout));

            // Send the request
            var response = await httpClient.PostAsync(webhookUrl, content, cts.Token);

            if (response.IsSuccessStatusCode)
            {
                logger.LogInformation("Successfully sent {MessageType} {MessageId} to webhook for agent {AgentId}. Status: {StatusCode}",
                    messageType, messageId, agent.AgentId, response.StatusCode);
                return true;
            }
            else
            {
                var responseBody = await response.Content.ReadAsStringAsync();
                logger.LogWarning("Webhook request failed for agent {AgentId}. Status: {StatusCode}, Response: {Response}",
                    agent.AgentId, response.StatusCode, responseBody);
                return false;
            }
        }
        catch (OperationCanceledException)
        {
            logger.LogWarning("Webhook request timed out for agent {AgentId}", agent.AgentId);
            return false;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error sending {MessageType} {MessageId} to webhook for agent {AgentId}", messageType, messageId, agent.AgentId);
            return false;
        }
    }

    /// <summary>
    /// Convert an email message to Activity Protocol format for email channel
    /// </summary>
    /// <param name="agent">The agent metadata</param>
    /// <param name="message">The email message</param>
    /// <returns>Activity object in the proper format</returns>
    private Activity ConvertEmailToActivity(AgentMetadata agent, EmailMessage message)
    {
        ActivityChannelAccount recipient;
        if (agent.SkipAgentIdAuth)
        {
            recipient = new ActivityChannelAccount
            {
                Id = agent.UserId.ToString(),
                Name = agent.AgentFriendlyName,
                AadObjectId = agent.UserId.ToString()
            };
        }
        else
        {
            recipient = new ActivityChannelAccount
            {
                Id = agent.AgentApplicationId.ToString(), // AA
                Name = agent.EmailId,// AU upn
                AadObjectId = agent.UserId.ToString(), //AAU
                AadClientId = agent.AgentId.ToString(), // AAI,
                Role = "agentuser"
            };
        }

        return new Activity
        {
            Type = "message",
            Id = message.Id,
            Timestamp = message.ReceivedDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffffffZ"),
            ServiceUrl = "https://email.botframework.com/",
            ChannelId = "email",
            From = new ActivityChannelAccount
            {
                Id = message.From,
                Name = ExtractNameFromEmail(message.From)
            },
            Conversation = new ActivityConversationAccount
            {
                IsGroup = false,
                Id = message.ConversationId,
                TenantId = agent.TenantId.ToString()
            },
            Recipient = recipient,
            Text = message.Body,
            Attachments = new List<object>(),
            Entities = new List<ActivityEntity>
            {
                new ActivityEntity
                {
                    Type = "mention",
                    Mentioned = new
                    {
                        id = agent.EmailId,
                        name = agent.AgentFriendlyName
                    },
                    Text = $"mailto:{agent.EmailId}"
                }
            },
            ChannelData = new
            {
                Subject = message.Subject,
                Importance = 1,
                DateTimeSent = message.ReceivedDateTime.ToString("yyyy-MM-ddTHH:mm:sszzz"),
                Id = new
                {
                    UniqueId = message.Id,
                    ChangeKey = (string?)null
                },
                ToRecipients = new[]
                {
                    new
                    {
                        Name = agent.AgentFriendlyName,
                        Address = agent.EmailId,
                        RoutingType = (string?)null,
                        MailboxType = (string?)null,
                        Id = (string?)null
                    }
                },
                CcRecipients = new object[0],
                TextBody = new
                {
                    BodyType = 1,
                    Text = message.Body
                },
                Body = new
                {
                    BodyType = 0,
                    Text = message.Body // In real scenario, this would be HTML content
                },
                ItemClass = "IPM.Note"
            }
        };
    }

    /// <summary>
    /// Convert a Teams chat message to Activity Protocol format for Teams channel
    /// </summary>
    /// <param name="agent">The agent metadata</param>
    /// <param name="chatMessage">The Teams chat message</param>
    /// <returns>Activity object in the proper format</returns>
    private object ConvertChatMessageToActivity(AgentMetadata agent, ChatMessageWithContext chatMessageWithContext)
    {
        var chatMessage = chatMessageWithContext.Message;
        var timestamp = chatMessage.CreatedDateTime?.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") ?? DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
        var localTimestamp = chatMessage.CreatedDateTime?.ToString("yyyy-MM-ddTHH:mm:ss.fffzzz") ?? DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss.fffzzz");

        // With this block:
        var conversationType = chatMessageWithContext.ChatType switch
        {
            ChatType.OneOnOne => "personal",
            ChatType.Group => "groupChat",
            _ => "personal"
        };

        object recipient;
        if (agent.SkipAgentIdAuth)
        {
            recipient = new
            {
                id = agent.UserId.ToString(),
                name = agent.AgentFriendlyName,
                aadObjectId = agent.UserId.ToString()
            };
        }
        else
        {
            recipient = new
            {
                id = agent.AgentApplicationId, // AA
                name = agent.EmailId,// AU upn
                aadObjectId = agent.UserId.ToString(), //AAU
                aadClientId = agent.AgentId, // AAI,
                role = "agentuser",
                agenticAppId = agent.AgentId.ToString(),
            };
        }

        return new
        {
            type = "message",
            text = chatMessage.Body?.Content ?? string.Empty,
            id = chatMessage.Id ?? Guid.NewGuid().ToString(),
            channelId = "msteams",
            from = new
            {
                id = chatMessage.From?.User?.Id ?? ExtractUserIdFromName(chatMessage.From?.User?.DisplayName ?? "Unknown"),
                name = chatMessage.From?.User?.DisplayName ?? "Unknown User",
                aadObjectId = chatMessage.From?.User?.Id ?? ExtractUserIdFromName(chatMessage.From?.User?.DisplayName ?? "Unknown")
            },
            Attachments = chatMessage.Attachments?.Select(a => new
            {
                id = a.Id,
                contentType = a.ContentType,
                contentUrl = a.ContentUrl,
                content = a.Content,
                name = a.Name,
            }).ToArray(),
            timestamp = timestamp,
            localTimestamp = localTimestamp,
            localTimezone = TimeZoneInfo.Local.Id,
            serviceUrl = "https://teams.microsoft.com/",
            conversation = new
            {
                conversationType = conversationType, // Could be "personal" or "groupChat" based on chat type
                tenantId = agent.TenantId.ToString(),
                id = chatMessage.ChatId ?? "unknown-chat-id"
            },
            recipient = recipient,
            textFormat = "plain",
            locale = "en-US",
            entities = new[]
            {
                new
                {
                    type = "clientInfo",
                    locale = "en-US",
                    country = "US",
                    platform = "Web",
                    timezone = TimeZoneInfo.Local.Id
                }
            },
            channelData = new
            {
                tenant = new
                {
                    id = agent.TenantId.ToString()
                }
            }
        };
    }

    /// <summary>
    /// Extract or generate a user ID from a display name
    /// </summary>
    /// <param name="displayName">The display name</param>
    /// <returns>A user ID (either extracted or generated)</returns>
    private static string ExtractUserIdFromName(string displayName)
    {
        if (string.IsNullOrEmpty(displayName))
            return Guid.NewGuid().ToString();

        // If it's already an email or ID format, use it
        if (displayName.Contains("@") || Guid.TryParse(displayName, out _))
            return displayName;

        // Generate a consistent ID based on the display name
        return $"user-{displayName.Replace(" ", "-").ToLowerInvariant()}";
    }

    /// <summary>
    /// Extract a display name from an email address
    /// </summary>
    /// <param name="email">The email address</param>
    /// <returns>Display name or email if no name can be extracted</returns>
    private static string ExtractNameFromEmail(string email)
    {
        if (string.IsNullOrEmpty(email))
            return "Unknown";

        // If the email contains a display name in the format "Name <email@domain.com>"
        if (email.Contains('<') && email.Contains('>'))
        {
            var nameEnd = email.IndexOf('<');
            if (nameEnd > 0)
            {
                return email.Substring(0, nameEnd).Trim().Trim('"');
            }
        }

        // Otherwise, just use the part before @ as the name
        var atIndex = email.IndexOf('@');
        if (atIndex > 0)
        {
            return email.Substring(0, atIndex);
        }

        return email;
    }

    /// <summary>
    /// Send an installation event to a webhook URL in Activity Protocol format
    /// </summary>
    /// <param name="agent">The agent metadata</param>
    /// <param name="agentUser">The agent user information</param>
    /// <returns>True if successful, false otherwise</returns>
    public async Task<bool> SendInstallationActivityToWebhookAsync(AgentMetadata agent, AgentUser agentUser, string managerChatId)
    {
        var activity = CreateInstallationActivity(agent, agentUser, managerChatId);
        return await SendActivityToWebhookInternalAsync(agent, activity, agent.WebhookUrl!, agent.AgentId.ToString(), "installation");
    }

    private Activity CreateInstallationActivity(AgentMetadata agent, AgentUser agentUser, string managerChatId)
    {
        return new Activity
        {
            Type = "installationUpdate",
            Id = Guid.NewGuid().ToString(),
            ChannelId = "msteams",
            From = new ActivityChannelAccount
            {
                Id = agentUser.Manager?.UserPrincipalName!,
                AadObjectId = agentUser.Manager?.Id!,
                Name = agentUser.Manager?.DisplayName!
            },
            Timestamp = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
            ServiceUrl = "https://teams.microsoft.com/",
            Conversation = new ActivityConversationAccount
            {
                IsGroup = false,
                Id = managerChatId,
                TenantId = agent.TenantId.ToString()
            },
            Recipient = new ActivityChannelAccount
            {
                Id = agent.AgentApplicationId.ToString(), // AA
                Name = agent.EmailId,// AU upn
                AadObjectId = agent.UserId.ToString(), //AAU
                AadClientId = agent.AgentId.ToString(), // AAI,
                Role = "agentuser"
            },
            Text = $"Agent {agent.AgentFriendlyName} has been created",
            Entities = new List<ActivityEntity>
            {
                new ActivityEntity
                {
                    Type = "clientInfo"
                }
            },
            ChannelData = new
            {
                tenant = new { id = agent.TenantId.ToString() },
                source = new { name = "agent_installation" },
                settings = new
                {
                    selectedChannel = new { id = $"agent-{agent.AgentId}" }
                },
                action = "add"
            }
        };
    }
}