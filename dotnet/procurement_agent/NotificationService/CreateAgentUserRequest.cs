namespace ProcurementA365Agent.NotificationService;

using System.Text.Json.Serialization;

public class CreateAgentUserRequest
{
    [JsonPropertyName("displayName")]
    public string DisplayName { get; set; } = string.Empty;

    [JsonPropertyName("userPrincipalName")]
    public string UserPrincipalName { get; set; } = string.Empty;

    [JsonPropertyName("mailNickname")]
    public string MailNickname { get; set; } = string.Empty;

    [JsonPropertyName("accountEnabled")]
    public bool AccountEnabled { get; set; } = true;
    
    public string IdentityParentId { get; init; }
}