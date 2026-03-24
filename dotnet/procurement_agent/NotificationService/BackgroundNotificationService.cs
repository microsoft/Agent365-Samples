namespace ProcurementA365Agent.NotificationService;

using ProcurementA365Agent.AgentLogic;
using ProcurementA365Agent.Capabilities;
using ProcurementA365Agent.Models;
using ProcurementA365Agent.Services;

/// <summary>
/// Background service that monitors and processes agent instances.
/// This will be able to act automatically based on timer, without requiring any incoming activity.
/// </summary>
public class BackgroundNotificationService : BackgroundService
{
    private readonly ILogger<BackgroundNotificationService> logger;
    private readonly IServiceProvider serviceProvider;
    private readonly IConfiguration configuration;
    private readonly TimeSpan checkInterval;
    private readonly HashSet<string> disableMailForAgenticTenantIds;

    public BackgroundNotificationService(
        ILogger<BackgroundNotificationService> logger,
        IServiceProvider serviceProvider,
        IConfiguration configuration)
    {
        this.logger = logger;
        this.serviceProvider = serviceProvider;
        this.configuration = configuration;

        // Configure check interval (default to 10 seconds)
        var intervalSeconds = configuration.GetValue("NotificationService:CheckIntervalSeconds", 10);
        checkInterval = TimeSpan.FromSeconds(intervalSeconds);

        // Load tenant IDs that should disable mail sending for agentic identity
        var tenantIds = configuration.GetSection("NotificationService:DisableMailForAgenticTenantIds").Get<string[]>() ?? [];
        disableMailForAgenticTenantIds = new HashSet<string>(tenantIds, StringComparer.OrdinalIgnoreCase);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Agent Background Service started");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                // await ProcessAgentApplicationEntitiesAsync(stoppingToken);
                await ProcessAgentsAsync(stoppingToken);


                logger.LogInformation("Notification Background Service cycle completed. Next check in {Interval}", checkInterval);
                await Task.Delay(checkInterval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                // Expected when cancellation is requested
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Error in Notification Background Service");

                // Wait before retrying to avoid rapid failure loops
                try
                {
                    await Task.Delay(TimeSpan.FromMinutes(1), stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }

        logger.LogInformation("Notification Background Service stopped");
    }

    private async Task ProcessAgentsAsync(CancellationToken cancellationToken)
    {
        await using var scope = serviceProvider.CreateAsyncScope();
        var agentMetadataRepository = scope.ServiceProvider.GetRequiredService<IAgentMetadataRepository>();
        var blueprintRepository = scope.ServiceProvider.GetRequiredService<IAgentBlueprintRepository>();
        var messagingService = scope.ServiceProvider.GetRequiredService<IAgentMessagingService>();
        var webhookService = scope.ServiceProvider.GetRequiredService<IActivitySenderService>();
        var agentLogicServiceFactory = scope.ServiceProvider.GetRequiredService<AgentLogicServiceFactory>();

        try
        {
            var agents = await GetAgents(agentMetadataRepository, cancellationToken);
            var blueprints = await blueprintRepository.ListEntitiesAsync(cancellationToken: cancellationToken);

            logger.LogDebug("Processing notifications for {AgentCount} agents for service {ServiceName}", agents.Count, ServiceUtilities.GetServiceName());

            foreach (var agent in agents)
            {
                SetAgentPresenceToActiveAsync(agent, cancellationToken);    
            }
            foreach (var agent in agents.Where(a => blueprints.FirstOrDefault(b => b.Id == a.AgentApplicationId)?.ProcessRuntimeEvents ?? true))
            {
                if (agent.IsMessagingEnabled || cancellationToken.IsCancellationRequested)
                    break;

                await ProcessSingleAgent(agent, messagingService, webhookService, agentLogicServiceFactory, agentMetadataRepository, cancellationToken);
            }
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error processing notifications for agents");
            throw;
        }
    }


    private async Task<IReadOnlyCollection<AgentMetadata>> GetAgents(
        IAgentMetadataRepository storageService, CancellationToken cancellationToken = default)
    {
        var agentEmail = configuration.GetAgentEmailFilter();

        if (string.IsNullOrEmpty(agentEmail))
        {
            return await storageService.ListAsyncForService(ServiceUtilities.GetServiceName(), cancellationToken);
        }

        return await storageService.GetByEmail(agentEmail, cancellationToken);
    }

    private async Task ProcessSingleAgent(
        AgentMetadata agent,
        IAgentMessagingService messagingService,
        IActivitySenderService webhookService,
        AgentLogicServiceFactory factory,
        IAgentMetadataRepository storageService,
        CancellationToken cancellationToken)
    {
        try
        {
            logger.LogInformation("Processing agent {AgentId} for tenant {TenantId}", agent.AgentId, agent.TenantId);

            // Check if manager greeting needs to be sent
            if (!agent.IsGreetingSent)
            {
                logger.LogInformation("Agent {AgentId} has not sent greeting to manager yet, attempting to send greeting", agent.AgentId);
                try
                {
                    var agentLogicService = await factory.GetService(agent);
                    await agentLogicService.NotifyManagerAboutNewAgentAsync(agent, cancellationToken);
                    
                    // Mark greeting as sent and update in storage
                    agent.IsGreetingSent = true;
                    await storageService.UpdateAsync(agent);
                    logger.LogInformation("Successfully sent manager greeting for agent {AgentId} and updated IsGreetingSent flag", agent.AgentId);
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Error sending manager greeting for agent {AgentId}. Will retry on next cycle.", agent.AgentId);
                    // Don't throw - allow other processing to continue
                }
            }

            // Check if agent should skip auth based on configuration or agent setting
            if (agent.SkipAgentIdAuth || !disableMailForAgenticTenantIds.Contains(agent.TenantId.ToString()))
            {
                await ProcessAgentEmail(agent, messagingService, webhookService, factory, storageService, cancellationToken);
            }

            // Process Teams chat messages for the agent
            await ProcessAgentChatMessagesAsync(agent, messagingService, webhookService, factory, storageService, cancellationToken);

            // Perform other periodic tasks for the agent
            await PerformPeriodicMaintenanceAsync(agent, cancellationToken);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error processing agent {AgentId} for tenant {TenantId}",
                agent.AgentId, agent.TenantId);
        }
    }

    private async Task ProcessAgentEmail(
        AgentMetadata agent, IAgentMessagingService emailService, IActivitySenderService webhookService, AgentLogicServiceFactory factory, IAgentMetadataRepository storageService, CancellationToken cancellationToken)
    {
        // Check for new emails since the last check
        var lastCheckTime = agent.LastEmailCheck ?? DateTime.UtcNow.AddHours(-1); // Default to 1 hour ago
        var newMessages = await emailService.CheckForNewEmailAsync(agent, lastCheckTime, cancellationToken);

        if (newMessages.Length > 0)
        {
            logger.LogInformation("Found {MessageCount} new messages for agent {AgentId}",
                newMessages.Length, agent.AgentId);

            // Check if agent has a webhook URL configured
            if (!string.IsNullOrEmpty(agent.WebhookUrl))
            {
                logger.LogInformation("Agent {AgentId} has webhook configured, using webhook path", agent.AgentId);

                // Process each new message via webhook
                foreach (var message in newMessages)
                {
                    if (cancellationToken.IsCancellationRequested)
                        break;

                    await ProcessEmailMessageViaWebhookAsync(agent, message, webhookService);
                }
            }
            else
            {
                logger.LogInformation("Agent {AgentId} has no webhook configured, using direct processing", agent.AgentId);
                var agentLogicService = await factory.GetService(agent);

                // Process each new message directly
                foreach (var message in newMessages)
                {
                    if (cancellationToken.IsCancellationRequested)
                        break;

                    await ProcessEmailMessageAsync(agent, message, emailService, agentLogicService);
                }
            }

            // Update the last check time
            agent.LastEmailCheck = newMessages.Max(m => m.ReceivedDateTime).AddSeconds(1);
            await storageService.UpdateAsync(agent);
        }
        else
        {
            logger.LogInformation("No new messages for agent {AgentId}", agent.AgentId);
        }
    }

    private async Task ProcessAgentChatMessagesAsync(
        AgentMetadata agent, IAgentMessagingService messagingService, IActivitySenderService webhookService,
        AgentLogicServiceFactory factory, IAgentMetadataRepository storageService, CancellationToken cancellationToken)
    {
        // Check for new Teams chat messages since the last check
        var lastCheckTime = agent.LastTeamsCheck ?? DateTime.UtcNow.AddHours(-1); // Default to 1 hour ago
        var newChatMessages = await messagingService.CheckForNewTeamsMessagesAsync(agent, lastCheckTime, cancellationToken);

        if (newChatMessages.Length > 0)
        {
            logger.LogInformation("Found {MessageCount} new Teams messages for agent {AgentId}",
                newChatMessages.Length, agent.AgentId);

            // Check if agent has a webhook URL configured
            if (!string.IsNullOrEmpty(agent.WebhookUrl))
            {
                logger.LogInformation("Agent {AgentId} has webhook configured, using webhook path for Teams messages", agent.AgentId);

                // Process each new chat message via webhook
                foreach (var chatMessage in newChatMessages)
                {
                    if (cancellationToken.IsCancellationRequested)
                        break;

                    await ProcessChatMessageViaWebhookAsync(agent, chatMessage, webhookService);
                }
            }
            else
            {
                logger.LogInformation("Agent {AgentId} has no webhook configured, using direct processing for Teams messages", agent.AgentId);
                var agentLogicService = await factory.GetService(agent);

                // Process each new chat message directly
                foreach (var chatMessageContext in newChatMessages)
                {
                    if (cancellationToken.IsCancellationRequested)
                        break;

                    await ProcessChatMessageAsync(agent, chatMessageContext, messagingService, agentLogicService);
                }
            }

            // Update the last check time
            var lastMessageTime = newChatMessages.Max(m => new[] { m.Message.CreatedDateTime, m.Message.LastModifiedDateTime }.Max())?.UtcDateTime ?? DateTime.UtcNow;
            agent.LastTeamsCheck = lastMessageTime.AddSeconds(1);

            // Update this in storage
            await storageService.UpdateAsync(agent);
        }
        else
        {
            logger.LogDebug("No new Teams messages for agent {AgentId}", agent.AgentId);
        }
    }

    private async Task ProcessEmailMessageAsync(
        AgentMetadata agent,
        EmailMessage message,
        IAgentMessagingService emailService,
        IAgentLogicService service)
    {
        try
        {
            logger.LogInformation("Processing email message {MessageId} for agent {AgentId}",
                message.Id, agent.AgentId);

            // Process the message through the agent with individual parameters
            var response = await service.NewEmailReceived(message.From, message.Subject, message.Body);

            logger.LogInformation("Agent {AgentId} processed message {MessageId}. Response generated: {HasResponse}",
                agent.AgentId, message.Id, !string.IsNullOrEmpty(response));

            // Here you could implement additional logic such as:
            // - Storing the conversation history
            // - Triggering follow-up actions
            // - Sending automated responses
            // - Creating tasks or alerts
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error processing email message {MessageId} for agent {AgentId}",
                message.Id, agent.AgentId);
        }
    }

