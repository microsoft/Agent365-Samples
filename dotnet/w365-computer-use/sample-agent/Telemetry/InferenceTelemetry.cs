// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.Agents.A365.Observability.Runtime.Tracing.Contracts;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Scopes;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace W365ComputerUseSample.Telemetry;

public static class InferenceTelemetry
{
    public static async Task<string> InvokeAsync(
        string requestBody,
        string modelName,
        string providerName,
        Func<Task<string>> sendAsync)
    {
        ArgumentNullException.ThrowIfNull(requestBody);
        ArgumentNullException.ThrowIfNull(sendAsync);

        var redactedRequestBody = RedactSensitivePayloads(requestBody);
        var telemetryContext = Agent365TelemetryContext.FromCurrentActivity();

        using var scope = InferenceScope.Start(
            request: telemetryContext.ToRequest(content: redactedRequestBody),
            details: new InferenceCallDetails(
                operationName: InferenceOperationType.Chat,
                model: modelName,
                providerName: providerName),
            agentDetails: telemetryContext.ToAgentDetails());

        scope.RecordInputMessages([redactedRequestBody]);

        try
        {
            var responseBody = await sendAsync().ConfigureAwait(false);
            var metadata = ReadResponseMetadata(responseBody);

            if (metadata.OutputMessages.Length > 0)
            {
                scope.RecordOutputMessages(metadata.OutputMessages);
            }

            if (metadata.InputTokens is { } inputTokens)
            {
                scope.RecordInputTokens(inputTokens);
            }

            if (metadata.OutputTokens is { } outputTokens)
            {
                scope.RecordOutputTokens(outputTokens);
            }

            if (metadata.FinishReasons.Length > 0)
            {
                scope.RecordFinishReasons(metadata.FinishReasons);
            }

            if (!string.IsNullOrEmpty(metadata.ResponseId))
            {
                scope.SetTagMaybe("gen_ai.response.id", metadata.ResponseId);
            }

            return responseBody;
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

    private static string RedactSensitivePayloads(string value)
    {
        return Regex.Replace(
            value,
            @"data:image\/[^""\s]+",
            "data:image/redacted;base64,<redacted>",
            RegexOptions.IgnoreCase);
    }

    private static InferenceResponseMetadata ReadResponseMetadata(string responseBody)
    {
        if (string.IsNullOrEmpty(responseBody))
        {
            return InferenceResponseMetadata.Empty;
        }

        try
        {
            using var doc = JsonDocument.Parse(responseBody);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return InferenceResponseMetadata.Empty;
            }

            var responseId = root.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String
                ? id.GetString()
                : null;

            int? inputTokens = null;
            int? outputTokens = null;
            if (root.TryGetProperty("usage", out var usage) && usage.ValueKind == JsonValueKind.Object)
            {
                if (usage.TryGetProperty("input_tokens", out var input)
                    && input.ValueKind == JsonValueKind.Number
                    && input.TryGetInt32(out var inputValue))
                {
                    inputTokens = inputValue;
                }

                if (usage.TryGetProperty("output_tokens", out var output)
                    && output.ValueKind == JsonValueKind.Number
                    && output.TryGetInt32(out var outputValue))
                {
                    outputTokens = outputValue;
                }
            }

            return new InferenceResponseMetadata(
                responseId,
                inputTokens,
                outputTokens,
                ReadFinishReasons(root),
                ReadOutputMessages(root));
        }
        catch (JsonException)
        {
            return InferenceResponseMetadata.Empty;
        }
    }

    private static string[] ReadFinishReasons(JsonElement root)
    {
        var finishReasons = new List<string>();
        AddStringProperty(root, "finish_reason", finishReasons);

        if (root.TryGetProperty("output", out var output) && output.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in output.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.Object)
                {
                    AddStringProperty(item, "finish_reason", finishReasons);
                }
            }
        }

        return finishReasons.Distinct(StringComparer.Ordinal).ToArray();
    }

    private static string[] ReadOutputMessages(JsonElement root)
    {
        if (!root.TryGetProperty("output", out var output) || output.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var messages = new List<string>();
        foreach (var item in output.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object
                || !item.TryGetProperty("content", out var content)
                || content.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            foreach (var part in content.EnumerateArray())
            {
                if (part.ValueKind == JsonValueKind.Object
                    && part.TryGetProperty("text", out var text)
                    && text.ValueKind == JsonValueKind.String)
                {
                    var value = text.GetString();
                    if (!string.IsNullOrEmpty(value))
                    {
                        messages.Add(value);
                    }
                }
            }
        }

        return messages.ToArray();
    }

    private static void AddStringProperty(JsonElement element, string propertyName, List<string> values)
    {
        if (element.TryGetProperty(propertyName, out var property) && property.ValueKind == JsonValueKind.String)
        {
            var value = property.GetString();
            if (!string.IsNullOrEmpty(value))
            {
                values.Add(value);
            }
        }
    }

    private sealed record InferenceResponseMetadata(
        string? ResponseId,
        int? InputTokens,
        int? OutputTokens,
        string[] FinishReasons,
        string[] OutputMessages)
    {
        public static readonly InferenceResponseMetadata Empty = new(null, null, null, [], []);
    }
}
