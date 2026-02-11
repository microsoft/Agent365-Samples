// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System;

namespace Agent365TaskPersonalizationSampleAgent.Services.TriggerEvaluation.Models;

/// <summary>
/// Constants for event type identifiers used in trigger evaluation.
/// These must match the event types defined in MCP-Platform.
/// </summary>
public static class EventTypes
{
    /// <summary>
    /// Event type for email notifications.
    /// </summary>
    public const string Email = "email";

    /// <summary>
    /// Event type for document comment notifications.
    /// </summary>
    public const string Document = "document";

    /// <summary>
    /// Event type for generic message notifications.
    /// </summary>
    public const string Message = "message";
}

/// <summary>
/// Base class for notification event data used in trigger evaluation.
/// </summary>
public abstract class NotificationEventData
{
    /// <summary>
    /// Gets the event type identifier (email, document, message).
    /// </summary>
    public abstract string EventType { get; }
}

/// <summary>
/// Event data model for email notifications.
/// Maps to the EmailEventModel in MCP-Platform.
/// </summary>
public sealed class EmailEventData : NotificationEventData
{
    /// <inheritdoc/>
    public override string EventType => EventTypes.Email;

    /// <summary>
    /// Gets or sets the email subject.
    /// </summary>
    public string Subject { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the sender's email address.
    /// </summary>
    public string FromEmail { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the sender's display name.
    /// </summary>
    public string FromName { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the email body content.
    /// </summary>
    public string Body { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the received timestamp.
    /// </summary>
    public DateTime ReceivedDateTime { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether the email has attachments.
    /// </summary>
    public bool HasAttachments { get; set; }
}

/// <summary>
/// Event data model for document (Word, Excel, etc.) comment notifications.
/// Maps to the DocumentEventModel in MCP-Platform.
/// </summary>
public sealed class DocumentEventData : NotificationEventData
{
    /// <inheritdoc/>
    public override string EventType => EventTypes.Document;

    /// <summary>
    /// Gets or sets the document name.
    /// </summary>
    public string DocumentName { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the comment content.
    /// </summary>
    public string CommentContent { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the comment author's email.
    /// </summary>
    public string CommentAuthorEmail { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the mentioned user's email (if @mentioned).
    /// </summary>
    public string MentionedUserEmail { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the comment creation timestamp.
    /// </summary>
    public DateTime CommentCreatedAt { get; set; }
}

/// <summary>
/// Event data model for Teams/chat message notifications.
/// Maps to the MessageEventModel in MCP-Platform.
/// </summary>
public sealed class MessageEventData : NotificationEventData
{
    /// <inheritdoc/>
    public override string EventType => EventTypes.Message;

    /// <summary>
    /// Gets or sets the message text content.
    /// </summary>
    public string Text { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the sender's email (UPN for Teams users).
    /// </summary>
    public string FromEmail { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the sender's Azure AD Object ID (for Teams users).
    /// </summary>
    public string FromAadObjectId { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the sender's display name.
    /// </summary>
    public string FromName { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the message creation timestamp.
    /// </summary>
    public DateTime CreatedDateTime { get; set; }

    /// <summary>
    /// Gets or sets the channel type (teams, webchat, etc.).
    /// </summary>
    public string ChannelType { get; set; } = string.Empty;
}
