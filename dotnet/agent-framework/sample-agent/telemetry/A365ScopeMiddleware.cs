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
    /// Middleware that sets up A365 observability scopes for each turn.
    /// This middleware:
    /// 1. Starts an InvokeAgentScope for the entire turn
    /// 2. Starts an OutputScope within OnSendActivities callback
    /// 3. Sets the InvokeAgentScope as the OutputScope's parent
    /// 4. Populates OutputScope with messages being sent
    /// </summary>
    public class A365ScopeMiddleware : Microsoft.Agents.Builder.IMiddleware
    {
        private readonly ILogger<A365ScopeMiddleware> _logger;

        public A365ScopeMiddleware(ILogger<A365ScopeMiddleware> logger)
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
            var invokeAgentDetails = new InvokeAgentDetails(
                details: agentDetails,
                sessionId: turnContext.Activity.Conversation?.Id);

            // Start the InvokeAgentScope for this turn
            using var invokeScope = InvokeAgentScope.Start(
                invokeAgentDetails: invokeAgentDetails,
                tenantDetails: tenantDetails,
                conversationId: turnContext.Activity.Conversation?.Id);

            // Capture the InvokeAgentScope's span ID to use as parent for OutputScope
            string? parentSpanId = invokeScope?.Id;

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

                    // Start OutputScope with InvokeAgentScope as parent
                    using var outputScope = OutputScope.Start(
                        agentDetails: agentDetails,
                        tenantDetails: tenantDetails,
                        outputMessages: outputMessages,
                        parentId: parentSpanId,
                        conversationId: turnContext.Activity.Conversation?.Id);

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

                _logger.LogError(ex, "Error in A365ScopeMiddleware");
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
