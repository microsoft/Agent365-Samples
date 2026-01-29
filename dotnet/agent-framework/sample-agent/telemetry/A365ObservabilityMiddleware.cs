// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Microsoft.Agents.A365.Observability.Hosting.Caching;
using Microsoft.Agents.A365.Observability.Hosting.Extensions;
using Microsoft.Agents.A365.Observability.Runtime.Common;
using Microsoft.Agents.A365.Runtime.Utils;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App.UserAuth;
using Microsoft.Agents.Core;
using System.Diagnostics;

namespace Agent365AgentFrameworkSampleAgent.telemetry
{
    /// <summary>
    /// Middleware that sets up A365 observability for each turn.
    /// This middleware:
    /// 1. Starts a parent activity (span) for the entire turn
    /// 2. Sets up baggage with agentId and tenantId for trace correlation
    /// 3. Registers observability token for the A365 exporter
    /// 4. Registers OnSendActivities callback to track outbound activities
    /// </summary>
    public class A365ObservabilityMiddleware : Microsoft.Agents.Builder.IMiddleware
    {
        private static readonly ActivitySource ActivitySource = new("A365.ObservabilityMiddleware");

        private readonly IExporterTokenCache<AgenticTokenStruct>? _agentTokenCache;
        private readonly ILogger<A365ObservabilityMiddleware> _logger;

        // Auth handler names - should match what's configured in the agent
        private const string AgenticAuthHandler = "agentic";
        private const string OboAuthHandler = "me";

        public A365ObservabilityMiddleware(
            IExporterTokenCache<AgenticTokenStruct>? agentTokenCache,
            ILogger<A365ObservabilityMiddleware> logger)
        {
            _agentTokenCache = agentTokenCache;
            _logger = logger;
        }

        public async Task OnTurnAsync(
            ITurnContext turnContext,
            NextDelegate next,
            CancellationToken cancellationToken = default)
        {
            // Start the parent activity for this turn
            using var turnActivity = ActivitySource.StartActivity("MiddlewareActivity", ActivityKind.Server);

            // Add initial turn context tags
            turnActivity?.SetTag("activity.type", turnContext.Activity.Type);
            turnActivity?.SetTag("channel.id", turnContext.Activity.ChannelId);
            turnActivity?.SetTag("conversation.id", turnContext.Activity.Conversation?.Id);
            turnActivity?.SetTag("agent.is_agentic", turnContext.IsAgenticRequest());

            try
            {
                // Resolve agent and tenant IDs
                string agentId = ResolveAgentId(turnContext);
                string tenantId = ResolveTenantId(turnContext);

                turnActivity?.SetTag("agent.id", agentId);
                turnActivity?.SetTag("tenant.id", tenantId);

                // Set up baggage scope - this flows to all child spans automatically via AsyncLocal
                using var baggageScope = new BaggageBuilder()
                    .TenantId(tenantId)
                    .AgentId(agentId)
                    .FromTurnContext(turnContext)
                    .Build();

                // Register observability token for the A365 exporter
                // Note: Full token registration requires UserAuthorization which is only available in the agent
                // This is a simplified version - see RegisterObservabilityTokenAsync for full implementation
                RegisterObservabilityTokenSync(agentId, tenantId, turnContext);

                // Track activities sent count for metrics
                int activitiesSentCount = 0;

                // Register OnSendActivities callback to track outbound activities
                turnContext.OnSendActivities(async (ctx, activities, nextSend) =>
                {
                    // Start a child activity for sending activities
                    // This will be a child of turnActivity if we're still inside RunStreamingAsync
                    // or a sibling if the agent call has completed
                    using var sendActivity = ActivitySource.StartActivity("MiddlewareSendActivityCallback", ActivityKind.Producer, parentId: turnActivity?.SpanId.ToString());

                    sendActivity?.SetTag("activities.count", activities.Count);

                    // Log each activity being sent
                    foreach (var activity in activities)
                    {
                        activitiesSentCount++;

                        sendActivity?.AddEvent(new ActivityEvent("ActivitySent", DateTimeOffset.UtcNow, new ActivityTagsCollection
                        {
                            { "activity.type", activity.Type },
                            { "activity.id", activity.Id },
                            { "text.length", activity.Text?.Length ?? 0 },
                            { "has_attachments", activity.Attachments?.Count > 0 }
                        }));

                        _logger.LogDebug(
                            "Sending activity: Type={Type}, Id={Id}, TextLength={TextLength}",
                            activity.Type,
                            activity.Id,
                            activity.Text?.Length ?? 0);
                    }

                    // Actually send the activities
                    var responses = await nextSend();

                    sendActivity?.SetTag("responses.count", responses.Length);

                    return responses;
                });

                // Continue to the next middleware or agent handler
                await next(cancellationToken);

                // Record success
                turnActivity?.SetStatus(ActivityStatusCode.Ok);
                turnActivity?.SetTag("activities.sent.total", activitiesSentCount);
            }
            catch (Exception ex)
            {
                // Record error
                turnActivity?.SetStatus(ActivityStatusCode.Error, ex.Message);
                turnActivity?.AddEvent(new ActivityEvent("Exception", DateTimeOffset.UtcNow, new ActivityTagsCollection
                {
                    { "exception.type", ex.GetType().FullName },
                    { "exception.message", ex.Message },
                    { "exception.stacktrace", ex.StackTrace }
                }));

                _logger.LogError(ex, "Error in A365ObservabilityMiddleware");
                throw;
            }
        }

