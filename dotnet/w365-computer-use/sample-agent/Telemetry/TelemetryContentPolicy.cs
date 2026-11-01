// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Collections;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace W365ComputerUseSample.Telemetry;

public static class TelemetryContentPolicy
{
    private const int TelemetryJsonMaxDepth = 128;

    private static readonly Regex DataImagePayload = new(
        @"data:image/[a-z0-9.+-]+(?:;[^,\s]*)?,[^\s""']+",
        RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static readonly Regex RawImageBase64 = new(
        @"^(?:iVBORw0KGgo|/9j/|_9j_|R0lGOD)[A-Za-z0-9+/_=\-\s]*$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly HashSet<string> ScreenshotToolNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "take_screenshot",
        "browser_screenshot",
    };

    public static string RedactModelPayload(string payload)
    {
        ArgumentNullException.ThrowIfNull(payload);
        return DataImagePayload.Replace(payload, "data:image/redacted;base64,<redacted>");
    }

    public static IDictionary<string, object?> RedactToolArguments(IDictionary<string, object?> arguments)
    {
        ArgumentNullException.ThrowIfNull(arguments);

        var redacted = new Dictionary<string, object?>(arguments.Count, StringComparer.Ordinal);
        foreach (var (key, value) in arguments)
        {
            redacted[key] = string.Equals(key, "text", StringComparison.OrdinalIgnoreCase)
                ? RedactText(value)
                : IsImageKey(key) || IsImageObject(value)
                    ? "<redacted image>"
                    : RedactValue(value);
        }

        return redacted;
    }

    public static string RedactToolResult(string toolName, string result)
    {
        ArgumentNullException.ThrowIfNull(toolName);
        ArgumentNullException.ThrowIfNull(result);

        if (ScreenshotToolNames.Contains(toolName))
        {
            return "<redacted screenshot result>";
        }

        if (IsRawImageBase64(result))
        {
            return "<redacted image result>";
        }

        return TryRedactStructuredResult(result, out var redacted)
            ? redacted
            : RedactStringValue(result);
    }

    private static object? RedactValue(object? value)
    {
        if (value is JsonElement element)
        {
            return IsImageObject(element) ? "<redacted image>" : RedactJsonElement(element);
        }

        return value switch
        {
            Uri => "<redacted url>",
            string text => RedactStringValue(text),
            IDictionary<string, object?> dictionary => RedactToolArguments(dictionary),
            IDictionary dictionary => RedactDictionary(dictionary),
            IEnumerable sequence => RedactSequence(sequence),
            _ => value,
        };
    }

    private static object? RedactJsonElement(JsonElement element)
    {
        return element.ValueKind switch
        {
            JsonValueKind.Object => RedactJsonObject(element),
            JsonValueKind.Array => RedactJsonArray(element),
            JsonValueKind.String => RedactStringValue(element.GetString() ?? string.Empty),
            JsonValueKind.Number => RedactNumber(element),
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.Null or JsonValueKind.Undefined => null,
            _ => null,
        };
    }

    private static IDictionary<string, object?> RedactJsonObject(JsonElement element)
    {
        var copy = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var property in element.EnumerateObject())
        {
            copy[property.Name] = string.Equals(property.Name, "text", StringComparison.OrdinalIgnoreCase)
                ? RedactText(property.Value)
                : IsImageKey(property.Name) || IsImageObject(property.Value)
                    ? "<redacted image>"
                    : RedactValue(property.Value);
        }

        return copy;
    }

    private static IReadOnlyList<object?> RedactJsonArray(JsonElement element)
    {
        var copy = new List<object?>();
        foreach (var item in element.EnumerateArray())
        {
            copy.Add(RedactValue(item));
        }

        return copy;
    }

    private static object RedactNumber(JsonElement element)
    {
        if (element.TryGetInt32(out var intValue))
        {
            return intValue;
        }

        if (element.TryGetInt64(out var longValue))
        {
            return longValue;
        }

        if (element.TryGetDecimal(out var decimalValue))
        {
            return decimalValue;
        }

        return element.TryGetDouble(out var doubleValue) ? doubleValue : element.GetRawText();
    }

    private static IDictionary<string, object?> RedactDictionary(IDictionary dictionary)
    {
        var copy = new Dictionary<string, object?>(dictionary.Count, StringComparer.Ordinal);
        foreach (DictionaryEntry entry in dictionary)
        {
            var key = entry.Key?.ToString() ?? string.Empty;
            copy[key] = string.Equals(key, "text", StringComparison.OrdinalIgnoreCase)
                ? RedactText(entry.Value)
                : IsImageKey(key) || IsImageObject(entry.Value)
                    ? "<redacted image>"
                    : RedactValue(entry.Value);
        }

        return copy;
    }

    private static IReadOnlyList<object?> RedactSequence(IEnumerable sequence)
    {
        var copy = new List<object?>();
        foreach (var value in sequence)
        {
            copy.Add(RedactValue(value));
        }

        return copy;
    }

    private static string RedactText(object? value)
    {
        var length = value switch
        {
            JsonElement { ValueKind: JsonValueKind.String } element => element.GetString()?.Length ?? 0,
            string text => text.Length,
            _ => value?.ToString()?.Length ?? 0,
        };

        return $"<redacted text; length={length}>";
    }

    private static bool IsImageKey(string key) =>
        key.Contains("image", StringComparison.OrdinalIgnoreCase)
        || key.Contains("screenshot", StringComparison.OrdinalIgnoreCase);

