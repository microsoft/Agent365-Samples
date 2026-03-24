namespace ProcurementA365Agent.Capabilities;

using Microsoft.Graph.Models;

public sealed class TeamsChatMessageFormatter
{
    public string FormatSender(ChatMessageFromIdentitySet? chatMessageFrom)
    {
        if (chatMessageFrom?.User != null)
        {
            return $"{chatMessageFrom.User.DisplayName} UserId: {chatMessageFrom.User.Id})";
        }

        return "Unknown User";
    }

    public string Format(ChatMessage chatMessage)
    {
        var messageBody = chatMessage.Body?.Content ?? "";
        var attachments = chatMessage.Attachments ?? [];

        // Replace attachment tags with actual attachment content
        foreach (var attachment in attachments)
        {
            if (!string.IsNullOrEmpty(attachment.Id))
            {
                var attachmentTag = $"<attachment id=\"{attachment.Id}\"></attachment>";
                if (messageBody.Contains(attachmentTag))
                {
                    var attachmentContent = FormatAttachmentContent(attachment) ?? string.Empty;
                    messageBody = messageBody.Replace(attachmentTag, attachmentContent);
                }
            }
        }

        return messageBody.Trim();
    }

    private string FormatAttachmentContent(ChatMessageAttachment attachment)
    {
        var content = attachment.Content != null ? $"Content: {attachment.Content}" : "";
        var contentUrl = attachment.ContentUrl != null ? $"Content URL: {attachment.ContentUrl}" : "";
        return
            $"""
             Attachment of type {attachment.ContentType}:
             {content}
             {contentUrl}
             """.Trim();
    }
}