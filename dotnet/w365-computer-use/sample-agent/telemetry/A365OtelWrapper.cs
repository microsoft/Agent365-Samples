// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.Agents.A365.Observability.Caching;
using Microsoft.Agents.A365.Observability.Runtime.Common;
using Microsoft.Agents.A365.Runtime.Utils;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App.UserAuth;
using Microsoft.Agents.Builder.State;
using W365ComputerUseSample.Telemetry;

namespace W365ComputerUseSample;

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
        Func<Task> func)
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
                catch (Exception ex) when (ex is ArgumentException || ex is InvalidOperationException)
                {
                    logger?.LogWarning("There was an error registering for observability: {Message}", ex.Message);
                }

                await func().ConfigureAwait(false);
            }).ConfigureAwait(false);
    }

    private static async Task<(string agentId, string tenantId)> ResolveTenantAndAgentId(ITurnContext turnContext, UserAuthorization authSystem, string authHandlerName)
    {
        string agentId = "";
        if (turnContext?.Activity?.IsAgenticRequest() == true)
        {
            agentId = turnContext.Activity.GetAgenticInstanceId();
        }
        else if (authSystem != null && !string.IsNullOrEmpty(authHandlerName) && turnContext != null)
        {
            agentId = Utility.ResolveAgentIdentity(turnContext, await authSystem.GetTurnTokenAsync(turnContext, authHandlerName));
        }

        if (string.IsNullOrEmpty(agentId)) agentId = Guid.Empty.ToString();
        string? tempTenantId = turnContext?.Activity?.Conversation?.TenantId ?? turnContext?.Activity?.Recipient?.TenantId;
        string tenantId = tempTenantId ?? Guid.Empty.ToString();

        return (agentId, tenantId);
    }
}
