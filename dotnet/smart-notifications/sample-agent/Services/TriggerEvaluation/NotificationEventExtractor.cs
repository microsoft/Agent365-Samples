// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System;
using Agent365TaskPersonalizationSampleAgent.Services.TriggerEvaluation.Models;
using Microsoft.Agents.A365.Notifications.Models;
using Microsoft.Agents.Builder;
using Microsoft.Extensions.Logging;

namespace Agent365TaskPersonalizationSampleAgent.Services.TriggerEvaluation;

/// <summary>
/// Extracts structured event data from notification activities for trigger evaluation.
/// </summary>
public interface INotificationEventExtractor
{
    /// <summary>
    /// Extracts event data from a notification activity.
    /// </summary>
    /// <param name="turnContext">The turn context containing the activity.</param>
    /// <param name="notificationActivity">The parsed notification activity.</param>
    /// <returns>
    /// The extracted event data appropriate for the notification type, or null if extraction fails.
    /// Returns <see cref="EmailEventData"/> for email notifications,
    /// <see cref="DocumentEventData"/> for document comments,
    /// or <see cref="MessageEventData"/> for other notification types.
    /// </returns>
    NotificationEventData? ExtractEventData(
        ITurnContext turnContext,
        AgentNotificationActivity notificationActivity);

    /// <summary>
    /// Extracts event data from a regular message activity (e.g., Teams chat message).
    /// </summary>
    /// <param name="turnContext">The turn context containing the message activity.</param>
    /// <returns>The extracted message event data, or null if extraction fails.</returns>
    NotificationEventData? ExtractMessageEventData(ITurnContext turnContext);
}

