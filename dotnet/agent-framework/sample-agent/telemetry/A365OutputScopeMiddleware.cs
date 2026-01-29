// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.Agents.A365.Observability.Runtime.Tracing.Contracts;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Scopes;
using Microsoft.Agents.A365.Runtime.Utils;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Core;

namespace Agent365AgentFrameworkSampleAgent.telemetry
{
    /// <summary>
    /// Keys for storing observability context in turnContext.Services.
    /// </summary>
    public static class ObservabilityServiceKeys
    {
        /// <summary>
        /// Key for the current InvokeAgentScope span ID.
        /// Use this to retrieve the span ID in agent handlers for persistence.
        /// </summary>
        public const string InvokeAgentSpanId = "A365.Observability.InvokeAgentSpanId";

        /// <summary>
        /// Key for the current InvokeAgentScope trace ID.
        /// Use this to retrieve the trace ID in agent handlers for persistence.
        /// </summary>
        public const string InvokeAgentTraceId = "A365.Observability.InvokeAgentTraceId";

        /// <summary>
        /// Key for a persisted/restored parent span ID (for async scenarios).
        /// Set this in the agent handler when processing a proactive message
        /// to link OutputScope back to the original InvokeAgentScope.
        /// </summary>
        public const string PersistedParentSpanId = "A365.Observability.PersistedParentSpanId";

        /// <summary>
        /// Key for agent details resolved by middleware.
        /// </summary>
        public const string AgentDetails = "A365.Observability.AgentDetails";

        /// <summary>
        /// Key for tenant details resolved by middleware.
        /// </summary>
        public const string TenantDetails = "A365.Observability.TenantDetails";
    }

    /// <summary>
    /// Extension methods for accessing observability context from ITurnContext.Services.
    /// </summary>
    public static class ObservabilityContextExtensions
    {
        /// <summary>
        /// Gets the current InvokeAgentScope span ID.
        /// Use this in agent handlers to persist for async scenarios.
        /// </summary>
        /// <example>
        /// <code>
        /// // In agent handler - persist span ID for async processing
        /// var spanId = turnContext.GetInvokeAgentSpanId();
        /// await _storage.SaveAsync(new AsyncWorkItem { OriginalSpanId = spanId, ... });
        /// </code>
        /// </example>
        public static string? GetInvokeAgentSpanId(this ITurnContext turnContext)
            => turnContext.Services.Get<string>(ObservabilityServiceKeys.InvokeAgentSpanId);

        /// <summary>
        /// Gets the current InvokeAgentScope trace ID.
        /// Use this in agent handlers to persist for async scenarios.
        /// </summary>
        public static string? GetInvokeAgentTraceId(this ITurnContext turnContext)
            => turnContext.Services.Get<string>(ObservabilityServiceKeys.InvokeAgentTraceId);

        /// <summary>
        /// Sets a persisted parent span ID for async scenarios.
        /// Call this in proactive message handlers after retrieving the span ID from storage.
        /// The OutputScope will use this as its parent instead of the current InvokeAgentScope.
        /// </summary>
        /// <example>
        /// <code>
        /// // In background worker's proactive message callback
        /// await adapter.ContinueConversationAsync(reference, async (turnContext, ct) =>
        /// {
        ///     // Restore the original span ID from storage
        ///     var workItem = await _storage.GetAsync(workItemId);
        ///     turnContext.SetPersistedParentSpanId(workItem.OriginalSpanId);
        ///     
        ///     // Now OutputScope will use the original span as parent
        ///     await turnContext.SendActivityAsync("Here's your reminder!");
        /// });
        /// </code>
        /// </example>
        public static void SetPersistedParentSpanId(this ITurnContext turnContext, string? spanId)
        {
            if (!string.IsNullOrEmpty(spanId))
            {
                turnContext.Services.Set(ObservabilityServiceKeys.PersistedParentSpanId, spanId);
            }
        }

        /// <summary>
        /// Gets the parent span ID for OutputScope.
        /// Returns persisted span ID if set (async scenario), otherwise current InvokeAgentScope span ID.
        /// </summary>
        internal static string? GetOutputParentSpanId(this ITurnContext turnContext)
            => turnContext.Services.Get<string>(ObservabilityServiceKeys.PersistedParentSpanId)
            ?? turnContext.Services.Get<string>(ObservabilityServiceKeys.InvokeAgentSpanId);

