namespace ProcurementA365Agent.Models
{
    using System.Text.Json.Serialization;

    public class AgentUser
    {
        [JsonPropertyName("id")]
        public string? Id { get; set; }

        [JsonPropertyName("userPrincipalName")]
        public string? UserPrincipalName { get; set; }

        [JsonPropertyName("displayName")]
        public string? DisplayName { get; set; }

        [JsonPropertyName("manager")]
        public AgentUserManager? Manager { get; set; }

        [JsonPropertyName("assignedLicenses")]
        public List<Microsoft.Graph.Models.AssignedLicense>? AssignedLicenses { get; set; }
    }

    public class AgentUserManager
    {
        [JsonPropertyName("@odata.type")]
        public string? ODataType { get; set; }

        [JsonPropertyName("id")]
        public string? Id { get; set; }

        [JsonPropertyName("userPrincipalName")]
        public string? UserPrincipalName { get; set; }

        [JsonPropertyName("displayName")]
        public string? DisplayName { get; set; }
    }
}
