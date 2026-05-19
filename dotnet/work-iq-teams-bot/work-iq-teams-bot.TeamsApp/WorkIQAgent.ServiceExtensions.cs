// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Azure.AI.OpenAI;
using Microsoft.Extensions.AI;
using Microsoft.Identity.Web;
using Microsoft.Identity.Web.TokenCacheProviders;
using Microsoft.Identity.Web.TokenCacheProviders.Distributed;
using Microsoft.OpenTelemetry;
using Microsoft.Teams.Apps.Diagnostics;
using Microsoft.Teams.Core.Diagnostics;
using OpenTelemetry;
using OpenTelemetry.Resources;
using System.ClientModel;

namespace work_iq_teams_bot.TeamsApp;

/// <summary>
/// Extension methods for registering the Agent, its dependencies, and the
/// custom <see cref="WorkIQTeamsBotApp"/> with DI.
/// </summary>
internal static class WorkIQServiceExtensions
{
    /// <summary>
    /// Registers <see cref="WorkIQTeamsBotApp"/>, <see cref="WorkIQAgent"/>, <see cref="IConversationHistoryStore"/>,
    /// <see cref="IMcpClientFactory"/>, and <see cref="IChatClient"/> with the service collection.
    /// </summary>
    public static IServiceCollection AddWorkIQAgent(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<WorkIQAgentOptions>(configuration.GetSection(WorkIQAgentOptions.SectionName));

        // Register the Agent Identities MSAL add-in so that WithAgentUserIdentity()
        // triggers the FIC (Federated Identity Credential) grant instead of falling
        // back to a silent token acquisition with mismatched client credentials.
        services.AddAgentIdentities();

        services.AddChatClient(sp =>
        {
            IConfiguration config = sp.GetRequiredService<IConfiguration>();
            string endpoint = config["AzureOpenAI:Endpoint"] ?? throw new InvalidOperationException("AzureOpenAI:Endpoint is required.");
            string apiKey = config["AzureOpenAI:ApiKey"] ?? throw new InvalidOperationException("AzureOpenAI:ApiKey is required.");
            string modelId = config["AzureOpenAI:ModelId"] ?? throw new InvalidOperationException("AzureOpenAI:ModelId is required.");

            return new AzureOpenAIClient(new Uri(endpoint), new ApiKeyCredential(apiKey))
                .GetChatClient(modelId)
                .AsIChatClient();
        })
        .UseFunctionInvocation()
        .UseOpenTelemetry(sourceName: "Experimental.Microsoft.Extensions.AI");

        services.AddScoped<WorkIQAgentMcpClientFactory>();

        // Conversation history must outlive any single turn -> singleton.
        services.AddSingleton<IConversationHistoryStore, InMemoryConversationHistoryStore>();

        // Agent is a per-turn execution unit; resolved from a fresh scope inside the bot handler.
        services.AddScoped<WorkIQAgent>();

        // Supply a distributed token cache so MSAL does not fall back to in-memory-only caching.
        // For production, replace AddDistributedMemoryCache with Redis/SQL Server.
        services.AddDistributedMemoryCache();
        services.AddSingleton<IMsalTokenCacheProvider, MsalDistributedTokenCacheAdapter>();

        string[] activitySources = [CoreTelemetryNames.ActivitySourceName, TeamsBotApplicationTelemetry.ActivitySourceName, "Experimental.Microsoft.Agents.AI", "ModelContextProtocol"];
        string[] meterNames = [CoreTelemetryNames.MeterName, TeamsBotApplicationTelemetry.MeterName, "Experimental.Microsoft.Agents.AI", "ModelContextProtocol"];

        services.AddOpenTelemetry()
            .ConfigureResource(r => r
                .AddService(serviceName: "WorkIQTeamsBot", serviceVersion: "0.0.1")
                .AddAttributes(new Dictionary<string, object>
                {
                    ["service.namespace"] = "TeamsSamples"
                }))
            .UseMicrosoftOpenTelemetry(o =>
            {
                o.Exporters = ExportTarget.Otlp | ExportTarget.AzureMonitor;
                o.Instrumentation.EnableHttpClientInstrumentation = true;
                o.Instrumentation.EnableAspNetCoreInstrumentation = true;
            })
            .WithTracing(t => t.AddSource(activitySources))
            .WithMetrics(m => m.AddMeter(meterNames));
        return services;
    }
}