        /// <summary>
        /// Gets agent details from Services (resolved by middleware).
        /// </summary>
        public static AgentDetails? GetAgentDetails(this ITurnContext turnContext)
            => turnContext.Services.Get<AgentDetails>(ObservabilityServiceKeys.AgentDetails);

        /// <summary>
        /// Gets tenant details from Services (resolved by middleware).
        /// </summary>
        public static TenantDetails? GetTenantDetails(this ITurnContext turnContext)
            => turnContext.Services.Get<TenantDetails>(ObservabilityServiceKeys.TenantDetails);
    }

    /// <summary>
    /// Middleware that sets up A365 observability scopes for each turn.
    /// 
    /// This middleware:
    /// 1. Starts an InvokeAgentScope for the entire turn
    /// 2. Stores the span ID in turnContext.Services for agent handlers to access and persist
    /// 3. Registers OnSendActivities callback that starts an OutputScope
    /// 4. OutputScope uses persisted span ID (if set by agent) or current InvokeAgentScope as parent
    /// 
    /// ## Usage in Agent Handler (Sync Scenario):
    /// ```csharp
    /// protected async Task OnMessageAsync(ITurnContext turnContext, ...)
    /// {
    ///     // Span ID is automatically available via Services
    ///     // OutputScope will automatically use InvokeAgentScope as parent
    ///     await turnContext.SendActivityAsync("Hello!");
    /// }
    /// ```
    /// 
    /// ## Usage in Agent Handler (Async Scenario - Scheduling):
    /// ```csharp
    /// protected async Task OnMessageAsync(ITurnContext turnContext, ...)
    /// {
    ///     // Get span ID to persist for later
    ///     var spanId = turnContext.GetInvokeAgentSpanId();
    ///     var traceId = turnContext.GetInvokeAgentTraceId();
    ///     
    ///     // Persist for async processing
    ///     await _storage.SaveAsync(new AsyncWorkItem
    ///     {
    ///         ConversationReference = turnContext.Activity.GetConversationReference(),
    ///         OriginalSpanId = spanId,
    ///         OriginalTraceId = traceId,
    ///         ScheduledFor = DateTime.UtcNow.AddDays(1)
    ///     });
    ///     
    ///     await turnContext.SendActivityAsync("I'll remind you tomorrow!");
    /// }
    /// ```
    /// 
    /// ## Usage in Proactive Message Handler (Background Worker):
    /// ```csharp
    /// await adapter.ContinueConversationAsync(reference, async (turnContext, ct) =>
    /// {
    ///     // Restore the original span ID from storage
    ///     var workItem = await _storage.GetAsync(workItemId);
    ///     turnContext.SetPersistedParentSpanId(workItem.OriginalSpanId);
    ///     
    ///     // Now OutputScope will use the original span as parent
    ///     await turnContext.SendActivityAsync("Here's your reminder!");
    /// });
    /// ```
    /// </summary>
    public class A365OutputScopeMiddleware : Microsoft.Agents.Builder.IMiddleware
    {
        private readonly ILogger<A365OutputScopeMiddleware> _logger;

        public A365OutputScopeMiddleware(ILogger<A365OutputScopeMiddleware> logger)
        {
            _logger = logger;
        }

