// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Text.Json;

namespace W365ComputerUseSample.ComputerUse;

public sealed record W365SessionOptions(
    string? SessionKind = null,
    int? DisplayWidth = null,
    int? DisplayHeight = null,
    string? BrowserMode = null)
{
    internal bool HasExplicitOptions =>
        SessionKind != null || DisplayWidth != null || DisplayHeight != null || BrowserMode != null;

    internal static W365SessionOptions FromChat(string? sessionKind, JsonElement properties)
    {
        int? displayWidth = null;
        int? displayHeight = null;
        string? browserMode = null;
        if (properties.ValueKind != JsonValueKind.Null)
        {
            if (properties.ValueKind != JsonValueKind.Object)
                throw new InvalidOperationException("The session properties requested in chat must be an object or null.");

            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in properties.EnumerateObject())
            {
                if (!names.Add(property.Name))
                    throw new InvalidOperationException("The chat router returned duplicate session properties.");

                switch (property.Name)
                {
                    case "displayWidth":
                        displayWidth = ReadDimension(property.Value, property.Name);
                        break;
                    case "displayHeight":
                        displayHeight = ReadDimension(property.Value, property.Name);
                        break;
                    case "browserMode" when property.Value.ValueKind == JsonValueKind.String:
                        browserMode = property.Value.GetString();
                        break;
                    default:
                        throw new InvalidOperationException($"The chat router returned an unsupported session property or value: {property.Name}.");
                }
            }
        }

        var options = new W365SessionOptions(sessionKind, displayWidth, displayHeight, browserMode);
        options.Validate();
        return options;
    }

    private static int ReadDimension(JsonElement value, string name)
    {
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out var dimension) || dimension <= 0)
            throw new InvalidOperationException($"The session {name} requested in chat must be a positive integer.");
        return dimension;
    }

    private void Validate()
    {
        if (SessionKind is not (null or "local" or "human" or "agentic"))
            throw new InvalidOperationException("The session kind requested in chat must be local, human or agentic, or omitted.");
        if (DisplayWidth is <= 0 || DisplayHeight is <= 0)
            throw new InvalidOperationException("The session display dimensions requested in chat must be positive integers.");
        if (BrowserMode is not (null or "chromium" or "legacy"))
            throw new InvalidOperationException("The session browser mode requested in chat must be chromium or legacy, or omitted.");
    }

    public Dictionary<string, object?> CreateStartArguments()
    {
        Validate();
        var arguments = new Dictionary<string, object?>();
        if (SessionKind != null) arguments["sessionKind"] = SessionKind;
        var properties = new Dictionary<string, object?>();
        if (DisplayWidth is { } width) properties["displayWidth"] = width;
        if (DisplayHeight is { } height) properties["displayHeight"] = height;
        if (BrowserMode != null) properties["browserMode"] = BrowserMode;
        if (properties.Count > 0) arguments["sessionProperties"] = properties;
        return arguments;
    }
}
