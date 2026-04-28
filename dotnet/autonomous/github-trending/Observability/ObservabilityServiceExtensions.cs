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
    // Registers S2S token cache, ObservabilityTokenService (if credentials are present),
    // and Agent365ObservabilityContext.
    // Config is written by `a365 setup all` under the Agent365Observability section.
    // When Agent365Observability credentials are missing, the agent still runs — spans are
    // emitted to the console exporter but not exported to the A365 service.
    public static IServiceCollection AddAgent365Observability(this IServiceCollection services)
    {
        services.AddSingleton<IExporterTokenCache<string>, ServiceTokenCache>();

        services.AddSingleton<Agent365ObservabilityContext>(sp =>
        {
            var obs = sp.GetRequiredService<IConfiguration>().GetSection("Agent365Observability");
            var agentDetails = new AgentDetails(
                agentId:          obs["AgentId"]          ?? "local-dev",
                agentName:        obs["AgentName"]        ?? "github-trending",
                agentDescription: obs["AgentDescription"] ?? "",
                agentBlueprintId: obs["AgentBlueprintId"] ?? "",
                tenantId:         obs["TenantId"]         ?? "local-dev");
            return new Agent365ObservabilityContext(agentDetails);
        });

        // Only start the background token service when the required credentials are configured.
        // Without these, the agent runs fine — observability spans go to the console exporter only.
        services.AddSingleton<ObservabilityTokenService>();
        services.AddHostedService(sp =>
        {
            var obs = sp.GetRequiredService<IConfiguration>().GetSection("Agent365Observability");
            var useManagedIdentity = bool.TryParse(obs["UseManagedIdentity"], out var parsedUseManagedIdentity)
                && parsedUseManagedIdentity;

            var hasCommonCredentials = !string.IsNullOrEmpty(obs["TenantId"])
                                    && !string.IsNullOrEmpty(obs["AgentId"])
                                    && !string.IsNullOrEmpty(obs["ClientId"])
                                    && !obs["TenantId"]!.StartsWith("<<");

            var hasClientSecret = !string.IsNullOrEmpty(obs["ClientSecret"])
                               && !obs["ClientSecret"]!.StartsWith("<<");

            var hasCredentials = hasCommonCredentials
                              && (useManagedIdentity || hasClientSecret);

            if (!hasCredentials)
            {
                var logger = sp.GetRequiredService<ILogger<ObservabilityTokenService>>();
                logger.LogWarning(
                    "Agent365Observability credentials not configured — skipping token service. " +
                    "Run 'a365 setup all' to enable A365 observability export.");
            }

            return new OptionalHostedService(
                hasCredentials ? sp.GetRequiredService<ObservabilityTokenService>() : null);
        });

        return services;
    }

    // Wrapper that conditionally starts a hosted service, allowing graceful skip.
    private sealed class OptionalHostedService(IHostedService? inner) : IHostedService
    {
        public Task StartAsync(CancellationToken ct) => inner?.StartAsync(ct) ?? Task.CompletedTask;
        public Task StopAsync(CancellationToken ct) => inner?.StopAsync(ct) ?? Task.CompletedTask;
    }
}
