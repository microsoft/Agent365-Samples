// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.ServiceDiscovery;
using Microsoft.Identity.Abstractions;
using Microsoft.Identity.Web;
using Microsoft.OpenTelemetry;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace Microsoft.Extensions.Hosting;

// Adds common Aspire services: service discovery, resilience, health checks, and OpenTelemetry.
// This project should be referenced by each service project in your solution.
// To learn more about using this project, see https://aka.ms/dotnet/aspire/service-defaults
public static class Extensions
{
    private const string HealthEndpointPath = "/health";
    private const string AlivenessEndpointPath = "/alive";

    public static TBuilder AddServiceDefaults<TBuilder>(
        this TBuilder builder,
        string[]? activitySources = null,
        string[]? meterNames = null,
        Func<IServiceProvider>? rootProviderAccessor = null) where TBuilder : IHostApplicationBuilder
    {
        builder.ConfigureOpenTelemetry(activitySources, meterNames, rootProviderAccessor);

        builder.AddDefaultHealthChecks();

        builder.Services.AddServiceDiscovery();

        builder.Services.ConfigureHttpClientDefaults(http =>
        {
            // Turn on resilience by default
            http.AddStandardResilienceHandler();

            // Turn on service discovery by default
            http.AddServiceDiscovery();
        });

        return builder;
    }

    public static TBuilder ConfigureOpenTelemetry<TBuilder>(
        this TBuilder builder,
        string[]? activitySources = null,
        string[]? meterNames = null,
        Func<IServiceProvider>? rootProviderAccessor = null) where TBuilder : IHostApplicationBuilder
    {
        builder.Logging.AddOpenTelemetry(logging =>
        {
            logging.IncludeFormattedMessage = true;
            logging.IncludeScopes = true;
        });

        builder.Services.AddOpenTelemetry()
            .ConfigureResource(r => r
                .AddService(
                    serviceName: builder.Environment.ApplicationName,
                    serviceVersion: "0.0.1")
                .AddAttributes(new Dictionary<string, object>
                {
                    ["service.namespace"] = "TeamsSamples"
                }))
            .UseMicrosoftOpenTelemetry(o =>
            {
                o.Exporters = ExportTarget.Otlp | ExportTarget.AzureMonitor | ExportTarget.Agent365;
                o.Instrumentation.EnableHttpClientInstrumentation = true;
                o.Instrumentation.EnableAspNetCoreInstrumentation = true;
                o.Agent365.Exporter.UseS2SEndpoint = true;
                if (rootProviderAccessor is not null)
                {
                    o.Agent365.Exporter.TokenResolver = async (agentId, tenantId) =>
                    {
                        var provider = rootProviderAccessor().GetRequiredService<IAuthorizationHeaderProvider>();
                        var options = new AuthorizationHeaderProviderOptions { AcquireTokenOptions = new() { AuthenticationOptionsName = "AzureAd", Tenant = tenantId } };
                        options.WithAgentIdentity(agentId);
                        var token = await provider.CreateAuthorizationHeaderForAppAsync(
                            "api://9b975845-388f-4429-889e-eab1ef63949c/.default", options);
                        return token.Substring("Bearer".Length).Trim();
                    };
                }
            })
            .WithMetrics(metrics =>
            {
                metrics.AddAspNetCoreInstrumentation()
                    .AddHttpClientInstrumentation()
                    .AddRuntimeInstrumentation();

                if (meterNames is { Length: > 0 })
                {
                    metrics.AddMeter(meterNames);
                }
            })
            .WithTracing(tracing =>
            {
                tracing.AddSource(builder.Environment.ApplicationName)
                    .AddAspNetCoreInstrumentation(options =>
                        // Exclude health check requests from tracing
                        options.Filter = context =>
                            !context.Request.Path.StartsWithSegments(HealthEndpointPath)
                            && !context.Request.Path.StartsWithSegments(AlivenessEndpointPath)
                    )
                    .AddHttpClientInstrumentation(options =>
                    {
                        // Suppress known-noisy spans from Agent365 MCP service endpoints.
                        // GET (SSE listener) returns 405 and DELETE (session teardown) returns 500
                        // due to server-side issues. See docs/mcp-service-http-errors.md.
                        options.FilterHttpRequestMessage = request =>
                        {
                            if (request.RequestUri?.Host is "agent365.svc.cloud.microsoft"
                                && request.RequestUri.AbsolutePath.StartsWith("/agents/servers/", StringComparison.OrdinalIgnoreCase))
                            {
                                return request.Method != HttpMethod.Get
                                    && request.Method != HttpMethod.Delete;
                            }

                            return true;
                        };
                    });

                if (activitySources is { Length: > 0 })
                {
                    tracing.AddSource(activitySources);
                }
            });

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
}
