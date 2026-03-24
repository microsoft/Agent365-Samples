namespace ProcurementA365Agent.AgentLogic;

using ProcurementA365Agent.Models;
using ProcurementA365Agent.Services;
using Microsoft.Agents.Builder.App;
using Microsoft.Agents.Core.Models;
using Microsoft.Agents.A365.Notifications.Models;
using AgentNotification;
using Microsoft.Agents.A365.Notifications.Extensions;

/// <summary>
/// This is main handler for incoming activities, and is linked to Agent SDK infrastructure.
/// This will need to resolve the incoming activity to the correct agent instance.
/// </summary>
public class A365AgentApplication : AgentApplication
{
    private readonly AgentLogicServiceFactory _factory;
    private readonly IAgentMetadataRepository agentMetadataRepository;
    private readonly IConfiguration _configuration;

    public A365AgentApplication(
        AgentApplicationOptions options,
        IAgentMetadataRepository agentMetadataRepository,
        AgentLogicServiceFactory factory,
        IConfiguration configuration) : base(options)
    {
        _factory = factory ?? throw new ArgumentNullException(nameof(factory));
        this.agentMetadataRepository = agentMetadataRepository ?? throw new ArgumentNullException(nameof(agentMetadataRepository));
        _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
        // Configure the agent to handle message activities
        ConfigureMessageHandling();
    }

    /// <summary>
    /// Configures message handling for the agent.
    /// </summary>
    private void ConfigureMessageHandling()
    {
        // Handle Email notifications using the AgentNotification extension
        this.OnAgenticEmailNotification(async (turnContext, turnState, agentNotificationActivity, cancellationToken) =>
        {
            var agent = await GetAgentFromRecipient(turnContext.Activity);
            var agentService = await _factory.GetService(agent);
            if (agent.IsMessagingEnabled)
            {
                // Use the specific email notification handler
                await agentService.HandleEmailNotificationAsync(turnContext, turnState, agentNotificationActivity);
            }
            else
            {
                await agentService.NewActivityReceived(turnContext, turnState, cancellationToken);
            }
        });

        // Handle Word notifications
        this.OnAgenticWordNotification(async (turnContext, turnState, agentNotificationActivity, cancellationToken) =>
        {
            var agent = await GetAgentFromRecipient(turnContext.Activity);
            var agentService = await _factory.GetService(agent);

            if (agent.IsMessagingEnabled)
            {
                // Use the specific comment notification handler for Word documents
                await agentService.HandleCommentNotificationAsync(turnContext, turnState, agentNotificationActivity);
            }
            else
            {
                await agentService.NewActivityReceived(turnContext, turnState, cancellationToken);
            }
        });

        // Handle Excel notifications
        this.OnAgenticExcelNotification(async (turnContext, turnState, agentNotificationActivity, cancellationToken) =>
        {
            var agent = await GetAgentFromRecipient(turnContext.Activity);
            var agentService = await _factory.GetService(agent);

            if (agent.IsMessagingEnabled)
            {
                // Use the specific comment notification handler for Excel documents
                await agentService.HandleCommentNotificationAsync(turnContext, turnState, agentNotificationActivity);
            }
            else
            {
                await agentService.NewActivityReceived(turnContext, turnState, cancellationToken);
            }
        });

        // Handle PowerPoint notifications
        this.OnAgenticPowerPointNotification(async (turnContext, turnState, agentNotificationActivity, cancellationToken) =>
        {
            var agent = await GetAgentFromRecipient(turnContext.Activity);
            var agentService = await _factory.GetService(agent);

            if (agent.IsMessagingEnabled)
            {
                // Use the specific comment notification handler for PowerPoint documents
                await agentService.HandleCommentNotificationAsync(turnContext, turnState, agentNotificationActivity);
            }
            else
            {
                await agentService.NewActivityReceived(turnContext, turnState, cancellationToken);
            }
        });

        this.OnAgenticUserIdentityCreatedNotification(async (turnContext, turnState, agentNotificationActivity, cancellationToken) =>
        {
            
            var agent = await GetAgentFromRecipient(turnContext.Activity);
            var agentService = await _factory.GetService(agent);
            if (agent.IsMessagingEnabled)
            {
                // Use the specific user identity created notification handler
                // Update this
                await agentService.NewAgentCreatedAsync(turnContext, turnState, agentNotificationActivity, cancellationToken);
            }
            else
            {
                await agentService.NewActivityReceived(turnContext, turnState, cancellationToken);
            }
        });

        OnActivity(ActivityTypes.Message, async (turnContext, turnState, cancellationToken) =>
        {
            // Based on the recipient, determine which agent to use
            var agent = await GetAgentFromRecipient(turnContext.Activity);

            // Get agent logic service from factory
            var agentService = await _factory.GetService(agent);

            // Ignoring all other channel Ids to prevent duplicate notifications.
			if (agent.IsMessagingEnabled && turnContext.Activity.ChannelId != "msteams")
            {
                return;
            }

			// Execute logic
			await agentService.NewActivityReceived(turnContext, turnState, cancellationToken);
        });

        // Keep existing handlers for backward compatibility
        OnActivity(ActivityTypes.Event, async (turnContext, turnState, cancellationToken) =>
        {
            var agent = await GetAgentFromRecipient(turnContext.Activity);
            var agentService = await _factory.GetService(agent);

            await agentService.NewActivityReceived(turnContext, turnState, cancellationToken);
        });

        OnActivity(ActivityTypes.InstallationUpdate, async (turnContext, turnState, cancellationToken) =>
        {
            var agent = await GetAgentFromRecipient(turnContext.Activity);
            var agentService = await _factory.GetService(agent);
            
            if (agent.IsMessagingEnabled)
            {
				// Create AgentNotificationActivity for installation updates
				var agentNotificationActivity = new AgentNotificationActivity(turnContext.Activity);
				await agentService.HandleInstallationUpdateAsync(turnContext, turnState, agentNotificationActivity);
            }
            else
            {
                await agentService.NewActivityReceived(turnContext, turnState, cancellationToken);
			}
		});
    }


