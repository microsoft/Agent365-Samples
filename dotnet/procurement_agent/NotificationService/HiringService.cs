namespace ProcurementA365Agent.NotificationService;

using System.Diagnostics;
using System.Text;
using System.Text.Json;
using ProcurementA365Agent.Models;
using ProcurementA365Agent.Services;
using ProcurementA365Agent.Util;

public sealed class HiringService(
    ILogger<HiringService> logger,
    IAgentBlueprintRepository agentBlueprintRepository,
    IAgentMetadataRepository agentMetadataRepository,
    GraphService graphService,
    IActivitySenderService activitySenderService,
    IConfiguration configuration,
    IHttpClientFactory httpClientFactory)
{
    private static readonly ActivitySource ActivitySource = new(Constants.ActivitySourceName);
    
    private static readonly HashSet<Guid> RequiredSkus = [ // TODO allow any teams!
        new("7e31c0d9-9551-471d-836f-32ee72be4a01"),// teams ENTERPRISE
        new("18a4bd3f-0b5b-4887-b04f-61dd0ee15f5e"), // E5 license skus
    ];

    private static readonly string[] RequiredScopes = ["Mail.ReadWrite", "Mail.Send", "Chat.ReadWrite", "User.Read.All"];
    private readonly HttpClient httpClient = httpClientFactory.CreateClient();

    public async Task ProcessBlueprint(AgentBlueprintEntity entity, CancellationToken cancellationToken)
    {
        using var activity = ActivitySource.StartActivity();
        activity?.SetTag("AgentBlueprintId", entity.Id);
        activity?.SetTag("TenantId", entity.TenantId);
        activity?.SetTag("ServiceName", entity.ServiceName);
        var lookbackTimespan = TimeSpan.Parse(configuration["NotificationService:LookbackPeriod"] ?? "1.00:00:00"); // default to 1-day lookback
        logger.LogDebug("Processing entity {EntityId} for tenant {TenantId}", entity.Id, entity.TenantId);
        
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(TimeSpan.FromSeconds(configuration.GetValue("NotificationService:BlueprintTimeoutInSeconds", 60)));
        var blueprintCancellation = cts.Token;
        
        try
        {
            // Get current agent identity service principals for this entity's ID since last check
            var servicePrincipals = await graphService.GetAgentIdentityServicePrincipalsAsync(
                entity.Id.ToString(),
                entity.TenantId.ToString(),
                DateTime.Now.Subtract(lookbackTimespan),
                blueprintCancellation);
            var existingInstanceIds = entity
                .GetAgentInstanceIds()
                .ToHashSet(StringComparer.OrdinalIgnoreCase);

            // Find new instances that weren't in the entity before
            var newServicePrincipals = servicePrincipals
                .Where(sp => !existingInstanceIds.Contains(sp.AppId))
                .ToList();

            logger.LogDebug("Found {NewInstanceCount} new agent identity instances for entity {EntityId}: [{NewInstances}]",
                newServicePrincipals.Count, entity.Id, newServicePrincipals.Select(sp => sp.AppId).JoinToString());

            foreach (var sp in newServicePrincipals)
            {
                var processed = await ProcessNewAgentInstance(entity, sp, blueprintCancellation);
                if (processed)
                {
                    // Add the new instance IDs to the entity
                    entity.AppendAgentInstanceIds([sp.AppId]);
                }
            }

            // Update the last checked time and entity
            entity.LastChecked = DateTime.UtcNow;
            await agentBlueprintRepository.UpdateEntityAsync(entity);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error processing entity {EntityId} for tenant {TenantId}",
                entity.Id, entity.TenantId);
        }
    }

    private async Task<bool> ProcessNewAgentInstance(
        AgentBlueprintEntity entity, AgentIdentityServicePrincipal servicePrincipal, CancellationToken cancellationToken)
    {
        using var instanceActivity = ActivitySource.StartActivity();
        instanceActivity?.SetTag("AgentInstanceId", servicePrincipal.AppId);

        try
        {
            logger.LogInformation("Processing new agent instance {InstanceId} for entity {EntityId}", servicePrincipal.AppId, entity.Id);

            var agentIdentityHasConsent = await graphService.CheckServicePrincipalOAuth2PermissionsAsync(
                servicePrincipal, RequiredScopes, entity.TenantId.ToString(), cancellationToken);
            if (!agentIdentityHasConsent)
            {
                logger.LogWarning("Agent instance id {InstanceId} does not have required consents {RequiredScopes}", servicePrincipal.AppId, RequiredScopes.JoinToString());
                // return false;
            }

            // Get the agent user for this instance
            var agentUser = await graphService.FindAgentUser(servicePrincipal, entity.TenantId, cancellationToken);
            if (agentUser == null)
            {
                var backfillAgentUserForBlueprints = configuration
                    .GetSection("NotificationService:BackfillAgentUserForBlueprints").Get<string[]>() ?? [];
                if (backfillAgentUserForBlueprints.Contains(entity.Id.ToString()))
                {
                    var domain = await GetDomain(entity.TenantId, cancellationToken);
                    
                    var alias = servicePrincipal.DisplayName.Replace(" ", "").ToLowerInvariant();
                    if (!string.IsNullOrEmpty(domain))
                    {
                        var userPrincipalName = $"{alias}@{domain}";
                        var existingUserWithSameUpn = await graphService.FindUserByPrincipalName(userPrincipalName, entity.RowKey, entity.TenantId, cancellationToken);
                        if (existingUserWithSameUpn != null)
                        {
                            // insert random suffix to avoid conflict
                            var randomSuffix = Guid.NewGuid().ToString().Split('-')[0];
                            alias = $"{alias}{randomSuffix}";
                            userPrincipalName = $"{alias}@{domain}";
                        }
                        var createAgentUserRequest = new CreateAgentUserRequest
                        {
                            DisplayName = servicePrincipal.DisplayName,
                            MailNickname = alias,
                            UserPrincipalName = userPrincipalName,
                            IdentityParentId = servicePrincipal.AppId
                        };
                        await graphService.CreateAgentUser(createAgentUserRequest, entity);
                    }
                    return false;
                }
            }
            if (agentUser == null || !ValidateAgentUser(agentUser))
            {
                logger.LogWarning("Could not find valid agent user for instance {InstanceId}", servicePrincipal.AppId);
                return false;
            }

            var agentMetadata = ConstructAgentMetadata(entity, servicePrincipal, agentUser);
            await agentMetadataRepository.CreateAsync(agentMetadata, throwErrorOnConflict: false);
            logger.LogInformation("Created agent record for instance {InstanceId} with user ID {UserId}",
                servicePrincipal.AppId, agentUser.Id);

            var chat = await graphService.CreateChatWithUserAsync(agentMetadata, agentUser.Manager!.Id!, cancellationToken);

            try
            {
                await CreateDigitalWorkerOnMavenService(agentMetadata, agentUser);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Could not create a DW on Maven Service {Ex}", ex);
            }
            
            // Send installation activity via webhook if webhook URL is configured
            if (!string.IsNullOrEmpty(entity.WebhookUrl))
            {
                var success = await activitySenderService.SendInstallationActivityToWebhookAsync(agentMetadata, agentUser, chat!.Id!);
                if (success)
                {
                    logger.LogInformation("Successfully sent installation activity for instance {InstanceId} to webhook {WebhookUrl}",
                        servicePrincipal.AppId, entity.WebhookUrl);
                }
                else
                {
                    logger.LogWarning("Failed to send installation activity for instance {InstanceId} to webhook {WebhookUrl}",
                        servicePrincipal.AppId, entity.WebhookUrl);
                }
            }
            else
            {
                logger.LogInformation("No webhook URL configured for entity {EntityId}, skipping installation activity", entity.Id);
            }
            return true;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error processing new agent instance {InstanceId} for entity {EntityId}",
                servicePrincipal.AppId, entity.Id);
            return false;
        }
    }

    private async Task<string?> GetDomain(Guid tenantId, CancellationToken cancellationToken)
    {
        var organization = await graphService.ReadOrganization(tenantId, cancellationToken);
        var defaultDomain = organization?.VerifiedDomains?.FirstOrDefault(o => o.IsDefault == true)
                            ?? organization?.VerifiedDomains?.FirstOrDefault();
        return defaultDomain?.Name;
    }

    private static AgentMetadata ConstructAgentMetadata(
        AgentBlueprintEntity entity, AgentIdentityServicePrincipal servicePrincipal, AgentUser agentUser) =>
        new()
        {
            PartitionKey = entity.TenantId.ToString(),
            RowKey = servicePrincipal.AppId,
            UserId = Guid.TryParse(agentUser.Id, out var userId) ? userId : Guid.NewGuid(),
            AgentId = Guid.TryParse(servicePrincipal.AppId, out var agentId) ? agentId : Guid.NewGuid(),
            AgentApplicationId = entity.Id,
            TenantId = entity.TenantId,
            AgentFriendlyName = agentUser.DisplayName!,
            OwningServiceName = entity.ServiceName,
            EmailId = agentUser.UserPrincipalName!,
            WebhookUrl = entity.WebhookUrl,
            SkipAgentIdAuth = false,
            LastEmailCheck = null,
            LastTeamsCheck = null
        };

    private bool ValidateAgentUser(AgentUser agentUser)
    {
        if (RequiredSkus.Except(agentUser.AssignedLicenses!.Select(l => l.SkuId!.Value)).Any())
        {
            logger.LogWarning(
                "Warning, agent user {AgentUserPrincipalName} does not have required licenses {Licenses}  - skipping",
                agentUser.UserPrincipalName, string.Join(',', RequiredSkus));
            return false;
        }

        if (agentUser.Manager?.Id == null)
        {
            logger.LogWarning("Warning, agent user {AgentUserPrincipalName} does not have a manager - skipping", agentUser.UserPrincipalName);
            return false;
        }

        return true;
    }

    private async Task CreateDigitalWorkerOnMavenService(AgentMetadata agentMetadata, AgentUser agentUser)
    {
        // Check if this entity is enabled for Maven service integration
        var enabledEntityIdsString = configuration["MavenService:EnabledEntityIds"] ?? "";
        var enabledEntityIds = enabledEntityIdsString
            .Split(',', StringSplitOptions.RemoveEmptyEntries)
            .Select(id => id.Trim())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        if (!enabledEntityIds.Contains(agentMetadata.AgentApplicationId.ToString()))
        {
            logger.LogInformation("Entity {EntityId} is not enabled for Maven service integration, skipping DW creation", 
                agentMetadata.AgentApplicationId);
            return;
        }

        var mavenServiceBaseUrl = configuration["MavenService:BaseUrl"];
        var defaultTitleId = configuration["MavenService:DefaultTitleId"];

        if (string.IsNullOrEmpty(mavenServiceBaseUrl))
        {
            logger.LogWarning("MavenService:BaseUrl not configured, skipping DW creation");
            return;
        }

        if (string.IsNullOrEmpty(defaultTitleId))
        {
            logger.LogWarning("MavenService:DefaultTitleId not configured, skipping DW creation");
            return;
        }

        var createDwUrl = $"{mavenServiceBaseUrl}/ad61f97c-a819-4ccb-8c83-2b7ec13d0d2b/{agentMetadata.TenantId}/create";

        var requestBody = new
        {
            name = $"{agentUser.DisplayName}-{Guid.NewGuid().ToString().Split('-')[0]}",
            alias = agentUser.UserPrincipalName,
            description = $"DW created from Hello World Agent - {agentUser.UserPrincipalName}",
            agentId = agentMetadata.AgentId.ToString(),
            identityId = agentMetadata.AgentId.ToString(),
            titleId = defaultTitleId,
            managerId = agentUser.Manager?.Id,
            licenseSkus = new[] { "" }
        };

        try
        {
            var json = JsonSerializer.Serialize(requestBody, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase
            });

            var content = new StringContent(json, Encoding.UTF8, "application/json");

            logger.LogInformation("Creating Digital Worker on Maven service for agent {AgentId} at URL {Url}", 
                agentMetadata.AgentId, createDwUrl);

            var response = await httpClient.PostAsync(createDwUrl, content);

            if (response.IsSuccessStatusCode)
            {
                var responseContent = await response.Content.ReadAsStringAsync();
                logger.LogInformation("Successfully created Digital Worker on Maven service for agent {AgentId}. Response: {Response}", 
                    agentMetadata.AgentId, responseContent);
            }
            else
            {
                var errorContent = await response.Content.ReadAsStringAsync();
                logger.LogError("Failed to create Digital Worker on Maven service for agent {AgentId}. Status: {StatusCode}, Response: {Response}", 
                    agentMetadata.AgentId, response.StatusCode, errorContent);
            }
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Exception occurred while creating Digital Worker on Maven service for agent {AgentId}", 
                agentMetadata.AgentId);
        }
    }
}