namespace ProcurementA365Agent.Services;

using Azure;
using Azure.Data.Tables;
using ProcurementA365Agent.Models;
using ProcurementA365Agent.Util;

public interface IAgentMetadataRepository
{
    Task<AgentMetadata?> GetAsync(Guid tenantId, Guid agentId, CancellationToken cancellationToken = default);
    Task<IReadOnlyCollection<AgentMetadata>> GetByEmail(string email, CancellationToken cancellationToken = default);
    Task<IReadOnlyCollection<AgentMetadata>> ListAsync(
        string? filter = null, CancellationToken cancellationToken = default);
    Task<IReadOnlyCollection<AgentMetadata>> ListAsyncForService(
        string serviceName, CancellationToken cancellationToken = default);
    Task<AgentMetadata> CreateAsync(AgentMetadata agent, bool throwErrorOnConflict = true);
    Task UpdateAsync(AgentMetadata agent);
    Task DeleteAsync(Guid tenantId, Guid agentId);
}

public interface IAgentBlueprintRepository
{
    Task<IReadOnlyCollection<AgentBlueprintEntity>> GetEntitiesByServiceAsync(
        string serviceName, CancellationToken cancellationToken = default);
    Task<IReadOnlyCollection<AgentBlueprintEntity>> ListEntitiesAsync(
        string? filter = null, CancellationToken cancellationToken = default);
    Task<AgentBlueprintEntity> CreateEntityAsync(AgentBlueprintEntity entity);
    Task<AgentBlueprintEntity> UpdateEntityAsync(AgentBlueprintEntity entity);
    Task DeleteEntityAsync(Guid id);
}

