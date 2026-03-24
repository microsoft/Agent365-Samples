namespace ProcurementA365Agent.Plugins;

using System.ComponentModel;
using ProcurementA365Agent.Models;
using ProcurementA365Agent.Services;
using Microsoft.SemanticKernel;

public sealed class TeamsPlugin(
    IAgentMessagingService messagingService,
    GraphService graphService,
    AgentMetadata agent)
{
    [KernelFunction, Description("Sends a message to a Teams chat")]
    public async Task<string> SendChatMessageAsync(
        [Description("The ID of the chat to send the message to")] string chatId,
        [Description("The message content to send in html")] string messageBody)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(chatId))
            {
                return "Error: Chat ID is required.";
            }

            if (string.IsNullOrWhiteSpace(messageBody))
            {
                return "Error: Message body is required.";
            }

            var sentMessage = await messagingService.SendChatMessageAsync(agent, chatId, messageBody);

            if (sentMessage != null)
            {
                return $"Message successfully sent to chat '{chatId}' with message ID '{sentMessage.Id}'.";
            }
            else
            {
                return "Message was sent but no response was received from the server.";
            }
        }
        catch (Exception ex)
        {
            return $"Error sending chat message: {ex.Message}";
        }
    }

    [KernelFunction,
     Description("Creates a new chat with a specified user by their user ID")]
    public async Task<string> CreateChatWithUser(
        [Description("The user ID of the target user to create a chat with")]
        string targetUserId)
    {
        try
        {
            var result = await graphService.CreateChatWithUserAsync(agent, targetUserId);
            if (result != null)
            {
                return $"Chat created with ID: {result.Id}";
            }
            else
            {
                return "Failed to create chat.";
            }
        }
        catch (Exception ex)
        {
            return "Error creating chat: " + ex.Message;
        }
    }
}