// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.Agents.A365.Observability;
using Microsoft.Agents.A365.Observability.Extensions.AgentFramework;
using Microsoft.Agents.A365.Observability.Runtime;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using W365ComputerUseSample.Telemetry;

namespace W365ComputerUseSample;

public static class ServiceExtensions
{
    public static void ConfigureOpenTelemetry(this WebApplicationBuilder builder)
    {
        builder.Services.AddOpenTelemetry()
            .ConfigureResource(resource => resource.AddService("W365ComputerUseSample"))
            .WithTracing(tracing =>
            {
                tracing
                    .AddSource(AgentMetrics.SourceName)
                    .AddAspNetCoreInstrumentation()
                    .AddHttpClientInstrumentation();

                // Console exporter removed — dumps a full Activity block per HTTP request and
                // swamped the console during bring-up. Re-add locally if you need trace output.
            })
            .WithMetrics(metrics =>
            {
                metrics
                    .AddMeter(AgentMetrics.SourceName)
                    .AddAspNetCoreInstrumentation()
                    .AddHttpClientInstrumentation()
                    .AddRuntimeInstrumentation();
            });
    }
}
