namespace ProcurementA365Agent.AgentLogic.SemanticKernel;

using Azure.Core;
using DocumentFormat.OpenXml.Drawing.Charts;
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
        Console.WriteLine($"SemanticKernelAgentLogicService: ModelDeployment={deployment}, AzureOpenAIEndpoint={endpoint}");
        if (string.IsNullOrWhiteSpace(deployment) || string.IsNullOrWhiteSpace(endpoint))
        {
            throw new InvalidOperationException("ModelDeployment and AzureOpenAIEndpoint must be configured.");
        }

        var instructions = AgentInstructions.GetInstructions(agent);
        _kernel = kernel;
        _chatCompletionAgent = new ChatCompletionAgent
        {
            // NOTE: This ID should match the agent ID for which the token is registered on L48-51 above
            Id = agent.AgentId.ToString(),
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
        _logger.LogInformation("Processing new agent creation event - sending greeting to manager");

        try
        {
            // Agent is already registered by A365AgentApplication.RegisterAgentFromNotificationAsync.
            // This method only needs to send the greeting to the manager.
            if (_agentMetadata.AgentManagerId.HasValue)
            {
                await NotifyManagerAboutNewAgentAsync(_agentMetadata, cancellationToken);
            }
            else
            {
                // Manager info may not have been populated yet — try once more
                await PopulateManagerInformationAsync(_agentMetadata, cancellationToken);
                if (_agentMetadata.AgentManagerId.HasValue)
                {
                    await NotifyManagerAboutNewAgentAsync(_agentMetadata, cancellationToken);
                }
                else
                {
                    _logger.LogWarning("No manager found for agent {AgentId}, skipping manager notification", _agentMetadata.AgentId);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error sending greeting for agent {AgentId}", _agentMetadata.AgentId);
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
            var user = await _graphService.FindUserById(agentMetadata, userId.ToString(), cancellationToken);
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
    /// Populates sender's user information (email and display name) from Graph API
    /// </summary>
    private async Task PopulateSenderUserInformationAsync(UserMetadata userMetadata, Guid userId, CancellationToken cancellationToken)
    {
        try
        {
            _logger.LogInformation("Attempting to retrieve user information for user {UserId}", userId);
            var user = await _graphService.FindUserById(_agentMetadata, userId.ToString(), cancellationToken);
            if (user != null)
            {
                userMetadata.EmailId = user.Mail ?? user.UserPrincipalName ?? string.Empty;
                userMetadata.Name = user.DisplayName ?? userMetadata.Name;
                _logger.LogInformation("Retrieved user information - Email: {Email}, DisplayName: {DisplayName}",
                    userMetadata.EmailId, userMetadata.Name);
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
    /// Notifies the manager about the new agent with retry logic.
    /// Retries up to 3 times with 10-second delays between attempts.
    /// </summary>
    public async Task NotifyManagerAboutNewAgentAsync(AgentMetadata agentMetadata, CancellationToken cancellationToken)
    {
        const int maxRetries = 3;
        const int delaySeconds = 10;

        if (!agentMetadata.AgentManagerId.HasValue)
        {
            _logger.LogWarning("Cannot notify manager - manager ID is not set for agent {AgentId}", agentMetadata.AgentId);
            return;
        }

        var managerId = agentMetadata.AgentManagerId.Value.ToString();
        
        // Generate greeting message with manager's name and new agent notification
        var greetingMessage = GenerateGreetingMessage(agentMetadata,
            recipientName: agentMetadata.AgentManagerName);

        for (int attempt = 1; attempt <= maxRetries; attempt++)
        {
            try
            {
                if (attempt > 1)
                {
                    _logger.LogInformation("Waiting {DelaySeconds}s before retry {Attempt}/{MaxRetries} to notify manager {ManagerId}",
                        delaySeconds, attempt, maxRetries, managerId);
                    await Task.Delay(TimeSpan.FromSeconds(delaySeconds), cancellationToken);
                }

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

                // Send message to manager
                var sentMessage = await _graphService.SendChatMessageAsync(agentMetadata, managerChat.Id, greetingMessage, cancellationToken);
                _logger.LogInformation("Attempt {Attempt}/{MaxRetries}: Successfully created chat {ChatId} with manager {ManagerId}, sending notification greetingMessage",
                    attempt, maxRetries, managerChat.Id, managerId);
                if (sentMessage != null)
                {
                    _logger.LogInformation("Successfully notified manager {ManagerId} about new agent {AgentId} on attempt {Attempt}",
                        managerId, agentMetadata.AgentId, attempt);
                    return; // Success - exit
                }
                else
                {
                    _logger.LogWarning("Attempt {Attempt}/{MaxRetries}: Failed to send greetingMessage to manager {ManagerId} - greetingMessage is null",
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

    private sealed class UserMetadata
    {
        public string? AadObjectId { get; set; }

        public string? Id { get; set; }

        public string? Name { get; set; }

        public string? EmailId { get; set; }
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
        if (turnContext.Activity.ChannelId != "msteams")
        {
            _logger.LogInformation("Non-Teams channel detected ({ChannelId}), skipping processing.", turnContext.Activity.ChannelId);
            return;
        }

        if (turnContext.Activity.ChannelId == "msteams" && LooksLikeRosterXml(turnContext.Activity.Text))
            return;

        // Send typing indicator immediately
        try
        {
            await turnContext.SendActivityAsync(new Microsoft.Agents.Core.Models.Activity { Type = ActivityTypes.Typing }, cancellationToken);
        }catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to send typing indicator");
        }

        var incomingText = turnContext.Activity.Text;
        _logger.LogInformation("New activity received (Semantic Kernel): {IncomingText}", incomingText);

        // Log sender information
        var sender = turnContext.Activity.From;
        var jsonSender = sender != null ? JsonSerializer.Serialize(sender) : "null";
        _logger.LogInformation("Sender: {Sender}", jsonSender);

        // Check for reset command from admin
        if (!string.IsNullOrWhiteSpace(incomingText) && 
            incomingText.Trim().Equals("reset", StringComparison.OrdinalIgnoreCase) &&
            sender?.AadObjectId != null)
        {
            _logger.LogInformation("Reset command received from admin {AdminObjectId}", sender.AadObjectId);
            await HandleResetCommandAsync(turnContext, cancellationToken);
            return;
        }

        if (turnContext.Activity.ChannelId == "msteams" && ContainsApprovalKeyword(incomingText))
        {
            _logger.LogInformation("Incoming message is an approval request.");
            await Task.Delay(3000); // Simulate processing delay
            await turnContext.SendActivityAsync(MessageFactory.Text("PO-7781 created for 4 Proseware Pro laptops for Adatum Corporation. PO added to delivery tracker."), cancellationToken);
            return;
        }

        // Check for attachment
        if (turnContext.Activity.ChannelId == "msteams" && turnContext.Activity.Attachments != null && turnContext.Activity.Attachments.Count > 0)
        {
            var teamsFileDownloadAttachments = turnContext.Activity.Attachments
        .Where(a => string.Equals(a.ContentType, "application/vnd.microsoft.teams.file.download.info", StringComparison.OrdinalIgnoreCase))
        .ToList();

            if (teamsFileDownloadAttachments.Count > 0)
            {
                _logger.LogInformation(
                    "Incoming message contains {AttachmentCount} Teams file download attachments (filtered from {TotalAttachmentCount} total).",
                    teamsFileDownloadAttachments.Count,
                    turnContext.Activity.Attachments.Count);
                _logger.LogInformation("Incoming message contains {AttachmentCount} attachments.", turnContext.Activity.Attachments.Count);
                await turnContext.SendActivityAsync(MessageFactory.Text("Thanks for uploading the Zava Procurement Policy Guide. I will use this document to inform my actions as your procurement agent."), cancellationToken);
                return;
            }
        }


        // Log target recipient
        var recipient = turnContext.Activity.Recipient;
        var json = recipient != null ? JsonSerializer.Serialize(recipient) : "null";
        _logger.LogInformation("Target Recipient: {Recipient}", json);

        var senderMetadata = sender != null ? new UserMetadata
        {
            AadObjectId = sender.AadObjectId,
            Id = sender.Id,
            Name = sender.Name,
        } : new UserMetadata();

        if (sender != null)
        {
            await PopulateSenderUserInformationAsync(senderMetadata, Guid.Parse(sender.AadObjectId), cancellationToken);
        }

        using var baggageScope = new BaggageBuilder()
            .CorrelationId(turnContext.Activity.RequestId)
            .TenantId(_agentMetadata.TenantId.ToString())
            .AgentId(_agentMetadata.AgentId.ToString())
            .Build();

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

        // name and email missing in teams channel data
        incomingText = $"Respond to this chat message with chat id {turnContext.Activity.Conversation.Id} " +
                        $"From: {sender?.Name} ({sender?.Id})\n" +
                        $"Message: {incomingText}";

        if (!this._agentMetadata.CanAgentInitiateEmails && ContainsEmailKeyword(incomingText))
        {
            var toolDetails = new ToolCallDetails(
                toolName: "mcp_MailTools_graph_mail_createMessage",
                arguments: JsonSerializer.Serialize(new { incomingText }));
            using var toolScope = ExecuteToolScope.Start(
                         toolDetails,
                         agentDetails,
                         tenantDetails);

            var chatId = turnContext.Activity.Conversation?.Id;
            _logger.LogWarning("Agent is not allowed to initiate emails. Aborting Graph streaming. {ChatId}", chatId);
            _logger.LogWarning("Incoming message: {IncomingText}", incomingText);
            await _graphService.ReplyChatMessageAsync(_agentMetadata, chatId, "Sorry, your company policy does not let me send email messages.");
            _logger.LogWarning("Agent is not allowed to initiate emails. Aborting Graph streaming.");
            toolScope.RecordError(new InvalidOperationException("Based on company policy this agent is not allowed to send email."));
            return;
        }

        // Choose streaming mode: Graph streaming for other channels (should not normally happen) otherwise collect and send
        if (_enableGraphStreaming)
        {
            await ProcessWithGraphStreamingAsync(turnContext, incomingText, cancellationToken);
        }
        else
        {
            await ProcessWithoutStreamingAsync(turnContext, incomingText, cancellationToken);
        }

        // Reset status set presence to Available before returning
        await _graphService.SetStatusMessage(_agentMetadata, "");
        await _graphService.SetPresence(_agentMetadata, PresenceState.Available);
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

    public async Task<string> NewEmailReceived(string fromEmail, string subject, string messageBody)
    {
        using var baggageScope = new BaggageBuilder()
            .TenantId(_agentMetadata.TenantId.ToString())
            .AgentId(_agentMetadata.AgentId.ToString())
            .Build();

        try
        {
            ChatHistoryAgentThread agentThread = new();
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

            // Load allowed senders from configuration (comma-separated). If list is empty, allow all.
            var allowedSendersConfig = _config.GetValue<string>("AgentConfiguration:AllowedEmailSenders");
            var allowedSenders = string.IsNullOrWhiteSpace(allowedSendersConfig)
                ? Array.Empty<string>()
                : allowedSendersConfig.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

            // EARLY RETURN: sender not authorized
            if (allowedSenders.Length > 0 &&
                !allowedSenders.Contains(fromEmail, StringComparer.OrdinalIgnoreCase))
            {
                _logger.LogInformation("Ignoring email from {FromEmail} - not in allowed sender list.", fromEmail);
                return;
            }

            // Extract subject from conversation topic (email subject is stored here)
            // Try to get from conversation first, then fall back to conversation ID as placeholder
            string emailSubject = "No Subject";

            // Check if turnContext.Activity is available and has conversation data
            if (turnContext.Activity?.Conversation != null)
            {
                // Try to get topic from conversation object
                var conversation = turnContext.Activity.Conversation;

                // Check if Properties exists and contains the key before accessing
                if (conversation.Properties != null &&
                    conversation.Properties.TryGetValue("topic", out var topicValue))
                {
                    emailSubject = topicValue.ToString() ?? string.Empty;
                }
            }

            if (!(emailSubject.Contains("purchase", StringComparison.InvariantCultureIgnoreCase) ||
                emailSubject.Contains("order", StringComparison.InvariantCultureIgnoreCase) ||
                emailSubject.Contains("purhcase", StringComparison.InvariantCultureIgnoreCase) ||
                emailSubject.Contains("ordet", StringComparison.InvariantCultureIgnoreCase) ||
                emailSubject.Contains("puchase", StringComparison.InvariantCultureIgnoreCase) ||
                emailSubject.Contains("purchas", StringComparison.InvariantCultureIgnoreCase) ||
                emailSubject.Contains("purchasr", StringComparison.InvariantCultureIgnoreCase) ||
                emailSubject.Contains("purchse", StringComparison.InvariantCultureIgnoreCase)))
            {
                _logger.LogInformation("Email subject not related to purchase order. Skipping {emailSubject}", emailSubject);
                return;
            }

            _logger.LogInformation("Email from {FromEmail}, Subject: {Subject}, Content: {Content}",
                fromEmail, emailSubject, emailContent);

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

            //_logger.LogInformation("Found manager {ManagerName} ({ManagerId})", "Reza Shojaei", "19:0b0c3220-a4a4-4a74-9219-1e9294431de1_603fb04d-a5af-4dbf-a3e1-1acbcd2ec798@unq.gbl.spaces")
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
            var tasks = new List<string>
            {
                "Identifying potential suppliers...",
                "Calling Relecloud agent for performance insights...",
                "Checking policy compliance...",
                "Finalizing purchase order details..."
            };

            await ResponseWithAdaptiveCard(managerChat.Id, tasks, "Purchase order request received", emailContent);
            _logger.LogInformation("Created/retrieved chat {ChatId} with manager", managerChat.Id);

            // Format the message for the agent to analyze the email
            var formattedMessage = $"I received an email requesting procurement approval.\n" +
                                  $"From: {fromEmail}\n" +
                                  $"Subject: {emailSubject}\n" +
                                  $"Message: {emailContent}\n\n" +
                                  $"We recieved this email for purchase. Process the purchased, and inform the manager. Your response is to your manager. You need to describe the work that you did.";

            // Use streaming to communicate with the manager via Teams chat
            //await ProcessProcurementRequest(turnContext, formattedMessage, new CancellationToken(), false); //await ProcessEmailWithManagerChatAsync(managerChat.Id, formattedMessage, CancellationToken.None);

            // Send email response confirming the order is processed and approved
            var emailResponseText = $"<p>Thank you for your email regarding the procurement request.\n\n" +
                                   $"I have analyzed your request and discussed it with my manager. " +
                                   //  //$"Analysis:\n{agentResponse}\n\n" +
                                   $"If you have any questions, please don't hesitate to reach out.</p>\n\n" +
                                   $"<p>Sincerely,</p><p>{_agentMetadata.AgentFriendlyName}</p>";

            var responseActivity = MessageFactory.Text("");
            responseActivity.Entities.Add(new Microsoft.Agents.A365.Notifications.Models.EmailResponse(emailResponseText));
            await turnContext.SendActivityAsync(responseActivity);

            _logger.LogInformation("Email response sent successfully");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error while processing email");
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
        var responseText = "Supplier has reported a delay for this order due to fulfillment errors. Supplier logistics portal indicates that due to the bulk order, items are currently out of stock at the supplier warehouse. Once more information is available, I will update the tracker.";
        var commentActivity = MessageFactory.Text(responseText);
        await turnContext.SendActivityAsync(commentActivity);
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

        _logger.LogInformation("Installation update response prepared: {ResponseText}", responseText);
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
    /// Generates the standard greeting message for the agent.
    /// This message is used when notifying managers about new agents and when handling reset commands.
    /// </summary>
    /// <param name="recipientName">Optional name of the recipient (e.g., manager name). If null, uses generic greeting.</param>
    /// <param name="includeNewAgentNote">If true, includes a note about being a new agent with provisioning info.</param>
    /// <returns>HTML-formatted greeting message</returns>
    private string GenerateGreetingMessage(AgentMetadata agentMetadata, string? recipientName = null)
    {
        return $"<p>Hi {recipientName}, I'm your <strong>Zava Procurement agent</strong>.</p>" +
               $"<p><strong>Here's what I can do</strong>:</p>" +
               $"<ul>" +
               $"<li>Parse emails and Teams threads for purchase requests</li>" +
               $"<li>Look up approved suppliers and pricing in your ERP</li>" +
               $"<li>Create Purchase Orders and notify stakeholders</li>" +
               $"<li>Hand off information for budget checks</li>" +
               $"</ul>" +
               $"<p>To get started, please upload supplier policies, approved suppliers lists, and your procurement playbook.</p>" +
               $"<br/><p><strong>ACTION NEEDED</strong>: Upload any procurement policies or guidelines.</p>";
    }

    /// <summary>
    /// Handles the reset command from an admin user - sends the greeting message
    /// </summary>
    private async Task HandleResetCommandAsync(ITurnContext turnContext, CancellationToken cancellationToken)
    {
        if (_agentMetadata.AgentManagerId == null)
        {
            await PopulateManagerInformationAsync(_agentMetadata, cancellationToken);
        }

        await NotifyManagerAboutNewAgentAsync(_agentMetadata, cancellationToken);
    }

    /// <summary>
    /// Sends an adaptive card showing progressive task completion with delays between updates.
    /// Each step is marked as completed with a 200ms delay between updates.
    /// Updates the same message by modifying its adaptive card attachment.
    /// </summary>
    /// <param name="chatId">The chat ID to send the adaptive card to</param>
    /// <param name="tasks">List of task descriptions to show as steps</param>
    /// <param name="title">The title to display in the card header</param>
    /// <param name="cancellationToken">Cancellation token</param>
    private async Task ResponseWithAdaptiveCard(
        string chatId, 
        List<string> tasks, 
        string title,
        string emailContent,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var responseText = AdaptiveCardAssets.Response;

            //// Start the agent invocation early (it will run in the background)
            //var agentResponseTask = Task.Run(async () =>
            //{
            //    var sb = new StringBuilder();
            //    await foreach (var chunk in InvokeAgentAsync(endPrompt + emailContent))
            //    {
            //        sb.Append(chunk.Message.Content);
            //    }
            //    return sb.ToString();
            //}, cancellationToken);
            
            _logger.LogInformation("Starting ResponseWithAdaptiveCard for chat {ChatId} with {TaskCount} tasks", chatId, tasks.Count);

            // Send initial card with first task in progress
            var cardJson = BuildAdaptiveCard(title, tasks, 1);
            var initialMessage = await _graphService.SendChatMessageAsync(_agentMetadata, chatId, cardJson, cancellationToken);
            
            if (initialMessage == null || string.IsNullOrEmpty(initialMessage.Id))
            {
                _logger.LogError("Failed to send initial adaptive card to chat {ChatId}", chatId);
                return;
            }

            var messageId = initialMessage.Id;

            // Progressively update the same card to show each task completing
            for (int i = 1; i <= tasks.Count - 1; i++)
            {
                await Task.Delay(5000, cancellationToken); 
                
                cardJson = BuildAdaptiveCard(title, tasks, i + 1);
                await _graphService.UpdateChatMessageAsync(_agentMetadata, chatId, messageId, cardJson);
                
                _logger.LogDebug("Updated adaptive card: {CompletedCount}/{TotalCount} tasks completed", i, tasks.Count);
            }

            // Now await the agent response (it should be ready or nearly ready by now)
            // var agentResponseText = await agentResponseTask;
            cardJson = BuildAdaptiveCard(title, tasks, tasks.Count);
            var finalText = $"{cardJson}\n\n{responseText}";
            await _graphService.UpdateChatMessageAsync(_agentMetadata, chatId, messageId, finalText);

            _logger.LogInformation("Completed ResponseWithAdaptiveCard for chat {ChatId}", chatId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in ResponseWithAdaptiveCard for chat {ChatId}", chatId);
        }
    }

    /// <summary>
    /// Builds an adaptive card JSON showing task progress.
    /// </summary>
    /// <param name="title">The title to display in the header</param>
    /// <param name="tasks">List of all tasks</param>
    /// <param name="completedCount">Number of tasks completed (0 = all in progress)</param>
    /// <returns>JSON string representing the adaptive card</returns>
    private string BuildAdaptiveCard(string title, List<string> tasks, int progressIndex)
    {
        var taskItems = new List<string>();

        // Clamp
        if (progressIndex < 0) progressIndex = 0;
        if (progressIndex > tasks.Count) progressIndex = tasks.Count;

        for (int i = 0; i < tasks.Count; i++)
        {
            bool isCompleted = i < progressIndex;
            bool isInProgress = i == progressIndex && progressIndex < tasks.Count;
            string spacingLine = i > 0 ? @"""spacing"": ""Medium""," : "";

            if (isCompleted)
            {
                taskItems.Add($@"
{{
  ""type"": ""ColumnSet"",
  {spacingLine}
  ""columns"": [
    {{
      ""type"": ""Column"",
      ""width"": ""auto"",
      ""items"": [
        {{
          ""type"": ""TextBlock"",
          ""text"": ""✓"",
          ""size"": ""Medium"",
          ""color"": ""Good"",
          ""weight"": ""Bolder""
        }}
      ]
    }},
    {{
      ""type"": ""Column"",
      ""width"": ""stretch"",
      ""items"": [
        {{
          ""type"": ""TextBlock"",
          ""text"": ""{tasks[i]}"",
          ""weight"": ""Default"",
          ""size"": ""Medium"",
          ""wrap"": true
        }}
      ]
    }}
  ]
}}");
            }
            else if (isInProgress)
            {
                taskItems.Add($@"
{{
  ""type"": ""ColumnSet"",
  {spacingLine}
  ""columns"": [
    {{
      ""type"": ""Column"",
      ""width"": ""auto"",
      ""items"": [
        {{
          ""type"": ""Image"",
          ""url"": ""{AdaptiveCardAssets.SpinnerSvg}"",
          ""size"": ""Small"",
          ""width"": ""20px"",
          ""height"": ""20px""
        }}
      ]
    }},
    {{
      ""type"": ""Column"",
      ""width"": ""stretch"",
      ""items"": [
        {{
          ""type"": ""TextBlock"",
          ""text"": ""{tasks[i]}"",
          ""weight"": ""Bolder"",
          ""size"": ""Medium"",
          ""wrap"": true
        }}
      ]
    }}
  ]
}}");
            }
        }

        var taskItemsJoined = string.Join(",", taskItems);

        var cardJson = $@"{{
  ""$schema"": ""https://adaptivecards.io/schemas/adaptive-card.json"",
  ""type"": ""AdaptiveCard"",
  ""version"": ""1.5"",
  ""body"": [
    {{
      ""type"": ""Container"",
      ""items"": [
        {{
          ""type"": ""ColumnSet"",
          ""selectAction"": {{
            ""type"": ""Action.ToggleVisibility"",
            ""targetElements"": [ ""taskList"" ]
          }},
          ""columns"": [
            {{
              ""type"": ""Column"",
              ""width"": ""stretch"",
              ""items"": [
                {{
                  ""type"": ""TextBlock"",
                  ""text"": ""{title}"",
                  ""weight"": ""Bolder"",
                  ""size"": ""Medium"",
                  ""wrap"": true
                }}
              ]
            }},
            {{
              ""type"": ""Column"",
              ""width"": ""auto"",
              ""items"": [
                {{
                  ""type"": ""Image"",
                  ""url"": ""data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTQgNkw4IDExTDEyIDYiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KPC9zdmc+"",
                  ""width"": ""16px"",
                  ""height"": ""16px"",
                  ""altText"": ""Toggle details""
                }}
              ],
              ""verticalContentAlignment"": ""Center""
            }}
          ]
        }}
      ]
    }},
    {{
      ""type"": ""Container"",
      ""id"": ""taskList"",
      ""spacing"": ""Medium"",
      ""separator"": true,
      ""isVisible"": {(progressIndex < tasks.Count ? "true" : "false")},
      ""items"": [
        {taskItemsJoined}
      ]
    }}
  ]
}}";

        return cardJson;
    }

    private async Task ProcessProcurementRequest(ITurnContext turnContext, string incomingText, CancellationToken cancellationToken, bool graphStreaming)
    {
        // This function should be invoked for incoming Teams messages. It should do the following:
        // 1. Immediately respond with a placeholder ("Working on your request...")
        // 2. Invoke the agent (1st pass) with the original context and update the same message
        // 3. Invoke the agent (2nd pass) with additional procurement summary context and update
        // 4. Invoke the agent (3rd pass) with risk / action context and update
        // If any invocation returns Adaptive Card JSON, send it as a NEW message instead of updating the existing one.
        try
        {
            var conversation = turnContext.Activity.Conversation;
            if (conversation?.Id == null)
            {
                _logger.LogWarning("ProcessProcurement called with an empty conversation id");
                return;
            }

            if (conversation.ConversationType == "channel")
            {
                await ProcessTeamsChannelMessageAsync(turnContext, incomingText, cancellationToken);
                return;
            }

            var chatId = conversation.Id;

            // Initial placeholder (Graph message so we can update it)
            var initialMessage = await _graphService.ReplyChatMessageAsync(_agentMetadata, chatId, "Working on your request...");
            if (initialMessage == null || string.IsNullOrEmpty(initialMessage.Id))
            {
                _logger.LogError("Failed to send placeholder procurement response to chat {ChatId}", chatId);
                return;
            }
            var messageId = initialMessage.Id;

            var aggregated = new StringBuilder();

            async Task<string> InvokeAndCollectAsync(string prompt)
            {
                var sb = new StringBuilder();
                await foreach (var responseItem in InvokeAgentAsync(prompt, chatId: chatId, cancellationToken: cancellationToken))
                {
                    sb.Append(responseItem.Message.Content ?? string.Empty);
                }
                return sb.ToString();
            }

            async Task<string> InvokeStreamingAndCollectAsync(string prompt)
            {
                var sectionBuilder = new StringBuilder();
                var aggregatedSnapshotBase = aggregated.ToString();
                var tokenBuffer = new StringBuilder();
                var bufferSize = _streamingBufferSize > 0 ? _streamingBufferSize : 20;

                await foreach (var token in InvokeAgentStreamingAsync(prompt, chatId: chatId, cancellationToken: cancellationToken))
                {
                    if (string.IsNullOrEmpty(token)) continue;
                    tokenBuffer.Append(token);
                    if (tokenBuffer.Length >= bufferSize)
                    {
                        sectionBuilder.Append(tokenBuffer);
                        tokenBuffer.Clear();
                        // Only update text version (cannot reliably stream adaptive card tokens)
                        var combined = new StringBuilder();
                        combined.Append(aggregatedSnapshotBase);
                        if (combined.Length > 0 && !combined.ToString().EndsWith("\n")) combined.AppendLine();
                        combined.Append("\n").Append(sectionBuilder.ToString());
                        await _graphService.UpdateChatMessageAsync(_agentMetadata, chatId, messageId, combined.ToString());
                    }
                }
                if (tokenBuffer.Length > 0)
                {
                    sectionBuilder.Append(tokenBuffer);
                    tokenBuffer.Clear();
                }
                // Final flush
                var finalCombined = new StringBuilder();
                finalCombined.Append(aggregatedSnapshotBase);
                if (finalCombined.Length > 0 && !finalCombined.ToString().EndsWith("\n")) finalCombined.AppendLine();
                finalCombined.Append("\n").Append(sectionBuilder.ToString());
                await _graphService.UpdateChatMessageAsync(_agentMetadata, chatId, messageId, finalCombined.ToString());
                return sectionBuilder.ToString();
            }

            async Task HandleInvocationResultAsync(string resultText, string label)
            {
                var isCard = IsAdaptiveCardJson(resultText);
                if (isCard)
                {
                    _logger.LogInformation("Adaptive card detected for {Label}; sending new card message", label);
                    try
                    {
                        await _graphService.SendChatMessageAsync(_agentMetadata, chatId, resultText, cancellationToken);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "Failed to send adaptive card; falling back to text update");
                        aggregated.AppendLine(string.IsNullOrWhiteSpace(resultText) ? "(no response)" : resultText.Trim());
                        await _graphService.UpdateChatMessageAsync(_agentMetadata, chatId, messageId, aggregated.ToString());
                    }
                }
                else
                {
                    aggregated.AppendLine(string.IsNullOrWhiteSpace(resultText) ? "(no response)" : resultText.Trim());
                    await _graphService.UpdateChatMessageAsync(_agentMetadata, chatId, messageId, aggregated.ToString());
                }
            }

            var adaptiveCardInstructions = " Give response in correct JSON adaptive card format. Schema should follow this structure: { \"type\": \"AdaptiveCard\", \"$schema\": \"http://adaptivecards.io/schemas/adaptive-card.json\", \"version\": \"1.4\", \"body\": [ ... ] }";

            // 1st invocation
            var section1Prompt = $"{incomingText}\n\nAccept the purchase order.";
            var section1Result = graphStreaming ? await InvokeStreamingAndCollectAsync(section1Prompt) : await InvokeAndCollectAsync(section1Prompt);
            await HandleInvocationResultAsync(section1Result, "Pass 1");

            // 2nd invocation
            aggregated.AppendLine();
            var section2Prompt = $"{incomingText}\n\nResearch the possible suppliers and choose the best option.";
            var section2Result = graphStreaming ? await InvokeStreamingAndCollectAsync(section2Prompt) : await InvokeAndCollectAsync(section2Prompt);
            await HandleInvocationResultAsync(section2Result, "Pass 2");

            // 3rd invocation
            aggregated.AppendLine();
            var section3Prompt = $"{incomingText}\n\nAsk for confirmation before proceeding with creating the purchase order with Supplier A.";
            var section3Result = graphStreaming ? await InvokeStreamingAndCollectAsync(section3Prompt) : await InvokeAndCollectAsync(section3Prompt);
            await HandleInvocationResultAsync(section3Result, "Pass 3");

            //// 4th invocation
            //aggregated.AppendLine();
            //var section4Prompt = $"{incomingText}\n\nFinalize creating the purchase order with Supplier A.";
            //var section4Result = graphStreaming ? await InvokeStreamingAndCollectAsync(section4Prompt) : await InvokeAndCollectAsync(section4Prompt);
            //await HandleInvocationResultAsync(section3Result, "Pass 4");

            _logger.LogInformation("ProcessProcurement completed for chat {ChatId} with 4 agent invocations (Streaming={Streaming})", chatId, graphStreaming);
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
            catch { }
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
            await ProcessResponse(turnContext, responseBuilder.ToString(), cancellationToken);
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

        // Add chatId to kernel arguments if provided so plugins can send updates
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
            _logger.LogInformation("Invoking agent {AgentId} for 1:1 chat with sender {SenderId}",
                _agentMetadata.AgentId, senderId);
            await foreach (var responseItem in InvokeAgentAsync(fullContext, chatId: senderChat.Id, cancellationToken: cancellationToken))
            {
                var responseText = responseItem.Message.Content ?? string.Empty;
                responseBuilder.Append(responseText);
            }

            var agentResponse = responseBuilder.ToString();

            if (string.IsNullOrWhiteSpace(agentResponse))
            {
                _logger.LogWarning("Agent {AgentId} produced no response for 1:1 chat with sender {SenderId}",
                    _agentMetadata.AgentId, senderId);
                return;
            }

            // Send the agent's response to the 1:1 chat with sender
            var sentMessage = await _graphService.SendChatMessageAsync(_agentMetadata, senderChat.Id, agentResponse, cancellationToken);

            if (sentMessage != null)
            {
                _logger.LogInformation("Successfully sent agent response to sender {SenderId} in 1:1 chat {ChatId}",
                    senderId, senderChat.Id);
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

    private bool IsAdaptiveCardJson(string content)
    {
        if (string.IsNullOrWhiteSpace(content)) return false;
        var trimmed = content.Trim();
        if (!(trimmed.StartsWith("{") && trimmed.EndsWith("}"))) return false;
        try
        {
            using var doc = JsonDocument.Parse(trimmed);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return false;
            var hasType = root.TryGetProperty("type", out var typeProp) && string.Equals(typeProp.GetString(), "AdaptiveCard", StringComparison.OrdinalIgnoreCase);
            var hasBody = root.TryGetProperty("body", out var bodyProp) && bodyProp.ValueKind == JsonValueKind.Array;
            var hasSchema = root.TryGetProperty("$schema", out var schemaProp) && (schemaProp.GetString()?.Contains("adaptivecards.io", StringComparison.OrdinalIgnoreCase) ?? false);
            return hasType && (hasBody || hasSchema);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "IsAdaptiveCardJson parse failure; treating as plain text");
            return false;
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

    private async Task ProcessResponse(ITurnContext turnContext, string responseText, CancellationToken cancellationToken)
    {
        // Check for JSON adaptive card response
        if (responseText.TrimStart().StartsWith("{") && responseText.TrimEnd().EndsWith("}"))
        {
            _logger.LogInformation("Detected JSON response, attempting to parse as Adaptive Card");
            try
            {

                var attachment = new Microsoft.Agents.Core.Models.Attachment
                {
                    ContentType = "application/vnd.microsoft.card.adaptive",
                    Content = Newtonsoft.Json.JsonConvert.DeserializeObject(responseText)
                };

                var reply = MessageFactory.Attachment(attachment);
                await turnContext.SendActivityAsync(reply, cancellationToken);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to parse or send Adaptive Card, falling back to text response");
            }
        }
        else
        {
            await turnContext.SendActivityAsync(MessageFactory.Text(responseText.ToString()), cancellationToken);
        }
    }

    private async Task<bool> IsProcurementMessageAsync(string incomingText, CancellationToken cancellationToken)
    {
        try
        {
            var prompt = $"Determine if the following message is a request to create a purchase order. Respond ONLY with 'Yes' or 'No'.\n\nMessage: \"{incomingText}\"";
            var responseBuilder = new StringBuilder();
            await foreach (var responseItem in _chatCompletionAgent.InvokeAsync(
                new ChatMessageContent
                {
                    Role = AuthorRole.User,
                    Content = prompt,
                },
                new ChatHistoryAgentThread(),
                cancellationToken: cancellationToken))
            {
                responseBuilder.Append(responseItem.Message.Content ?? string.Empty);
            }
            var responseText = responseBuilder.ToString().Trim().ToLowerInvariant();
            _logger.LogInformation("Procurement classification response: {ResponseText}", responseText);
            return responseText.Contains("yes");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error determining if message is procurement-related");
            return false;
        }
    }



    /// <summary>
    /// Checks if the text contains any email-related keywords.
    /// </summary>
    /// <param name="text">The text to check</param>
    /// <returns>True if any email keyword is found, false otherwise</returns>
    private static bool ContainsEmailKeyword(string text)
    {
        // Email-related keywords to check for policy enforcement
        var EmailKeywords = new[]
          {
            "email",
            "e-mail",
            "mail",
            "emails",
            "e-mails",
            "mails",
            "send email",
            "send mail",
            "compose email",
            "compose mail",
            "write email",
            "write mail"
            };
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        return EmailKeywords.Any(keyword =>
            text.Contains(keyword, StringComparison.InvariantCultureIgnoreCase));
    }

    private static bool ContainsApprovalKeyword(string text)
    {
        // Email-related keywords to check for policy enforcement
        var EmailKeywords = new[]
          {
              "accept",
              "accepted",
              "i accept",
              "i accept.",
              "accept.",
              "accepted.",
              "i approve",
              "i approve.",
              "approve",
              "approved",
              "confirmed",
              "confirm",
              "yes",
              "yes!",
              "yes.",
              "approve.",
              "ok",
              "ok.",
              "go ahead",
              "go ahead.",
              "please go ahead and create the purchase order",
              "proceed",
              "proceed.",
              "okay",
              "okay.",
              "go ahead and create the purchase order",
              "go ahead and create the purchase order.",
              "confirm.",
              "confirmed."
        };
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        return EmailKeywords.Any(keyword =>
            text.Equals(keyword, StringComparison.InvariantCultureIgnoreCase));
    }
    #endregion
}