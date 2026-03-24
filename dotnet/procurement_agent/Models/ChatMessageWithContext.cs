namespace ProcurementA365Agent.Models
{
    using Microsoft.Graph.Models;

    public class ChatMessageWithContext
    {
        public ChatMessage Message { get; set; } = null!;
        public ChatType ChatType { get; set; }
        public string ChatId { get; set; } = string.Empty;
        public string? ChatTopic { get; set; }
    }
}
