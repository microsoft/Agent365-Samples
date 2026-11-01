// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.Agents.A365.Observability.Runtime.Tracing.Contracts;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Scopes;

namespace W365ComputerUseSample.Telemetry;

public static class ToolTelemetry
{
    public static async Task<string> InvokeAsync(
        string toolName,
        IDictionary<string, object?> arguments,
        string? toolCallId,
        string toolServerName,
        Uri? endpoint,
        string? conversationId,
        string? channelId,
        Func<Task<string>> invokeAsync)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(toolName);
        ArgumentNullException.ThrowIfNull(arguments);
        ArgumentException.ThrowIfNullOrWhiteSpace(toolServerName);
        ArgumentNullException.ThrowIfNull(invokeAsync);

        var context = Agent365TelemetryContext.FromCurrentActivity(
            conversationIdOverride: conversationId,
            channelNameOverride: channelId);
        var details = new ToolCallDetails(
            toolName: toolName,
            argumentsObject: ToStructuredTelemetryArguments(arguments),
            toolCallId: ResolveToolCallId(toolName, toolCallId),
            description: null,
            toolType: ToolType.Function,
            endpoint: endpoint,
            toolServerName: toolServerName);
        var scope = TryStartScope(context, details, conversationId, channelId);

        try
        {
            var result = await invokeAsync().ConfigureAwait(false);
            RecordResponse(scope, TelemetryContentPolicy.RedactToolResult(toolName, result));
            return result;
        }
        catch (OperationCanceledException)
        {
            RecordCancellation(scope);
            throw;
        }
        catch (Exception exception)
        {
            RecordError(scope, toolName, exception);
            throw;
        }
        finally
        {
            DisposeScope(scope);
        }
    }

    private static ExecuteToolScope? TryStartScope(
        Agent365TelemetryContext context,
        ToolCallDetails details,
        string? conversationId,
        string? channelId)
    {
        try
        {
            return ExecuteToolScope.Start(
                context.ToRequest(conversationId: conversationId, channelName: channelId),
                details,
                context.ToAgentDetails());
        }
        catch (InvalidOperationException)
        {
            return null;
        }
    }

    private static void RecordResponse(ExecuteToolScope? scope, string result)
    {
        if (scope is null)
        {
            return;
        }

        try
        {
            scope.RecordResponse(result);
        }
        catch (InvalidOperationException)
        {
        }
    }

    private static void RecordCancellation(ExecuteToolScope? scope)
    {
        if (scope is null)
        {
            return;
        }

        try
        {
            scope.RecordCancellation();
        }
        catch (InvalidOperationException)
        {
        }
    }

    private static void RecordError(ExecuteToolScope? scope, string toolName, Exception exception)
    {
        if (scope is null)
        {
            return;
        }

        try
        {
            scope.RecordError(new InvalidOperationException(
                TelemetryContentPolicy.RedactToolResult(toolName, exception.Message)));
        }
        catch (InvalidOperationException)
        {
        }
    }

    private static void DisposeScope(ExecuteToolScope? scope)
    {
        if (scope is null)
        {
            return;
        }

        try
        {
            scope.Dispose();
        }
        catch (InvalidOperationException)
        {
        }
    }

    private static string ResolveToolCallId(string toolName, string? toolCallId) =>
        !string.IsNullOrWhiteSpace(toolCallId)
            ? toolCallId
            : $"{toolName}-{Guid.NewGuid():N}";

    private static IDictionary<string, object> ToStructuredTelemetryArguments(
        IDictionary<string, object?> arguments) =>
        TelemetryContentPolicy.RedactToolArguments(arguments).ToDictionary(
            pair => pair.Key,
            pair => pair.Value ?? string.Empty,
            StringComparer.Ordinal);
}
