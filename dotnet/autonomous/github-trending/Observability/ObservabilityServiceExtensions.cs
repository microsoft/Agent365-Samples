// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.Agents.A365.Observability.Hosting.Caching;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace GitHubTrending;

// Injectable singleton wrapping AgentDetails for single-tenant agents.
// Pass ctx.AgentDetails to InvokeAgentScope.Start() for span attributes.
public sealed class Agent365ObservabilityContext
{
    public AgentDetails AgentDetails { get; }
    internal Agent365ObservabilityContext(AgentDetails d) => AgentDetails = d;
}

public static class ObservabilityServiceExtensions
{
    // Registers S2S token cache, ObservabilityTokenService, and Agent365ObservabilityContext.
    // Config is written by `a365 setup all` under the Agent365Observability section.
    public static IServiceCollection AddAgent365Observability(this IServiceCollection services)
    {
        services.AddSingleton<IExporterTokenCache<string>, ServiceTokenCache>();
        services.AddHostedService<ObservabilityTokenService>();
        services.AddSingleton<Agent365ObservabilityContext>(sp =>
        {
            var obs = sp.GetRequiredService<IConfiguration>().GetSection("Agent365Observability");
            var agentDetails = new AgentDetails(
                agentId:          obs["AgentId"],
                agentName:        obs["AgentName"],
                agentDescription: obs["AgentDescription"],
                agentBlueprintId: obs["AgentBlueprintId"],
                tenantId:         obs["TenantId"]
                    ?? throw new InvalidOperationException("Agent365Observability:TenantId is required."));
            return new Agent365ObservabilityContext(agentDetails);
        });
        return services;
    }
}
