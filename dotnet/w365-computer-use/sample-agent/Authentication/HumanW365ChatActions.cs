// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Text.Json;
using Microsoft.Agents.Core.Models;

namespace W365ComputerUseSample.Authentication;

public enum HumanW365ChatActionKind
{
    Continue,
    Cancel
}

public sealed record HumanW365ChatAction(HumanW365ChatActionKind Kind, string RequestId);

internal static class HumanW365ChatActions
{
    internal static bool TryRead(object? value, out HumanW365ChatAction? action)
    {
        action = null;
        if (value == null)
            return false;
        var payload = JsonSerializer.SerializeToElement(value);
        if (payload.ValueKind != JsonValueKind.Object
            || !payload.TryGetProperty("w365HumanAction", out var kind))
            return false;

        if (payload.EnumerateObject().Count(p => p.Name == "w365HumanAction") != 1
            || payload.EnumerateObject().Count(p => p.Name == "requestId") != 1
            || kind.ValueKind != JsonValueKind.String
            || !payload.TryGetProperty("requestId", out var requestId)
            || requestId.ValueKind != JsonValueKind.String
            || !Guid.TryParseExact(requestId.GetString(), "N", out _))
            return true;

        var parsedKind = kind.GetString() switch
        {
            "continue" => HumanW365ChatActionKind.Continue,
            "cancel" => HumanW365ChatActionKind.Cancel,
            _ => (HumanW365ChatActionKind?)null
        };
        if (parsedKind != null)
            action = new HumanW365ChatAction(parsedKind.Value, requestId.GetString()!);
        return true;
    }

    internal static Attachment CreateSignInCard(string signInUrl, bool cloudPc = false) => new()
    {
        ContentType = "application/vnd.microsoft.card.adaptive",
        Content = new
        {
            type = "AdaptiveCard",
            version = "1.3",
            actions = new object[]
            {
                cloudPc ? new
                {
                    type = "Action.OpenUrl",
                    title = "Sign in",
                    url = signInUrl
                } : new
                {
                    type = "Action.OpenUrl",
                    title = "Sign in with Microsoft",
                    url = signInUrl,
                    iconUrl = new Uri(new Uri(signInUrl), "/w365-auth/ms-symbol.png").AbsoluteUri
                }
            }
        }
    };

    internal static Attachment CreateControlsCard(string requestId) => new()
    {
        ContentType = "application/vnd.microsoft.card.adaptive",
        Content = new
        {
            type = "AdaptiveCard",
            version = "1.3",
            actions = new object[]
            {
                new
                {
                    type = "Action.Submit",
                    title = "Continue after sign-in",
                    associatedInputs = "none",
                    data = new { w365HumanAction = "continue", requestId }
                },
                new
                {
                    type = "Action.Submit",
                    title = "Cancel request",
                    associatedInputs = "none",
                    data = new { w365HumanAction = "cancel", requestId }
                }
            }
        }
    };
}
