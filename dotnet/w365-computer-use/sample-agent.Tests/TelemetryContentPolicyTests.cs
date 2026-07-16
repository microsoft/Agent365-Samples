// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using W365ComputerUseSample.Telemetry;
using Xunit;

namespace W365ComputerUseSample.Tests;

public sealed class TelemetryContentPolicyTests
{
    [Fact]
    public void PrepareText_redacts_content_by_default()
    {
        const string value = "password=secret";

        var prepared = TelemetryContentPolicy.PrepareTextForTest(
            value,
            captureContent: false,
            contentKind: "inference request");

        Assert.Equal("<redacted inference request; length=15>", prepared);
        Assert.DoesNotContain("secret", prepared);
    }

    [Fact]
    public void PrepareText_sanitizes_credentials_when_content_capture_is_enabled()
    {
        const string value = "Open https://host/screenshare.html?sid=session-1&hc=handoff-secret "
            + "and data:image/png;base64,image-secret";

        var prepared = TelemetryContentPolicy.PrepareTextForTest(
            value,
            captureContent: true,
            contentKind: "agent output");

        Assert.DoesNotContain("handoff-secret", prepared);
        Assert.DoesNotContain("image-secret", prepared);
        Assert.Contains("hc=<redacted>", prepared);
        Assert.Contains("data:image/redacted;base64,<redacted>", prepared);
    }

    [Fact]
    public void PrepareArguments_preserves_numbers_but_redacts_strings_by_default()
    {
        var arguments = new Dictionary<string, object?>
        {
            ["x"] = 42,
            ["text"] = "typed secret",
            ["sessionId"] = "session-secret",
        };

        var prepared = TelemetryContentPolicy.PrepareArgumentsForTest(arguments, captureContent: false);

        Assert.Equal(42, prepared["x"]);
        Assert.Equal("<redacted string; length=12>", prepared["text"]);
        Assert.Equal("<redacted string; length=14>", prepared["sessionId"]);
    }
}
