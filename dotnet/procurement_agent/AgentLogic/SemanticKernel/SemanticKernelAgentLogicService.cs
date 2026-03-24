namespace ProcurementA365Agent.AgentLogic.SemanticKernel;

using Microsoft.Agents.A365.Notifications.Models;
using Microsoft.Agents.A365.Observability.Extensions.SemanticKernel;
using Microsoft.Agents.A365.Observability.Runtime.Common;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Contracts;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Scopes;
using Microsoft.Agents.A365.Tooling.Extensions.SemanticKernel.Services;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.State;
using Microsoft.Agents.Core.Models;
using Microsoft.Graph.Models;
using Microsoft.SemanticKernel;
using Microsoft.SemanticKernel.Agents;
using Microsoft.SemanticKernel.ChatCompletion;
using Microsoft.SemanticKernel.Memory;
using ProcurementA365Agent.AgentLogic.AuthCache;
using ProcurementA365Agent.Models;
using ProcurementA365Agent.Services;
using System;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using tryAGI.OpenAI;
using AgentMetadata = ProcurementA365Agent.Models.AgentMetadata;

/// <summary>
/// Semantic Kernel-based implementation of AgentLogicService.
/// This contains all core business logic for a agent instance using Semantic Kernel.
/// </summary>
public class SemanticKernelAgentLogicService : IAgentLogicService
{
    private readonly Kernel _kernel;
    private readonly AgentMetadata _agentMetadata;
    private readonly ChatCompletionAgent _chatCompletionAgent;
    private readonly Mem0Provider? _mem0Provider;
    private readonly ILogger _logger;
    private readonly GraphService _graphService;
    private readonly IAgentMetadataRepository _agentRepository;
    private readonly bool _enableGraphStreaming;
    private readonly int _streamingBufferSize;
    private readonly bool _intermittentStream;
    private readonly IConfiguration _config;
    public SemanticKernelAgentLogicService(
        AgentTokenHelper tokenHelper,
        AgentMetadata agent,
        Kernel kernel,
        string certificateData,
        IConfiguration config,
        ILogger logger,
        IMcpToolRegistrationService mcpToolRegistrationService,
        IAgentTokenCache tokenCache,
        GraphService graphService,
        IAgentMetadataRepository agentRepository)
    {
        _agentMetadata = agent ?? throw new ArgumentNullException(nameof(agent));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _graphService = graphService ?? throw new ArgumentNullException(nameof(graphService));
        _agentRepository = agentRepository ?? throw new ArgumentNullException(nameof(agentRepository));
        // Read streaming configuration flags - only Graph streaming is supported
        _enableGraphStreaming = config.GetValue<bool>("AgentConfiguration:EnableGraphStreaming", defaultValue: false);
        _intermittentStream = config.GetValue<bool>("AgentConfiguration:IntermittentStream", defaultValue: false);
        _config = config;
        _streamingBufferSize = config.GetValue<int>("AgentConfiguration:StreamingBufferSize", defaultValue: 20);
        _logger.LogInformation("Graph streaming for Teams: {GraphStreaming}, Buffer size: {BufferSize} chars", 
            _enableGraphStreaming ? "ENABLED" : "DISABLED", _streamingBufferSize);

        // Register observability-only credential (separate instance to isolate caching if needed)
        var observabilityCredential = new AgentTokenCredential(tokenHelper, agent, certificateData);
        var obsScopes = EnvironmentUtils.GetObservabilityAuthenticationScope();
        tokenCache.RegisterObservability(agent.AgentId.ToString(), agent.TenantId.ToString(), observabilityCredential, obsScopes);

        var deployment = config["ModelDeployment"] ?? throw new ArgumentNullException("ModelDeployment");
        var endpoint = config["AzureOpenAIEndpoint"];
        var mem0Token = config["Mem0ApiToken"];
        Console.WriteLine($"SemanticKernelAgentLogicService: ModelDeployment={deployment}, AzureOpenAIEndpoint={endpoint}, Mem0ApiToken={(string.IsNullOrWhiteSpace(mem0Token) ? "not set" : "set")}");
        if (string.IsNullOrWhiteSpace(deployment) || string.IsNullOrWhiteSpace(endpoint))
        {
            throw new InvalidOperationException("ModelDeployment and AzureOpenAIEndpoint must be configured.");
        }

        // Create an HttpClient for the Mem0 service if key is provided
        if (!string.IsNullOrWhiteSpace(mem0Token))
        {
            var httpClient = new HttpClient()
            {
                BaseAddress = new Uri("https://api.mem0.ai")
            };
            httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Token", mem0Token);

            // Create a Mem0 provider for the current user.
            _mem0Provider = new Mem0Provider(httpClient, options: new()
            {
                UserId = "U1"
            });
        }

        var instructions = AgentInstructions.GetInstructions(agent);
        _kernel = kernel;
        _chatCompletionAgent = new ChatCompletionAgent
        {
            // NOTE: This ID should match the agent ID for which the token is registered on L48-51 above
            Id = agent.AgentId.ToString(),
            Name = agent.EmailId,
            Instructions = instructions,
            Kernel = _kernel,
            Arguments = new KernelArguments(new PromptExecutionSettings()
            {
                // Enable automatic function calling with chaining support
                // This allows the agent to call multiple tools in sequence within a single turn
#pragma warning disable SKEXP0001 // Type is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed.
                FunctionChoiceBehavior = FunctionChoiceBehavior.Auto(options: new() 
                { 
                    RetainArgumentTypes = true,
                    // AllowConcurrentInvocation = false, // Set to true to allow parallel tool calls
                    // AllowParallelCalls = false // Alternative property name depending on SK version
                })
#pragma warning restore SKEXP0001 // Type is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed.
            }),
        }.WithTracing();
    }


    public async Task NewAgentCreatedAsync(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity agentNotificationActivity, CancellationToken cancellationToken)
    {
        _logger.LogInformation("Processing new agent creation event");

        try
        {
            var recipient = agentNotificationActivity.Recipient;
            if (recipient == null)
            {
                _logger.LogWarning("Recipient is null in agent notification activity");
                return;
            }

            // Extract IDs from recipient
            if (!Guid.TryParse(recipient.TenantId, out var tenantId))
            {
                _logger.LogError("Invalid tenant ID: {TenantId}", recipient.TenantId);
                return;
            }

            if (!Guid.TryParse(recipient.AgenticUserId, out var agenticUserId))
            {
                _logger.LogError("Invalid agentic user ID: {AgenticUserId}", recipient.AgenticUserId);
                return;
            }

            if (!Guid.TryParse(recipient.AgenticAppId, out var agenticAppId))
            {
                _logger.LogError("Invalid agentic app ID: {AgenticAppId}", recipient.AgenticAppId);
                return;
            }

            // Get AgentApplicationId (ClientId) from configuration
            var clientId = _config.GetValue<string>("Connections:ServiceConnection:Settings:ClientId");
            if (string.IsNullOrEmpty(clientId) || !Guid.TryParse(clientId, out var agentApplicationId))
            {
                _logger.LogError("Invalid or missing ClientId in configuration: {ClientId}", clientId);
                return;
            }

            // Get service name
            var owningServiceName = ServiceUtilities.GetServiceName();

            // Initialize agent metadata with temporary values
            var agentMetadata = new AgentMetadata(
                tenantId: tenantId,
                agentId: agenticAppId,
                userId: agenticUserId,
                agentFriendlyName: $"Agent-{agenticAppId}", // Temporary, will be updated from Graph
                owningServiceName: owningServiceName)
            {
                AgentApplicationId = agentApplicationId,
                WebhookUrl = null,
                McpServerUrl = null,
                IsMessagingEnabled = true,
                SkipAgentIdAuth = false,
                EmailId = string.Empty // Will attempt to get from Graph
                // IsGreetingSent = false // Initialize to false - will be sent by background service
            };

            // Retrieve user information from Graph
            await PopulateUserInformationAsync(agentMetadata, agenticUserId, cancellationToken);

            // Retrieve manager information from Graph
            await PopulateManagerInformationAsync(agentMetadata, cancellationToken);

            // Save agent metadata to database
            try
            {
                await _agentRepository.CreateAsync(agentMetadata, throwErrorOnConflict: false);
                _logger.LogInformation("Successfully created agent metadata in database: AgentId={AgentId}, TenantId={TenantId}, UserId={UserId}, AgentApplicationId={AgentApplicationId}, ServiceName={ServiceName}, Email={Email}, DisplayName={DisplayName}, ManagerId={ManagerId}",
                    agentMetadata.AgentId, agentMetadata.TenantId, agentMetadata.UserId, agentMetadata.AgentApplicationId, 
                    agentMetadata.OwningServiceName, agentMetadata.EmailId, agentMetadata.AgentFriendlyName, agentMetadata.AgentManagerId);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to save agent metadata to database for AgentId={AgentId}", agenticAppId);
                throw;
            }

            // Note: Manager notification will be sent by the background service when IsGreetingSent is false
            _logger.LogInformation("Agent metadata created successfully. Manager notification will be sent by background service.");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing new agent creation event");
        }
    }

