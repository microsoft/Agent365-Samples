// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Microsoft.Agents.A365.Observability.Caching;
using Microsoft.Agents.A365.Observability.Runtime.Common;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.State;
using Microsoft.Identity.Client;

namespace Agent365AgentFrameworkSampleAgent.telemetry
{
    public static class A365OtelWrapper
    {
        public static async Task InvokeObservedAgentOperation(
            string operationName,
            ITurnContext turnContext,
            ITurnState turnState,
            IExporterTokenCache<string>? serviceTokenCache,
            IConfiguration? configuration,
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
                        // Acquire a client credentials token for the observability endpoint.
                        var clientId = configuration?["Connections:ServiceConnection:Settings:ClientId"] ?? string.Empty;
                        var clientSecret = configuration?["Connections:ServiceConnection:Settings:ClientSecret"] ?? string.Empty;
                        var authority = configuration?["Connections:ServiceConnection:Settings:AuthorityEndpoint"] ?? string.Empty;
                        var observabilityScope = "https://api.powerplatform.com/.default";

                        var cca = ConfidentialClientApplicationBuilder
                            .Create(clientId)
                            .WithClientSecret(clientSecret)
                            .WithAuthority(authority)
                            .Build();

                        var tokenResult = await cca.AcquireTokenForClient(new[] { observabilityScope }).ExecuteAsync();
                        var token = tokenResult.AccessToken;

                        serviceTokenCache?.RegisterObservability(agentId, tenantId, token, new[] { observabilityScope });
                    }
                    catch (Exception ex)
                    {
                        logger?.LogWarning(ex, "There was an error registering for observability: {Message}", ex.Message);
                    }

                    // Invoke the actual operation.
                    await func().ConfigureAwait(false);
                }).ConfigureAwait(false);
        }
    }
}
