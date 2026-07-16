// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using W365ComputerUseSample.Telemetry;
using Xunit;

namespace W365ComputerUseSample.Tests;

public sealed class ToolTelemetryTests
{
    [Fact]
    public async Task InvokeAsync_returns_result_from_tool_delegate()
    {
        var args = new Dictionary<string, object?> { ["x"] = 1, ["text"] = "hello" };
        var callCount = 0;

        var result = await ToolTelemetry.InvokeAsync(
            toolName: "click",
            arguments: args,
            toolCallId: "call-1",
            toolServerName: "w365",
            endpoint: new Uri("https://tools.example.com"),
            conversationId: "conversation-1",
            channelId: "msteams",
            invokeAsync: () =>
            {
                callCount++;
                return Task.FromResult("tool-result");
            });

        Assert.Equal(1, callCount);
        Assert.Equal("tool-result", result);
    }

    [Fact]
    public async Task InvokeAsync_preserves_stringified_tool_result()
    {
        var result = await ToolTelemetry.InvokeAsync(
            toolName: "tool_object",
            arguments: new Dictionary<string, object?>(),
            toolCallId: null,
            toolServerName: "mcp",
            endpoint: null,
            conversationId: null,
            channelId: null,
            invokeAsync: () => Task.FromResult("123"));

        Assert.Equal("123", result);
    }

    [Fact]
    public void HelperGeneratesToolCallIdWhenCallerDoesNotHaveOne()
    {
        var helper = ReadRepoFile("sample-agent", "Telemetry", "ToolTelemetry.cs");
        var invokeAsyncBody = ExtractMethodBody(helper, "public static async Task<string> InvokeAsync");

        Assert.Contains("var resolvedToolCallId = ResolveToolCallId(toolName, toolCallId);", invokeAsyncBody);
        Assert.Contains("toolCallId: resolvedToolCallId", invokeAsyncBody);
        Assert.Contains("private static string ResolveToolCallId(string toolName, string? toolCallId)", helper);
        Assert.Contains("toolCallId", helper);
        Assert.Contains("toolName", helper);
        Assert.Contains("Guid.NewGuid().ToString(\"N\")", helper);
    }

    [Fact]
    public void ResolveToolCallId_preserves_caller_supplied_id()
    {
        var toolCallId = ToolTelemetry.ResolveToolCallIdForTest("click", "call-1");

        Assert.Equal("call-1", toolCallId);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void ResolveToolCallId_generates_prefixed_guid_when_missing(string? providedToolCallId)
    {
        var toolCallId = ToolTelemetry.ResolveToolCallIdForTest("click", providedToolCallId);

        Assert.StartsWith("click-", toolCallId);
        Assert.True(
            Guid.TryParseExact(toolCallId["click-".Length..], "N", out _),
            $"Expected generated tool call id to end with an N-formatted GUID, got '{toolCallId}'.");
    }

    [Fact]
    public async Task InvokeAsync_rethrows_tool_failures()
    {
        var exception = new InvalidOperationException("tool failed");

        var thrown = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            ToolTelemetry.InvokeAsync(
                toolName: "click",
                arguments: new Dictionary<string, object?>(),
                toolCallId: null,
                toolServerName: "w365",
                endpoint: null,
                conversationId: null,
                channelId: null,
                invokeAsync: () => throw exception));

        Assert.Same(exception, thrown);
    }

    [Fact]
    public async Task InvokeAsync_rethrows_cancellation()
    {
        var exception = new OperationCanceledException();

        var thrown = await Assert.ThrowsAsync<OperationCanceledException>(() =>
            ToolTelemetry.InvokeAsync(
                toolName: "wait_milliseconds",
                arguments: new Dictionary<string, object?>(),
                toolCallId: "call-2",
                toolServerName: "w365",
                endpoint: null,
                conversationId: null,
                channelId: null,
                invokeAsync: () => throw exception));

        Assert.Same(exception, thrown);
    }

