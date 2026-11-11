// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Text;
using System.Text.Json;

namespace W365ComputerUseSample.ComputerUse;

internal static class W365McpPayloadCapture
{
    internal const int MaxBodyBytes = 16 * 1024;
    private static readonly UTF8Encoding Utf8 = new(false, true);

    internal static string DecodeBody(byte[] body) => Utf8.GetString(body);

    internal static (string? Method, string? Id, string Json) SummarizeRequest(byte[] body)
    {
        var json = DecodeBody(body);
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return (null, null, json);

            var method = root.TryGetProperty("method", out var value) && value.ValueKind == JsonValueKind.String
                ? value.GetString() : null;
            var id = root.TryGetProperty("id", out value) ? value.ValueKind switch
            {
                JsonValueKind.String => value.GetString(),
                JsonValueKind.Number => value.GetRawText(),
                _ => null
            } : null;
            return (method, id, json);
        }
        catch (JsonException)
        {
            return ("[unparsed-json]", null, json);
        }
    }
}
