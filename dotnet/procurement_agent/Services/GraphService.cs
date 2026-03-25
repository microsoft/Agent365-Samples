namespace ProcurementA365Agent.Services;

using System.Collections.Concurrent;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Azure.Identity;
using ProcurementA365Agent.AgentLogic;
using ProcurementA365Agent.Capabilities;
using ProcurementA365Agent.Models;
using ProcurementA365Agent.NotificationService;
using ProcurementA365Agent.Util;
using Microsoft.Graph;
using Microsoft.Graph.Chats.Item.MarkChatReadForUser;
using Microsoft.Graph.Me.Presence.SetPresence;
using Microsoft.Graph.Me.Presence.SetStatusMessage;
using Microsoft.Graph.Models;
using Microsoft.Graph.Models.ODataErrors;
using Microsoft.Graph.Users.Item.SendMail;
using Microsoft.Kiota.Abstractions;

public sealed class GraphService(
    IConfiguration configuration,
    ILogger<GraphService> logger,
    AgentTokenHelper agentTokenHelper)
{
    private static readonly ConcurrentDictionary<string, GraphServiceClient> GraphServiceClients = new();
    private static readonly string[] CommonUserFieldSelect = ["id", "displayName", "mail", "userPrincipalName"];
    private const string TeamsBetaBaseUrl = "https://canary.graph.microsoft.com/testprodbetateamsgraphdev";
    private const string GraphBetaUrl = "https://graph.microsoft.com/beta";
    private readonly string[] canaryTenantIds = configuration.GetSection("Graph:CanaryTenantIds").Get<string[]>() ?? [];

    /// <summary>
    /// Standard select fields for message queries to ensure consistent data retrieval
    /// </summary>
    public static readonly string[] MessageSelectFields =
    [
        "id", "subject", "from", "toRecipients", "receivedDateTime",
        "bodyPreview", "body", "hasAttachments", "isRead", "conversationId"
    ];

    private static readonly JsonSerializerOptions JsonSerializerOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    public async Task<string> ReadFileBySharingUrl(
        AgentMetadata agent, string sharingUrl, CancellationToken cancellationToken)
    {
        var graphClient = GetGraphServiceClient(agent);
        try
        {
            return await new FileReader(graphClient)
                .ReadSharedFile(sharingUrl, cancellationToken);
        }
        catch (Exception e)
        {
            logger.LogError(e, "Error reading shared file by URL: {SharingUrl}", sharingUrl);
            ClearCachedClient(agent.AgentId);
            throw;
        }
    }

    public async Task<string> ListSharedFiles(AgentMetadata agent, CancellationToken cancellationToken)
    {
        var graphClient = GetGraphServiceClient(agent);
        var drive = await graphClient.Me.Drive.GetAsync(cancellationToken: cancellationToken);
        var sharedWithMeGetResponse = await graphClient.Drives[drive?.Id].SharedWithMe
            .GetAsSharedWithMeGetResponseAsync(
                requestConfiguration => { requestConfiguration.QueryParameters.Top = 50; }, cancellationToken);
        logger.LogInformation("Retrieved {ValueCount} shared files", sharedWithMeGetResponse?.Value?.Count ?? 0);
        return sharedWithMeGetResponse?.Value
            ?.Select(i => $"{i.Id}: {i.Name} (LastModified: {i.LastModifiedDateTime})")
            .JoinToString("\n") ?? "[]";
    }
    
    public async Task<User?> FindUserByPrincipalName(
        string userPrincipalName, string agentApplicationId, Guid tenantId, CancellationToken cancellationToken)
    {
        var graphClient = GetAppGraphServiceClient(tenantId.ToString(), agentApplicationId);
        var users = await graphClient.Users
            .GetAsync(requestConfiguration =>
            {
                requestConfiguration.QueryParameters.Filter = $"userPrincipalName eq '{userPrincipalName.Replace("'", "''")}'";
                requestConfiguration.QueryParameters.Select = CommonUserFieldSelect;
            }, cancellationToken);
        
        return users?.Value?.FirstOrDefault();
    }
    
    public async Task<User?> FindManagerForUser(
        AgentMetadata agent, string userPrincipalName, CancellationToken cancellationToken)
    {
        try
        {
            var graphClient = GetGraphServiceClient(agent);
            return await graphClient.Users[userPrincipalName].Manager.GetAsync(requestConfiguration =>
            {
                requestConfiguration.QueryParameters.Select = CommonUserFieldSelect;
            }, cancellationToken) as User;
        }
        catch (ODataError oDataError) when (oDataError.ResponseStatusCode == 404)
        {
            return null;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error finding manager for user {UserPrincipalName}", userPrincipalName);
            ClearCachedClient(agent.AgentId);
            throw;
        }
    }

    public async Task SetPresence(
        AgentMetadata agentMetadata,
        PresenceState presenceState,
        TimeSpan? expirationDuration = null,
        CancellationToken cancellationToken = default)
    {
        var client = GetGraphServiceClient(agentMetadata);
        var (availability, activity) = presenceState;
        var body = new SetPresencePostRequestBody
        {
            Activity = activity.ToString(),
            Availability = availability.ToString(),
            SessionId = agentMetadata.AgentId.ToString(),
            ExpirationDuration = expirationDuration ?? TimeSpan.FromMinutes(5),
        };
        try
        {
            await client.Me.Presence.SetPresence.PostAsync(body, cancellationToken: cancellationToken);
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "Error setting presence for agent {AgentId} to {Availability}, {Activity}",
                agentMetadata.AgentId, availability, activity);
        }
    }

    public async Task ClearStatusMessages(AgentMetadata agentMetadata, CancellationToken cancellationToken = default)
    {
        var client = GetGraphServiceClient(agentMetadata);
        try
        {
            await client.Me.Presence.ClearUserPreferredPresence.PostAsync(cancellationToken: cancellationToken);
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "Error clearing status messages for agent {AgentId}", agentMetadata.AgentId);
        }
    }

    public async Task SetStatusMessage(
        AgentMetadata agentMetadata, string statusMessage,
        CancellationToken cancellationToken = default)
    {
        var client = GetGraphServiceClient(agentMetadata);
        var body = new SetStatusMessagePostRequestBody
        {
            StatusMessage = new PresenceStatusMessage
            {
                Message = new ItemBody
                {
                    Content = statusMessage,
                    ContentType = BodyType.Text,
                },
                ExpiryDateTime = new DateTimeTimeZone
                {
                    DateTime = DateTime.UtcNow.Add(TimeSpan.FromMinutes(5)).ToString("O"),
                    TimeZone = "UTC"
                }
            }
        };
        try
        {
            await client.Me.Presence.SetStatusMessage.PostAsync(body, cancellationToken: cancellationToken);
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "Error setting status message for agent {AgentId} to {StatusMessage}",
                agentMetadata.AgentId, statusMessage);
        }
    }

    public async Task MarkChatAsRead(AgentMetadata agentMetadata, string chatId, CancellationToken cancellationToken = default)
    {
        var graphClient = GetGraphServiceClient(agentMetadata);

        try
        {
            var body = new MarkChatReadForUserPostRequestBody
            {
                User = new TeamworkUserIdentity
                {
                    Id = agentMetadata.UserId.ToString(),
                    UserIdentityType = TeamworkUserIdentityType.AadUser,
                    AdditionalData = new Dictionary<string, object>
                    {
                        {
                            "tenantId", agentMetadata.TenantId.ToString()
                        },
                    },
                }
            };
            await graphClient.Chats[chatId].MarkChatReadForUser
                .PostAsync(body, cancellationToken: cancellationToken);
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "Error marking chat {ChatId} as read for agent {AgentId}", chatId, agentMetadata.UserId);
        }
    }

    public async Task<string?> FindUser(AgentMetadata agent, string searchTerm, CancellationToken cancellationToken)
    {
        var graphClient = GetGraphServiceClient(agent);
        try
        {
            var response = await graphClient.Users
                .GetAsync(requestConfiguration =>
                {
                    requestConfiguration.QueryParameters.Filter =
                        $"startsWith(displayName,'{searchTerm.Replace("'", "''")}') or startsWith(givenName,'{searchTerm.Replace("'", "''")}') or startsWith(surname,'{searchTerm.Replace("'", "''")}') or startsWith(mail,'{searchTerm.Replace("'", "''")}') or startsWith(userPrincipalName,'{searchTerm.Replace("'", "''")}')";
                    requestConfiguration.QueryParameters.Top = 10;
                    requestConfiguration.QueryParameters.Select = CommonUserFieldSelect;
                }, cancellationToken);

            logger.LogInformation("Found {ValueCount} users matching '{Name}'", response?.Value?.Count ?? 0, searchTerm);

            return response?.Value
                ?.Select(u => $"{u.DisplayName} <{u.Mail ?? u.UserPrincipalName}> (Id: {u.Id})")
                .JoinToString("\n");
        }
        catch (Exception e)
        {
            logger.LogError(e, "Error finding user with term: {SearchTerm}", searchTerm);
            ClearCachedClient(agent.AgentId);
            throw;
        }
    }

    public async Task<string> ReadFile(
        AgentMetadata agent, string fileId, CancellationToken cancellationToken)
    {
        var graphClient = GetGraphServiceClient(agent);
        try
        {
            return await new FileReader(graphClient).ReadFile(fileId, cancellationToken);
        }
        catch (Exception e)
        {
            logger.LogError(e, "Error reading file with ID: {FileId}", fileId);
            ClearCachedClient(agent.AgentId);
            throw;
        }
    }

    /// <summary>
    /// Get messages for a specific user since a specified date/time.
    /// </summary>
    /// <param name="emailId">The full email address or the user object id</param>
    /// <param name="sinceDateTime">The date time</param>
    /// <returns>A list of messages</returns>
    /// <exception cref="ArgumentException">If email id is null.</exception>
    public async Task<IEnumerable<Message>> GetMessagesSinceAsync(
        AgentMetadata agent, string emailId, DateTime sinceDateTime, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(emailId))
        {
            throw new ArgumentException("User ID is required", nameof(emailId));
        }

        try
        {
            var graphClient = GetGraphServiceClient(agent);
            var filterDateTime = sinceDateTime.FormatDateTimeForOData();

            logger.LogInformation(
                $"Attempting to get messages for user: {emailId} since {sinceDateTime} using appId: {agent.AgentApplicationId} in tenant: {agent.TenantId}");

            // Get messages for the specified user since the specified date/time
            var messages = await graphClient.Users[emailId].Messages
                .GetAsync(requestConfiguration =>
                {
                    requestConfiguration.QueryParameters.Filter =
                        $"receivedDateTime gt {filterDateTime} and isDraft eq false and parentFolderId ne 'sentitems' " +
                        $"and from/emailAddress/address ne '{emailId.Replace("'", "''")}' and from/emailAddress/address ne 'no-reply@teams.mail.microsoft'";
                    requestConfiguration.QueryParameters.Orderby = ["receivedDateTime desc"];
                    requestConfiguration.QueryParameters.Select = MessageSelectFields;
                }, cancellationToken);

            logger.LogInformation(
                $"Retrieved {messages?.Value?.Count ?? 0} messages for user: {emailId} since {sinceDateTime}");
            return messages?.Value ?? [];
        }
        catch (Exception ex)
        {
            logger.LogError(ex, $"Error getting messages since {sinceDateTime} for user: {emailId}");
            ClearCachedClient(agent.AgentId);
            throw;
        }
    }

    /// <summary>
    /// Get Teams messages for a specific user since a specified date/time.
    /// Uses the getAllMessages endpoint for efficient retrieval of all chat messages.
    /// </summary>
    /// <param name="agent">The agent metadata</param>
    /// <param name="userId">The user ID to get Teams messages for</param>
    /// <param name="sinceDateTime">The date time to get messages since</param>
    /// <returns>A list of Teams chat messages</returns>
    /// <exception cref="ArgumentException">If user ID is null or empty.</exception>
    public async Task<IEnumerable<ChatMessage>> GetTeamsMessagesSinceAsync(
        AgentMetadata agent, string userId, DateTime sinceDateTime, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(userId))
        {
            throw new ArgumentException("User ID is required", nameof(userId));
        }

        try
        {
            var graphClient = GetGraphServiceClient(agent);
            var filterDateTime = sinceDateTime.FormatDateTimeForOData();

            logger.LogDebug("Attempting to get Teams messages for user: {UserId} since {SinceDateTime} using appId: {BlueprintId} in tenant: {TenantId}",
                userId, sinceDateTime, agent.AgentApplicationId, agent.TenantId);

            // Use the getAllMessages endpoint to efficiently get all chat messages for the user
            var response = await graphClient.Users[userId].Chats.GetAllMessages
                .GetAsGetAllMessagesGetResponseAsync(requestConfiguration =>
                {
                    requestConfiguration.QueryParameters.Filter =
                        $"lastModifiedDateTime gt {filterDateTime} and lastModifiedDateTime lt {DateTime.UtcNow:O} and messageType ne 'systemEventMessage'";
                }, cancellationToken);
            var chatMessages = response?.Value?.ToList() ?? [];

            logger.LogDebug("Retrieved {MessagesCount} Teams messages for user: {UserId} since {SinceDateTime} (from {ValueCount} total messages)",
                chatMessages.Count, userId, sinceDateTime, response?.Value?.Count ?? 0);
            return chatMessages;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error getting Teams messages since {SinceDateTime} for user: {UserId}", sinceDateTime, userId);
            ClearCachedClient(agent.AgentId);
            throw;
        }
    }

    /// <summary>
    /// Get all chats that the agent's user is a member of.
    /// </summary>
    /// <param name="agent">The agent metadata</param>
    /// <returns>A list of chats the user is a member of</returns>
    /// <exception cref="ArgumentException">If agent's UserId is empty.</exception>
    public async Task<IEnumerable<Chat>> GetUserChatsAsync(AgentMetadata agent, CancellationToken cancellationToken = default)
    {
        if (agent.UserId == Guid.Empty)
        {
            throw new ArgumentException("Agent's UserId is required", nameof(agent));
        }

        try
        {
            var graphClient = GetGraphServiceClient(agent);
            var userIdString = agent.UserId.ToString();

            logger.LogInformation("Attempting to get chats for user: {UserIdString} using appId: {BlueprintId} in tenant: {TenantId}",
                userIdString, agent.AgentApplicationId, agent.TenantId);

            var chats = await graphClient.Users[userIdString].Chats
                .GetAsync(requestConfiguration =>
                {
                    requestConfiguration.QueryParameters.Select =
                    [
                        "id", "topic", "chatType", "createdDateTime", "lastUpdatedDateTime", "webUrl"
                    ];
                    requestConfiguration.QueryParameters.Top = 50;
                }, cancellationToken);

            logger.LogInformation("Retrieved {Count} chats for user: {UserIdString}", chats?.Value?.Count ?? 0, userIdString);
            return chats?.Value?.Where(c => c.ChatType is ChatType.OneOnOne or ChatType.Group) ?? [];
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error getting chats for user: {AgentUserId}", agent.UserId);
            ClearCachedClient(agent.AgentId);
            throw;
        }
    }

    public async Task<Chat?> CreateChatWithUserAsync(
        AgentMetadata agent, string targetUserId, CancellationToken cancellationToken = default)
    {
        if (agent.UserId == Guid.Empty)
        {
            throw new ArgumentException("Agent's UserId is required", nameof(agent));
        }

        if (string.IsNullOrEmpty(targetUserId))
        {
            throw new ArgumentException("Target user ID is required", nameof(targetUserId));
        }

        if (!Guid.TryParse(targetUserId, out _))
        {
            throw new ArgumentException("Target user ID must be a valid Guid", nameof(targetUserId));
        }
        
        if (agent.UserId.ToString().Equals(targetUserId, StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException("Cannot create chat with self", nameof(targetUserId));
        }

        try
        {
            var graphClient = GetGraphServiceClient(agent);
            var agentUserIdString = agent.UserId.ToString();

            logger.LogInformation(
                $"Attempting to create chat between agent user: {agentUserIdString} and target user: {targetUserId} using appId: {agent.AgentApplicationId} in tenant: {agent.TenantId}");

            // Create a new one-on-one chat
            var chat = new Chat
            {
                ChatType = ChatType.OneOnOne,
                Members =
                [
                    new AadUserConversationMember
                    {
                        OdataType = "#microsoft.graph.aadUserConversationMember",
                        Roles = ["owner"],
                        AdditionalData = new Dictionary<string, object>
                        {
                            { "user@odata.bind", $"https://graph.microsoft.com/v1.0/users('{agentUserIdString}')" }
                        }
                    },

                    new AadUserConversationMember
                    {
                        OdataType = "#microsoft.graph.aadUserConversationMember",
                        Roles = ["owner"],
                        AdditionalData = new Dictionary<string, object>
                        {
                            { "user@odata.bind", $"https://graph.microsoft.com/v1.0/users('{targetUserId}')" }
                        }
                    }
                ]
            };

            var createdChat = await graphClient.Chats.PostAsync(chat, cancellationToken: cancellationToken);

            logger.LogInformation(
                $"Successfully created chat with ID: {createdChat?.Id} between agent user: {agentUserIdString} and target user: {targetUserId}");
            return createdChat;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error creating chat between agent user: {AgentUserId} and target user: {TargetUserId}", agent.UserId, targetUserId);
            ClearCachedClient(agent.AgentId);
            throw;
        }
    }

    /// <summary>
    /// Send a message to a specific Teams chat.
    /// </summary>
    /// <param name="agent">The agent metadata</param>
    /// <param name="chatId">The ID of the chat to send the message to</param>
    /// <param name="messageBody">The message content to send (HTML format)</param>
    /// <param name="cancellationToken">Cancellation token</param>
    /// <returns>The sent message</returns>
    public async Task<ChatMessage?> SendChatMessageAsync(
        AgentMetadata agent, string chatId, string messageBody, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(chatId))
        {
            throw new ArgumentException("Chat ID is required", nameof(chatId));
        }
        
        if (string.IsNullOrEmpty(messageBody))
        {
            throw new ArgumentException("Message body is required", nameof(messageBody));
        }

        try
        {
            var graphClient = GetGraphServiceClient(agent);

            var chatMessage = new ChatMessage
            {
                Body = new ItemBody
                {
                    ContentType = BodyType.Html,
                    Content = messageBody
                }
            };

            logger.LogDebug("Attempting to send chat message to chat: {ChatId}", chatId);

            var sentMessage = await graphClient.Chats[chatId].Messages
                .PostAsync(chatMessage, cancellationToken: cancellationToken);

            logger.LogInformation("Successfully sent chat message to chat: {ChatId}, message ID: {MessageId}",
                chatId, sentMessage?.Id);

            return sentMessage;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error sending chat message to chat: {ChatId}", chatId);
            ClearCachedClient(agent.AgentId);
            throw;
        }
    }

    public async Task<IEnumerable<AgentIdentityServicePrincipal>> GetAgentIdentityServicePrincipalsAsync(
        string createdByAppId, string tenantId, DateTime? createdSince, CancellationToken cancellation)
    {
        try
        {
            var graphClient = GetAppGraphServiceClient(tenantId, baseUrl: GraphBetaUrl);

            logger.LogInformation("Attempting to get AgentIdentity service principals created by app ID: {AppId}  in tenant: {TenantId} {Since}", createdByAppId, tenantId, (createdSince.HasValue ? $" since {createdSince.Value:yyyy-MM-ddTHH:mm:ssZ}" : ""));

            // Build the filter query
            var filter = $"createdByAppId eq '{createdByAppId}'";
            if (createdSince.HasValue)
            {
                var createdSinceString = createdSince.Value.ToString("yyyy-MM-ddTHH:mm:ssZ");
                filter += $" and createdDateTime ge {createdSinceString}";
            }

            // Use direct request since this is a beta endpoint with custom filtering
            var requestInformation = new RequestInformation
            {
                HttpMethod = Method.GET,
                URI = new Uri(
                    $"{graphClient.RequestAdapter.BaseUrl}/servicePrincipals/Microsoft.Graph.AgentIdentity?$filter={filter}&$select=createdByAppId,appId,displayName&$top=200")
            };

            // Execute the request and deserialize directly using System.Text.Json
            await using var response = await graphClient.RequestAdapter.SendPrimitiveAsync<Stream>(requestInformation, cancellationToken: cancellation);

            if (response == null)
            {
                logger.LogWarning("Received null response from service principals endpoint");
                return [];
            }

            var oDataResponse = await JsonSerializer.DeserializeAsync<ODataResponse<AgentIdentityServicePrincipal>>(response, JsonSerializerOptions, cancellation);
            var servicePrincipals = oDataResponse?.Value ?? [];

            logger.LogInformation("Retrieved {ServicePrincipalsCount} service principals for Microsoft.Graph.AgentIdentity created by app ID: {AppId}{Filter}", servicePrincipals.Count, createdByAppId, createdSince.HasValue ? $" since {createdSince.Value:yyyy-MM-ddTHH:mm:ssZ}" : "");
            return Enumerable.Reverse(servicePrincipals); // TODO reverse is temporary - API cannot sort
        }
        catch (Exception ex)
        {
            logger.LogError(ex,
                $"Error getting AgentIdentity service principals created by app ID: {createdByAppId}{(createdSince.HasValue ? $" since {createdSince.Value:yyyy-MM-ddTHH:mm:ssZ}" : "")}");
            ClearCachedClient(baseUrl: GraphBetaUrl);
            throw;
        }
    }

    public async Task CreateAgentUser(
        CreateAgentUserRequest request,
        AgentBlueprintEntity entity)
    {
        var graphClient = GetAppGraphServiceClient(entity.TenantId.ToString(), baseUrl: GraphBetaUrl);

        var user = new AgentUserEntity
        {
            DisplayName = request.DisplayName,
            UserPrincipalName = request.UserPrincipalName,
            IdentityParent = new IdentityParent { Id = request.IdentityParentId },
            MailNickname = request.MailNickname,
            AccountEnabled = true,
            UsageLocation = "US",
        };

        try
        {
            var response = await graphClient.Users.PostAsync(user);
            logger.LogInformation("Created agent user {UserPrincipalName} with ID {UserId} for entity {EntityId} / IdentityId {IdentityId}",
                response?.UserPrincipalName, response?.Id, entity.Id, request.IdentityParentId);
        }
        catch (ODataError oDataError)
        {
            Console.WriteLine(oDataError);
        }
    }

    public async Task<Organization?> ReadOrganization(Guid tenantId, CancellationToken cancellationToken)
    {
        var graphClient = GetAppGraphServiceClient(tenantId.ToString(), baseUrl: GraphBetaUrl);
        var organization = await graphClient.Organization.GetAsync(
            cancellationToken: cancellationToken);

        return organization?.Value?.FirstOrDefault();
    }

    public async Task<AgentUser?> FindAgentUser(
        AgentIdentityServicePrincipal servicePrincipal, Guid tenantId, CancellationToken cancellationToken)
    {
        try
        {
            var graphClient = GetAppGraphServiceClient(tenantId.ToString(), baseUrl: GraphBetaUrl);

            logger.LogInformation(
                "Attempting to get agent users for identity parent ID: {IdentityParentId} in tenant: {TenantId}", servicePrincipal.AppId, tenantId);

            // Use direct request since this is a beta endpoint with custom filtering
            var requestInformation = new RequestInformation
            {
                HttpMethod = Method.GET,
                URI = new Uri(
                    $"{graphClient.RequestAdapter.BaseUrl}/users/microsoft.graph.agentUser?$filter=identityParentId eq '{servicePrincipal.AppId}'&$select=id,userPrincipalName,displayName,assignedLicenses&$expand=manager($select=id,userPrincipalName,displayName)")
            };

            // Execute the request and deserialize directly using System.Text.Json
            await using var response = await graphClient.RequestAdapter
                .SendPrimitiveAsync<Stream>(requestInformation, cancellationToken: cancellationToken);

            if (response == null)
            {
                logger.LogWarning("Received null response from agent users endpoint");
                return null;
            }

            var oDataResponse = await JsonSerializer.DeserializeAsync<ODataResponse<AgentUser>>(response, JsonSerializerOptions, cancellationToken);
            var agentUsers = oDataResponse?.Value ?? [];

            logger.LogInformation(
                $"Retrieved {agentUsers.Count} agent users for identity parent ID: {servicePrincipal.AppId}");

            // Validate that there's exactly one result
            if (agentUsers.Count != 1)
            {
                logger.LogWarning(
                    $"Warning, {agentUsers.Count} agent user found for identity parent ID: {servicePrincipal.AppId}");
                return null;
            }

            return agentUsers.First();
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error getting agent users for identity parent ID: {ServicePrincipalAppId}", servicePrincipal.AppId);
            ClearCachedClient(baseUrl: GraphBetaUrl);
            throw;
        }
    }

    public async Task<bool> CheckServicePrincipalOAuth2PermissionsAsync(
        AgentIdentityServicePrincipal servicePrincipal,
        IReadOnlyCollection<string> requiredScopes, string tenantId, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(servicePrincipal.AppId))
        {
            throw new ArgumentException("Client ID is required", nameof(servicePrincipal));
        }

        if (string.IsNullOrEmpty(tenantId))
        {
            throw new ArgumentException("Tenant ID is required", nameof(tenantId));
        }

        if (requiredScopes == null || !requiredScopes.Any())
        {
            throw new ArgumentException("Required scopes list is required and cannot be empty",
                nameof(requiredScopes));
        }

        try
        {
            var graphClient = GetAppGraphServiceClient(tenantId);

            logger.LogDebug("Checking OAuth2 permission grants for client ID: {AppId} in tenant: {TenantId}", servicePrincipal.AppId, tenantId);

            // Use the Graph SDK to query OAuth2 permission grants
            var permissionGrants = await graphClient.Oauth2PermissionGrants
                .GetAsync(requestConfiguration =>
                {
                    requestConfiguration.QueryParameters.Filter = $"clientId eq '{servicePrincipal.AppId}'";
                }, cancellationToken);

            logger.LogInformation(
                $"Retrieved {permissionGrants?.Value?.Count ?? 0} OAuth2 permission grants for client ID: {servicePrincipal.AppId}");

            // Collect all granted scopes from all permission grants using LINQ
            var grantedScopes = new HashSet<string>(
                permissionGrants?.Value?
                    .Where(grant => !string.IsNullOrEmpty(grant.Scope))
                    .SelectMany(grant => grant.Scope!.Split(' ', StringSplitOptions.RemoveEmptyEntries))
                    .Select(scope => scope.Trim()) ?? [],
                StringComparer.OrdinalIgnoreCase);

            logger.LogInformation($"Found granted scopes: {string.Join(", ", grantedScopes)}");

            // Check if ALL required scopes are present in granted scopes
            var hasAllScopes = requiredScopes.All(scope => grantedScopes.Contains(scope));

            logger.LogInformation($"Service principal has all required scopes: {hasAllScopes}");
            return hasAllScopes;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, $"Error checking OAuth2 permission grants for client ID: {servicePrincipal.AppId}");
            ClearCachedClient();
            throw;
        }
    }

    /// <summary>
    /// Get messages from a list of chats that were not sent by the agent's user and since the last Teams check time.
    /// </summary>
    /// <param name="agent">The agent metadata</param>
    /// <param name="chats">The list of chats to get messages from</param>
    /// <param name="sinceDateTime">The date time to get messages since (last Teams check time)</param>
    /// <returns>A list of chat messages with chat context not sent by the agent's user</returns>
    /// <exception cref="ArgumentException">If agent's UserId is empty or chats list is null.</exception>
    public async Task<IEnumerable<ChatMessageWithContext>> GetChatMessagesFromOthersAsync(
        AgentMetadata agent, IEnumerable<Chat> chats, DateTime sinceDateTime, CancellationToken cancellationToken = default)
    {
        if (agent.UserId == Guid.Empty)
        {
            throw new ArgumentException("Agent's UserId is required", nameof(agent));
        }

        if (chats == null)
        {
            throw new ArgumentException("Chats list is required", nameof(chats));
        }

        try
        {
            var graphClient = GetGraphServiceClient(agent);
            var userIdString = agent.UserId.ToString();
            var allMessagesWithContext = new List<ChatMessageWithContext>();
            var chatsList = chats.ToList();
            var filterDateTime = sinceDateTime.FormatDateTimeForOData();

            logger.LogInformation(
                $"Attempting to get messages from {chatsList.Count} chats for user: {userIdString} since {sinceDateTime} using appId: {agent.AgentApplicationId} in tenant: {agent.TenantId}");

            foreach (var chat in chatsList.Where(c => !string.IsNullOrEmpty(c.Id)))
            {
                try
                {
                    // Get messages from this specific chat
                    var messages = await graphClient.Chats[chat.Id].Messages
                        .GetAsync(requestConfiguration =>
                        {
                            requestConfiguration.QueryParameters.Filter = $"lastModifiedDateTime gt {filterDateTime}";
                            requestConfiguration.QueryParameters.Orderby = ["lastModifiedDateTime desc"];
                        }, cancellationToken);

                    if (messages?.Value != null)
                    {
                        // Filter out messages sent by the agent's user
                        var messagesFromOthers = messages.Value.Where(msg =>
                            msg.From?.User?.Id != userIdString &&
                            msg.MessageType != ChatMessageType.SystemEventMessage);

                        // Convert to ChatMessageWithContext and add chat information
                        var messagesWithContext = messagesFromOthers.Select(msg => new ChatMessageWithContext
                        {
                            Message = msg,
                            ChatType = chat.ChatType ?? ChatType.OneOnOne,
                            ChatId = chat.Id!,
                            ChatTopic = chat.Topic
                        });

                        allMessagesWithContext.AddRange(messagesWithContext);
                    }
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Error getting messages from chat {ChatId}, skipping this chat", chat.Id);
                }
            }

            // Sort all messages by creation time (most recent first)
            var sortedMessages = allMessagesWithContext.OrderByDescending(m => m.Message.CreatedDateTime).ToList();

            logger.LogInformation(
                $"Retrieved {sortedMessages.Count} messages from others across {chatsList.Count} chats for user: {userIdString} since {sinceDateTime}");
            return sortedMessages;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error getting chat messages from others for user: {AgentUserId}", agent.UserId);
            ClearCachedClient(agent.AgentId);
            throw;
        }
    }

    /// <summary>
    /// Reply to a chat with a message.
    /// </summary>
    /// <param name="agent">The agent metadata</param>
    /// <param name="chatId">The chat ID to send the message to</param>
    /// <param name="messageBody">The body/content of the message to send</param>
    /// <returns>The created chat message</returns>
    /// <exception cref="ArgumentException">If chat ID is empty or message body is empty.</exception>
    public async Task<ChatMessage?> ReplyChatMessageAsync(AgentMetadata agent, string chatId, string messageBody)
    {
        if (string.IsNullOrEmpty(chatId))
        {
            throw new ArgumentException("Chat ID is required", nameof(chatId));
        }

        if (string.IsNullOrEmpty(messageBody))
        {
            throw new ArgumentException("Message body is required", nameof(messageBody));
        }

        try
        {
            var graphClient = GetGraphServiceClient(agent);
            logger.LogInformation("Attempting to send message to chat: {ChatId} using appId: {AgentApplicationId} in tenant: {TenantId}", chatId, agent.AgentApplicationId, agent.TenantId);

            var chatMessage = new ChatMessage
            {
                Body = new ItemBody
                {
                    ContentType = BodyType.Html,
                    Content = messageBody
                }
            };

            var sentMessage = await graphClient.Chats[chatId].Messages.PostAsync(chatMessage);

            logger.LogInformation("Message sent successfully to chat: {ChatId} with message ID: {SentMessageId}", chatId, sentMessage?.Id);
            return sentMessage;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error sending message to chat: {ChatId}", chatId);
            ClearCachedClient(agent.AgentId);
            throw;
        }
    }

    /// <summary>
    /// Update an existing chat message.
    /// </summary>
    /// <param name="agent">The agent metadata</param>
    /// <param name="chatId">The chat ID containing the message</param>
    /// <param name="messageId">The message ID to update</param>
    /// <param name="messageBody">The new message body/content</param>
    /// <returns>The updated chat message</returns>
    /// <exception cref="ArgumentException">If chat ID, message ID, or message body is empty.</exception>
    public async Task<ChatMessage?> UpdateChatMessageAsync(AgentMetadata agent, string chatId, string messageId, string messageBody)
    {
        if (string.IsNullOrEmpty(chatId))
        {
            throw new ArgumentException("Chat ID is required", nameof(chatId));
        }

        if (string.IsNullOrEmpty(messageId))
        {
            throw new ArgumentException("Message ID is required", nameof(messageId));
        }

        if (string.IsNullOrEmpty(messageBody))
        {
            throw new ArgumentException("Message body is required", nameof(messageBody));
        }

        try
        {
            var graphClient = GetGraphServiceClient(agent);
            logger.LogDebug("Attempting to update message {MessageId} in chat: {ChatId}", messageId, chatId);

            var chatMessage = new ChatMessage
            {
                Body = new ItemBody
                {
                    ContentType = BodyType.Html,
                    Content = messageBody
                }
            };

            var updatedMessage = await graphClient.Chats[chatId].Messages[messageId].PatchAsync(chatMessage);

            logger.LogDebug("Message updated successfully in chat: {ChatId}, message ID: {MessageId}", chatId, messageId);
            return updatedMessage;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error updating message {MessageId} in chat: {ChatId}", messageId, chatId);
            ClearCachedClient(agent.AgentId);
            throw;
        }
    }

    /// <summary>
    /// Get all messages in a Teams channel thread (parent message + all replies).
    /// </summary>
    /// <param name="agent">The agent metadata</param>
    /// <param name="teamId">The team ID containing the channel</param>
    /// <param name="channelId">The channel ID containing the message</param>
    /// <param name="messageId">The parent message ID (root of the thread)</param>
    /// <param name="cancellationToken">Cancellation token</param>
    /// <returns>List of all messages in the thread (parent + replies)</returns>
    public async Task<IEnumerable<ChatMessage>> GetChannelMessageThreadAsync(
        AgentMetadata agent, string teamId, string channelId, string messageId, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(teamId))
        {
            throw new ArgumentException("Team ID is required", nameof(teamId));
        }

        if (string.IsNullOrEmpty(channelId))
        {
            throw new ArgumentException("Channel ID is required", nameof(channelId));
        }

        if (string.IsNullOrEmpty(messageId))
        {
            throw new ArgumentException("Message ID is required", nameof(messageId));
        }

        try
        {
            var graphClient = GetGraphServiceClient(agent);
            var threadMessages = new List<ChatMessage>();

            logger.LogDebug("Attempting to retrieve channel thread - Team: {TeamId}, Channel: {ChannelId}, Message: {MessageId}",
                teamId, channelId, messageId);

            // First, get the parent message
            try
            {
                var parentMessage = await graphClient.Teams[teamId].Channels[channelId].Messages[messageId]
                    .GetAsync(cancellationToken: cancellationToken);

                if (parentMessage != null)
                {
                    threadMessages.Add(parentMessage);
                    logger.LogDebug("Retrieved parent message {MessageId}", messageId);
                }
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Could not retrieve parent message {MessageId}", messageId);
            }

            // Then get all replies to the parent message
            try
            {
                var replies = await graphClient.Teams[teamId].Channels[channelId].Messages[messageId].Replies
                    .GetAsync(requestConfiguration =>
                    {
                        requestConfiguration.QueryParameters.Orderby = ["createdDateTime"];
                    }, cancellationToken: cancellationToken);

                if (replies?.Value != null)
                {
                    threadMessages.AddRange(replies.Value);
                    logger.LogDebug("Retrieved {Count} replies to message {MessageId}", replies.Value.Count, messageId);
                }
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Could not retrieve replies for message {MessageId}", messageId);
            }

            logger.LogInformation("Retrieved {Count} total messages in thread for message {MessageId}", 
                threadMessages.Count, messageId);

            return threadMessages;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error getting channel message thread - Team: {TeamId}, Channel: {ChannelId}, Message: {MessageId}",
                teamId, channelId, messageId);
            ClearCachedClient(agent.AgentId);
            throw;
        }
    }

    public async Task SendEmailAsync(
        AgentMetadata agent, string fromUserId, string toEmail, string subject, string body)
    {
        if (string.IsNullOrEmpty(fromUserId))
        {
            throw new ArgumentException("From user ID is required", nameof(fromUserId));
        }

        if (string.IsNullOrEmpty(toEmail))
        {
            throw new ArgumentException("To email is required", nameof(toEmail));
        }

        if (string.IsNullOrEmpty(subject))
        {
            throw new ArgumentException("Subject is required", nameof(subject));
        }

        if (string.IsNullOrEmpty(body))
        {
            throw new ArgumentException("Body is required", nameof(body));
        }

        try
        {
            var graphClient = GetGraphServiceClient(agent);

            var message = new Message
            {
                Subject = subject,
                Body = new ItemBody
                {
                    ContentType = BodyType.Html,
                    Content = body
                },
                ToRecipients =
                [
                    new Recipient
                    {
                        EmailAddress = new EmailAddress
                        {
                            Address = toEmail
                        }
                    }
                ]
            };

            var sendMailBody = new SendMailPostRequestBody
            {
                Message = message,
                SaveToSentItems = true
            };

            await graphClient.Users[fromUserId].SendMail.PostAsync(sendMailBody);

            logger.LogInformation("Email sent successfully from {FromUserId} to {Email} with subject '{Subject}'", fromUserId, toEmail, subject);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error sending email from {FromUserId} to {Email}", fromUserId, toEmail);
            ClearCachedClient(agent.AgentId);
            throw;
        }
    }

    public async Task<string> ListSharepointFiles(
        AgentMetadata agent, string siteId, CancellationToken cancellationToken)
    {
        var graphClient = GetGraphServiceClient(agent);
        var drive = await graphClient.Sites[siteId].Drive.GetAsync(cancellationToken: cancellationToken);
        var items = await graphClient.Drives[drive?.Id].Root.GetAsync(cancellationToken: cancellationToken);
        var files = items?.Children?.Where(c => c.Folder != null).ToList();
        return files?.Select(f => f.Name)
            .WhereNotNull()
            .JoinToString() ?? "[]";
    }

    private GraphServiceClient GetGraphServiceClient(AgentMetadata agent)
    {
        var baseUrl = !agent.SkipAgentIdAuth && canaryTenantIds.Contains(agent.TenantId.ToString())
            ? TeamsBetaBaseUrl
            : GraphBetaUrl;
        var key = agent.AgentId.ToString();
        var client = GraphServiceClients.GetOrAdd(key, _ => CreateGraphServiceClient(agent, baseUrl));
        return client;
    }

    private GraphServiceClient GetAppGraphServiceClient(
        string tenantId, string? applicationId = null, string? baseUrl = null)
    {
        var key = applicationId + baseUrl;
        var certificateData = configuration.GetCertificateData();
        applicationId ??= configuration["GraphReadApplicationId"];

        var client = GraphServiceClients.GetOrAdd(key,
            _ => CreateGraphServiceClientWithCertificate(applicationId!, tenantId, certificateData!, baseUrl));
        return client;
    }

    /// <summary>
    /// Clears the cached GraphServiceClient for a specific agent.
    /// This can be useful when agent credentials change.
    /// </summary>
    private static void ClearCachedClient(Guid agentId)
    {
        if (GraphServiceClients.TryRemove(agentId.ToString(), out var client))
        {
            client.Dispose();
        }
    }

    /// <summary>
    /// Clears the cached GraphServiceClient for a specific agent.
    /// This can be useful when agent credentials change.
    /// </summary>
    private static void ClearCachedClient(string? applicationId = null, string? baseUrl = null)
    {
        var key = applicationId + baseUrl;
        if (GraphServiceClients.TryRemove(key, out var client))
        {
            client.Dispose();
        }
    }

    /// <summary>
    /// Clears all cached GraphServiceClient instances.
    /// </summary>
    public static void ClearAllCachedClients()
    {
        var clients = GraphServiceClients.Values.ToArray();
        GraphServiceClients.Clear();

        foreach (var client in clients)
        {
            client.Dispose();
        }
    }

    private GraphServiceClient CreateGraphServiceClient(AgentMetadata agent, string baseUrl)
    {
        var agentInstanceId = agent.AgentId.ToString();
        var tenantId = agent.TenantId.ToString();

        // Validate required configuration
        if (agent.AgentApplicationId == Guid.Empty || agent.TenantId == Guid.Empty || agent.AgentId == Guid.Empty)
        {
            throw new InvalidOperationException(
                "Agent configuration is required. Please provide AgentApplicationId and TenantId in the agent.");
        }

        // Check for certificate authentication configuration
        // This will be populated by KeyVault configuration provider
        var certificateData = configuration.GetCertificateData();

        if (!string.IsNullOrEmpty(certificateData))
        {
            if (!agent.SkipAgentIdAuth)
            {
                try
                {
                    return CreateGraphClientWithAgenticUserIdentity(agent, certificateData, baseUrl);
                }
                catch (Exception ex)
                {
                    logger.LogError(ex,
                        "Error in GraphServiceClientCreateGraphClientWithAgenticUserIdentity, trying older CreateGraphServiceClientWithCertificate instead");
                }
            }

            return CreateGraphServiceClientWithCertificate(agentInstanceId, tenantId, certificateData);
        }

        // Fall back to client secret authentication
        var clientSecret = configuration["AzureAd:ClientSecret"];
        if (string.IsNullOrEmpty(clientSecret))
        {
            throw new InvalidOperationException(
                "Azure AD configuration is required. Please provide either ClientSecret or Certificate (base64-encoded certificate data).");
        }

        logger.LogInformation("Using application authentication with client secret");

        var options = new ClientSecretCredentialOptions
        {
            AuthorityHost = AzureAuthorityHosts.AzurePublicCloud,
        };

        var clientSecretCredential = new ClientSecretCredential(
            tenantId,
            agentInstanceId,
            clientSecret,
            options);

        return new GraphServiceClient(clientSecretCredential);
    }

    private GraphServiceClient CreateGraphClientWithAgenticUserIdentity(
        AgentMetadata agent, string certificateData, string baseUrl)
    {
        try
        {
            var tokenCredential = new AgentTokenCredential(agentTokenHelper, agent, certificateData);
            return new GraphServiceClient(tokenCredential, baseUrl: baseUrl);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error creating GraphServiceClient with agentic user identity");
            throw;
        }
    }

    private GraphServiceClient CreateGraphServiceClientWithCertificate(
        string clientId, string tenantId, string certificateData, string? baseUrl = null)
    {
        try
        {
            var options = new ClientCertificateCredentialOptions
            {
                AuthorityHost = AzureAuthorityHosts.AzurePublicCloud,
            };

            logger.LogInformation("Using application authentication with certificate data from configuration");


            byte[] certificateBytes;
            try
            {
                certificateBytes = Convert.FromBase64String(certificateData);
            }
            catch (FormatException ex)
            {
                throw new InvalidOperationException("Certificate data must be a valid base64-encoded string", ex);
            }

            var certificate =
                X509CertificateLoader.LoadPkcs12(certificateBytes,
                    null);

            var clientCertificateCredential = new ClientCertificateCredential(
                tenantId,
                clientId,
                certificate,
                options);

            return new GraphServiceClient(clientCertificateCredential, baseUrl: baseUrl);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error creating GraphServiceClient with certificate authentication");
            throw;
        }
    }

    public async Task<User?> FindUserById(AgentMetadata agent, string userId, CancellationToken cancellationToken)
    {
        try
        {
            var graphClient = GetGraphServiceClient(agent);
            return await graphClient.Users[userId].GetAsync(cancellationToken: cancellationToken);
        }
        catch (Exception)
        {
            ClearCachedClient(agent.AgentId);
            throw;
        }
    }
