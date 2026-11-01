// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.Agents.A365.Observability.Runtime.Common;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Scopes;
using Microsoft.Agents.A365.Runtime.Utils;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App.UserAuth;
using Microsoft.Agents.Builder.State;
using System.Text.RegularExpressions;
using W365ComputerUseSample.Telemetry;

namespace W365ComputerUseSample;

public static class A365OtelWrapper
{
    private static readonly Regex HandoffCodeQueryParameter = new(
        @"(?<prefix>[?&]hc=)[^&\s\)]+",
        RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    public static Task InvokeObservedAgentOperation(
        string operationName,
        ITurnContext turnContext,
        ITurnState turnState,
        CancellationToken cancellationToken,
        Agent365TelemetryOptions? telemetryOptions,
        UserAuthorization authSystem,
        string authHandlerName,
        ILogger? logger,
        Func<Task> func)
    {
        ArgumentNullException.ThrowIfNull(func);

        Func<Task<string?>> outputHandler = async () =>
        {
            await func().ConfigureAwait(false);
            return null;
        };

        return InvokeObservedAgentOperation(
            operationName,
            turnContext,
            turnState,
            cancellationToken,
            telemetryOptions,
            authSystem,
            authHandlerName,
            logger,
            outputHandler);
    }

    public static async Task InvokeObservedAgentOperation(
        string operationName,
        ITurnContext turnContext,
        ITurnState turnState,
        CancellationToken cancellationToken,
        Agent365TelemetryOptions? telemetryOptions,
        UserAuthorization authSystem,
        string authHandlerName,
        ILogger? logger,
        Func<Task<string?>> func)
    {
        await AgentMetrics.InvokeObservedAgentOperation(
            operationName,
            turnContext,
            async () =>
            {
                (string agentId, string tenantId) = await ResolveTenantAndAgentId(turnContext, authSystem, authHandlerName);
                var telemetryContext = Agent365TelemetryContext.FromTurnContext(
                    turnContext,
                    agentId,
                    tenantId,
                    telemetryOptions);

                using var baggageScope = telemetryContext.BuildBaggageScope();
                using var invokeAgentScope = InvokeAgentScope.Start(
                    telemetryContext.ToRequest(turnContext.Activity.Text),
                    telemetryContext.ToInvokeEndpoint(),
                    telemetryContext.ToAgentDetails(),
                    telemetryContext.ToCallerDetails());
                invokeAgentScope.SetTagMaybe("server.port", telemetryContext.ToServerPortAttribute());

                try
                {
                    var outputMessage = await func().ConfigureAwait(false);
                    if (!string.IsNullOrWhiteSpace(outputMessage))
                    {
                        outputMessage = RedactTelemetryOutput(outputMessage);
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
            }).ConfigureAwait(false);
    }

    private static string RedactTelemetryOutput(string outputMessage) =>
        HandoffCodeQueryParameter.Replace(
            TelemetryContentPolicy.RedactModelPayload(outputMessage),
            "${prefix}<redacted>");

    private static async Task<(string agentId, string tenantId)> ResolveTenantAndAgentId(ITurnContext turnContext, UserAuthorization authSystem, string authHandlerName)
    {
        ArgumentNullException.ThrowIfNull(turnContext);

        string? agentId = null;
        if (turnContext.Activity.IsAgenticRequest())
        {
            agentId = turnContext.Activity.GetAgenticInstanceId();
        }
        else if (authSystem != null && !string.IsNullOrEmpty(authHandlerName))
        {
            agentId = Utility.ResolveAgentIdentity(turnContext, await authSystem.GetTurnTokenAsync(turnContext, authHandlerName));
        }

        if (string.IsNullOrEmpty(agentId))
        {
            agentId = Guid.Empty.ToString();
        }

        string tenantId = turnContext.Activity?.Conversation?.TenantId
            ?? turnContext.Activity?.Recipient?.TenantId
            ?? Guid.Empty.ToString();

        return (agentId, tenantId);
    }
}
