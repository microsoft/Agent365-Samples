// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.Agents.A365.Observability.Runtime.Tracing.Contracts;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Scopes;
using System.Text.RegularExpressions;

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
        var resolvedToolCallId = ResolveToolCallId(toolName, toolCallId);

        using var scope = ExecuteToolScope.Start(
            request: context.ToRequest(conversationId: conversationId, channelName: channelId),
            details: new ToolCallDetails(
                toolName: toolName,
                argumentsObject: ToSerializableArguments(arguments),
                toolCallId: resolvedToolCallId,
                toolType: ToolType.Function,
                endpoint: endpoint,
                toolServerName: toolServerName),
            agentDetails: context.ToAgentDetails());

        try
        {
            var result = await invokeAsync().ConfigureAwait(false);
            scope.RecordResponse(RedactSensitiveResult(toolName, result));
            return result;
        }
        catch (OperationCanceledException)
        {
            scope.RecordCancellation();
            throw;
        }
        catch (Exception ex)
        {
            scope.RecordError(ex);
            throw;
        }
    }

    private static string ResolveToolCallId(string toolName, string? toolCallId)
    {
        return !string.IsNullOrWhiteSpace(toolCallId)
            ? toolCallId
            : $"{toolName}-{Guid.NewGuid():N}";
    }

    private static Dictionary<string, object> ToSerializableArguments(
        IDictionary<string, object?> arguments)
    {
        return arguments.ToDictionary(
            pair => pair.Key,
            pair => RedactSensitiveArgument(pair.Key, pair.Value),
            StringComparer.Ordinal);
    }

    private static object RedactSensitiveArgument(string key, object? value)
    {
        if (!string.Equals(key, "text", StringComparison.OrdinalIgnoreCase))
        {
            return value!;
        }

        var length = value?.ToString()?.Length ?? 0;
        return $"<redacted text; length={length}>";
    }

    private static string RedactSensitiveResult(string toolName, string result)
    {
        if (string.Equals(toolName, "take_screenshot", StringComparison.OrdinalIgnoreCase))
        {
            return "<redacted screenshot result>";
        }

        return Regex.Replace(
            result,
            @"data:image\/[^""\s]+",
            "data:image/redacted;base64,<redacted>",
            RegexOptions.IgnoreCase);
    }
}
