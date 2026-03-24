namespace ProcurementA365Agent.Controllers;

using ProcurementA365Agent.Models;
using ProcurementA365Agent.Services;
using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("api/ComplianceAgent")] // Deprecated route, kept for backward compatibility
[Route("api/agents")]
public class AgentController(
    IAgentMetadataRepository agentMetadataRepository
) : ControllerBase
{
    [HttpGet("healthcheck")]
    public async Task<ActionResult<object>> HealthCheck()
    {
        var agents = await agentMetadataRepository.ListAsync();

        return Ok("Health check successful. Agent count: " + agents.Count());
    }

    /// <summary>
    /// Create a new agent instance
    /// Example url: http://localhost:5280/api/agents/provision
    /// </summary>
    /// <returns>Success if agent was provisioned</returns>
    [HttpPost("provision")]
    public async Task<ActionResult<object>> Provision(ProvisionRequest request)
    {
        if (request.AgentBlueprintId.Equals(Guid.Empty))
        {
            return BadRequest("AgentBlueprintId is required");
        }

        if (request.AgentId.Equals(Guid.Empty))
        {
            return BadRequest("AgentId is required");
        }
        
        // Check if agent already exists
        var existingAgent = await agentMetadataRepository.GetAsync(request.TenantId, request.AgentId);
        if (existingAgent != null)
        {
            return BadRequest("Agent already exists for TenantId: " + request.TenantId + ", AgentId: " + request.AgentId);
        }

        var emailId = string.IsNullOrEmpty(request.UserEmail) ? request.UserObjectId.ToString() : request.UserEmail;

        var newAgent = new AgentMetadata
        {
            TenantId = request.TenantId,
            AgentId = request.AgentId,
            AgentApplicationId = request.AgentBlueprintId,
            UserId = request.UserObjectId,
            EmailId = emailId,
            WebhookUrl = request.WebhookUrl,
            OwningServiceName = ServiceUtilities.GetServiceName(),
            PartitionKey = request.TenantId.ToString(),
            RowKey = request.AgentId.ToString(),
            // Use provided friendly name or make up one for debugging purposes
            AgentFriendlyName = string.IsNullOrEmpty(request.AgentFriendlyName)
                ? $"Agent-{request.AgentId}-{DateTime.UtcNow:yyyyMMddHHmmss}"
                : request.AgentFriendlyName
        };

        await agentMetadataRepository.CreateAsync(newAgent);

        return Ok("Provisioning successful for AgentId: " + request.AgentId);
    }

    [HttpDelete("{tenantId:guid}/{agentId:guid}")]
    public async Task<IActionResult> DeleteAgent(Guid tenantId, Guid agentId)
    {
        await agentMetadataRepository.DeleteAsync(tenantId, agentId);
        return NoContent();
    }
}

public class ProvisionRequest
{
    /// <summary>
    /// EntraID tenantId
    /// </summary>
    public Guid TenantId { get; set; }

    /// <summary>
    /// EntraID agent application Id
    /// </summary>
    public Guid AgentId { get; set; }

    /// <summary>
    /// EntraID user object Id
    /// </summary>
    public Guid UserObjectId { get; set; }

    /// <summary>
    /// User email address
    /// </summary>
    public string UserEmail { get; set; } = string.Empty;

    /// <summary>
    /// Webhook URL for notifications
    /// </summary>
    public string WebhookUrl { get; set; } = string.Empty;

    /// <summary>
    /// Friendly name for the agent (optional)
    /// </summary>
    public string AgentFriendlyName { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the Agent Blueprint Id.
    /// </summary>
    public Guid AgentBlueprintId { get; set; }
}