// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Microsoft.Agents.A365.Observability.Caching;
using Microsoft.Agents.A365.Observability.Runtime.Common;
using Microsoft.Agents.A365.Runtime.Utils;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App.UserAuth;
using Microsoft.Agents.Builder.State;

namespace Agent365CopilotStudioSampleAgent.telemetry
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
            await AgentMetrics.InvokeObservedAgentOperation(
                operationName,
                turnContext,
                async () =>
                {
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
                        logger?.LogWarning(ex, "There was an error registering for observability.");
                    }

                    await func().ConfigureAwait(false);
                }).ConfigureAwait(false);
        }

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
