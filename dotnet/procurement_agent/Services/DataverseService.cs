namespace ProcurementA365Agent.Services;

using System.Collections.Concurrent;
using ProcurementA365Agent.AgentLogic;
using ProcurementA365Agent.Models;
using Microsoft.PowerPlatform.Dataverse.Client;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

public sealed class DataverseService(
    IConfiguration configuration,
    ILogger<DataverseService> logger,
    AgentTokenHelper agentTokenHelper)
{
    private static readonly ConcurrentDictionary<Guid, ServiceClient> DataverseServiceClients = new();

    /// <summary>
    /// Simple method to retrieve records from a Dataverse table for POC
    /// </summary>
    /// <param name="agent">The agent with authentication credentials</param>
    /// <param name="tableName">The logical name of the table to query</param>
    /// <returns>Collection of records</returns>
    public async Task<IEnumerable<Entity>> GetRecordsAsync(AgentMetadata agent, string tableName)
    {
        if (string.IsNullOrEmpty(tableName))
        {
            throw new ArgumentException("Table name is required", nameof(tableName));
        }

        try
        {
            var serviceClient = GetDataverseServiceClient(agent);
            logger.LogInformation("Attempting to get records from table: {TableName} using appId: {AgentApplicationId} in tenant: {TenantId}", tableName, agent.AgentApplicationId, agent.TenantId);

            var query = new QueryExpression(tableName)
            {
                ColumnSet = { AllColumns = true },
                TopCount = 10
            };

            var result = await serviceClient.RetrieveMultipleAsync(query);
            
            logger.LogInformation("Retrieved {EntitiesCount} records from table: {TableName}", result.Entities.Count, tableName);
            return result.Entities;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error getting records from table: {TableName}", tableName);
            throw;
        }
    }

    private ServiceClient GetDataverseServiceClient(AgentMetadata agent)
    {
        var agentId = agent.AgentId;
        
        return DataverseServiceClients.GetOrAdd(agentId, _ => CreateDataverseServiceClient(agent));
    }

    private ServiceClient CreateDataverseServiceClient(AgentMetadata agent)
    {
        // Validate required configuration
        if (agent.AgentId == Guid.Empty || agent.AgentApplicationId == Guid.Empty || agent.TenantId == Guid.Empty)
        {
            throw new InvalidOperationException("Agent configuration is required. Please provide AgentId, AgentApplicationId and TenantId in the agent.");
        }

        // Get the Dataverse environment URL from configuration
        var dataverseEnvironmentUrl = configuration["DataverseOrgUrl"];
        if (string.IsNullOrEmpty(dataverseEnvironmentUrl))
        {
            throw new InvalidOperationException("DataverseOrgUrl is required in configuration.");
        }

        // Check for certificate authentication configuration
        var certificateData = configuration.GetCertificateData();
        
        if (!string.IsNullOrEmpty(certificateData))
        {
            if (!agent.SkipAgentIdAuth)
            {
                try
                {
                    return CreateDataverseServiceClientWithAgenticUserIdentity(agent, certificateData, dataverseEnvironmentUrl);
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Error in CreateDataverseServiceClientWithAgenticUserIdentity, trying fallback method");
                }
            }
        }

        throw new InvalidOperationException("Unable to create Dataverse client. Ensure proper authentication configuration is provided.");
    }

    private ServiceClient CreateDataverseServiceClientWithAgenticUserIdentity(
        AgentMetadata agent,
        string certificateData,
        string dataverseOrgUrl)
    {
        try
        {
            logger.LogInformation("Creating Dataverse ServiceClient with agentic user identity using AgentTokenCredential");

            // Create AgentTokenCredential directly with the agent object
            var tokenCredential = new AgentTokenCredential(agentTokenHelper, agent, certificateData);

            // Create ServiceClient with a lambda that uses the AgentTokenCredential
            var serviceClient = new ServiceClient(
                new Uri(dataverseOrgUrl),
                async (resource) =>
                {
                    // Create token request context with Dataverse scope
                    var tokenRequestContext = new Azure.Core.TokenRequestContext([$"{dataverseOrgUrl}/.default"]);
                    
                    // Get token using AgentTokenCredential
                    var accessToken = await tokenCredential.GetTokenAsync(tokenRequestContext, CancellationToken.None);
                    
                    return accessToken.Token;
                },
                useUniqueInstance: true);

            return serviceClient;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error creating Dataverse ServiceClient with agentic user identity");
            throw;
        }
    }
}