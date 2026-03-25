namespace ProcurementA365Agent.Models;

using Azure;
using Azure.Data.Tables;

public class AgentMetadata : ITableEntity
{
    public string PartitionKey { get; set; } = string.Empty;
    public string RowKey { get; set; } = string.Empty;
    public DateTimeOffset? Timestamp { get; set; }
    public ETag ETag { get; set; }

    // Business properties
    public Guid UserId { get; set; }
    public Guid AgentId { get; set; }
    public Guid AgentApplicationId { get; set; }
    public Guid TenantId { get; set; }
    public string AgentFriendlyName { get; set; } = string.Empty;

    // This is used to keep track of which AppService is responsible for running logic of this agent.
    public string OwningServiceName { get; set; } = string.Empty;

    public DateTime? LastEmailCheck { get; set; }
    public DateTime? LastTeamsCheck { get; set; }
    public string EmailId { get; set; } = string.Empty;
    public string? WebhookUrl { get; set; }
    public bool SkipAgentIdAuth { get; set; } = false;

    public bool IsMessagingEnabled { get; set; } = true;

    public bool CanAgentInitiateEmails { get; set; } = true;

    /// <summary>
    /// MCP Server URL for this agent. If null or empty, MCP tools will not be enabled.
    /// </summary>
    public string? McpServerUrl { get; set; }

    // Manager information (optional)
    public Guid? AgentManagerId { get; set; }
    public string? AgentManagerName { get; set; }
    public string? AgentManagerEmail { get; set; }

    /// <summary>
    /// Comma-separated list of admin object IDs who can perform administrative actions.
    /// Stored as a string in Table Storage for compatibility.
    /// </summary>
    public string AdminObjectIds { get; set; } = string.Empty;

    public AgentMetadata()
    {
    }

    public AgentMetadata(Guid tenantId, Guid agentId, Guid userId, string agentFriendlyName, string owningServiceName)
    {
        // Use TenantId as PartitionKey for efficient querying within tenant
        PartitionKey = tenantId.ToString();
        // Use AgentId as RowKey for unique identification
        RowKey = userId.ToString();

        TenantId = tenantId;
        AgentId = agentId;
        UserId = userId;
        AgentFriendlyName = agentFriendlyName;
        OwningServiceName = owningServiceName;
    }

    /// <summary>
    /// Get the list of admin object IDs as a collection
    /// </summary>
    public IEnumerable<string> GetAdminObjectIds()
    {
        if (string.IsNullOrEmpty(AdminObjectIds))
            return Array.Empty<string>();

        return AdminObjectIds.Split(',', StringSplitOptions.RemoveEmptyEntries)
            .Select(id => id.Trim())
            .Where(id => !string.IsNullOrEmpty(id));
    }

    /// <summary>
    /// Set the admin object IDs from a collection
    /// </summary>
    public void SetAdminObjectIds(IEnumerable<string> adminIds)
    {
        AdminObjectIds = string.Join(",", adminIds.Where(id => !string.IsNullOrEmpty(id)));
    }

    /// <summary>
    /// Add new admin object IDs to the existing list
    /// </summary>
    public void AppendAdminObjectIds(IEnumerable<string> newAdminIds)
    {
        var currentIds = GetAdminObjectIds().ToHashSet(StringComparer.OrdinalIgnoreCase);
        var updatedIds = currentIds.Union(newAdminIds.Where(id => !string.IsNullOrEmpty(id)), StringComparer.OrdinalIgnoreCase);
        SetAdminObjectIds(updatedIds);
    }

    /// <summary>
    /// Check if a given object ID is in the admin list
    /// </summary>
    public bool IsAdmin(string objectId)
    {
        if (string.IsNullOrEmpty(objectId))
            return false;

        return GetAdminObjectIds().Any(adminId => 
            adminId.Equals(objectId, StringComparison.OrdinalIgnoreCase));
    }
}