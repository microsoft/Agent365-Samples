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

namespace W365ComputerUseSample.Telemetry;

public static class ObservabilityServiceCollectionExtensions
{
    public static IServiceCollection AddW365ComputerUseOpenTelemetry(
        this IServiceCollection services,
        IConfiguration configuration,
        AsyncAuthTokenResolver observabilityTokenResolver)
    {
        services.AddOpenTelemetry()
            .ConfigureResource(resource => resource.AddService("W365ComputerUseSample"))
            .UseMicrosoftOpenTelemetry(options =>
            {
                options.Exporters = ExportTarget.Agent365;
                if (configuration.GetValue<bool>("EnableOpenTelemetryConsoleExporter"))
                {
                    options.Exporters |= ExportTarget.Console;
                }

                options.Agent365.ClusterCategory = "production";
                options.Agent365.UseS2SEndpoint = true;
                options.Agent365.TokenResolver = observabilityTokenResolver;
                options.Instrumentation.EnableHttpClientInstrumentation = true;
                options.Instrumentation.EnableAspNetCoreInstrumentation = true;
                options.Instrumentation.EnableAgent365Instrumentation = true;
            })
            .WithTracing(tracing => tracing.AddSource(AgentMetrics.SourceName))
            .WithMetrics(metrics => metrics.AddMeter(AgentMetrics.SourceName));

        services.Configure<Agent365ExporterOptions>(options =>
        {
            options.ClusterCategory = "production";
            options.UseS2SEndpoint = true;
            options.TokenResolver = observabilityTokenResolver;
        });

        return services;
    }
}