    private static bool IsImageObject(object? value)
    {
        if (value is JsonElement element)
        {
            return IsImageObject(element);
        }

        if (value is not IDictionary dictionary)
        {
            return false;
        }

        foreach (DictionaryEntry entry in dictionary)
        {
            if (string.Equals(entry.Key?.ToString(), "type", StringComparison.OrdinalIgnoreCase)
                && entry.Value is string type
                && (type.Contains("image", StringComparison.OrdinalIgnoreCase)
                    || type.Contains("screenshot", StringComparison.OrdinalIgnoreCase)))
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsImageObject(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        foreach (var property in element.EnumerateObject())
        {
            if (string.Equals(property.Name, "type", StringComparison.OrdinalIgnoreCase)
                && property.Value.ValueKind == JsonValueKind.String)
            {
                var type = property.Value.GetString();
                if (type?.Contains("image", StringComparison.OrdinalIgnoreCase) == true
                    || type?.Contains("screenshot", StringComparison.OrdinalIgnoreCase) == true)
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static string RedactStringValue(string value)
    {
        if (DataImagePayload.IsMatch(value) || IsRawImageBase64(value))
        {
            return "<redacted image>";
        }

        if (LooksLikeUrl(value))
        {
            return "<redacted url>";
        }

        return RedactText(value);
    }

    private static bool LooksLikeUrl(string value)
    {
        var trimmed = value.Trim();
        return trimmed.Contains("://", StringComparison.Ordinal)
            || Uri.TryCreate(trimmed, UriKind.Absolute, out _);
    }

    private static bool IsRawImageBase64(string value)
    {
        var payload = value.Trim();
        return RawImageBase64.IsMatch(payload) || HasImageBinaryPrefix(payload);
    }

    private static bool HasImageBinaryPrefix(string value)
    {
        var bytes = TryDecodeBase64Prefix(value);
        return bytes is not null
            && (IsBitmap(bytes)
                || IsTiff(bytes)
                || IsIcon(bytes)
                || IsWebP(bytes)
                || IsIsoImage(bytes));
    }

    private static byte[]? TryDecodeBase64Prefix(string value)
    {
        Span<char> prefix = stackalloc char[24];
        var count = 0;
        foreach (var character in value)
        {
            if (char.IsWhiteSpace(character))
            {
                continue;
            }

            if (count == prefix.Length)
            {
                break;
            }

            prefix[count++] = character == '-' ? '+' : character == '_' ? '/' : character;
        }

        var usableLength = count - (count % 4);
        if (usableLength == 0)
        {
            return null;
        }

        try
        {
            return Convert.FromBase64String(new string(prefix[..usableLength]));
        }
        catch (FormatException)
        {
            return null;
        }
    }

    private static bool IsBitmap(IReadOnlyList<byte> bytes) =>
        bytes.Count >= 2 && bytes[0] == (byte)'B' && bytes[1] == (byte)'M';

    private static bool IsTiff(IReadOnlyList<byte> bytes) =>
        bytes.Count >= 4
        && ((bytes[0] == (byte)'I' && bytes[1] == (byte)'I' && bytes[2] == 42 && bytes[3] == 0)
            || (bytes[0] == (byte)'M' && bytes[1] == (byte)'M' && bytes[2] == 0 && bytes[3] == 42));

    private static bool IsIcon(IReadOnlyList<byte> bytes) =>
        bytes.Count >= 4
        && bytes[0] == 0
        && bytes[1] == 0
        && (bytes[2] == 1 || bytes[2] == 2)
        && bytes[3] == 0;

    private static bool IsWebP(IReadOnlyList<byte> bytes) =>
        bytes.Count >= 12
        && bytes[0] == (byte)'R'
        && bytes[1] == (byte)'I'
        && bytes[2] == (byte)'F'
        && bytes[3] == (byte)'F'
        && bytes[8] == (byte)'W'
        && bytes[9] == (byte)'E'
        && bytes[10] == (byte)'B'
        && bytes[11] == (byte)'P';

    private static bool IsIsoImage(IReadOnlyList<byte> bytes) =>
        bytes.Count >= 12
        && bytes[4] == (byte)'f'
        && bytes[5] == (byte)'t'
        && bytes[6] == (byte)'y'
        && bytes[7] == (byte)'p'
        && ((bytes[8] == (byte)'a' && bytes[9] == (byte)'v' && bytes[10] == (byte)'i' && bytes[11] is (byte)'f' or (byte)'s')
            || (bytes[8] == (byte)'h' && bytes[9] == (byte)'e' && bytes[10] == (byte)'i' && bytes[11] is (byte)'c' or (byte)'x'));

    private static bool TryRedactStructuredResult(string result, out string redacted)
    {
        try
        {
            using var document = JsonDocument.Parse(result, new JsonDocumentOptions
            {
                MaxDepth = TelemetryJsonMaxDepth,
            });
            if (document.RootElement.ValueKind is JsonValueKind.Object or JsonValueKind.Array)
            {
                redacted = JsonSerializer.Serialize(RedactValue(document.RootElement));
                return true;
            }

            if (document.RootElement.ValueKind == JsonValueKind.String)
            {
                var value = document.RootElement.GetString() ?? string.Empty;
                var redactedValue = RedactStringValue(value);
                if (!string.Equals(value, redactedValue, StringComparison.Ordinal))
                {
                    redacted = JsonSerializer.Serialize(redactedValue);
                    return true;
                }
            }
        }
        catch (JsonException) when (LooksLikeJson(result))
        {
            redacted = "<redacted structured result>";
            return true;
        }
        catch (JsonException)
        {
            // Non-JSON tool results are handled by the normal payload redactor.
        }

        redacted = string.Empty;
        return false;
    }

    private static bool LooksLikeJson(string value)
    {
        foreach (var character in value)
        {
            if (!char.IsWhiteSpace(character))
            {
                return character is '{' or '[' or '"';
            }
        }

        return false;
    }
}
