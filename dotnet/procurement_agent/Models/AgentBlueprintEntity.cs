namespace ProcurementA365Agent.Models;

using Azure;
using Azure.Data.Tables;

/// <summary>
/// Represents an Agent Blueprint Entity that tracks agent blueprint instances across tenants.
/// This entity is used to monitor and track agent identity service principals created for a specific application.
/// </summary>
public class AgentBlueprintEntity : ITableEntity
{
    public string PartitionKey { get; set; } = string.Empty;
    public string RowKey { get; set; } = string.Empty;
    public DateTimeOffset? Timestamp { get; set; }
    public ETag ETag { get; set; }

    // Business properties
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public string ServiceName { get; set; } = string.Empty;
    public string AgentIdentityInstanceIds { get; set; } = string.Empty;
    public string? WebhookUrl { get; set; }
    public DateTime? LastChecked { get; set; }
    
    public bool ProcessLifecycleEvents { get; set; } = true;
    public bool ProcessRuntimeEvents { get; set; } = true;
        
    /// <summary>
    /// Number of instances currently tracked
    /// </summary>
    public int InstanceCount { get; set; }

    public AgentBlueprintEntity()
    {
    }

    public AgentBlueprintEntity(Guid id, Guid tenantId, string serviceName)
    {
        Id = id;
        TenantId = tenantId;
        ServiceName = serviceName;
            
        // Use ServiceName as PartitionKey for efficient querying by service
        PartitionKey = serviceName;
        // Use Id as RowKey for unique identification
        RowKey = id.ToString();
    }

    /// <summary>
    /// Get the list of agent identity instance IDs as a collection
    /// </summary>
    public IEnumerable<string> GetAgentInstanceIds()
    {
        if (string.IsNullOrEmpty(AgentIdentityInstanceIds))
            return [];

        return AgentIdentityInstanceIds.Split(',', StringSplitOptions.RemoveEmptyEntries)
            .Select(id => id.Trim())
            .Where(id => !string.IsNullOrEmpty(id));
    }

    /// <summary>
    /// Set the agent identity instance IDs from a collection
    /// </summary>
    public void SetAgentInstanceIds(IEnumerable<string> instanceIds)
    {
        AgentIdentityInstanceIds = string.Join(",", instanceIds.Where(id => !string.IsNullOrEmpty(id)));
        InstanceCount = GetAgentInstanceIds().Count();
    }

    /// <summary>
    /// Add new instance IDs to the existing list
    /// </summary>
    public void AppendAgentInstanceIds(IEnumerable<string> newInstanceIds)
    {
        var currentIds = GetAgentInstanceIds().ToHashSet(StringComparer.OrdinalIgnoreCase);
        var updatedIds = currentIds.Union(newInstanceIds.Where(id => !string.IsNullOrEmpty(id)), StringComparer.OrdinalIgnoreCase);
        SetAgentInstanceIds(updatedIds);
    }
}