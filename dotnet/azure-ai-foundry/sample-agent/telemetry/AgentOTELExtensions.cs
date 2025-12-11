// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.ServiceDiscovery;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace AzureAIFoundrySampleAgent.Telemetry
{
    // Adds common Aspire services: service discovery, resilience, health checks, and OpenTelemetry.
    // This can be used by ASP.NET Core apps, Azure Functions, and other .NET apps using the Generic Host.
    // This allows you to use the local aspire desktop and monitor Agents SDK operations.
    // To learn more about using the local aspire desktop, see https://learn.microsoft.com/en-us/dotnet/aspire/fundamentals/dashboard/standalone?tabs=bash
    public static class AgentOTELExtensions
    {
        private const string HealthEndpointPath = "/health";
        private const string AlivenessEndpointPath = "/alive";

        public static TBuilder AddServiceDefaults<TBuilder>(this TBuilder builder) where TBuilder : IHostApplicationBuilder
        {
            builder.ConfigureOpenTelemetry();

            builder.AddDefaultHealthChecks();

            builder.Services.AddServiceDiscovery();

            builder.Services.ConfigureHttpClientDefaults(http =>
            {
                // Turn on resilience by default
                http.AddStandardResilienceHandler();

                // Turn on service discovery by default
                http.AddServiceDiscovery();
            });

            // Uncomment the following to restrict the allowed schemes for service discovery.
            // builder.Services.Configure<ServiceDiscoveryOptions>(options =>
            // {
            //     options.AllowedSchemes = ["https"];
            // });

            return builder;
        }

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
                    serviceName: "A365.AzureAIFoundry",
                    serviceVersion: "1.0",
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
                            "A365.AzureAIFoundry",
                            "Microsoft.Agents.Builder",
                            "Microsoft.Agents.Hosting",
                            "A365.AzureAIFoundry.MyAgent",
                            "Microsoft.AspNetCore",
                            "System.Net.Http"
                        )
                        .AddAspNetCoreInstrumentation(tracing =>
                        {
                            // Exclude health check requests from tracing
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
                        // Uncomment the following line to enable gRPC instrumentation (requires the OpenTelemetry.Instrumentation.GrpcNetClient package)
                        //.AddGrpcClientInstrumentation()
                        .AddHttpClientInstrumentation(o =>
                        {
                            o.RecordException = true;
                            // Enrich outgoing request/response with extra tags
                            o.EnrichWithHttpRequestMessage = (activity, request) =>
                            {
                                activity.SetTag("http.request.method", request.Method);
                                activity.SetTag("http.request.host", request.RequestUri?.Host);
                                activity.SetTag("http.request.useragent", request.Headers?.UserAgent);
                            };
                            o.EnrichWithHttpResponseMessage = (activity, response) =>
                            {
                                activity.SetTag("http.response.status_code", (int)response.StatusCode);
                                //activity.SetTag("http.response.headers", response.Content.Headers);
                                // Convert response.Content.Headers to a string array: "HeaderName=val1,val2"
                                var headerList = response.Content?.Headers?
                                    .Select(h => $"{h.Key}={string.Join(",", h.Value)}")
                                    .ToArray();

                                if (headerList is { Length: > 0 })
                                {
                                    // Set as an array tag (preferred for OTEL exporters supporting array-of-primitive attributes)
                                    activity.SetTag("http.response.headers", headerList);

                                    // (Optional) Also emit individual header tags (comment out if too high-cardinality)
                                    // foreach (var h in response.Content.Headers)
                                    // {
                                    //     activity.SetTag($"http.response.header.{h.Key.ToLowerInvariant()}", string.Join(",", h.Value));
                                    // }
                                }

                            };
                            // Example filter: suppress telemetry for health checks
                            o.FilterHttpRequestMessage = request =>
                                !request.RequestUri?.AbsolutePath.Contains("health", StringComparison.OrdinalIgnoreCase) ?? true;
                        })
                        // Add console exporter for development/debugging
                        .AddConsoleExporter();
                });

            //builder.AddOpenTelemetryExporters();
            return builder;
        }

        public static TBuilder AddDefaultHealthChecks<TBuilder>(this TBuilder builder) where TBuilder : IHostApplicationBuilder
        {
            builder.Services.AddHealthChecks()
                // Add a default liveness check to ensure app is responsive
                .AddCheck("self", () => HealthCheckResult.Healthy(), ["live"]);

            return builder;
        }

        public static WebApplication MapDefaultEndpoints(this WebApplication app)
        {
            // Adding health checks endpoints to applications in non-development environments has security implications.
            // See https://aka.ms/dotnet/aspire/healthchecks for details before enabling these endpoints in non-development environments.
            if (app.Environment.IsDevelopment())
            {
                // All health checks must pass for app to be considered ready to accept traffic after starting
                app.MapHealthChecks(HealthEndpointPath);

                // Only health checks tagged with the "live" tag must pass for app to be considered alive
                app.MapHealthChecks(AlivenessEndpointPath, new HealthCheckOptions
                {
                    Predicate = r => r.Tags.Contains("live")
                });
            }

            return app;
        }

        private static TBuilder AddOpenTelemetryExporters<TBuilder>(this TBuilder builder) where TBuilder : IHostApplicationBuilder
        {
            var useOtlpExporter = !string.IsNullOrWhiteSpace(builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]);

            if (useOtlpExporter)
            {
                builder.Services.AddOpenTelemetry().UseOtlpExporter();
            }

            // Uncomment the following lines to enable the Azure Monitor exporter (requires the Azure.Monitor.OpenTelemetry.AspNetCore package)
            //if (!string.IsNullOrEmpty(builder.Configuration["APPLICATIONINSIGHTS_CONNECTION_STRING"]))
            //{
            //    builder.Services.AddOpenTelemetry()
            //       .UseAzureMonitor();
            //}

            return builder;
        }

    }
}