    /// <summary>
    /// Populates user information (email and display name) from Graph API
    /// </summary>
    private async Task PopulateUserInformationAsync(AgentMetadata agentMetadata, Guid userId, CancellationToken cancellationToken)
    {
        try
        {
            _logger.LogInformation("Attempting to retrieve user information for user {UserId}", userId);
            var user = await _graphService.FindUserById(_agentMetadata, userId.ToString(), cancellationToken);
            if (user != null)
            {
                agentMetadata.EmailId = user.Mail ?? user.UserPrincipalName ?? string.Empty;
                agentMetadata.AgentFriendlyName = user.DisplayName ?? agentMetadata.AgentFriendlyName;
                _logger.LogInformation("Retrieved user information - Email: {Email}, DisplayName: {DisplayName}", 
                    agentMetadata.EmailId, agentMetadata.AgentFriendlyName);
            }
            else
            {
                _logger.LogWarning("User not found in Graph for user ID {UserId}", userId);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to retrieve user information from Graph for user {UserId}. Continuing with default values.", userId);
        }
    }

    /// <summary>
    /// Populates manager information from Graph API
    /// </summary>
    private async Task PopulateManagerInformationAsync(AgentMetadata agentMetadata, CancellationToken cancellationToken)
    {
        try
        {
            _logger.LogInformation("Attempting to retrieve manager information for user {UserId}", agentMetadata.UserId);
            
            // Use the agent's email to find the manager
            if (string.IsNullOrEmpty(agentMetadata.EmailId))
            {
                _logger.LogWarning("Cannot retrieve manager - agent email is not set");
                return;
            }

            var manager = await _graphService.FindManagerForUser(_agentMetadata, agentMetadata.EmailId, cancellationToken);
            if (manager != null && !string.IsNullOrEmpty(manager.Id))
            {
                agentMetadata.AgentManagerId = Guid.TryParse(manager.Id, out var managerId) ? managerId : null;
                agentMetadata.AgentManagerName = manager.DisplayName;
                agentMetadata.AgentManagerEmail = manager.Mail ?? manager.UserPrincipalName;
                
                _logger.LogInformation("Retrieved manager information - ManagerId: {ManagerId}, ManagerName: {ManagerName}, ManagerEmail: {ManagerEmail}", 
                    agentMetadata.AgentManagerId, agentMetadata.AgentManagerName, agentMetadata.AgentManagerEmail);
            }
            else
            {
                _logger.LogInformation("No manager found for user {UserId}", agentMetadata.UserId);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to retrieve manager information from Graph for user {UserId}. Continuing without manager info.", agentMetadata.UserId);
        }
    }

    /// <summary>
    /// Notifies the manager about the new agent with retry logic.
    /// Retries up to 10 times with delays: first attempt after 45 seconds, subsequent attempts after 30 seconds each.
    /// This should be called from the background service when IsGreetingSent is false.
    /// </summary>
    public async Task NotifyManagerAboutNewAgentAsync(AgentMetadata agentMetadata, CancellationToken cancellationToken)
    {
        const int maxRetries = 10;
        const int firstDelaySeconds = 45;
        const int subsequentDelaySeconds = 30;

        // Get manager information from Graph API
        Microsoft.Graph.Models.User? manager = null;
        try
        {
            _logger.LogInformation("Retrieving manager information from Graph for agent {AgentId}", agentMetadata.AgentId);
            
            if (string.IsNullOrEmpty(agentMetadata.EmailId))
            {
                _logger.LogWarning("Cannot retrieve manager - agent email is not set for agent {AgentId}", agentMetadata.AgentId);
                return;
            }

            manager = await _graphService.FindManagerForUser(_agentMetadata, agentMetadata.EmailId, cancellationToken);
            
            if (manager == null || string.IsNullOrEmpty(manager.Id))
            {
                _logger.LogWarning("No manager found in Graph for agent {AgentId}", agentMetadata.AgentId);
                return;
            }

            _logger.LogInformation("Found manager {ManagerName} ({ManagerId}) for agent {AgentId}", 
                manager.DisplayName, manager.Id, agentMetadata.AgentId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to retrieve manager from Graph for agent {AgentId}", agentMetadata.AgentId);
            return;
        }

        var managerId = manager.Id;
        var managerName = manager.DisplayName ?? "Manager";
        var message = $"<p>Hello <strong>{managerName}</strong>,</p>" +
                     $"<p>I am <strong>{agentMetadata.AgentFriendlyName}</strong>, your new digital procurement agent. " +
                     $"I'm here to help streamline your procurement processes and assist with purchase requests, " +
                     $"vendor management, and procurement-related tasks.</p>" +
                     $"<p><strong>My Details:</strong></p>" +
                     $"<ul>" +
                     $"<li><strong>Name:</strong> {agentMetadata.AgentFriendlyName}</li>" +
                     $"<li><strong>Email:</strong> {agentMetadata.EmailId}</li>" +
                     $"<li><strong>Agent ID:</strong> {agentMetadata.AgentId}</li>" +
                     $"</ul>" +
                     $"<p>I'm now ready to assist you with procurement tasks! " +
                     $"Please note that it may take a few minutes for all licenses and permissions to be fully provisioned.</p>" +
                     $"<p>Feel free to reach out if you have any questions or need assistance with procurement-related matters.</p>" +
                     $"<p>Please let me know if you have any onboarding instructions. For example, you can give me list of actions I cannot do.</p>" +
                     $"<p><em>Best regards,<br/>{agentMetadata.AgentFriendlyName}</em></p>";

        for (int attempt = 1; attempt <= maxRetries; attempt++)
        {
            try
            {
                // Wait before the attempt (45 seconds for first, 30 seconds for subsequent)
                var delaySeconds = attempt == 1 ? firstDelaySeconds : subsequentDelaySeconds;
                _logger.LogInformation("Waiting {DelaySeconds} seconds before attempt {Attempt}/{MaxRetries} to notify manager {ManagerId}",
                    delaySeconds, attempt, maxRetries, managerId);
                await Task.Delay(TimeSpan.FromSeconds(delaySeconds), cancellationToken);

                _logger.LogInformation("Attempt {Attempt}/{MaxRetries}: Creating chat with manager {ManagerId} for agent {AgentId}",
                    attempt, maxRetries, managerId, agentMetadata.AgentId);

                // Create or get existing chat with manager
                var managerChat = await _graphService.CreateChatWithUserAsync(agentMetadata, managerId, cancellationToken);
                
                if (managerChat?.Id == null)
                {
                    _logger.LogWarning("Attempt {Attempt}/{MaxRetries}: Failed to create chat with manager {ManagerId} - chat ID is null",
                        attempt, maxRetries, managerId);
                    continue; // Retry
                }

                _logger.LogInformation("Attempt {Attempt}/{MaxRetries}: Successfully created chat {ChatId} with manager {ManagerId}, sending notification message",
                    attempt, maxRetries, managerChat.Id, managerId);

                // Send message to manager
                var sentMessage = await _graphService.SendChatMessageAsync(agentMetadata, managerChat.Id, message, cancellationToken);
                
                if (sentMessage != null)
                {
                    _logger.LogInformation("Successfully notified manager {ManagerId} about new agent {AgentId} on attempt {Attempt}",
                        managerId, agentMetadata.AgentId, attempt);
                    return; // Success - exit
                }
                else
                {
                    _logger.LogWarning("Attempt {Attempt}/{MaxRetries}: Failed to send message to manager {ManagerId} - message is null",
                        attempt, maxRetries, managerId);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Attempt {Attempt}/{MaxRetries}: Error notifying manager {ManagerId} about new agent {AgentId}",
                    attempt, maxRetries, managerId, agentMetadata.AgentId);
                
                // If this was the last attempt, log an error
                if (attempt == maxRetries)
                {
                    _logger.LogError(ex, "Failed to notify manager {ManagerId} about new agent {AgentId} after {MaxRetries} attempts",
                        managerId, agentMetadata.AgentId, maxRetries);
                }
            }
        }

        _logger.LogError("Exhausted all {MaxRetries} attempts to notify manager {ManagerId} about new agent {AgentId}",
            maxRetries, managerId, agentMetadata.AgentId);
    }

    private static bool LooksLikeRosterXml(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return false;
        // Fast path: starts with a known roster verb
        var t = text.TrimStart();
        return t.StartsWith("<addmember>", StringComparison.OrdinalIgnoreCase)
            || t.StartsWith("<deletemember>", StringComparison.OrdinalIgnoreCase)
            || t.StartsWith("<updatemember>", StringComparison.OrdinalIgnoreCase)
            || t.StartsWith("<membersadded>", StringComparison.OrdinalIgnoreCase);
    }

    public async Task NewActivityReceived(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {
        if (turnContext.Activity.ChannelId == "msteams" && LooksLikeRosterXml(turnContext.Activity.Text))
            return;

        // Send typing indicator immediately
        await turnContext.SendActivityAsync(new Microsoft.Agents.Core.Models.Activity { Type = ActivityTypes.Typing }, cancellationToken);
        // await turnContext.SendActivityAsync(MessageFactory.Text("hey there"), cancellationToken);
        using var baggageScope = new BaggageBuilder()
            .FromTurnContext(turnContext)
            .CorrelationId(turnContext.Activity.RequestId)
            .Build();

        var incomingText = turnContext.Activity.Text;
        _logger.LogInformation("New activity received (Semantic Kernel): {IncomingText}", incomingText);

        // Log target recipient
        var recipient = turnContext.Activity.Recipient;
        var json = recipient != null ? JsonSerializer.Serialize(recipient) : "null";
        _logger.LogInformation("Target Recipient: {Recipient}", json);

        // Log sender information
        var sender = turnContext.Activity.From;
        var jsonSender = sender != null ? JsonSerializer.Serialize(sender) : "null";
        _logger.LogInformation("Sender: {Sender}", jsonSender);

        // Create agent details from metadata
        var agentDetails = new AgentDetails(
            agentId: _agentMetadata.AgentId.ToString(),
            agentName: _agentMetadata.AgentFriendlyName,
            agentDescription: null,
            iconUri: null,
            agentAUID: _agentMetadata.UserId.ToString(),
            agentUPN: _agentMetadata.EmailId,
            agentBlueprintId: _agentMetadata.AgentApplicationId.ToString(),
            tenantId: _agentMetadata.TenantId.ToString());

        // Create tenant details from metadata
        var tenantDetails = new TenantDetails(_agentMetadata.TenantId);

        // Get the endpoint from configuration or construct from service URL
        var serviceEndpoint = turnContext.Activity.ServiceUrl;
        var endpoint = new Uri("https://zava-procurement-webapp.azurewebsites.net/api/messages"); // replace with generic webhook

        // Create invoke agent details
        var invokeAgentDetails = new InvokeAgentDetails(
            endpoint: endpoint,
            details: agentDetails);

        // Start agent invocation scope for tracing
        using var invokeScope = InvokeAgentScope.Start(invokeAgentDetails, tenantDetails);

        if (turnContext.Activity.ChannelId == "email")
        {
            var subject = string.Empty;
            if (turnContext.Activity.ChannelData is JsonElement jsonElement && jsonElement.TryGetProperty("subject", out var subjectProperty))
            {
                subject = subjectProperty.GetString() ?? string.Empty;
            }

            _logger.LogInformation("Extracted subject: {Subject}", subject);
            incomingText = $"Please respond to this email From: {sender!.Id}\nSubject: {subject}\nMessage: {incomingText}";
        }
        else if (turnContext.Activity.ChannelId == "msteams")
        {
            // name and email missing in teams channel data
            incomingText = $"Respond to this chat message with chat id {turnContext.Activity.Conversation.Id} " +
                            $"From: {sender?.Name} ({sender?.Id})\n" +
                            $"Message: {incomingText}";
        }

        if (turnContext.Activity.ChannelId == "msteams" && !this._agentMetadata.CanAgentInitiateEmails)
        {
            var chatId = turnContext.Activity.Conversation?.Id;
            await _graphService.ReplyChatMessageAsync(_agentMetadata, chatId, "Sorry, your company policy does not let me send email messages.");
            _logger.LogWarning("Agent is not allowed to initiate emails. Aborting Graph streaming.");
            return;
        }

        // If this is a Teams message, run the procurement multi-stage processing instead of standard streaming logic
        if (turnContext.Activity.ChannelId == "msteams" && _intermittentStream)
        {
            await ProcessProcurement(turnContext, incomingText, cancellationToken, _enableGraphStreaming);
        }
        else
        {
            // Choose streaming mode: Graph streaming for other channels (should not normally happen) otherwise collect and send
            if (_enableGraphStreaming && turnContext.Activity.ChannelId == "msteams")
            {
                await ProcessWithGraphStreamingAsync(turnContext, incomingText, cancellationToken);
            }
            else
            {
                await ProcessWithoutStreamingAsync(turnContext, incomingText, cancellationToken);
            }
        }

        // Reset status message and set presence to Available before returning
        await _graphService.SetStatusMessage(_agentMetadata, "");
        await _graphService.SetPresence(_agentMetadata, PresenceState.Available);
    }

    public async Task<string> NewEmailReceived(string fromEmail, string subject, string messageBody)
    {
        using var baggageScope = new BaggageBuilder()
            .TenantId(_agentMetadata.TenantId.ToString())
            .AgentId(_agentMetadata.AgentId.ToString())
            .Build();

        try
        {
            ChatHistoryAgentThread agentThread = new();
            if (_mem0Provider != null)
            {
                agentThread.AIContextProviders.Add(_mem0Provider);
            }

            var formattedMessage = $"Please respond to this email From: {fromEmail}\nSubject: {subject}\nMessage: {messageBody}";

            var responseText = new StringBuilder();
            await foreach (var responseItem in InvokeAgentAsync(formattedMessage, agentThread))
            {
                responseText.Append(responseItem.Message.Content ?? string.Empty);
            }

            return responseText.ToString();
        }
        catch (Exception ex)
        {
            throw new Exception($"Error processing message: {ex.Message}", ex);
        }
    }

    public async Task<string> NewChatReceived(string chatId, string fromUser, string messageBody)
    {
        using var baggageScope = new BaggageBuilder()
            .TenantId(_agentMetadata.TenantId.ToString())
            .AgentId(_agentMetadata.AgentId.ToString())
            .Build();

        try
        {
            ChatHistoryAgentThread agentThread = new();
            if (_mem0Provider != null)
            {
                agentThread.AIContextProviders.Add(_mem0Provider);
            }

            // Create context and user messages
            var contextMessage = new ChatMessageContent(AuthorRole.System, $"You are chatting with {fromUser} via Teams - ChatId {chatId}");
            var userMessage = new ChatMessageContent(AuthorRole.User, messageBody);
            var messages = new List<ChatMessageContent> { contextMessage, userMessage };

            await _graphService.MarkChatAsRead(_agentMetadata, chatId);
            var responseText = new StringBuilder();
            await foreach (var responseItem in _chatCompletionAgent.InvokeAsync(messages, agentThread))
            {
                responseText.Append(responseItem.Message.Content ?? string.Empty);
            }

            // Reset status message and set presence to Available before returning
            await _graphService.SetStatusMessage(_agentMetadata, "");
            await _graphService.SetPresence(_agentMetadata, PresenceState.Available);

            return responseText.ToString();
        }
        catch (Exception ex)
        {
            throw new Exception($"Error processing chat message: {ex.Message}", ex);
        }
    }


    #region IAgentLogicService Event Handler Methods

    /// <summary>
    /// Handles email notification events from Messaging.
    /// Processes the email by:
    /// 1. Extracting email details
    /// 2. Creating a chat with the manager
    /// 3. Using streaming to communicate with the manager
    /// 4. Responding to the email confirming order is processed
    /// </summary>
    public async Task HandleEmailNotificationAsync(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity emailEvent)
    {
        _logger.LogInformation("Processing email notification - NotificationType: {NotificationType}",
            emailEvent.NotificationType);

        try
        {
            // Extract email details
            var emailContent = emailEvent.Text ?? string.Empty;
            var fromEmail = emailEvent.From?.Id ?? "unknown sender";
           
            
            _logger.LogInformation("Email from {FromEmail}, Content: {Content}", 
                fromEmail, emailContent);

            // Check if this is an Office comment notification email and ignore it
            var htmlBody = emailEvent.EmailNotification?.HtmlBody ?? string.Empty;
            if (IsOfficeCommentNotification(htmlBody))
            {
                _logger.LogInformation("Ignoring Office comment notification email from {FromEmail}", fromEmail);
                return;
            }

            // Hardcoded manager email for now
            //const string managerEmail = "rezash@a365preview001.onmicrosoft.com";
            //const string managerId = "0b0c3220-a4a4-4a74-9219-1e9294431de1";
            // 19:0b0c3220-a4a4-4a74-9219-1e9294431de1_20816c1e-be89-4a54-a9f9-992d3b7d125d@unq.gbl.spaces
            // Find manager user
            var manager = await _graphService.FindManagerForUser(_agentMetadata, _agentMetadata.UserId.ToString(), CancellationToken.None);
            if (manager?.Id == null)
            {
                _logger.LogWarning("Could not find manager with email for agent: {agentName}", _agentMetadata.AgentFriendlyName);

                // Send error response to email
                var errorResponse = MessageFactory.Text("");
                errorResponse.Entities.Add(new Microsoft.Agents.A365.Notifications.Models.EmailResponse(
                    "I couldn't find my manager to approve this request. Please contact support."));
                await turnContext.SendActivityAsync(errorResponse);
                return;
            }

            //_logger.LogInformation("Found manager {ManagerName} ({ManagerId})", "Reza Shojaei", "19:0b0c3220-a4a4-4a74-9219-1e9294431de1_603fb04d-a5af-4dbf-a3e1-1acbcd2ec798@unq.gbl.spaces");

            // Create or get existing chat with manager
            Chat? managerChat;
            try
            {
                managerChat = await _graphService.CreateChatWithUserAsync(_agentMetadata, manager.Id, CancellationToken.None);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error creating chat with manager {ManagerId}", manager.Id);

                // Send error response to email
                var errorResponse = MessageFactory.Text("");
                errorResponse.Entities.Add(new Microsoft.Agents.A365.Notifications.Models.EmailResponse(
                    "I encountered an error contacting my manager. Please try again later."));
                await turnContext.SendActivityAsync(errorResponse);
                return;
            }

            if (managerChat?.Id == null)
            {
                _logger.LogError("Failed to create or retrieve chat with manager {ManagerId}", manager.Id);
                
                // Send error response to email
                var errorResponse = MessageFactory.Text("");
                errorResponse.Entities.Add(new Microsoft.Agents.A365.Notifications.Models.EmailResponse(
                    "I couldn't create a chat with my manager. Please contact support."));
                await turnContext.SendActivityAsync(errorResponse);
                return;
            }

            _logger.LogInformation("Created/retrieved chat {ChatId} with manager", managerChat.Id);

            // Format the message for the agent to analyze the email
            var formattedMessage = $"I received an email requesting procurement approval.\n" +
                                  $"From: {fromEmail}\n" +
                                  $"Message: {emailContent}\n\n" +
                                  $"We recieved this email for purchase. Process the purchased, and inform the manager. Your response is to your manager. You nee to describe the work that you did.";

            // Use streaming to communicate with the manager via Teams chat
            var agentResponse = await ProcessEmailWithManagerChatAsync(managerChat.Id, formattedMessage, CancellationToken.None);

            if (string.IsNullOrWhiteSpace(agentResponse))
            {
                _logger.LogWarning("Agent produced no response for email notification");
                agentResponse = "I analyzed the email but couldn't generate a response.";
            }

            _logger.LogInformation("Successfully processed email and chatted with manager. Agent response: {Response}", agentResponse);

            // Send email response confirming the order is processed and approved
            var emailResponseText = $"Thank you for your email regarding the procurement request.\n\n" +
                                   $"I have analyzed your request and discussed it with my manager. " +
                                   $"Your order has been processed and approved.\n\n" +
                                 //  $"Analysis:\n{agentResponse}\n\n" +
                                   $"If you have any questions, please don't hesitate to reach out.\n\n" +
                                   $"Best regards,\n{_agentMetadata.AgentFriendlyName}";

            var responseActivity = MessageFactory.Text("");
            responseActivity.Entities.Add(new Microsoft.Agents.A365.Notifications.Models.EmailResponse(emailResponseText));
            await turnContext.SendActivityAsync(responseActivity);

            _logger.LogInformation("Email response sent successfully");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing email notification");
            
            // Send error response to email
            var errorResponse = MessageFactory.Text("");
            errorResponse.Entities.Add(new Microsoft.Agents.A365.Notifications.Models.EmailResponse(
                "I encountered an error processing your email. Please try again later or contact support."));
            await turnContext.SendActivityAsync(errorResponse);
        }
    }

    /// <summary>
    /// Handles document comment notification events (Word, Excel, PowerPoint) from Messaging
    /// </summary>
    public async Task HandleCommentNotificationAsync(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity commentEvent)
    {
        _logger.LogInformation("Processing comment notification - NotificationType: {NotificationType}",
            commentEvent.NotificationType);

        // For now returning a static response - can be enhanced with actual AI processing
        var str = new StringBuilder();
        str.Append("You are helpfull agent that response to comments in the documents. Your job is to try to answer user questions based on your knowledge.");
        str.Append("If it needs access to document, just say you will work on it and will get back to user.");
        str.Append("keep your responses short. Here is the user input:");
        str.Append(turnContext.Activity.Text);

        var response = new StringBuilder();

        await foreach (var r in  InvokeAgentAsync(str.ToString())) {
            response.Append(r.Message?.Content ?? String.Empty);
        }
        var commentActivity = MessageFactory.Text(response.ToString());
        turnContext.SendActivityAsync(commentActivity);
    }

    /// <summary>
    /// Handles Teams message events from Messaging
    /// </summary>
    public async Task HandleTeamsMessageAsync(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity teamsEvent)
    {
        _logger.LogInformation("Processing Teams message event - From: {FromUser}",
            teamsEvent.From?.Name);

        var formattedMessage = $"Respond to this chat message with chat id {teamsEvent.Conversation?.Id} " +
                              $"From: {teamsEvent.From?.Name} ({teamsEvent.From?.Id})\n" +
                              $"Message: {teamsEvent.Text}";

        // For now returning a static response - can be enhanced with actual AI processing
        var responseText = "Hello this is a response to a Teams message received through Messaging.";

        _logger.LogInformation("Teams message response prepared: {ResponseText}", responseText);
    }

    /// <summary>
    /// Handles installation update events from Messaging
    /// </summary>
    public async Task HandleInstallationUpdateAsync(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity installationEvent)
    {
        _logger.LogInformation("Processing installation update event for {SenderId}", installationEvent.From?.Id);

        var formattedMessage = $"You were just added as a digital worker. Please send an email to {installationEvent.From?.Id} with information on what you can do.";

        // For now returning a static response - can be enhanced with actual AI processing
        var responseText = "Hello this is a response to an installation update received through Messaging.";

        //_logger.LogInformation("Installation update response prepared: {ResponseText}", responseText);
    }

    /// <summary>
    /// Handles generic activity events that don't fit other categories
    /// </summary>
    public async Task NewActivityReceived(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity genericEvent)
    {
        _logger.LogInformation("Processing generic activity event - NotificationType: {NotificationType}",
            genericEvent.NotificationType);

        // For generic events, provide basic processing
        // For now, just echo the received text back as response
        var responseText = $"Echo: {genericEvent.Text}";

        _logger.LogInformation("Generic activity response prepared: {ResponseText}", responseText);
    }

    #endregion

    #region Helper Methods

    /// <summary>
    /// Determines if an email is an Office comment notification that should be ignored.
    /// Office comment notifications contain specific patterns like the "Why am I receiving this notification from Office?" link.
    /// </summary>
    /// <param name="htmlBody">The HTML body of the email</param>
    /// <returns>True if this is an Office comment notification, false otherwise</returns>
    private bool IsOfficeCommentNotification(string htmlBody)
    {
        if (string.IsNullOrWhiteSpace(htmlBody))
        {
            return false;
        }

        // Check for the distinctive "Why am I receiving this notification from Office?" link
        // This appears to be a standard footer in all Office comment notification emails
        var hasOfficeNotificationLink = htmlBody.Contains("Why am I receiving this notification from Office?", StringComparison.OrdinalIgnoreCase) &&
                                       htmlBody.Contains("go.microsoft.com/fwlink/?linkid=2113319", StringComparison.OrdinalIgnoreCase);

        // Additional check: Look for "Go to comment" button which is typical of Office comment emails
        var hasGoToCommentButton = htmlBody.Contains("Go to comment", StringComparison.OrdinalIgnoreCase);

        // Additional check: Look for comment-related image alt text
        var hasCommentIcon = htmlBody.Contains("Comment Icon", StringComparison.OrdinalIgnoreCase) ||
                            htmlBody.Contains("alt=\"Comment Icon\"", StringComparison.OrdinalIgnoreCase);

        // Return true if we find the office notification link (primary indicator)
        // The other checks provide additional confidence
        return hasOfficeNotificationLink || (hasGoToCommentButton && hasCommentIcon);
    }

    private async Task ProcessProcurement(ITurnContext turnContext, string incomingText, CancellationToken cancellationToken, bool graphStreaming)
    {
        // This function should be invoked for incoming Teams messages. It should do the following:
        // 1. Immediately respond with a placeholder ("Working on your request...")
        // 2. Invoke the agent (1st pass) with the original context and update the same message
        // 3. Invoke the agent (2nd pass) with additional procurement summary context and update
        // 4. Invoke the agent (3rd pass) with risk / action context and update
        // All updates happen on the same Teams chat message.
        try
        {
            var conversation = turnContext.Activity.Conversation;
            if (conversation?.Id == null)
            {
                _logger.LogWarning("ProcessProcurement called with an empty conversation id");
                return;
            }

            // If channel message, reuse existing channel processing to move to 1:1 chat.
            if (conversation.ConversationType == "channel")
            {
                await ProcessTeamsChannelMessageAsync(turnContext, incomingText, cancellationToken);
                return;
            }

            var chatId = conversation.Id;

            // 1. Initial placeholder message
            var placeholderText = "Working on your request...";
            var initialMessage = await _graphService.ReplyChatMessageAsync(_agentMetadata, chatId, placeholderText);
            if (initialMessage == null || string.IsNullOrEmpty(initialMessage.Id))
            {
                _logger.LogError("Failed to send placeholder procurement response to chat {ChatId}", chatId);
                return;
            }
            var messageId = initialMessage.Id;

            // Aggregated content across invocations (declare BEFORE helpers so they can reference it)
            var aggregated = new StringBuilder();

            // Non-streaming helper local function
            async Task<string> InvokeAndCollectAsync(string prompt)
            {
                var sb = new StringBuilder();
                await foreach (var responseItem in InvokeAgentAsync(prompt, chatId: chatId, cancellationToken: cancellationToken))
                {
                    sb.Append(responseItem.Message.Content ?? string.Empty);
                }
                return sb.ToString();
            }

            // Streaming helper local function - updates message incrementally
            async Task<string> InvokeStreamingAndCollectAsync(string prompt)
            {
                var sectionBuilder = new StringBuilder();
                var aggregatedSnapshotBase = aggregated.ToString(); // previous completed sections
                var tokenBuffer = new StringBuilder();
                var bufferSize = _streamingBufferSize > 0 ? _streamingBufferSize : 20;

                await foreach (var token in InvokeAgentStreamingAsync(prompt, chatId: chatId, cancellationToken: cancellationToken))
                {
                    if (string.IsNullOrEmpty(token)) continue;
                    tokenBuffer.Append(token);
                    // Flush buffer when size threshold reached
                    if (tokenBuffer.Length >= bufferSize)
                    {
                        sectionBuilder.Append(tokenBuffer);
                        tokenBuffer.Clear();
                        // Combine previous sections + current in-progress section
                        var combined = new StringBuilder();
                        combined.Append(aggregatedSnapshotBase);
                        if (combined.Length > 0 && !combined.ToString().EndsWith("\n")) combined.AppendLine();
                        combined.Append(sectionBuilder.ToString());
                        await _graphService.UpdateChatMessageAsync(_agentMetadata, chatId, messageId, combined.ToString());
                    }
                }
                // Flush remaining tokens
                if (tokenBuffer.Length > 0)
                {
                    sectionBuilder.Append(tokenBuffer);
                    tokenBuffer.Clear();
                }
                // Final update for this section
                var finalCombined = new StringBuilder();
                finalCombined.Append(aggregatedSnapshotBase);
                if (finalCombined.Length > 0 && !finalCombined.ToString().EndsWith("\n")) finalCombined.AppendLine();
                finalCombined.Append(sectionBuilder.ToString());
                await _graphService.UpdateChatMessageAsync(_agentMetadata, chatId, messageId, finalCombined.ToString());
                return sectionBuilder.ToString();
            }

            // 2. First invocation: original incoming text
            var section1Prompt = incomingText;
            string section1Result = graphStreaming
                ? await InvokeStreamingAndCollectAsync(section1Prompt)
                : await InvokeAndCollectAsync(section1Prompt);
            if (!graphStreaming)
            {
                aggregated.AppendLine(string.IsNullOrWhiteSpace(section1Result) ? "(no response)" : section1Result.Trim());
                await _graphService.UpdateChatMessageAsync(_agentMetadata, chatId, messageId, aggregated.ToString());
            }
            else
            {
                aggregated.AppendLine(string.IsNullOrWhiteSpace(section1Result) ? "(no response)" : section1Result.Trim());
            }

            // 3. Second invocation: procurement summary context
            var section2Prompt = $"{incomingText}\n\nProvide a concise procurement-focused summary highlighting key items, suppliers, pricing, and any notable variances.";
            string section2Result = graphStreaming
                ? await InvokeStreamingAndCollectAsync(section2Prompt)
                : await InvokeAndCollectAsync(section2Prompt);
            if (!graphStreaming)
            {
                aggregated.AppendLine();
                aggregated.AppendLine(string.IsNullOrWhiteSpace(section2Result) ? "(no response)" : section2Result.Trim());
                await _graphService.UpdateChatMessageAsync(_agentMetadata, chatId, messageId, aggregated.ToString());
            }
            else
            {
                aggregated.AppendLine();
                aggregated.AppendLine(string.IsNullOrWhiteSpace(section2Result) ? "(no response)" : section2Result.Trim());
            }

            // 4. Third invocation: risk / action assessment context
            var section3Prompt = $"{incomingText}\n\nAnalyze procurement risks, potential cost savings opportunities, and propose next actions. Return actionable bullet points.";
            string section3Result = graphStreaming
                ? await InvokeStreamingAndCollectAsync(section3Prompt)
                : await InvokeAndCollectAsync(section3Prompt);
            aggregated.AppendLine();
            aggregated.AppendLine(string.IsNullOrWhiteSpace(section3Result) ? "(no response)" : section3Result.Trim());

            // Final update after third invocation (for streaming we may have been incrementally updating per section already)
            await _graphService.UpdateChatMessageAsync(_agentMetadata, chatId, messageId, aggregated.ToString());

            _logger.LogInformation("ProcessProcurement completed for chat {ChatId} with 3 agent invocations (Streaming={Streaming})", chatId, graphStreaming);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error executing ProcessProcurement workflow");
            try
            {
                if (turnContext.Activity.Conversation?.Id is string chatId && !string.IsNullOrEmpty(chatId))
                {
                    await _graphService.ReplyChatMessageAsync(_agentMetadata, chatId, "Sorry, an error occurred while processing your procurement request.");
                }
            }
            catch { /* ignore secondary errors */ }
        }
    }

    /// <summary>
    /// Process the message using Graph API to update Teams messages in place (simulated streaming)
    /// Uses token-level streaming from Semantic Kernel for better real-time experience.
    /// Implements buffering to reduce Graph API calls and provide smoother updates.
    /// </summary>
    private async Task ProcessWithGraphStreamingAsync(ITurnContext turnContext, string incomingText, CancellationToken cancellationToken)
    {
        _logger.LogInformation("Processing with GRAPH STREAMING mode for Teams");
        var chatId = turnContext.Activity.Conversation.Id;

        if (turnContext.Activity.Conversation.ConversationType == "channel")
        {
            // Channel message processing: if in a channel, create 1:1 chat and process there
            await ProcessTeamsChannelMessageAsync(turnContext, incomingText, cancellationToken);
            return; // Exit early - response already sent to 1:1 chat, don't send to channel
        }

        try
        {
            // Send initial "thinking" message to Teams using Graph
            var initialMessage = await _graphService.ReplyChatMessageAsync(_agentMetadata, chatId, "...");

            if (initialMessage == null || string.IsNullOrEmpty(initialMessage.Id))
            {
                _logger.LogError("Failed to send initial message to Teams chat {ChatId}", chatId);
                return;
            }

            var messageId = initialMessage.Id;
            var responseBuilder = new StringBuilder();
            var tokenBuffer = new StringBuilder();
            var chunkCount = 0;
            var updateCount = 0;
            var tokenBufferSize = _streamingBufferSize; // Use configured buffer size

            // Use token-level streaming for finer-grained updates - pass chatId so plugins can send updates
            await foreach (var streamingContent in InvokeAgentStreamingAsync(incomingText, chatId: chatId, cancellationToken: cancellationToken))
            {
                try
                {
                    var responseText = streamingContent;

                    if (string.IsNullOrEmpty(responseText))
                    {
                        _logger.LogDebug("Received empty streaming chunk");
                        continue;
                    }

                    chunkCount++;

                    // Add to token buffer
                    tokenBuffer.Append(responseText);

                    // Only update when buffer reaches threshold OR if we have accumulated significant content
                    if (tokenBuffer.Length >= tokenBufferSize)
                    {
                        // Append buffered tokens to full response
                        responseBuilder.Append(tokenBuffer);

                        updateCount++;
                        _logger.LogDebug("Update #{UpdateNumber}: Buffered {BufferLength} chars from {ChunkCount} chunks, total {TotalLength} chars",
                            updateCount, tokenBuffer.Length, chunkCount, responseBuilder.Length);

                        // Update the Teams message with accumulated response using Graph API
                        await _graphService.UpdateChatMessageAsync(_agentMetadata, chatId, messageId, responseBuilder.ToString());

                        // Clear the buffer after successful update
                        tokenBuffer.Clear();
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error updating Teams message with streaming chunk");
                }
            }

            // Send any remaining buffered content
            if (tokenBuffer.Length > 0)
            {
                responseBuilder.Append(tokenBuffer);
                updateCount++;
                _logger.LogDebug("Final update: Flushing {BufferLength} remaining chars", tokenBuffer.Length);

                await _graphService.UpdateChatMessageAsync(_agentMetadata, chatId, messageId, responseBuilder.ToString());
            }

            // If we didn't get any response, update with an error message
            if (responseBuilder.Length == 0)
            {
                _logger.LogWarning("No streaming chunks received from agent");
                await _graphService.UpdateChatMessageAsync(_agentMetadata, chatId, messageId,
                    "Sorry, I couldn't generate a response at this time.");
            }
            else
            {
                _logger.LogInformation("Graph streaming completed: {ChunkCount} chunks received, {UpdateCount} updates sent, {TotalLength} total chars",
                    chunkCount, updateCount, responseBuilder.Length);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in Graph streaming mode for Teams");
            // Try to send an error message
            try
            {
                await _graphService.ReplyChatMessageAsync(_agentMetadata, chatId,
                    "Sorry, I encountered an error processing your request.");
            }
            catch
            {
                // Ignore errors when sending error message
            }
        }
    }

    /// <summary>
    /// Process the message by collecting all chunks first, then sending as a single message
    /// </summary>
    private async Task ProcessWithoutStreamingAsync(ITurnContext turnContext, string incomingText, CancellationToken cancellationToken)
    {
        _logger.LogInformation("Processing with NON-STREAMING mode (collect and send)");
        var chatId = turnContext.Activity.Conversation?.Id;

        if (turnContext.Activity.Conversation?.ConversationType == "channel")
        {
            // Channel message processing: if in a channel, create 1:1 chat and process there
            await ProcessTeamsChannelMessageAsync(turnContext, incomingText, cancellationToken);
            return; // Exit early - response already sent to 1:1 chat, don't send to channel
        }

        // Collect all response chunks first, then send as a single message
        var responseBuilder = new StringBuilder();
        var hasResponse = false;

        // Stream the agent's response chunks - pass chatId so plugins can send updates
        await foreach (var responseItem in InvokeAgentAsync(incomingText, chatId: chatId, cancellationToken: cancellationToken))
        {
            try
            {
                var responseText = responseItem.Message.Content ?? string.Empty;
                _logger.LogInformation("Received response chunk: {ResponseText}", responseText);

                // Append to response builder
                responseBuilder.Append(responseText);
                hasResponse = true;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error processing response chunk: {ResponseText}", responseItem.Message.Content);
            }
        }

        // Send the complete response as a single message
        if (hasResponse && responseBuilder.Length > 0)
        {
            await turnContext.SendActivityAsync(MessageFactory.Text(responseBuilder.ToString()), cancellationToken);
        }
        else
        {
            await turnContext.SendActivityAsync(MessageFactory.Text("Sorry, I couldn't generate a response at this time."), cancellationToken);
        }
    }

    /// <summary>
    /// Invokes the agent with token-level streaming using Semantic Kernel's streaming capabilities.
    /// Returns individual text chunks/tokens as they're generated, which we concatenate ourselves.
    /// This provides finer-grained streaming than InvokeAsync.
    /// </summary>
    /// <param name="incomingText">The input text to send to the agent</param>
    /// <param name="agentThread">Optional agent thread to use. If null, creates a new empty thread.</param>
    /// <param name="chatId">Optional chat ID for sending progress updates to Teams</param>
    /// <param name="cancellationToken">Cancellation token</param>
    /// <returns>An async enumerable of text chunks/tokens</returns>
    private async IAsyncEnumerable<string> InvokeAgentStreamingAsync(
        string incomingText, 
        ChatHistoryAgentThread? agentThread = null,
        string? chatId = null,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        agentThread ??= new ChatHistoryAgentThread();

        var content = new ChatMessageContent
        {
            Role = AuthorRole.User,
            Content = incomingText,
        };

        // Add chatId to kernel arguments if provided so plugins can access it
        if (!string.IsNullOrEmpty(chatId) && _chatCompletionAgent.Arguments != null)
        {
            _chatCompletionAgent.Arguments["_chatId"] = chatId;
            _logger.LogDebug("Added chatId {ChatId} to kernel arguments for plugins", chatId);
        }

        // Use InvokeStreamingAsync for token-level streaming
        // This yields individual text chunks/tokens as they arrive from the LLM
        await foreach (var streamingResponse in _chatCompletionAgent.InvokeStreamingAsync(content, agentThread, cancellationToken: cancellationToken))
        {
            // Extract text content from the streaming response
            var textContent = streamingResponse.Message.Content;
            
            if (!string.IsNullOrEmpty(textContent))
            {
                yield return textContent;
            }
        }
    }

    /// <summary>
    /// Process a Teams channel message by retrieving the full conversation thread,
    /// creating a 1:1 chat with the sender, and invoking the agent to process the thread in that chat.
    /// </summary>
    /// <param name="turnContext">The turn context containing the channel message details</param>
    /// <param name="incomingText">The formatted incoming message text</param>
    /// <param name="cancellationToken">Cancellation token</param>
    private async Task ProcessTeamsChannelMessageAsync(
        ITurnContext turnContext,
        string incomingText,
        CancellationToken cancellationToken)
    {
        try
        {
            _logger.LogInformation("Processing Teams channel message for agent {AgentId}", _agentMetadata.AgentId);

            // Get the sender's user ID from the activity
            // Extract the sender's user ID and strip any prefix (e.g., "8:orgid:")
            var senderIdRaw = turnContext.Activity.From?.Id;
            string? senderId = null;

            if (!string.IsNullOrWhiteSpace(senderIdRaw))
            {
                // Check if the ID contains a prefix pattern (e.g., "8:orgid:guid")
                var parts = senderIdRaw.Split(':');
                if (parts.Length >= 3)
                {
                    // Take the last part which should be the GUID
                    senderId = parts[^1];
                }
                else
                {
                    // No prefix found, use the raw ID as-is
                    senderId = senderIdRaw;
                }
            }
            _logger.LogInformation("Channel message sender ID: {SenderId}", senderId ?? "null");
            var senderName = turnContext.Activity.From?.Name ?? "Unknown";

            if (string.IsNullOrWhiteSpace(senderId))
            {
                _logger.LogWarning("Could not retrieve sender ID for channel message");
                return;
            }

            _logger.LogInformation("Channel message from {SenderName} ({SenderId})", senderName, senderId);

            // Create or get existing 1:1 chat with the sender
            Chat? senderChat;
            try
            {
                senderChat = await _graphService.CreateChatWithUserAsync(_agentMetadata, senderId, cancellationToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error creating 1:1 chat with sender {SenderId}", senderId);
                return;
            }

            if (senderChat?.Id == null)
            {
                _logger.LogError("Failed to create or retrieve 1:1 chat with sender {SenderId}", senderId);
                return;
            }

            _logger.LogInformation("Successfully created/retrieved 1:1 chat {ChatId} with sender {SenderId}", 
                senderChat.Id, senderId);

            // Immediately send a typing indicator style placeholder in the 1:1 chat
            try
            {
                await _graphService.SendChatMessageAsync(_agentMetadata, senderChat.Id, "...");
                _logger.LogDebug("Sent typing indicator placeholder to 1:1 chat {ChatId}", senderChat.Id);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to send typing indicator placeholder to 1:1 chat {ChatId}", senderChat.Id);
            }

            // Extract channel information from activity
            var channelData = turnContext.Activity.GetChannelData<dynamic>();
            string? teamId = channelData?.team?.id;
            string? channelId = channelData?.channel?.id;
            string? messageId = null;
            string? replyToId = null;

            // Get the message ID (could be a reply or a new message)
            messageId = turnContext.Activity.Id;

            replyToId = turnContext.Activity.ReplyToId;

            // Build thread context
            var threadContext = new StringBuilder();
            threadContext.AppendLine("--- Channel Thread ---");

            // If this is a reply or we have channel context, try to get the full thread using Graph API
            if (!string.IsNullOrEmpty(teamId) && !string.IsNullOrEmpty(channelId))
            {
                _logger.LogInformation("Attempting to retrieve channel thread - Team: {TeamId}, Channel: {ChannelId}, MessageId: {MessageId}, ReplyToId: {ReplyToId}",
                    teamId, channelId, messageId, replyToId);

                try
                {
                    // If this is a reply, get all messages in the thread from the parent
                    var threadMessageId = !string.IsNullOrEmpty(replyToId) ? replyToId : messageId;

                    if (!string.IsNullOrEmpty(threadMessageId))
                    {
                        var threadMessages = await _graphService.GetChannelMessageThreadAsync(
                            _agentMetadata, teamId, channelId, threadMessageId, cancellationToken);

                        if (threadMessages != null && threadMessages.Any())
                        {
                            foreach (var msg in threadMessages.OrderBy(m => m.CreatedDateTime))
                            {
                                var msgSender = msg.From?.User?.DisplayName ?? "Unknown";
                                var timestamp = msg.CreatedDateTime?.ToString("g") ?? "Unknown time";
                                var content = msg.Body?.Content ?? "";

                                // Strip HTML tags for cleaner text
                                content = System.Text.RegularExpressions.Regex.Replace(content, "<.*?>", string.Empty);

                                threadContext.AppendLine($"[{timestamp}] {msgSender}: {content}");
                            }
                            threadContext.AppendLine("--- End of Thread ---");
                            threadContext.AppendLine();
                        }
                        else
                        {
                            _logger.LogWarning("No messages found in the thread");
                        }
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Could not retrieve channel thread, will use single message context");
                }
            }

            // If no thread context was established, fall back to single message context
            if (threadContext.Length == 0)
            {
                threadContext.AppendLine("--- Single Message Context ---");
                threadContext.AppendLine($"{turnContext.Activity.Text}");
                threadContext.AppendLine();
            }

            var fullContext = threadContext.ToString();
            _logger.LogInformation("Built thread context with {Length} characters", fullContext.Length);

            // Invoke the agent with the thread context
            var responseBuilder = new StringBuilder();
            await foreach (var responseItem in InvokeAgentAsync(fullContext, chatId: senderChat.Id, cancellationToken: cancellationToken))
            {
                var responseText = responseItem.Message.Content ?? string.Empty;
                responseBuilder.Append(responseText);
            }

            var agentResponse = responseBuilder.ToString();

            if (string.IsNullOrWhiteSpace(agentResponse))
            {
                _logger.LogWarning("Agent produced no response for channel message");
                return;
            }

            // Send the agent's response to the 1:1 chat with sender
            var sentMessage = await _graphService.SendChatMessageAsync(_agentMetadata, senderChat.Id, agentResponse, cancellationToken);

            if (sentMessage != null)
            {
                _logger.LogInformation("Successfully sent agent response to sender in 1:1 chat {ChatId}", 
                    senderChat.Id);
            }
            else
            {
                _logger.LogWarning("Failed to send agent response to sender");
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing Teams channel message for agent {AgentId}", _agentMetadata.AgentId);
        }
    }

    /// <summary>
    /// Process an email by chatting with the manager using Graph API streaming.
    /// Similar to ProcessWithGraphStreamingAsync but returns the final response text.
    /// </summary>
    /// <param name="chatId">The chat ID to send messages to</param>
    /// <param name="messageContent">The message content to process</param>
    /// <param name="cancellationToken">Cancellation token</param>
    /// <returns>The complete agent response text</returns>
    private async Task<string> ProcessEmailWithManagerChatAsync(
        string chatId,
        string messageContent,
        CancellationToken cancellationToken)
    {
        _logger.LogInformation("Processing email with manager chat using GRAPH STREAMING mode");

        try
        {
            // Send initial "thinking" message to Teams using Graph
            var initialMessage = await _graphService.ReplyChatMessageAsync(_agentMetadata, chatId, "Analyzing the procurement request...");

            if (initialMessage == null || string.IsNullOrEmpty(initialMessage.Id))
            {
                _logger.LogError("Failed to send initial message to Teams chat {ChatId}", chatId);
                return string.Empty;
            }

            var messageId = initialMessage.Id;
            var responseBuilder = new StringBuilder();
            var tokenBuffer = new StringBuilder();
            var chunkCount = 0;
            var updateCount = 0;
            var tokenBufferSize = _streamingBufferSize; // Use configured buffer size

            // Use token-level streaming for finer-grained updates - pass chatId so plugins can send updates
            await foreach (var streamingContent in InvokeAgentStreamingAsync(messageContent, chatId: chatId, cancellationToken: cancellationToken))
            {
                try
                {
                    var responseText = streamingContent;

                    if (string.IsNullOrEmpty(responseText))
                    {
                        _logger.LogDebug("Received empty streaming chunk");
                        continue;
                    }

                    chunkCount++;

                    // Add to token buffer
                    tokenBuffer.Append(responseText);

                    // Only update when buffer reaches threshold OR if we have accumulated significant content
                    if (tokenBuffer.Length >= tokenBufferSize)
                    {
                        // Append buffered tokens to full response
                        responseBuilder.Append(tokenBuffer);

                        updateCount++;
                        _logger.LogDebug("Update #{UpdateNumber}: Buffered {BufferLength} chars from {ChunkCount} chunks, total {TotalLength} chars",
                            updateCount, tokenBuffer.Length, chunkCount, responseBuilder.Length);

                        // Update the Teams message with accumulated response using Graph API
                        await _graphService.UpdateChatMessageAsync(_agentMetadata, chatId, messageId, responseBuilder.ToString());

                        // Clear the buffer after successful update
                        tokenBuffer.Clear();
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error updating Teams message with streaming chunk");
                }
            }

            // Send any remaining buffered content
            if (tokenBuffer.Length > 0)
            {
                responseBuilder.Append(tokenBuffer);
                updateCount++;
                _logger.LogDebug("Final update: Flushing {BufferLength} remaining chars", tokenBuffer.Length);

                await _graphService.UpdateChatMessageAsync(_agentMetadata, chatId, messageId, responseBuilder.ToString());
            }

            // If we didn't get any response, update with an error message
            if (responseBuilder.Length == 0)
            {
                _logger.LogWarning("No streaming chunks received from agent");
                await _graphService.UpdateChatMessageAsync(_agentMetadata, chatId, messageId,
                    "Sorry, I couldn't generate a response at this time.");
                return string.Empty;
            }
            else
            {
                _logger.LogInformation("Graph streaming completed: {ChunkCount} chunks received, {UpdateCount} updates sent, {TotalLength} total chars",
                    chunkCount, updateCount, responseBuilder.Length);
                return responseBuilder.ToString();
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in Graph streaming mode for manager chat");
            // Try to send an error message
            try
            {
                await _graphService.ReplyChatMessageAsync(_agentMetadata, chatId,
                    "Sorry, I encountered an error processing the request.");
            }
            catch
            {
                // Ignore errors when sending error message
            }
            return string.Empty;
        }
    }

    /// <summary>
    /// Invokes the agent with the specified input text and returns the response stream.
    /// The caller is responsible for handling the responses (e.g., sending via turn context or collecting as string).
    /// This returns complete response items (may contain tool calls, system messages, etc.)
    /// </summary>
    /// <param name="incomingText">The input text to send to the agent</param>
    /// <param name="agentThread">Optional agent thread to use. If null, creates a new empty thread.</param>
    /// <param name="chatId">Optional chat ID for sending progress updates to Teams</param>
    /// <param name="cancellationToken">Cancellation token</param>
    /// <returns>An async enumerable of agent response items</returns>
    private IAsyncEnumerable<AgentResponseItem<ChatMessageContent>> InvokeAgentAsync(
        string incomingText, 
        ChatHistoryAgentThread? agentThread = null,
        string? chatId = null,
        CancellationToken cancellationToken = default)
    {
        // NOTE: This won't retain history from previous messages in the thread currently
        //       This could be added at a later time
        //       For now, just always use new empty thread unless one is provided
        agentThread ??= new ChatHistoryAgentThread();

        var content = new ChatMessageContent
        {
            Role = AuthorRole.User,
            Content = incomingText,
        };

        _logger.LogInformation("Invoking agent {AgentId} with content: {incomingText}", 
            _agentMetadata.AgentId, incomingText);

        return _chatCompletionAgent.InvokeAsync(content, agentThread, cancellationToken: cancellationToken);
    }

    #endregion
}