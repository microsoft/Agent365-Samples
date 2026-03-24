namespace ProcurementA365Agent.Tests.Capabilities;

using ProcurementA365Agent.Capabilities;
using Microsoft.Graph.Models;
using Xunit;

public sealed class TeamsChatMessageFormatterTests
{
    private readonly TeamsChatMessageFormatter messageFormatter = new();

    [Fact]
    public void ContentUrl_Rendered()
    {
        const string expected = "expected";
        var chatMessage = ConstructMessage(
            "<attachment id=\"1756499412365\"></attachment>\n<p>Some text</p>",
            new ChatMessageAttachment
            {
                Id = "1756499412365",
                ContentType = "attachment",
                Content = null,
                ContentUrl = expected, 
            }
        );
        
        var actual = messageFormatter.Format(chatMessage);
        
        Assert.Contains(expected, actual);
    }
    
    [Fact]
    public void ForwardedMessageReference_Rendered()
    {
        var chatMessage = ConstructMessage(
            "<attachment id=\"1756499412365\"></attachment>\n<p>Some text</p>",
            new ChatMessageAttachment
            {
                Id = "1756499412365",
                ContentType = "forwardedMessageReference",
                Content =
                    "{\"messageId\":\"1756499412365\",\"messagePreview\":\"Message reference content\",\"messageSender\":{\"application\":null,\"device\":null,\"user\":{\"userIdentityType\":\"aadUser\",\"tenantId\":\"5369a35c-46a5-4677-8ff9-2e65587654e7\",\"id\":\"e966aa04-4668-4e9e-b225-231e0e0c4d57\",\"displayName\":\"A365-agentic-user3\"}}}",
            }
        );

        var actual = messageFormatter.Format(chatMessage);

        // Verify that the attachment tag is replaced with the attachment content
        Assert.DoesNotContain("<attachment id=\"1756499412365\"></attachment>", actual);

        // Verify that the attachment content (message reference) is included
        Assert.Contains("Message reference content", actual);

        // Verify that the body is still present
        Assert.Contains("Some text", actual);

        // Verify that the sender's display name from the attachment is included
        Assert.Contains("A365-agentic-user3", actual);
    }
    
    [Fact]
    public void Test_Format_ReplacesAttachmentTagWithAttachmentContent()
    {
        var chatMessage = ConstructMessage(
            "<attachment id=\"1756499412365\"></attachment>\n<p>Some text</p>",
            new ChatMessageAttachment
            {
                Id = "1756499412365",
                ContentType = "messageReference",
                Content =
                    "{\"messageId\":\"1756499412365\",\"messagePreview\":\"Message reference content\",\"messageSender\":{\"application\":null,\"device\":null,\"user\":{\"userIdentityType\":\"aadUser\",\"tenantId\":\"5369a35c-46a5-4677-8ff9-2e65587654e7\",\"id\":\"e966aa04-4668-4e9e-b225-231e0e0c4d57\",\"displayName\":\"A365-agentic-user3\"}}}",
            }
        );

        var actual = messageFormatter.Format(chatMessage);

        // Verify that the attachment tag is replaced with the attachment content
        Assert.DoesNotContain("<attachment id=\"1756499412365\"></attachment>", actual);

        // Verify that the attachment content (message reference) is included
        Assert.Contains("Message reference content", actual);

        // Verify that the body is still present
        Assert.Contains("Some text", actual);

        // Verify that the sender's display name from the attachment is included
        Assert.Contains("A365-agentic-user3", actual);
    }

    [Fact]
    public void Test_Format_RendersMultipleAttachmentsInCorrectOrder()
    {
        var chatMessage = ConstructMessage(
            "<p>Start</p>\n<attachment id=\"first-attachment\"></attachment>\n<p>Middle</p>\n<attachment id=\"second-attachment\"></attachment>\n<p>End</p>",
            new ChatMessageAttachment
            {
                Id = "first-attachment",
                ContentType = "messageReference",
                Content =
                    "{\"messageId\":\"first-attachment\",\"messagePreview\":\"First message\",\"messageSender\":{\"application\":null,\"device\":null,\"user\":{\"userIdentityType\":\"aadUser\",\"tenantId\":\"5369a35c-46a5-4677-8ff9-2e65587654e7\",\"id\":\"user1\",\"displayName\":\"User One\"}}}",
            },
            new ChatMessageAttachment
            {
                Id = "second-attachment",
                ContentType = "messageReference",
                Content =
                    "{\"messageId\":\"second-attachment\",\"messagePreview\":\"Second message\",\"messageSender\":{\"application\":null,\"device\":null,\"user\":{\"userIdentityType\":\"aadUser\",\"tenantId\":\"5369a35c-46a5-4677-8ff9-2e65587654e7\",\"id\":\"user2\",\"displayName\":\"User Two\"}}}",
            })
        ;

        var actual = messageFormatter.Format(chatMessage);

        // Verify all attachment tags are replaced
        Assert.DoesNotContain("<attachment id=\"first-attachment\"></attachment>", actual);
        Assert.DoesNotContain("<attachment id=\"second-attachment\"></attachment>", actual);

        // Verify the order is preserved: Start -> First message -> Middle -> Second message -> End
        var startIndex = actual.IndexOf("<p>Start</p>", StringComparison.Ordinal);
        var firstMessageIndex = actual.IndexOf("First message", StringComparison.Ordinal);
        var middleIndex = actual.IndexOf("<p>Middle</p>", StringComparison.Ordinal);
        var secondMessageIndex = actual.IndexOf("Second message", StringComparison.Ordinal);
        var endIndex = actual.IndexOf("<p>End</p>", StringComparison.Ordinal);

        Assert.True(startIndex < firstMessageIndex, "Start should come before First message");
        Assert.True(firstMessageIndex < middleIndex, "First message should come before Middle");
        Assert.True(secondMessageIndex < endIndex, "Second message should come before End");
    }

    private ChatMessage ConstructMessage(string content, params ChatMessageAttachment[] attachments) => new()
    {
        Attachments = attachments.ToList(),
        Body = new ItemBody
        {
            Content = content,
            ContentType = BodyType.Html,
        },
        From = new ChatMessageFromIdentitySet
        {
            User = new TeamworkUserIdentity
            {
                Id = "7bcfd089-1aeb-4ab1-a820-03de4e112f7d",
                DisplayName = "First Last",
                AdditionalData = new Dictionary<string, object>
                {
                    { "tenantId", "5369a35c-46a5-4677-8ff9-2e65587654e7" }
                },
                UserIdentityType = TeamworkUserIdentityType.AadUser,
            }
        },
        Locale = "en-us",
    };
}