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
    /// Indicates whether the initial greeting has been sent to the manager.
    /// Used to ensure the greeting is only sent once during background processing.
    /// </summary>
    public bool IsGreetingSent { get; set; } = false;

    public AgentMetadata()
    {
    }

    public AgentMetadata(Guid tenantId, Guid agentId, Guid userId, string agentFriendlyName, string owningServiceName)
    {
        // Use TenantId as PartitionKey for efficient querying within tenant
        PartitionKey = tenantId.ToString();
        // Use AgentId as RowKey for unique identification
        RowKey = agentId.ToString();

        TenantId = tenantId;
        AgentId = agentId;
        UserId = userId;
        AgentFriendlyName = agentFriendlyName;
        OwningServiceName = owningServiceName;
    }
}