    private async Task<AgentMetadata> GetAgentFromRecipient(IActivity activity)
    {
        ChannelAccount recipient = activity.Recipient;
        ConversationAccount conversation = activity.Conversation;

        if (recipient == null)  
        {
            throw new ArgumentNullException(nameof(recipient), "Recipient cannot be null.");
        }

        // Recipient will have an ID, but this may not be sufficient to determine the agent.
        // ChannelAccount recipient currently has an AadObjectId, which we can try using to identify the user.
        // If activityProtocol and SDK is changed to pass a new field, we can update this code to use that instead.
        var aadObjectId = Guid.TryParse(recipient.AadObjectId, out var parsedId) ? parsedId : Guid.Empty;
        var id = recipient.Id;
        var tenantId = Guid.TryParse(conversation.TenantId, out var parsedTenantId) ? parsedTenantId : Guid.Empty;

        var agents = await GetAgents(agentMetadataRepository);

        var matchingAgent = agents.FirstOrDefault(a => a.UserId == aadObjectId || a.UserId.ToString() == id);
        if (matchingAgent != null)
        {
            return matchingAgent;
        }

        matchingAgent = agents.FirstOrDefault(a => a.AgentId == aadObjectId);
        if (matchingAgent != null)
        {
            return matchingAgent;
        }

        matchingAgent = agents.FirstOrDefault(a => a.EmailId == id);
        if (matchingAgent != null)
        {
            return matchingAgent;
        }

        if (string.IsNullOrEmpty(recipient.AadObjectId))
        {
            Console.WriteLine($"Recipient AadObjectId is null or empty for recipient ID {recipient.Id}. Using the default agent.");
            matchingAgent = agents.FirstOrDefault();
        }
        if (matchingAgent != null)
        {
            return matchingAgent;
        }

        throw new InvalidOperationException(
            $"No agent found for recipient {recipient.Name} with ID {recipient.Id} in tenant {tenantId}. " +
            "Ensure the agent is registered and has the correct user ID or agent ID.");
    }

    private async Task<IReadOnlyCollection<AgentMetadata>> GetAgents(IAgentMetadataRepository storageService)
    {
        var agentEmail = _configuration.GetAgentEmailFilter();

        if (string.IsNullOrEmpty(agentEmail))
        {
            return await storageService.ListAsyncForService(ServiceUtilities.GetServiceName());
        }

        return await storageService.GetByEmail(agentEmail);
    }
}
