namespace ProcurementA365Agent.AgentLogic.Tools;

using System.ComponentModel;
using OpenAI.Chat;

/// <summary>
/// Simple Ping tool for OpenAI function calling that returns a custom message.
/// </summary>
public static class OpenAIPingTool
{
    [Description("Returns a custom message for testing tool calls.")]
    public static string Ping([Description("The message to echo back")] string message)
    {
        return $"Pong! You said: {message}";
    }

    /// <summary>
    /// Creates a ChatTool instance for this ping tool
    /// </summary>
    public static ChatTool CreateChatTool()
    {
        return ChatTool.CreateFunctionTool(
            functionName: nameof(Ping),
            functionDescription: "Returns a custom message for testing tool calls.",
            functionParameters: BinaryData.FromString("""
            {
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": "The message to echo back"
                    }
                },
                "required": ["message"]
            }
            """));
    }
}
