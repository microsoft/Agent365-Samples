// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.Agents.A365.Observability.Runtime.Tracing.Exporters;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.OpenTelemetry;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Agent365.Samples.Observability;

namespace W365ComputerUseSample.Telemetry;

public static class ObservabilityServiceCollectionExtensions
{
    public static IServiceCollection AddW365ComputerUseOpenTelemetry(
        this IServiceCollection services,
        IConfiguration configuration,
        AsyncAuthTokenResolver? observabilityTokenResolver)
    {
        var agent365ExporterEnabled = ObservabilityAppTokenFactory.IsAgent365ExporterEnabled(configuration);
        services.AddOpenTelemetry()
            .ConfigureResource(resource => resource.AddService("W365ComputerUseSample"))
            .UseMicrosoftOpenTelemetry(options =>
            {
                options.Exporters = agent365ExporterEnabled ? ExportTarget.Agent365 : (ExportTarget)0;
                if (configuration.GetValue<bool>("EnableOpenTelemetryConsoleExporter"))
                {
                    options.Exporters |= ExportTarget.Console;
                }

                options.Agent365.ClusterCategory = "production";
                if (agent365ExporterEnabled)
                {
                    options.Agent365.UseS2SEndpoint = true;
                    options.Agent365.TokenResolver = observabilityTokenResolver
                        ?? throw new InvalidOperationException("Agent365 exporter is enabled but the OBS token resolver was not configured.");
                }
                options.Instrumentation.EnableHttpClientInstrumentation = true;
                options.Instrumentation.EnableAspNetCoreInstrumentation = true;
                options.Instrumentation.EnableAgent365Instrumentation = true;
            })
            .WithTracing(tracing => tracing.AddSource(AgentMetrics.SourceName))
            .WithMetrics(metrics => metrics.AddMeter(AgentMetrics.SourceName));

        if (agent365ExporterEnabled)
        {
            services.Configure<Agent365ExporterOptions>(options =>
            {
                options.ClusterCategory = "production";
                options.UseS2SEndpoint = true;
                options.TokenResolver = observabilityTokenResolver
                    ?? throw new InvalidOperationException("Agent365 exporter is enabled but the OBS token resolver was not configured.");
            });
        }

        return services;
    }
}
