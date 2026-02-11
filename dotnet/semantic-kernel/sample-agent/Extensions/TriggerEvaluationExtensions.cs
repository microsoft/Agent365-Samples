// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System;
using Agent365SemanticKernelSampleAgent.Services.TriggerEvaluation;
using Microsoft.Agents.A365.Tooling.Utils;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Agent365SemanticKernelSampleAgent.Extensions;

/// <summary>
/// Extension methods for registering trigger evaluation services.
///
/// Design Principles:
/// - DIP: All services registered against interfaces
/// - OCP: Configuration via Options pattern allows customization without modification
/// - SRP: Each service has a single responsibility
/// </summary>
public static class TriggerEvaluationExtensions
{
    /// <summary>
    /// Adds trigger evaluation services to the service collection.
    ///
    /// Services registered:
    /// - <see cref="ITriggerEvaluationService"/> - Evaluates events against trigger definitions via MCP tool
    /// - <see cref="INotificationEventExtractor"/> - Extracts event data from notifications
    /// - <see cref="IInstructionSanitizer"/> - Sanitizes instructions for prompt injection
    ///
    /// Authentication:
    /// - Uses SDK's UserAuthorization mechanism (same as MCP tools)
    ///
    /// Environment Variables:
    /// - MCP_PLATFORM_ENDPOINT - The MCP Platform endpoint URL (falls back to production URL if not set)
    /// </summary>
    /// <param name="services">The service collection.</param>
    /// <param name="configuration">The configuration for reading settings.</param>
    /// <returns>The service collection for chaining.</returns>
    public static IServiceCollection AddTriggerEvaluation(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);

        // Configure options using the Options pattern (DIP, OCP)
        services.Configure<TriggerEvaluationOptions>(options =>
        {
            // Bind from configuration section
            configuration.GetSection(TriggerEvaluationOptions.SectionName).Bind(options);

            // Apply MCP Platform base URL - use configured value or fall back to utility
            options.McpPlatformBaseUrl ??= Utility.GetMcpBaseUrl(configuration);
        });

        // Register core services as Singleton to match MyAgent's lifetime
        services.AddSingleton<ITriggerEvaluationService, TriggerEvaluationService>();
        services.AddSingleton<INotificationEventExtractor, NotificationEventExtractor>();

        // Register instruction sanitizer (OCP - configurable patterns)
        services.AddSingleton<IInstructionSanitizer>(sp =>
        {
            var options = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<TriggerEvaluationOptions>>().Value;
            return new DefaultInstructionSanitizer(options);
        });

        return services;
    }

    /// <summary>
    /// Adds trigger evaluation services with default configuration.
    /// Prefer the overload with IConfiguration for production use.
    /// </summary>
    public static IServiceCollection AddTriggerEvaluation(this IServiceCollection services)
    {
        // Read MCP Platform endpoint from environment variable with production fallback
        // Note: Prefer using the overload with IConfiguration which uses Utility.GetMcpPlatformBaseUrl
        var mcpPlatformEndpoint = Environment.GetEnvironmentVariable("MCP_PLATFORM_ENDPOINT");

        // Register with default configuration
        services.Configure<TriggerEvaluationOptions>(options =>
        {
            options.McpPlatformBaseUrl = mcpPlatformEndpoint;
        });

        services.AddSingleton<ITriggerEvaluationService, TriggerEvaluationService>();
        services.AddSingleton<INotificationEventExtractor, NotificationEventExtractor>();

        services.AddSingleton<IInstructionSanitizer>(sp =>
        {
            var options = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<TriggerEvaluationOptions>>().Value;
            return new DefaultInstructionSanitizer(options);
        });

        return services;
    }
}