/// <summary>
    /// Send a message to a specific Teams chat.
    /// </summary>
    /// <param name="agent">The agent metadata</param>
    /// <param name="chatId">The ID of the chat to send the message to</param>
    /// <param name="messageBody">The message content to send (HTML format)</param>
    /// <param name="cancellationToken">Cancellation token</param>
    /// <returns>The sent message</returns>
    public async Task<ChatMessage?> SendAdaptiveCardChatMessageAsync(
        AgentMetadata agent, string chatId, string cardJson, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(chatId)) throw new ArgumentException("Chat ID is required", nameof(chatId));
        if (string.IsNullOrEmpty(cardJson)) throw new ArgumentException("String representing JSON card is required", nameof(cardJson));
        try
        {
            var graphClient = GetGraphServiceClient(agent);
            var attachmentId = Guid.NewGuid().ToString();
            var chatMessage = new ChatMessage
            {
                // Body MUST contain an <attachment id="..."></attachment> marker that matches each attachment Id
                Body = new ItemBody { ContentType = BodyType.Html, Content = $"<attachment id=\"{attachmentId}\"></attachment>" },
                Attachments = new List<ChatMessageAttachment>
                {
                    new ChatMessageAttachment
                    {
                        Id = attachmentId,
                        ContentType = "application/vnd.microsoft.card.adaptive",
                        Content = cardJson
                    }
                }
            };
            logger.LogDebug("Attempting to send adaptive card to chat: {ChatId}", chatId);
            var sentMessage = await graphClient.Chats[chatId].Messages.PostAsync(chatMessage, cancellationToken: cancellationToken);
            logger.LogInformation("Successfully sent adaptive card to chat: {ChatId}, message ID: {MessageId}", chatId, sentMessage?.Id);
            return sentMessage;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error sending adaptive card to chat: {ChatId}", chatId);
            ClearCachedClient(agent.AgentId);
            throw;
        }
    }

    /// <summary>
    /// Updates an adaptive card message, optionally including a text message alongside the card.
    /// Note: Graph API supports updating both the card and message content in a single PATCH request.
    /// </summary>
    /// <param name="agent">The agent metadata</param>
    /// <param name="chatId">The ID of the chat</param>
    /// <param name="messageId">The ID of the message to update</param>
    /// <param name="updatedCardJson">The updated adaptive card JSON</param>
    /// <param name="messageText">Optional text message to display alongside the card (can be null or empty)</param>
    /// <param name="cancellationToken">Cancellation token</param>
    /// <returns>The updated message</returns>
    public async Task<ChatMessage?> UpdateAdaptiveCardChatMessageAsync(
        AgentMetadata agent, 
        string chatId, 
        string messageId, 
        string updatedCardJson,
        string? messageText = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(chatId)) throw new ArgumentException("Chat ID is required", nameof(chatId));
        if (string.IsNullOrEmpty(messageId)) throw new ArgumentException("Message ID is required", nameof(messageId));
        if (string.IsNullOrEmpty(updatedCardJson)) throw new ArgumentException("Updated card JSON is required", nameof(updatedCardJson));
        
        try
        {
            var graphClient = GetGraphServiceClient(agent);
            logger.LogDebug("Attempting to update adaptive card in message {MessageId} in chat: {ChatId}", messageId, chatId);
            
            var attachmentId = Guid.NewGuid().ToString();
            
            // Build body content - either with custom message text or just the attachment marker
            string bodyContent;
            if (!string.IsNullOrWhiteSpace(messageText))
            {
                // Include custom message text along with the attachment
                bodyContent = $"<attachment id=\"{attachmentId}\"></attachment><br/> {messageText}";
            }
            else
            {
                // Just the attachment marker
                bodyContent = $"<attachment id=\"{attachmentId}\"></attachment>";
            }
            
            var chatMessage = new ChatMessage
            {
                Body = new ItemBody 
                { 
                    ContentType = BodyType.Html, 
                    Content = bodyContent
                },
                Attachments = new List<ChatMessageAttachment>
                {
                    new ChatMessageAttachment
                    {
                        Id = attachmentId,
                        ContentType = "application/vnd.microsoft.card.adaptive",
                        Content = updatedCardJson
                    }
                }
            };
            
            var updatedMessage = await graphClient.Chats[chatId].Messages[messageId].PatchAsync(chatMessage, cancellationToken: cancellationToken);
            logger.LogDebug("Adaptive card updated successfully in chat: {ChatId}, message ID: {MessageId}", chatId, messageId);
            return updatedMessage;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Error updating adaptive card in message {MessageId} in chat: {ChatId}", messageId, chatId);
            ClearCachedClient(agent.AgentId);
            throw;
        }
    }

}