        public async Task OnTurnAsync(
            ITurnContext turnContext,
            NextDelegate next,
            CancellationToken cancellationToken = default)
        {
            // Resolve agent and tenant details
            var agentDetails = ResolveAgentDetails(turnContext);
            var tenantDetails = ResolveTenantDetails(turnContext);

            // Store in Services for agent handlers to access
            turnContext.Services.Set(ObservabilityServiceKeys.AgentDetails, agentDetails);
            turnContext.Services.Set(ObservabilityServiceKeys.TenantDetails, tenantDetails);

            var invokeAgentDetails = new InvokeAgentDetails(
                details: agentDetails,
                sessionId: turnContext.Activity.Conversation?.Id);

            // Start the InvokeAgentScope for this turn
            using var invokeScope = InvokeAgentScope.Start(
                invokeAgentDetails: invokeAgentDetails,
                tenantDetails: tenantDetails,
                conversationId: turnContext.Activity.Conversation?.Id);

            // Store span ID and trace ID in Services for agent handlers to access
            // Agent can retrieve these to persist for async scenarios
            if (invokeScope != null)
            {
                turnContext.Services.Set(ObservabilityServiceKeys.InvokeAgentSpanId, invokeScope.Id);
                turnContext.Services.Set(ObservabilityServiceKeys.InvokeAgentTraceId, invokeScope.TraceId);

                _logger.LogDebug(
                    "InvokeAgentScope started: SpanId={SpanId}, TraceId={TraceId}",
                    invokeScope.Id,
                    invokeScope.TraceId);
            }

            try
            {
                // Record input message if present
                if (!string.IsNullOrEmpty(turnContext.Activity.Text))
                {
                    invokeScope?.RecordInputMessages([turnContext.Activity.Text]);
                }

                // Register OnSendActivities callback to track outbound activities with OutputScope
                turnContext.OnSendActivities(async (ctx, activities, nextSend) =>
                {
                    // Collect output messages from activities
                    var outputMessages = activities
                        .Where(a => !string.IsNullOrEmpty(a.Text))
                        .Select(a => a.Text!)
                        .ToArray();

                    // Get the parent span ID:
                    // 1. If agent set a persisted span ID (async scenario), use that
                    // 2. Otherwise, use the current InvokeAgentScope's span ID
                    var parentSpanId = ctx.GetOutputParentSpanId();

                    // Get agent/tenant details from Services (stored earlier in this turn)
                    var storedAgentDetails = ctx.GetAgentDetails() ?? agentDetails;
                    var storedTenantDetails = ctx.GetTenantDetails() ?? tenantDetails;

                    _logger.LogDebug(
                        "OutputScope starting: ParentSpanId={ParentSpanId}, MessageCount={Count}, IsPersistedParent={IsPersisted}",
                        parentSpanId,
                        outputMessages.Length,
                        ctx.Services.Get<string>(ObservabilityServiceKeys.PersistedParentSpanId) != null);

                    // Start OutputScope with the resolved parent span ID
                    using var outputScope = OutputScope.Start(
                        agentDetails: storedAgentDetails,
                        tenantDetails: storedTenantDetails,
                        outputMessages: outputMessages,
                        parentId: parentSpanId,
                        conversationId: ctx.Activity.Conversation?.Id);

                    foreach (var activity in activities)
                    {
                        _logger.LogDebug(
                            "OutputScope: Sending activity Type={Type}, Id={Id}, TextLength={TextLength}",
                            activity.Type,
                            activity.Id,
                            activity.Text?.Length ?? 0);
                    }

                    // Actually send the activities
                    var responses = await nextSend();

                    return responses;
                });

                // Continue to the next middleware or agent handler
                await next(cancellationToken);

                _logger.LogDebug("InvokeAgentScope completed successfully");
            }
            catch (Exception ex)
            {
                // Record error on the InvokeAgentScope
                invokeScope?.RecordError(ex);

                _logger.LogError(ex, "Error in A365OutputScopeMiddleware");
                throw;
            }
        }

        /// <summary>
        /// Resolves agent details from the turn context.
        /// </summary>
        private static AgentDetails ResolveAgentDetails(ITurnContext turnContext)
        {
            string agentId;
            if (turnContext.Activity.IsAgenticRequest())
            {
                agentId = turnContext.Activity.GetAgenticInstanceId() ?? Guid.Empty.ToString();
            }
            else
            {
                agentId = turnContext.Activity.Recipient?.AgenticAppId ?? Guid.Empty.ToString();
            }

            return new AgentDetails(
                agentId: agentId,
                agentName: turnContext.Activity.Recipient?.Name);
        }

        /// <summary>
        /// Resolves tenant details from the turn context.
        /// </summary>
        private static TenantDetails ResolveTenantDetails(ITurnContext turnContext)
        {
            var tenantIdString = turnContext.Activity.Conversation?.TenantId
                ?? turnContext.Activity.Recipient?.TenantId;

            if (Guid.TryParse(tenantIdString, out var tenantGuid))
            {
                return new TenantDetails(tenantGuid);
            }

            return new TenantDetails(Guid.Empty);
        }
    }
}
