// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.ServiceDiscovery;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace PerplexitySampleAgent.telemetry;

public static class AgentOTELExtensions
{
    private const string HealthEndpointPath = "/health";
    private const string AlivenessEndpointPath = "/alive";

    public static TBuilder ConfigureOpenTelemetry<TBuilder>(this TBuilder builder) where TBuilder : IHostApplicationBuilder
    {
        builder.Logging.AddOpenTelemetry(logging =>
        {
            logging.IncludeFormattedMessage = true;
            logging.IncludeScopes = true;
        });

        builder.Services.AddOpenTelemetry()
            .ConfigureResource(r => r
                .Clear()
                .AddService(
                    serviceName: "A365.Perplexity",
                    serviceVersion: "1.0.0",
                    serviceInstanceId: Environment.MachineName)
                .AddAttributes(new Dictionary<string, object>
                {
                    ["deployment.environment"] = builder.Environment.EnvironmentName,
                    ["service.namespace"] = "Microsoft.Agents"
                }))
            .WithMetrics(metrics =>
            {
                metrics.AddAspNetCoreInstrumentation()
                    .AddHttpClientInstrumentation()
                    .AddRuntimeInstrumentation()
                    .AddMeter("agent.messages.processed",
                        "agent.routes.executed",
                        "agent.conversations.active",
                        "agent.route.execution.duration",
                        "agent.message.processing.duration");
            })
            .WithTracing(tracing =>
            {
                tracing.AddSource(builder.Environment.ApplicationName)
                    .AddSource(
                        "A365.Perplexity",
                        "Microsoft.Agents.Builder",
                        "Microsoft.Agents.Hosting",
                        "A365.Perplexity.MyAgent",
                        "Microsoft.AspNetCore",
                        "System.Net.Http"
                    )
                    .AddAspNetCoreInstrumentation(tracing =>
                    {
                        tracing.Filter = context =>
                            !context.Request.Path.StartsWithSegments(HealthEndpointPath)
                            && !context.Request.Path.StartsWithSegments(AlivenessEndpointPath);
                        tracing.RecordException = true;
                        tracing.EnrichWithHttpRequest = (activity, request) =>
                        {
                            activity.SetTag("http.request.body.size", request.ContentLength);
                            activity.SetTag("user_agent", request.Headers.UserAgent);
                        };
                        tracing.EnrichWithHttpResponse = (activity, response) =>
                        {
                            activity.SetTag("http.response.body.size", response.ContentLength);
                        };
                    })
                    .AddHttpClientInstrumentation(o =>
                    {
                        o.RecordException = true;
                        o.EnrichWithHttpRequestMessage = (activity, request) =>
                        {
                            activity.SetTag("http.request.method", request.Method);
                            activity.SetTag("http.request.host", request.RequestUri?.Host);
                            activity.SetTag("http.request.useragent", request.Headers?.UserAgent);
                        };
                        o.EnrichWithHttpResponseMessage = (activity, response) =>
                        {
                            activity.SetTag("http.response.status_code", (int)response.StatusCode);
                            var headerList = response.Content?.Headers?
                                .Select(h => $"{h.Key}={string.Join(",", h.Value)}")
                                .ToArray();
                            if (headerList is { Length: > 0 })
                            {
                                activity.SetTag("http.response.headers", headerList);
                            }
                        };
                        o.FilterHttpRequestMessage = request =>
                            !request.RequestUri?.AbsolutePath.Contains("health", StringComparison.OrdinalIgnoreCase) ?? true;
                    });
            });

        var useOtlpExporter = !string.IsNullOrWhiteSpace(builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]);
        if (useOtlpExporter)
        {
            builder.Services.AddOpenTelemetry().UseOtlpExporter();
        }

        builder.Services.AddHealthChecks()
            .AddCheck("self", () => HealthCheckResult.Healthy(), ["live"]);

        builder.Services.AddServiceDiscovery();

        builder.Services.ConfigureHttpClientDefaults(http =>
        {
            http.AddStandardResilienceHandler();
            http.AddServiceDiscovery();
        });

        return builder;
    }
}
