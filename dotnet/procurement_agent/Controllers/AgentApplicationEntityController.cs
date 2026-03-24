namespace ProcurementA365Agent.Controllers;

using ProcurementA365Agent.Models;
using ProcurementA365Agent.Services;
using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("api/AgentApplicationEntity")]
[Route("api/AgentBlueprint")]
public sealed class AgentBlueprintEntityController(
    IAgentBlueprintRepository agentBlueprintRepository
) : ControllerBase
{
    /// <summary>
    /// Get all agent blueprint entities for this service
    /// </summary>
    [HttpGet]
    public async Task<ActionResult<IEnumerable<AgentBlueprintEntity>>> GetAll()
    {
        var entities = await agentBlueprintRepository.GetEntitiesByServiceAsync(ServiceUtilities.GetServiceName());
        return Ok(entities);
    }

    /// <summary>
    /// Create a new agent blueprint entity
    /// </summary>
    [HttpPost]
    public async Task<ActionResult<AgentBlueprintEntity>> CreateEntity(CreateEntityRequest request)
    {
        var entity = new AgentBlueprintEntity(
            request.Id ?? Guid.NewGuid(),
            request.TenantId,
            ServiceUtilities.GetServiceName())
        {
            WebhookUrl = request.WebhookUrl
        };

        var createdEntity = await agentBlueprintRepository.CreateEntityAsync(entity);
        return Ok(createdEntity);
    }

    /// <summary>
    /// Delete an agent blueprint entity
    /// </summary>
    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> DeleteEntity(Guid id)
    {
        await agentBlueprintRepository.DeleteEntityAsync(id);
        return NoContent();
    }
}

public sealed class CreateEntityRequest
{
    /// <summary>
    /// Optional ID for the entity. If not provided, a new GUID will be generated.
    /// </summary>
    public Guid? Id { get; set; }

    /// <summary>
    /// The tenant ID for this entity
    /// </summary>
    public Guid TenantId { get; set; }

    /// <summary>
    /// Webhook URL for notifications
    /// </summary>
    public string? WebhookUrl { get; set; }
}