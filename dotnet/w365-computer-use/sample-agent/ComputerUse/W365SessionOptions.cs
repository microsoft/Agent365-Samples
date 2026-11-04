// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Globalization;
using Microsoft.Extensions.Configuration;

namespace W365ComputerUseSample.ComputerUse;

internal sealed class W365SessionOptions
{
    private readonly string? sessionKind;
    private readonly Dictionary<string, object?> properties = [];

    public W365SessionOptions(IConfiguration configuration)
    {
        var section = configuration.GetSection("W365:Session");
        sessionKind = section["SessionKind"];
        if (sessionKind != null && sessionKind is not ("local" or "human" or "agentic"))
        {
            throw new InvalidOperationException("W365:Session:SessionKind must be local, human or agentic, or omitted.");
        }

        foreach (var name in new[] { "DisplayWidth", "DisplayHeight" })
        {
            if (section[name] is not { } value) continue;
            if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var dimension) || dimension <= 0)
            {
                throw new InvalidOperationException($"W365:Session:{name} must be a positive integer.");
            }

            properties[char.ToLowerInvariant(name[0]) + name[1..]] = dimension;
        }

        if (section["BrowserMode"] is { } browserMode)
        {
            if (browserMode is not ("chromium" or "legacy"))
            {
                throw new InvalidOperationException("W365:Session:BrowserMode must be chromium or legacy, or omitted.");
            }

            properties["browserMode"] = browserMode;
        }
    }

    public Dictionary<string, object?> CreateStartArguments()
    {
        var arguments = new Dictionary<string, object?>();
        if (sessionKind != null) arguments["sessionKind"] = sessionKind;
        if (properties.Count > 0) arguments["sessionProperties"] = new Dictionary<string, object?>(properties);
        return arguments;
    }
}
