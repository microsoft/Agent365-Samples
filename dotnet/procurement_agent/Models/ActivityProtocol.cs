namespace ProcurementA365Agent.Models
{
    using System.Text.Json.Serialization;

    /// <summary>
    /// Represents an activity in the Activity Protocol format
    /// </summary>
    public class Activity
    {
        [JsonPropertyName("type")]
        public string Type { get; set; } = "message";

        [JsonPropertyName("id")]
        public string Id { get; set; } = string.Empty;

        [JsonPropertyName("timestamp")]
        public string Timestamp { get; set; } = string.Empty;

        [JsonPropertyName("serviceUrl")]
        public string ServiceUrl { get; set; } = string.Empty;

        [JsonPropertyName("channelId")]
        public string ChannelId { get; set; } = "email";

        [JsonPropertyName("from")]
        public ActivityChannelAccount From { get; set; } = new();

        [JsonPropertyName("conversation")]
        public ActivityConversationAccount Conversation { get; set; } = new();

        [JsonPropertyName("recipient")]
        public ActivityChannelAccount Recipient { get; set; } = new();

        [JsonPropertyName("text")]
        public string Text { get; set; } = string.Empty;

        [JsonPropertyName("attachments")]
        public List<object> Attachments { get; set; } = new();

        [JsonPropertyName("entities")]
        public List<ActivityEntity> Entities { get; set; } = new();

        [JsonPropertyName("channelData")]
        public object? ChannelData { get; set; }
    }

    public class ActivityChannelAccount
    {
        [JsonPropertyName("id")]
        public string Id { get; set; } = string.Empty;

        [JsonPropertyName("name")]
        public string Name { get; set; } = string.Empty;

        [JsonPropertyName("aadObjectId")]
        public string AadObjectId { get; set; } = string.Empty;

        [JsonPropertyName("aadClientId")]
        public string AadClientId { get; set; } = string.Empty;

        [JsonPropertyName("role")]
        public string Role { get; set; } = string.Empty;
    }

    public class ActivityConversationAccount
    {
        [JsonPropertyName("isGroup")]
        public bool IsGroup { get; set; } = false;

        [JsonPropertyName("id")]
        public string Id { get; set; } = string.Empty;

        [JsonPropertyName("tenantId")]
        public string TenantId { get; set; } = string.Empty;
    }

    public class ActivityEntity
    {
        [JsonPropertyName("type")]
        public string Type { get; set; } = string.Empty;

        [JsonPropertyName("mentioned")]
        public object? Mentioned { get; set; }

        [JsonPropertyName("text")]
        public string? Text { get; set; }
    }
}
