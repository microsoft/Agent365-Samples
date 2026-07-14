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

        (string agentId, string tenantId) = await ResolveTenantAndAgentId(turnContext, authSystem, authHandlerName, logger);
        var observabilityScopes = EnvironmentUtils.GetObservabilityAuthenticationScope();

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
                    "Observability token exchange failed: agentId={AgentId} tenantId={TenantId} authHandler={AuthHandler}",
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
        ForceInvokeAgentServerPortTag(invokeAgentScope, telemetryContext);
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
            RecordInvokeAgentOutputMessage(invokeAgentScope, outputMessage);
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

    private static void RecordInvokeAgentOutputMessage(InvokeAgentScope invokeAgentScope, string? outputMessage)
    {
        var outputMessages = GetInvokeAgentOutputMessages(outputMessage);
        if (outputMessages.Length > 0)
        {
            invokeAgentScope.RecordOutputMessages(outputMessages);
        }
    }

    private static string[] GetInvokeAgentOutputMessages(string? outputMessage) =>
        string.IsNullOrWhiteSpace(outputMessage) ? [] : [outputMessage];

    internal static string[] GetInvokeAgentOutputMessagesForTest(string? outputMessage) =>
        GetInvokeAgentOutputMessages(outputMessage);

    private static void ForceInvokeAgentServerPortTag(
        InvokeAgentScope invokeAgentScope,
        Agent365TelemetryContext telemetryContext)
    {
        invokeAgentScope.SetTagMaybe("server.port", telemetryContext.ToServerPortAttribute());
    }

    private static InvokeAgentScope StartInvokeAgentScope(
        ITurnContext turnContext,
        Agent365TelemetryContext telemetryContext)
    {
        var agentDetails = telemetryContext.ToAgentDetails();
        var request = telemetryContext.ToRequest(content: turnContext.Activity.Text);
        var callerDetails = telemetryContext.ToCallerDetails();

        var scopeDetails = new InvokeAgentScopeDetails(
            endpoint: TryCreateEndpoint(turnContext.Activity.ServiceUrl) ?? telemetryContext.ToInvokeEndpoint());

        return InvokeAgentScope.Start(
            request: request,
            scopeDetails: scopeDetails,
            agentDetails: agentDetails,
            callerDetails: callerDetails);
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

        string agentId = "";
        if (turnContext.Activity.IsAgenticRequest())
        {
            agentId = turnContext.Activity.GetAgenticInstanceId();
        }
        else
        {
            if (authSystem != null && !string.IsNullOrEmpty(authHandlerName))
            {
                try
                {
                    agentId = Utility.ResolveAgentIdentity(turnContext, await authSystem.GetTurnTokenAsync(turnContext, authHandlerName));
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger?.LogWarning(
                        ex,
                        "Observability identity resolution failed; falling back to turn context and configured Agent365Observability values.");
                }
            }
        }

        string? tempTenantId = turnContext.Activity?.Conversation?.TenantId ?? turnContext.Activity?.Recipient?.TenantId;
        string tenantId = tempTenantId ?? string.Empty;

        return (agentId, tenantId);
    }
}
