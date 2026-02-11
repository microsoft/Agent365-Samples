// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Microsoft.Agents.A365.Observability.Caching;
using Microsoft.Agents.A365.Observability.Runtime.Common;
using Microsoft.Agents.A365.Runtime.Utils;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App.UserAuth;
using Microsoft.Agents.Builder.State;
using Microsoft.Extensions.Logging;
using System;
using System.Threading.Tasks;

namespace Agent365TaskPersonalizationSampleAgent.telemetry
{
    public static class A365OtelWrapper
    {
        public static async Task InvokeObservedAgentOperation(
            string operationName,
            ITurnContext turnContext,
            ITurnState turnState,
            IExporterTokenCache<AgenticTokenStruct>? agentTokenCache,
            UserAuthorization authSystem,
            string authHandlerName,
            ILogger? logger,
            Func<Task> func
            )
        {
            // Wrap the operation with AgentSDK observability.
            await AgentMetrics.InvokeObservedAgentOperation(
                operationName,
                turnContext,
                async () =>
                {
                    // Resolve the tenant and agent id being used to communicate with A365 services. 
                    (string agentId, string tenantId) = await ResolveTenantAndAgentId(turnContext, authSystem, authHandlerName);

                    using var baggageScope = new BaggageBuilder()
                    .TenantId(tenantId)
                    .AgentId(agentId)
                    .Build();

                    try
                    {
                        agentTokenCache?.RegisterObservability(agentId, tenantId, new AgenticTokenStruct
                        {
                            UserAuthorization = authSystem,
                            TurnContext = turnContext,
                            AuthHandlerName = authHandlerName
                        }, EnvironmentUtils.GetObservabilityAuthenticationScope());
                    }
                    catch (Exception ex)
                    {
                        logger?.LogWarning($"There was an error registering for observability: {ex.Message}");
                    }

                    // Invoke the actual operation.
                    await func().ConfigureAwait(false);
                }).ConfigureAwait(false);
        }

        /// <summary>
        /// Resolve Tenant and Agent Id from the turn context.
        /// </summary>
        /// <param name="turnContext"></param>
        /// <returns></returns>
        private static async Task<(string agentId, string tenantId)> ResolveTenantAndAgentId(ITurnContext turnContext, UserAuthorization authSystem, string authHandlerName)
        {
            string agentId = "";
            if (turnContext.Activity.IsAgenticRequest())
            {
                agentId = turnContext.Activity.GetAgenticInstanceId();
            }
            else
            {
                if (authSystem != null && !string.IsNullOrEmpty(authHandlerName))
                    agentId = Utility.ResolveAgentIdentity(turnContext, await authSystem.GetTurnTokenAsync(turnContext, authHandlerName));
            }
            agentId = agentId ?? Guid.Empty.ToString();
            string? tempTenantId = turnContext?.Activity?.Conversation?.TenantId ?? turnContext?.Activity?.Recipient?.TenantId;
            string tenantId = tempTenantId ?? Guid.Empty.ToString();

            return (agentId, tenantId);
        }

    }
}
