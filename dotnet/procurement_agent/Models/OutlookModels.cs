namespace ProcurementA365Agent.Models
{
    using System.Text.Json.Serialization;

    public class NotificationPayload
    {
        [JsonPropertyName("value")]
        public List<Notification> Value { get; set; } = new();
    }

    public class Notification
    {
        [JsonPropertyName("subscriptionId")]
        public string SubscriptionId { get; set; } = string.Empty;

        [JsonPropertyName("changeType")]
        public string ChangeType { get; set; } = string.Empty;

        [JsonPropertyName("clientState")]
        public string ClientState { get; set; } = string.Empty;

        [JsonPropertyName("subscriptionExpirationDateTime")]
        public DateTimeOffset SubscriptionExpirationDateTime { get; set; }

        [JsonPropertyName("resource")]
        public string Resource { get; set; } = string.Empty;

        [JsonPropertyName("resourceData")]
        public ResourceData ResourceData { get; set; } = new();
    }

    public class ResourceData
    {
        [JsonPropertyName("@odata.type")]
        public string ODataType { get; set; } = string.Empty;

        [JsonPropertyName("@odata.id")]
        public string ODataId { get; set; } = string.Empty;

        [JsonPropertyName("@odata.etag")]
        public string ODataEtag { get; set; } = string.Empty;

        [JsonPropertyName("id")]
        public string Id { get; set; } = string.Empty;
    }

    public class SubscriptionRequest
    {
        public string NotificationUrl { get; set; } = string.Empty;
        public string UserId { get; set; } = string.Empty;
    }

    public class SubscriptionResponse
    {
        public string Id { get; set; } = string.Empty;
        public string Resource { get; set; } = string.Empty;
        public string ChangeType { get; set; } = string.Empty;
        public string NotificationUrl { get; set; } = string.Empty;
        public DateTimeOffset ExpirationDateTime { get; set; }
        public string ClientState { get; set; } = string.Empty;
    }

    public class SendEmailRequest
    {
        public string FromUserId { get; set; } = string.Empty;
        public string ToEmail { get; set; } = string.Empty;
        public string Subject { get; set; } = string.Empty;
        public string Body { get; set; } = string.Empty;
    }
}
