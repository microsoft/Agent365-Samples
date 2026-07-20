// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Contracts;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Scopes;

namespace W365ComputerUseSample.Telemetry;

public static class InferenceTelemetry
{
    private static readonly Regex HandoffCodeQueryParameter = new(
        @"(?<prefix>[?&]hc=)[^&\s\)]+",
        RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    public static async Task<string> InvokeAsync(
        string requestBody,
        string modelName,
        string providerName,
        Func<Task<string>> sendAsync)
    {
        ArgumentNullException.ThrowIfNull(sendAsync);

        var sanitizedRequest = TelemetryContentPolicy.RedactModelPayload(requestBody);
        var telemetryContext = Agent365TelemetryContext.FromCurrentActivity();
        using var inferenceScope = InferenceScope.Start(
            telemetryContext.ToRequest(content: sanitizedRequest),
            new InferenceCallDetails(InferenceOperationType.Chat, modelName, providerName),
            telemetryContext.ToAgentDetails());

        inferenceScope.RecordInputMessages([sanitizedRequest]);

        try
        {
            var responseBody = await sendAsync().ConfigureAwait(false);
            var metadata = ParseResponseMetadata(responseBody);

            if (metadata.OutputMessages.Length > 0)
            {
                inferenceScope.RecordOutputMessages(
                    metadata.OutputMessages.Select(SanitizeOutputMessage).ToArray());
            }

            if (metadata.InputTokens is int inputTokens)
            {
                inferenceScope.RecordInputTokens(inputTokens);
            }

            if (metadata.OutputTokens is int outputTokens)
            {
                inferenceScope.RecordOutputTokens(outputTokens);
            }

            if (metadata.FinishReasons.Length > 0)
            {
                inferenceScope.RecordFinishReasons(metadata.FinishReasons);
            }

            if (!string.IsNullOrWhiteSpace(metadata.ResponseId))
            {
                inferenceScope.SetTagMaybe("gen_ai.response.id", metadata.ResponseId);
            }

            return responseBody;
        }
        catch (OperationCanceledException)
        {
            inferenceScope.RecordCancellation();
            throw;
        }
        catch (Exception exception)
        {
            inferenceScope.RecordError(exception);
            throw;
        }
    }

    private static InferenceResponseMetadata ParseResponseMetadata(string responseBody)
    {
        try
        {
            using var document = JsonDocument.Parse(responseBody);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return InferenceResponseMetadata.Empty;
            }

            var outputMessages = new List<string>();
            var finishReasons = new List<string>();
            AddString(root, "finish_reason", finishReasons);

            if (root.TryGetProperty("output", out var output)
                && output.ValueKind == JsonValueKind.Array)
            {
                foreach (var outputItem in output.EnumerateArray())
                {
                    if (outputItem.ValueKind != JsonValueKind.Object)
                    {
                        continue;
                    }

                    AddString(outputItem, "finish_reason", finishReasons);
                    if (outputItem.TryGetProperty("content", out var content)
                        && content.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var contentItem in content.EnumerateArray())
                        {
                            if (contentItem.ValueKind == JsonValueKind.Object)
                            {
                                AddString(contentItem, "text", outputMessages);
                            }
                        }
                    }
                }
            }

            return new InferenceResponseMetadata(
                GetString(root, "id"),
                GetUsageTokenCount(root, "input_tokens"),
                GetUsageTokenCount(root, "output_tokens"),
                outputMessages.ToArray(),
                finishReasons.Distinct(StringComparer.Ordinal).ToArray());
        }
        catch (JsonException)
        {
            return InferenceResponseMetadata.Empty;
        }
    }

    private static string SanitizeOutputMessage(string outputMessage) =>
        HandoffCodeQueryParameter.Replace(
            TelemetryContentPolicy.RedactToolResult("model_response", outputMessage),
            "${prefix}<redacted>");

    private static int? GetUsageTokenCount(JsonElement root, string propertyName)
    {
        return root.TryGetProperty("usage", out var usage)
            && usage.ValueKind == JsonValueKind.Object
            && usage.TryGetProperty(propertyName, out var tokenCount)
            && tokenCount.TryGetInt32(out var value)
                ? value
                : null;
    }

    private static string? GetString(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static void AddString(JsonElement element, string propertyName, ICollection<string> values)
    {
        var value = GetString(element, propertyName);
        if (!string.IsNullOrWhiteSpace(value))
        {
            values.Add(value);
        }
    }

}

internal sealed record InferenceResponseMetadata(
    string? ResponseId,
    int? InputTokens,
    int? OutputTokens,
    string[] OutputMessages,
    string[] FinishReasons)
{
    public static readonly InferenceResponseMetadata Empty = new(null, null, null, [], []);
}
