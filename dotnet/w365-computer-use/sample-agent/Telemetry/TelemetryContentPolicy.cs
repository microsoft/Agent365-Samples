// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Collections;
using System.Text.RegularExpressions;

namespace W365ComputerUseSample.Telemetry;

internal static partial class TelemetryContentPolicy
{
    private const string CaptureContentEnvironmentVariable = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT";

    public static bool IsContentCaptureEnabled() =>
        string.Equals(
            Environment.GetEnvironmentVariable(CaptureContentEnvironmentVariable),
            "true",
            StringComparison.OrdinalIgnoreCase);

    public static string PrepareText(string value, string contentKind) =>
        PrepareText(value, IsContentCaptureEnabled(), contentKind);

    public static Dictionary<string, object> PrepareArguments(IDictionary<string, object?> arguments) =>
        PrepareArguments(arguments, IsContentCaptureEnabled());

    internal static string PrepareTextForTest(string value, bool captureContent, string contentKind) =>
        PrepareText(value, captureContent, contentKind);

    internal static Dictionary<string, object> PrepareArgumentsForTest(
        IDictionary<string, object?> arguments,
        bool captureContent) =>
        PrepareArguments(arguments, captureContent);

    private static string PrepareText(string value, bool captureContent, string contentKind)
    {
        value ??= string.Empty;
        if (!captureContent)
        {
            return $"<redacted {contentKind}; length={value.Length}>";
        }

        var sanitized = DataImageRegex().Replace(value, "data:image/redacted;base64,<redacted>");
        sanitized = SensitiveQueryParameterRegex().Replace(
            sanitized,
            match => $"{match.Groups["prefix"].Value}<redacted>");
        return BearerTokenRegex().Replace(sanitized, "Bearer <redacted>");
    }

    private static Dictionary<string, object> PrepareArguments(
        IDictionary<string, object?> arguments,
        bool captureContent)
    {
        return arguments.ToDictionary(
            pair => pair.Key,
            pair => PrepareArgumentValue(pair.Value, captureContent),
            StringComparer.Ordinal);
    }

    private static object PrepareArgumentValue(object? value, bool captureContent)
    {
        return value switch
        {
            null => string.Empty,
            string text => captureContent
                ? PrepareText(text, captureContent: true, contentKind: "string")
                : $"<redacted string; length={text.Length}>",
            IDictionary<string, object?> dictionary => PrepareArguments(dictionary, captureContent),
            IDictionary dictionary => dictionary.Keys
                .Cast<object>()
                .ToDictionary(
                    key => key.ToString() ?? string.Empty,
                    key => PrepareArgumentValue(dictionary[key], captureContent),
                    StringComparer.Ordinal),
            IEnumerable enumerable when value is not string => enumerable
                .Cast<object?>()
                .Select(item => PrepareArgumentValue(item, captureContent))
                .ToArray(),
            _ => value,
        };
    }

    [GeneratedRegex(@"data:image\/[^""\s]+", RegexOptions.IgnoreCase)]
    private static partial Regex DataImageRegex();

    [GeneratedRegex(@"(?<prefix>[?&](?:sid|hc|ariToken|access_token|token|code)=)[^&#\s)\]]+", RegexOptions.IgnoreCase)]
    private static partial Regex SensitiveQueryParameterRegex();

    [GeneratedRegex(@"\bBearer\s+[A-Za-z0-9\-._~+/]+=*", RegexOptions.IgnoreCase)]
    private static partial Regex BearerTokenRegex();
}