    [Fact]
    public void HelperUsesExecuteToolScopeAndRecordsResult()
    {
        var helper = ReadRepoFile("sample-agent", "Telemetry", "ToolTelemetry.cs");
        var invokeAsyncBody = ExtractMethodBody(helper, "public static async Task<string> InvokeAsync");

        Assert.Contains("ExecuteToolScope.Start(", invokeAsyncBody);
        Assert.Contains("new ToolCallDetails(", invokeAsyncBody);
        Assert.Contains("var telemetryContext = Agent365TelemetryContext.FromCurrentActivity(", invokeAsyncBody);
        Assert.Contains("conversationIdOverride: conversationId", invokeAsyncBody);
        Assert.Contains("channelNameOverride: channelId", invokeAsyncBody);
        Assert.Contains("request: telemetryContext.ToRequest(conversationId: conversationId, channelName: channelId)", invokeAsyncBody);
        Assert.Contains("toolName: toolName", invokeAsyncBody);
        Assert.Contains("argumentsObject: ToSerializableArguments(arguments)", invokeAsyncBody);
        Assert.Contains("toolCallId: resolvedToolCallId", invokeAsyncBody);
        Assert.Contains("ToolType.Function", invokeAsyncBody);
        Assert.Contains("toolType: ToolType.Function", invokeAsyncBody);
        Assert.Contains("endpoint: endpoint", invokeAsyncBody);
        Assert.Contains("toolServerName: toolServerName", invokeAsyncBody);
        Assert.Contains("scope.RecordResponse(result)", invokeAsyncBody);
        Assert.Contains("scope.RecordCancellation()", invokeAsyncBody);
        Assert.Contains("scope.RecordError(ex)", invokeAsyncBody);
    }

    [Fact]
    public void HelperUsesSharedAgent365TelemetryContextForToolRequestAndAgentDetails()
    {
        var helper = ReadRepoFile("sample-agent", "Telemetry", "ToolTelemetry.cs");
        var invokeAsyncBody = ExtractMethodBody(helper, "public static async Task<string> InvokeAsync");

        Assert.Contains("var telemetryContext = Agent365TelemetryContext.FromCurrentActivity(", invokeAsyncBody);
        Assert.Contains("conversationIdOverride: conversationId", invokeAsyncBody);
        Assert.Contains("channelNameOverride: channelId", invokeAsyncBody);
        Assert.Contains("request: telemetryContext.ToRequest(conversationId: conversationId, channelName: channelId)", invokeAsyncBody);
        Assert.Contains("agentDetails: telemetryContext.ToAgentDetails()", invokeAsyncBody);
        Assert.DoesNotContain("CreateAgentDetailsFromActivity()", invokeAsyncBody);
    }

    private static string ReadRepoFile(params string[] pathParts)
    {
        var allParts = new string[pathParts.Length + 1];
        allParts[0] = FindRepositoryRoot();
        Array.Copy(pathParts, 0, allParts, 1, pathParts.Length);
        return File.ReadAllText(Path.Combine(allParts));
    }

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (Directory.Exists(Path.Combine(directory.FullName, "sample-agent"))
                && Directory.Exists(Path.Combine(directory.FullName, "sample-agent.Tests")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException("Could not find the W365-SampleAgent repository root.");
    }

    private static string ExtractMethodBody(string source, string methodSignatureStart)
    {
        var start = source.IndexOf(methodSignatureStart, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Could not find method starting with {methodSignatureStart}.");
        var openBrace = source.IndexOf('{', start);
        Assert.True(openBrace >= 0, $"Could not find opening brace for {methodSignatureStart}.");

        var depth = 0;
        for (var i = openBrace; i < source.Length; i++)
        {
            if (source[i] == '{') depth++;
            if (source[i] == '}') depth--;
            if (depth == 0) return source[openBrace..(i + 1)];
        }

        throw new InvalidOperationException($"Could not find closing brace for {methodSignatureStart}.");
    }
}
