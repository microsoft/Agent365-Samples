// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Microsoft.Agents.A365.Observability.Caching;
using Microsoft.Agents.A365.Observability.Runtime.Common;
using Microsoft.Agents.Authentication;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.State;

namespace Agent365AgentFrameworkSampleAgent.telemetry
{
    public static class A365OtelWrapper
    {
        public static async Task InvokeObservedAgentOperation(
            string operationName,
            ITurnContext turnContext,
            ITurnState turnState,
            IExporterTokenCache<string>? serviceTokenCache,
            IAccessTokenProvider? fmiTokenProvider,
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
                    // Resolve agent and tenant IDs from the turn context.
                    string rawAgentId = turnContext?.Activity?.Recipient?.Id ?? Guid.Empty.ToString();
                    // Strip Teams bot framework prefix (e.g. "28:") to get the raw GUID
                    string agentId = rawAgentId.Contains(':') ? rawAgentId.Substring(rawAgentId.IndexOf(':') + 1) : rawAgentId;
                    string tenantId = turnContext?.Activity?.Conversation?.TenantId
                                   ?? turnContext?.Activity?.Recipient?.TenantId
                                   ?? Guid.Empty.ToString();

                    using var baggageScope = new BaggageBuilder()
                    .TenantId(tenantId)
                    .AgentId(agentId)
                    .Build();

                    try
                    {
                        // Acquire a Power Platform token via the BlueprintFmiTokenProvider.
                        var observabilityScope = "https://api.powerplatform.com/.default";
                        var token = await fmiTokenProvider!.GetAccessTokenAsync(
                            "https://api.powerplatform.com",
                            new List<string> { observabilityScope });

                        serviceTokenCache?.RegisterObservability(agentId, tenantId, token, new[] { observabilityScope });
                    }
                    catch (Exception ex)
                    {
                        logger?.LogWarning(ex, "[A365Otel] Error registering for observability: {Message}", ex.Message);
                    }

                    // Invoke the actual operation.
                    await func().ConfigureAwait(false);
                }).ConfigureAwait(false);
        }
    }
}