    private async Task ProcessChatMessageAsync(
        AgentMetadata agent,
        ChatMessageWithContext chatMessageContext,
        IAgentMessagingService messagingService,
        IAgentLogicService service)
    {
        try
        {
            var chatMessage = chatMessageContext.Message;
            logger.LogInformation("Processing Teams chat message {MessageId} for agent {AgentId} in chat type {ChatType}",
                chatMessage.Id, agent.AgentId, chatMessageContext.ChatType);
            var teamsChatMessageFormatter = new TeamsChatMessageFormatter();

            // Process the chat message through the agent
            var fromUser = teamsChatMessageFormatter.FormatSender(chatMessage.From);
            var chatId = chatMessage.ChatId ?? chatMessageContext.ChatId;
            var messageBody = teamsChatMessageFormatter.Format(chatMessage);
            var response = await service.NewChatReceived(chatId, fromUser, messageBody);

            logger.LogInformation("Agent {AgentId} processed Teams message {MessageId}. Response generated: {HasResponse}",
                agent.AgentId, chatMessage.Id, !string.IsNullOrEmpty(response));

            // Here you could implement additional logic such as:
            // - Storing the conversation history
            // - Triggering follow-up actions
            // - Sending automated responses in Teams
            // - Creating tasks or alerts
            await messagingService.SendChatMessageAsync(agent, chatId, response);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error processing Teams chat message {MessageId} for agent {AgentId}",
                chatMessageContext.Message.Id, agent.AgentId);
        }
    }

    private async Task ProcessChatMessageViaWebhookAsync(
        AgentMetadata agent,
        ChatMessageWithContext chatMessage,
        IActivitySenderService webhookService)
    {
        try
        {
            logger.LogInformation("Processing Teams chat message {MessageId} via webhook for agent {AgentId} in chat type {ChatType}",
                chatMessage.Message.Id, agent.AgentId, chatMessage.ChatType);

            // Send the message to the webhook URL - Note: webhook may need to be updated to handle ChatMessageWithContext
            var success = await webhookService.SendActivityToWebhookAsync(agent, chatMessage, agent.WebhookUrl!);

            if (success)
            {
                logger.LogInformation("Successfully sent Teams message {MessageId} to webhook for agent {AgentId}",
                    chatMessage.Message.Id, agent.AgentId);
            }
            else
            {
                logger.LogWarning("Failed to send Teams message {MessageId} to webhook for agent {AgentId}",
                    chatMessage.Message.Id, agent.AgentId);
            }
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error processing Teams chat message {MessageId} via webhook for agent {AgentId}",
                chatMessage.Message.Id, agent.AgentId);
        }
    }

    private async Task ProcessEmailMessageViaWebhookAsync(
        AgentMetadata agent,
        EmailMessage message,
        IActivitySenderService webhookService)
    {
        try
        {
            logger.LogInformation("Processing email message {MessageId} via webhook for agent {AgentId}",
                message.Id, agent.AgentId);

            // Send the message to the webhook URL
            var success = await webhookService.SendActivityToWebhookAsync(agent, message, agent.WebhookUrl!);

            if (success)
            {
                logger.LogInformation("Successfully sent message {MessageId} to webhook for agent {AgentId}",
                    message.Id, agent.AgentId);
            }
            else
            {
                logger.LogWarning("Failed to send message {MessageId} to webhook for agent {AgentId}",
                    message.Id, agent.AgentId);
            }
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error processing email message {MessageId} via webhook for agent {AgentId}",
                message.Id, agent.AgentId);
        }
    }

    private async Task PerformPeriodicMaintenanceAsync(AgentMetadata agent, CancellationToken cancellationToken)
    {
        try
        {
            // Implement periodic maintenance tasks such as:
            // - Checking deadlines
            // - Generating periodic reports
            // - Cleaning up old data
            // - Validating agent configuration

            logger.LogDebug("Performing periodic maintenance for agent {AgentId}", agent.AgentId);

            // Placeholder for maintenance logic
            await Task.CompletedTask;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error during periodic maintenance for agent {AgentId}", agent.AgentId);
        }
    }

    /// <summary>
    /// Sets the agent's presence to available/active
    /// </summary>
    /// <param name="agent">The agent to set presence for</param>
    /// <param name="cancellationToken">Cancellation token</param>
    private async Task SetAgentPresenceToActiveAsync(AgentMetadata agent, CancellationToken cancellationToken = default)
    {
        try
        {
            await using var scope = serviceProvider.CreateAsyncScope();
            var graphService = scope.ServiceProvider.GetRequiredService<GraphService>();

            logger.LogDebug("Setting presence to Available for agent {AgentId}", agent.AgentId);
            await graphService.SetPresence(agent, PresenceState.Available, cancellationToken: cancellationToken);
            logger.LogInformation("Successfully set presence to Available for agent {AgentId}", agent.AgentId);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Error setting presence to Available for agent {AgentId}. Continuing execution.", agent.AgentId);
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        logger.LogInformation("Agent Background Service is stopping");
        await base.StopAsync(cancellationToken);
    }

    private async Task ProcessAgentApplicationEntitiesAsync(CancellationToken cancellationToken)
    {
        await using var scope = serviceProvider.CreateAsyncScope();
        var storageService = scope.ServiceProvider.GetRequiredService<IAgentBlueprintRepository>();
        var hiringService = scope.ServiceProvider.GetRequiredService<HiringService>();

        try
        {
            logger.LogDebug("Processing agent application entities for service {ServiceName}", ServiceUtilities.GetServiceName());
            var blueprints = await storageService.GetEntitiesByServiceAsync(ServiceUtilities.GetServiceName(), cancellationToken);
            logger.LogDebug("Found {EntityCount} agent application entities to process", blueprints.Count);

            foreach (var blueprint in blueprints.Where(b => b.ProcessLifecycleEvents))
            {
                if (cancellationToken.IsCancellationRequested)
                    break;
                
                await hiringService.ProcessBlueprint(blueprint, cancellationToken);
            }
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error processing agent application entities");
            throw;
        }
    }
}
