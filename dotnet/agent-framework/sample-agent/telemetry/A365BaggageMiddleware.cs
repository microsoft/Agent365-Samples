// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.Agents.A365.Observability.Hosting.Extensions;
using Microsoft.Agents.A365.Observability.Runtime.Common;
using Microsoft.Agents.A365.Runtime.Utils;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Core;

namespace Agent365AgentFrameworkSampleAgent.telemetry
{
    /// <summary>
    /// Lightweight middleware that sets up A365 baggage for each turn.
    /// This middleware only sets up baggage with agentId and tenantId for trace correlation.
    /// </summary>
    public class A365BaggageMiddleware : Microsoft.Agents.Builder.IMiddleware
    {
        private readonly ILogger<A365BaggageMiddleware> _logger;

        public A365BaggageMiddleware(ILogger<A365BaggageMiddleware> logger)
        {
            _logger = logger;
        }

        public async Task OnTurnAsync(
            ITurnContext turnContext,
            NextDelegate next,
            CancellationToken cancellationToken = default)
        {
            // Resolve agent and tenant IDs
            string agentId = ResolveAgentId(turnContext);
            string tenantId = ResolveTenantId(turnContext);

            _logger.LogDebug(
                "Setting baggage for AgentId={AgentId}, TenantId={TenantId}",
                agentId,
                tenantId);

            // Set up baggage scope - this flows to all child spans automatically via AsyncLocal
            using var baggageScope = new BaggageBuilder()
                .TenantId(tenantId)
                .AgentId(agentId)
                .FromTurnContext(turnContext)
                .Build();

            // Continue to the next middleware or agent handler
            await next(cancellationToken);
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
    }
}