        /// <summary>
        /// Resolves the agent ID from the turn context.
        /// For agentic requests, uses GetAgenticInstanceId.
        /// For non-agentic, uses the recipient's agentic app ID.
        /// </summary>
        private static string ResolveAgentId(ITurnContext turnContext)
        {
            if (turnContext.Activity.IsAgenticRequest())
            {
                return turnContext.Activity.GetAgenticInstanceId() ?? Guid.Empty.ToString();
            }

            // For non-agentic requests, try to get from recipient
            return turnContext.Activity.Recipient?.AgenticAppId ?? Guid.Empty.ToString();
        }

        /// <summary>
        /// Resolves the tenant ID from the turn context.
        /// </summary>
        private static string ResolveTenantId(ITurnContext turnContext)
        {
            return turnContext.Activity.Conversation?.TenantId
                ?? turnContext.Activity.Recipient?.TenantId
                ?? Guid.Empty.ToString();
        }

        /// <summary>
        /// Registers observability token synchronously (simplified version).
        /// Note: Full registration requires UserAuthorization which is only available in the agent.
        /// This method prepares the cache entry; the agent should call the full registration.
        /// </summary>
        private void RegisterObservabilityTokenSync(string agentId, string tenantId, ITurnContext turnContext)
        {
            try
            {
                // Note: Full token registration requires UserAuthorization and auth handler name
                // which are only available inside the AgentApplication.
                // This is a placeholder - the agent should call RegisterObservability with full params.
                _logger.LogDebug(
                    "Observability context prepared for AgentId={AgentId}, TenantId={TenantId}",
                    agentId,
                    tenantId);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to prepare observability context");
            }
        }

        /// <summary>
        /// Registers observability token with full authentication context.
        /// Call this from the agent handler where UserAuthorization is available.
        /// </summary>
        public async Task RegisterObservabilityTokenAsync(
            ITurnContext turnContext,
            UserAuthorization userAuthorization,
            string authHandlerName)
        {
            if (_agentTokenCache == null)
            {
                _logger.LogDebug("Agent token cache not available, skipping observability registration");
                return;
            }

            try
            {
                string agentId = ResolveAgentId(turnContext);
                string tenantId = ResolveTenantId(turnContext);

                // For non-agentic requests, resolve agent ID from token
                if (!turnContext.Activity.IsAgenticRequest() && userAuthorization != null)
                {
                    var token = await userAuthorization.GetTurnTokenAsync(turnContext, authHandlerName);
                    if (token != null)
                    {
                        agentId = Utility.ResolveAgentIdentity(turnContext, token) ?? agentId;
                    }
                }

                _agentTokenCache.RegisterObservability(
                    agentId,
                    tenantId,
                    new AgenticTokenStruct(
                        userAuthorization: userAuthorization,
                        turnContext: turnContext,
                        authHandlerName: authHandlerName),
                    EnvironmentUtils.GetObservabilityAuthenticationScope());

                _logger.LogDebug(
                    "Observability token registered for AgentId={AgentId}, TenantId={TenantId}",
                    agentId,
                    tenantId);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to register observability token");
            }
        }
    }
}
