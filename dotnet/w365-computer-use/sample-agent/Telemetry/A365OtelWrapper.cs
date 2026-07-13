// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.Agents.A365.Observability.Hosting.Caching;
using Microsoft.Agents.A365.Observability.Runtime.Common;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Contracts;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Scopes;
using Microsoft.Agents.A365.Runtime.Utils;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App.UserAuth;
using Microsoft.Agents.Builder.State;
using W365ComputerUseSample.Telemetry;

namespace W365ComputerUseSample;

public static class A365OtelWrapper
{
    public static Task InvokeObservedAgentOperation(
        string operationName,
        ITurnContext turnContext,
        ITurnState turnState,
        IExporterTokenCache<AgenticTokenStruct>? agentTokenCache,
        ServiceTokenCache? serviceTokenCache,
        Agent365TelemetryOptions? telemetryOptions,
        UserAuthorization authSystem,
        string authHandlerName,
        ILogger? logger,
        Func<Task> func)
    {
        ArgumentNullException.ThrowIfNull(func);

        return InvokeObservedAgentOperation(
            operationName,
            turnContext,
            turnState,
            agentTokenCache,
            serviceTokenCache,
            telemetryOptions,
            authSystem,
            authHandlerName,
            logger,
            async () =>
            {
                await func().ConfigureAwait(false);
                return null;
            });
    }

    public static async Task InvokeObservedAgentOperation(
        string operationName,
        ITurnContext turnContext,
        ITurnState turnState,
        IExporterTokenCache<AgenticTokenStruct>? agentTokenCache,
        ServiceTokenCache? serviceTokenCache,
        Agent365TelemetryOptions? telemetryOptions,
        UserAuthorization authSystem,
        string authHandlerName,
        ILogger? logger,
        Func<Task<string?>> func)
    {
        ArgumentNullException.ThrowIfNull(func);

        (string agentId, string tenantId) = await ResolveTenantAndAgentId(
            turnContext,
            authSystem,
            authHandlerName,
            logger).ConfigureAwait(false);

        var telemetryContext = Agent365TelemetryContext.FromTurnContext(
            turnContext,
            agentId,
            tenantId,
            telemetryOptions);
        var exportAgentId = telemetryContext.AgentId ?? Guid.Empty.ToString();
        var exportTenantId = telemetryContext.TenantId ?? Guid.Empty.ToString();

        using var baggageScope = telemetryContext.BuildBaggageScope();

        if (!string.IsNullOrWhiteSpace(authHandlerName))
        {
            var observabilityScopes = EnvironmentUtils.GetObservabilityAuthenticationScope();

            try
            {
                var token = await authSystem.ExchangeTurnTokenAsync(
                    turnContext,
                    authHandlerName,
                    null!,
                    observabilityScopes,
                    default).ConfigureAwait(false);

                if (!string.IsNullOrEmpty(token))
                {
                    serviceTokenCache?.RegisterObservability(
                        exportAgentId,
                        exportTenantId,
                        token,
                        observabilityScopes);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger?.LogError(
                    ex,
                    "Observability token exchange or service-cache registration failed for agent {AgentId}, tenant {TenantId}, and auth handler {AuthHandler}.",
                    exportAgentId,
                    exportTenantId,
                    authHandlerName);
            }

            try
            {
                if (agentTokenCache is AgenticTokenCache agenticTokenCache)
                {
                    agenticTokenCache.InvalidateToken(exportAgentId, exportTenantId);
                }

                agentTokenCache?.RegisterObservability(
                    exportAgentId,
                    exportTenantId,
                    new AgenticTokenStruct(authSystem, turnContext, authHandlerName, null),
                    observabilityScopes);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger?.LogWarning(
                    ex,
                    "Observability agent-cache registration failed for agent {AgentId}, tenant {TenantId}, and auth handler {AuthHandler}.",
                    exportAgentId,
                    exportTenantId,
                    authHandlerName);
            }
        }

        using var invokeAgentScope = StartInvokeAgentScope(turnContext, telemetryContext);
        invokeAgentScope.SetTagMaybe("server.port", telemetryContext.ToServerPortAttribute());
        string? outputMessage = null;

        try
        {
            await AgentMetrics.InvokeObservedAgentOperation(
                operationName,
                turnContext,
                async () =>
                {
                    outputMessage = await func().ConfigureAwait(false);
                }).ConfigureAwait(false);

            if (!string.IsNullOrWhiteSpace(outputMessage))
            {
                invokeAgentScope.RecordOutputMessages([outputMessage]);
            }
        }
        catch (OperationCanceledException)
        {
            invokeAgentScope.RecordCancellation();
            throw;
        }
        catch (Exception ex)
        {
            invokeAgentScope.RecordError(ex);
            throw;
        }
    }

    private static InvokeAgentScope StartInvokeAgentScope(
        ITurnContext turnContext,
        Agent365TelemetryContext telemetryContext)
    {
        var scopeDetails = new InvokeAgentScopeDetails(
            endpoint: TryCreateEndpoint(turnContext.Activity.ServiceUrl) ?? telemetryContext.ToInvokeEndpoint());

        return InvokeAgentScope.Start(
            request: telemetryContext.ToRequest(turnContext.Activity.Text),
            scopeDetails: scopeDetails,
            agentDetails: telemetryContext.ToAgentDetails(),
            callerDetails: telemetryContext.ToCallerDetails());
    }

    private static Uri? TryCreateEndpoint(string? serviceUrl)
    {
        return Uri.TryCreate(serviceUrl, UriKind.Absolute, out var endpoint)
            ? endpoint
            : null;
    }

    private static async Task<(string agentId, string tenantId)> ResolveTenantAndAgentId(
        ITurnContext turnContext,
        UserAuthorization authSystem,
        string authHandlerName,
        ILogger? logger)
    {
        ArgumentNullException.ThrowIfNull(turnContext);

        string agentId = string.Empty;
        if (turnContext.Activity.IsAgenticRequest())
        {
            agentId = turnContext.Activity.GetAgenticInstanceId();
        }
        else if (!string.IsNullOrEmpty(authHandlerName))
        {
            try
            {
                var token = await authSystem.GetTurnTokenAsync(turnContext, authHandlerName).ConfigureAwait(false);
                agentId = Utility.ResolveAgentIdentity(turnContext, token);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger?.LogWarning(
                    ex,
                    "Observability identity resolution failed; falling back to turn context and configured Agent365 observability values.");
            }
        }

        var tenantId = turnContext.Activity.Conversation?.TenantId
            ?? turnContext.Activity.Recipient?.TenantId
            ?? string.Empty;

        return (agentId, tenantId);
    }
}