public sealed class StorageTableService(
    ILogger<StorageTableService> logger, TableServiceClient tableServiceClient
) : IAgentMetadataRepository, IAgentBlueprintRepository
{
    private readonly TableClient tableClient = tableServiceClient.GetTableClient(TableName);
    private readonly TableClient entityTableClient = tableServiceClient.GetTableClient(EntityTableName);
    private const string TableName = "Agents";
    private const string EntityTableName = "AgentApplicationEntitiesV1";

    /// <summary>
    /// Initialize the tables if they don't exist
    /// </summary>
    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            await tableClient.CreateIfNotExistsAsync(cancellationToken);
            logger.LogInformation("Table '{TableName}' initialized successfully", TableName);
            
            await entityTableClient.CreateIfNotExistsAsync(cancellationToken);
            logger.LogInformation("Table '{EntityTableName}' initialized successfully", EntityTableName);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to initialize tables");
            throw;
        }
    }

    /// <summary>
    /// Get a specific agent by tenant and agent ID
    /// </summary>
    public async Task<AgentMetadata?> GetAsync(Guid tenantId, Guid agentId, CancellationToken cancellationToken = default)
    {
        try
        {
            var response = await tableClient.GetEntityIfExistsAsync<AgentMetadata>(
                tenantId.ToString(),
                agentId.ToString(),
                cancellationToken: cancellationToken);

            if (response.HasValue)
            {
                logger.LogDebug("Retrieved agent {AgentId} for tenant {TenantId}", agentId, tenantId);
                return response.Value;
            }

            logger.LogDebug("Agent {AgentId} not found for tenant {TenantId}", agentId, tenantId);
            return null;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to retrieve agent {AgentId} for tenant {TenantId}", agentId, tenantId);
            throw;
        }
    }

    public Task<IReadOnlyCollection<AgentMetadata>> GetByEmail(
        string email, CancellationToken cancellationToken = default)
    {
        return ListAsync(TableClient.CreateQueryFilter($"EmailId eq {email}"), cancellationToken);
    }

    /// <summary>
    /// Get all agents without filtering
    /// </summary>
    public async Task<IReadOnlyCollection<AgentMetadata>> ListAsync(
        string? filter = null, CancellationToken cancellationToken = default)
    {
        try
        {
            var agents = await tableClient
                .QueryAsync<AgentMetadata>(filter, cancellationToken: cancellationToken)
                .ToListAsync();
            logger.LogDebug("Retrieved {Count} agents", agents.Count);
            return agents;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to retrieve all agents");
            throw;
        }
    }

    /// <summary>
    /// Get all agents for a specific service
    /// </summary>
    public async Task<IReadOnlyCollection<AgentMetadata>> ListAsyncForService(
        string serviceName, CancellationToken cancellationToken = default)
    {
        try
        {
            var filter = TableClient.CreateQueryFilter($"OwningServiceName eq {serviceName}");
            var agents = await ListAsync(filter, cancellationToken);
            logger.LogDebug("Retrieved {Count} agents for service {ServiceName}", agents.Count, serviceName);
            return agents;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to retrieve agents for service {ServiceName}", serviceName);
            throw;
        }
    }

    /// <summary>
    /// Create a new agent
    /// </summary>
    public async Task<AgentMetadata> CreateAsync(AgentMetadata agent, bool throwErrorOnConflict = true)
    {
        try
        {
            // Ensure the partition and row keys are set correctly
            agent.PartitionKey = agent.TenantId.ToString();
            agent.RowKey = agent.AgentId.ToString();

            // Ensure DateTime properties are in UTC for Azure Table Storage
            EnsureDateTimePropertiesAreUtc(agent);

            _ = await tableClient.AddEntityAsync(agent);
            logger.LogInformation("Created agent {AgentId} for tenant {TenantId}", agent.AgentId, agent.TenantId);

            return agent;
        }
        catch (RequestFailedException ex) when (ex.Status == 409)
        {
            logger.LogError("Agent {AgentId} already exists for tenant {TenantId}", agent.AgentId, agent.TenantId);
            if (throwErrorOnConflict)
            {
                throw new InvalidOperationException($"Agent {agent.AgentId} already exists for tenant {agent.TenantId}", ex);
            }
            return agent;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to create Agent {AgentId} for tenant {TenantId}", agent.AgentId, agent.TenantId);
            throw;
        }
    }

    /// <summary>
    /// Update an existing Agent
    /// </summary>
    public async Task UpdateAsync(AgentMetadata agent)
    {
        try
        {
            // Ensure the partition and row keys are set correctly
            agent.PartitionKey = agent.TenantId.ToString();
            agent.RowKey = agent.AgentId.ToString();

            // Ensure DateTime properties are in UTC for Azure Table Storage
            EnsureDateTimePropertiesAreUtc(agent);

            await tableClient.UpdateEntityAsync(agent, agent.ETag, TableUpdateMode.Replace);
            logger.LogInformation("Updated agent {AgentId} for tenant {TenantId}", agent.AgentId, agent.TenantId);

        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            logger.LogError("Agent {AgentId} not found for tenant {TenantId}", agent.AgentId, agent.TenantId);
            throw new InvalidOperationException($"Agent {agent.AgentId} not found for tenant {agent.TenantId}", ex);
        }
        catch (RequestFailedException ex) when (ex.Status == 412)
        {
            logger.LogError("Agent {AgentId} was modified by another process", agent.AgentId);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to update agent {AgentId} for tenant {TenantId}", agent.AgentId, agent.TenantId);
            throw;
        }
    }

    /// <summary>
    /// Delete an agent
    /// </summary>
    public async Task DeleteAsync(Guid tenantId, Guid agentId)
    {
        try
        {
            await tableClient.DeleteEntityAsync(tenantId.ToString(), agentId.ToString());
            logger.LogInformation("Deleted agent {AgentId} for tenant {TenantId}", agentId, tenantId);
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            logger.LogWarning("Attempted to delete non-existent agent {AgentId} for tenant {TenantId}", agentId, tenantId);
            // Don't throw for delete of non-existent entity - idempotent operation
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to delete agent {AgentId} for tenant {TenantId}", agentId, tenantId);
            throw;
        }
    }

    /// <summary>
    /// Ensures that all DateTime properties in the AgentMetadata are in UTC format
    /// to prevent Azure Table Storage serialization errors
    /// </summary>
    private static void EnsureDateTimePropertiesAreUtc(AgentMetadata agent)
    {
        // Convert LastEmailCheck to UTC if it has a value and is not already UTC
        if (agent.LastEmailCheck.HasValue && agent.LastEmailCheck.Value.Kind != DateTimeKind.Utc)
        {
            agent.LastEmailCheck = agent.LastEmailCheck.Value.Kind == DateTimeKind.Local
                ? agent.LastEmailCheck.Value.ToUniversalTime()
                : DateTime.SpecifyKind(agent.LastEmailCheck.Value, DateTimeKind.Utc);
        }
    }

    #region AgentApplicationEntity Methods

    /// <summary>
    /// Get a specific agent application entity by ID
    /// </summary>
    public async Task<AgentBlueprintEntity?> GetEntityAsync(Guid id, CancellationToken cancellationToken = default)
    {
        try
        {
            // We need to query by RowKey since we don't know the PartitionKey (ServiceName)
            var filter = TableClient.CreateQueryFilter($"RowKey eq {id.ToString()}");
            var entities = await entityTableClient
                .QueryAsync<AgentBlueprintEntity>(filter, cancellationToken: cancellationToken)
                .ToListAsync();
            
            var entity = entities.FirstOrDefault();
            if (entity != null)
            {
                logger.LogDebug("Retrieved agent application entity {Id}", id);
                return entity;
            }

            logger.LogDebug("Agent application entity {Id} not found", id);
            return null;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to retrieve agent application entity {Id}", id);
            throw;
        }
    }

    /// <summary>
    /// Get all agent application entities for a specific service
    /// </summary>
    public async Task<IReadOnlyCollection<AgentBlueprintEntity>> GetEntitiesByServiceAsync(
        string serviceName, CancellationToken cancellationToken = default)
    {
        try
        {
            var filter = TableClient.CreateQueryFilter($"ServiceName eq {serviceName}");
            var entities = await ListEntitiesAsync(filter, cancellationToken);
            logger.LogDebug("Retrieved {Count} agent application entities for service {ServiceName}", entities.Count, serviceName);
            return entities;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to retrieve agent application entities for service {ServiceName}", serviceName);
            throw;
        }
    }

    /// <summary>
    /// List agent blueprint entities with optional filtering
    /// </summary>
    public async Task<IReadOnlyCollection<AgentBlueprintEntity>> ListEntitiesAsync(
        string? filter = null, CancellationToken cancellationToken = default)
    {
        try
        {
            var entities = await entityTableClient
                .QueryAsync<AgentBlueprintEntity>(filter, cancellationToken: cancellationToken)
                .ToListAsync();
            logger.LogDebug("Retrieved {Count} agent application entities", entities.Count);
            return entities;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to retrieve agent application entities");
            throw;
        }
    }

    /// <summary>
    /// Create a new agent application entity
    /// </summary>
    public async Task<AgentBlueprintEntity> CreateEntityAsync(AgentBlueprintEntity entity)
    {
        try
        {
            // Ensure the partition and row keys are set correctly
            entity.PartitionKey = entity.TenantId.ToString();
            entity.RowKey = entity.Id.ToString();

            // Ensure DateTime properties are in UTC for Azure Table Storage
            EnsureEntityDateTimePropertiesAreUtc(entity);

            _ = await entityTableClient.AddEntityAsync(entity);
            logger.LogInformation("Created agent application entity {Id} for service {ServiceName}", entity.Id, entity.ServiceName);

            return entity;
        }
        catch (RequestFailedException ex) when (ex.Status == 409)
        {
            logger.LogError("Agent application entity {Id} already exists", entity.Id);
            throw new InvalidOperationException($"Agent application entity {entity.Id} already exists", ex);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to create agent application entity {Id}", entity.Id);
            throw;
        }
    }

    /// <summary>
    /// Update an existing agent application entity
    /// </summary>
    public async Task<AgentBlueprintEntity> UpdateEntityAsync(AgentBlueprintEntity entity)
    {
        try
        {
            // Ensure the partition and row keys are set correctly
            entity.PartitionKey = entity.TenantId.ToString();
            entity.RowKey = entity.Id.ToString();

            // Ensure DateTime properties are in UTC for Azure Table Storage
            EnsureEntityDateTimePropertiesAreUtc(entity);

            _ = await entityTableClient.UpdateEntityAsync(entity, entity.ETag, TableUpdateMode.Replace);
            logger.LogInformation("Updated agent application entity {Id}", entity.Id);

            return entity;
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            logger.LogError("Agent application entity {Id} not found", entity.Id);
            throw new InvalidOperationException($"Agent application entity {entity.Id} not found", ex);
        }
        catch (RequestFailedException ex) when (ex.Status == 412)
        {
            logger.LogError("Agent application entity {Id} was modified by another process", entity.Id);
            throw new InvalidOperationException($"Agent application entity {entity.Id} was modified by another process. Please refresh and try again.", ex);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to update agent application entity {Id}", entity.Id);
            throw;
        }
    }

    /// <summary>
    /// Delete an agent application entity
    /// </summary>
    public async Task DeleteEntityAsync(Guid id)
    {
        try
        {
            // First find the entity to get the partition key
            var entity = await GetEntityAsync(id);
            if (entity == null)
            {
                logger.LogWarning("Attempted to delete non-existent agent application entity {Id}", id);
                return; // Idempotent operation
            }

            await entityTableClient.DeleteEntityAsync(entity.PartitionKey, entity.RowKey);
            logger.LogInformation("Deleted agent application entity {Id}", id);
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            logger.LogWarning("Attempted to delete non-existent agent application entity {Id}", id);
            // Don't throw for delete of non-existent entity - idempotent operation
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to delete agent application entity {Id}", id);
            throw;
        }
    }

    /// <summary>
    /// Ensures that all DateTime properties in the AgentApplicationEntity are in UTC format
    /// to prevent Azure Table Storage serialization errors
    /// </summary>
    private static void EnsureEntityDateTimePropertiesAreUtc(AgentBlueprintEntity entity)
    {
        // Convert LastChecked to UTC if it has a value and is not already UTC
        if (entity.LastChecked.HasValue && entity.LastChecked.Value.Kind != DateTimeKind.Utc)
        {
            entity.LastChecked = entity.LastChecked.Value.Kind == DateTimeKind.Local
                ? entity.LastChecked.Value.ToUniversalTime()
                : DateTime.SpecifyKind(entity.LastChecked.Value, DateTimeKind.Utc);
        }
    }

    #endregion
}