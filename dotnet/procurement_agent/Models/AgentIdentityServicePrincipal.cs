namespace ProcurementA365Agent.Models;

using System.Text.Json.Serialization;

public class AgentIdentityServicePrincipal(
    string createdByAppId, string appId, string displayName)
{
    [JsonPropertyName("createdByAppId")]
    public string CreatedByAppId { get; set; } = createdByAppId;

    [JsonPropertyName("appId")]
    public string AppId { get; set; } = appId;

    [JsonPropertyName("displayName")]
    public string DisplayName { get; set; } = displayName;
}

public class ODataResponse<T>
{
    [JsonPropertyName("value")]
    public List<T>? Value { get; set; }
}