/// <summary>
/// Default implementation of the notification event extractor.
/// </summary>
public sealed class NotificationEventExtractor : INotificationEventExtractor
{
    private readonly ILogger<NotificationEventExtractor> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="NotificationEventExtractor"/> class.
    /// </summary>
    /// <param name="logger">The logger instance for diagnostic output.</param>
    public NotificationEventExtractor(ILogger<NotificationEventExtractor> logger)
    {
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <inheritdoc/>
    public NotificationEventData? ExtractEventData(
        ITurnContext turnContext,
        AgentNotificationActivity notificationActivity)
    {
        ArgumentNullException.ThrowIfNull(turnContext);
        ArgumentNullException.ThrowIfNull(notificationActivity);

        try
        {
            return notificationActivity.NotificationType switch
            {
                NotificationTypeEnum.EmailNotification => ExtractEmailEventData(turnContext, notificationActivity),
                NotificationTypeEnum.WpxComment => ExtractDocumentEventData(turnContext, notificationActivity),
                _ => ExtractGenericMessageEventData(turnContext, notificationActivity)
            };
        }
        catch (ArgumentException ex)
        {
            _logger.LogWarning(ex,
                "Invalid argument while extracting event data from notification type {NotificationType}",
                notificationActivity.NotificationType);
            return null;
        }
        catch (InvalidOperationException ex)
        {
            _logger.LogWarning(ex,
                "Invalid operation while extracting event data from notification type {NotificationType}",
                notificationActivity.NotificationType);
            return null;
        }
    }

    /// <inheritdoc/>
    public NotificationEventData? ExtractMessageEventData(ITurnContext turnContext)
    {
        ArgumentNullException.ThrowIfNull(turnContext);

        try
        {
            var activity = turnContext.Activity;
            var messageTime = activity?.Timestamp?.UtcDateTime ?? DateTime.UtcNow;

            // Try to extract email from various sources for Teams
            var fromEmail = ExtractUserEmail(activity);

            var eventData = new MessageEventData
            {
                Text = activity?.Text ?? string.Empty,
                FromEmail = fromEmail,
                FromAadObjectId = activity?.From?.AadObjectId ?? string.Empty,
                FromName = activity?.From?.Name ?? string.Empty,
                CreatedDateTime = messageTime,
                ChannelType = activity?.ChannelId?.Channel ?? string.Empty
            };

            _logger.LogDebug(
                "Extracted message event data: From='{FromName}', FromEmail='{FromEmail}', Channel='{ChannelType}'",
                eventData.FromName,
                eventData.FromEmail,
                eventData.ChannelType);

            return eventData;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to extract message event data");
            return null;
        }
    }

    /// <summary>
    /// Extracts user email from activity, checking multiple sources for Teams compatibility.
    /// </summary>
    private static string ExtractUserEmail(Microsoft.Agents.Core.Models.IActivity? activity)
    {
        if (activity?.From == null)
        {
            return string.Empty;
        }

        // 1. Check if From.Properties contains userPrincipalName (UPN/email for Teams)
        if (activity.From.Properties != null &&
            activity.From.Properties.TryGetValue("userPrincipalName", out var upn))
        {
            var upnValue = upn.ToString();
            if (!string.IsNullOrEmpty(upnValue) && upnValue != "null")
            {
                return upnValue;
            }
        }

        // 2. Check if From.Properties contains email directly
        if (activity.From.Properties != null &&
            activity.From.Properties.TryGetValue("email", out var email))
        {
            var emailValue = email.ToString();
            if (!string.IsNullOrEmpty(emailValue) && emailValue != "null")
            {
                return emailValue;
            }
        }

        // 3. Check ChannelData for Teams-specific user info
        if (activity.ChannelData is System.Text.Json.JsonElement channelData)
        {
            if (channelData.TryGetProperty("teamsUserAadObjectId", out _))
            {
                // For Teams, try to get email from channel data
                if (channelData.TryGetProperty("userPrincipalName", out var teamsUpn))
                {
                    var teamsUpnValue = teamsUpn.GetString();
                    if (!string.IsNullOrEmpty(teamsUpnValue))
                    {
                        return teamsUpnValue;
                    }
                }
            }
        }

        // 4. Fallback: Use AadObjectId or Id (may be GUID for Teams)
        return activity.From.AadObjectId ?? activity.From.Id ?? string.Empty;
    }

    /// <summary>
    /// Extracts email event data from an email notification.
    /// </summary>
    private EmailEventData ExtractEmailEventData(
        ITurnContext turnContext,
        AgentNotificationActivity notificationActivity)
    {
        // Extract timestamp from activity if available, otherwise use current time
        var receivedTime = turnContext.Activity?.Timestamp?.UtcDateTime ?? DateTime.UtcNow;

        var eventData = new EmailEventData
        {
            // Email subject is typically in the notification text
            Subject = notificationActivity.Text ?? string.Empty,
            FromEmail = notificationActivity.From?.Id ?? string.Empty,
            FromName = notificationActivity.From?.Name ?? string.Empty,
            Body = turnContext.Activity?.Text ?? string.Empty,
            ReceivedDateTime = receivedTime,
            HasAttachments = false // Not directly available from notification, would need Graph API call
        };

        _logger.LogDebug(
            "Extracted email event data: Subject='{Subject}', From='{FromName}'",
            TruncateForLog(eventData.Subject),
            eventData.FromName);

        return eventData;
    }

    /// <summary>
    /// Extracts document event data from a WPX (Word) comment notification.
    /// </summary>
    private DocumentEventData ExtractDocumentEventData(
        ITurnContext turnContext,
        AgentNotificationActivity notificationActivity)
    {
        var wpxNotification = notificationActivity.WpxCommentNotification;

        // Extract timestamp from activity if available
        var commentTime = turnContext.Activity?.Timestamp?.UtcDateTime ?? DateTime.UtcNow;

        var eventData = new DocumentEventData
        {
            DocumentName = wpxNotification?.DocumentId ?? string.Empty,
            CommentContent = notificationActivity.Text ?? string.Empty,
            CommentAuthorEmail = notificationActivity.From?.Id ?? string.Empty,
            MentionedUserEmail = turnContext.Activity?.Recipient?.Id ?? string.Empty,
            CommentCreatedAt = commentTime
        };

        _logger.LogDebug(
            "Extracted document event data: Document='{DocumentName}', Author='{CommentAuthorEmail}'",
            eventData.DocumentName,
            eventData.CommentAuthorEmail);

        return eventData;
    }

    /// <summary>
    /// Extracts message event data for generic notifications.
    /// </summary>
    private MessageEventData ExtractGenericMessageEventData(
        ITurnContext turnContext,
        AgentNotificationActivity notificationActivity)
    {
        // Extract timestamp from activity if available
        var messageTime = turnContext.Activity?.Timestamp?.UtcDateTime ?? DateTime.UtcNow;

        var eventData = new MessageEventData
        {
            Text = notificationActivity.Text ?? turnContext.Activity?.Text ?? string.Empty,
            FromEmail = notificationActivity.From?.Id ?? turnContext.Activity?.From?.Id ?? string.Empty,
            FromName = notificationActivity.From?.Name ?? turnContext.Activity?.From?.Name ?? string.Empty,
            CreatedDateTime = messageTime,
            ChannelType = turnContext.Activity?.ChannelId?.ToString() ?? string.Empty
        };

        _logger.LogDebug(
            "Extracted message event data: From='{FromName}', Channel='{ChannelType}'",
            eventData.FromName,
            eventData.ChannelType);

        return eventData;
    }

    /// <summary>
    /// Truncates a string for safe logging to prevent log injection and excessive output.
    /// </summary>
    /// <param name="value">The string to truncate.</param>
    /// <param name="maxLength">Maximum length before truncation.</param>
    /// <returns>The truncated string with ellipsis if needed.</returns>
    private static string TruncateForLog(string value, int maxLength = 50)
    {
        if (string.IsNullOrEmpty(value)) return string.Empty;
        return value.Length <= maxLength ? value : value[..maxLength] + "...";
    }
}
