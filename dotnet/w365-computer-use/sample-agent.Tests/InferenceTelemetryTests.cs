// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using W365ComputerUseSample.Telemetry;
using Xunit;

namespace W365ComputerUseSample.Tests;

public sealed class InferenceTelemetryTests
{
    [Fact]
    public async Task InvokeAsync_returns_response_from_send_delegate()
    {
        const string responseJson = """{ "id": "resp_123", "output": [] }""";
        var called = false;

        var result = await InferenceTelemetry.InvokeAsync(
            requestBody: "{ }",
            modelName: "model-1",
            providerName: "provider-1",
            sendAsync: () =>
            {
                called = true;
                return Task.FromResult(responseJson);
            });

        Assert.True(called);
        Assert.Equal(responseJson, result);
    }

    [Fact]
    public async Task InvokeAsync_rethrows_send_failures()
    {
        var exception = new InvalidOperationException("model failed");

        var thrown = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            InferenceTelemetry.InvokeAsync(
                requestBody: "{ }",
                modelName: "model-1",
                providerName: "provider-1",
                sendAsync: () => throw exception));

        Assert.Same(exception, thrown);
    }

    [Fact]
    public void TryReadResponseMetadata_extracts_usage_finish_reason_response_id_and_text()
    {
        const string responseJson = """
        {
          "id": "resp_123",
          "output": [
            {
              "type": "message",
              "role": "assistant",
              "finish_reason": "stop",
              "content": [
                { "type": "output_text", "text": "hello world" }
              ]
            }
          ],
          "usage": {
            "input_tokens": 11,
            "output_tokens": 7
          }
        }
        """;

        var metadata = InferenceTelemetry.ReadResponseMetadataForTest(responseJson);

        Assert.Equal("resp_123", metadata.ResponseId);
        Assert.Equal(11, metadata.InputTokens);
        Assert.Equal(7, metadata.OutputTokens);
        Assert.Equal(new[] { "stop" }, metadata.FinishReasons);
        Assert.Equal(new[] { "hello world" }, metadata.OutputMessages);
    }

    [Fact]
    public void TryReadResponseMetadata_handles_missing_optional_fields()
    {
        const string responseJson = """{ "output": [] }""";

        var metadata = InferenceTelemetry.ReadResponseMetadataForTest(responseJson);

        Assert.Null(metadata.ResponseId);
        Assert.Null(metadata.InputTokens);
        Assert.Null(metadata.OutputTokens);
        Assert.Empty(metadata.FinishReasons);
        Assert.Empty(metadata.OutputMessages);
    }

    [Fact]
    public void TryReadResponseMetadata_handles_invalid_json()
    {
        var metadata = InferenceTelemetry.ReadResponseMetadataForTest("not-json");

        Assert.Null(metadata.ResponseId);
        Assert.Null(metadata.InputTokens);
        Assert.Null(metadata.OutputTokens);
        Assert.Empty(metadata.FinishReasons);
        Assert.Empty(metadata.OutputMessages);
    }

    [Fact]
    public void HelperUsesInferenceScopeAndRecordsResponseMetadata()
    {
        var helper = ReadRepoFile("sample-agent", "Telemetry", "InferenceTelemetry.cs");
        var invokeAsyncBody = ExtractMethodBody(helper, "public static async Task<string> InvokeAsync");

        Assert.Contains("InferenceScope.Start(", invokeAsyncBody);
        Assert.Contains("new InferenceCallDetails(", invokeAsyncBody);
        Assert.Contains("var telemetryContext = Agent365TelemetryContext.FromCurrentActivity();", invokeAsyncBody);
        Assert.Contains("request: telemetryContext.ToRequest(content: requestBody)", invokeAsyncBody);
        Assert.Contains("model: modelName", invokeAsyncBody);
        Assert.Contains("providerName: providerName", invokeAsyncBody);
        Assert.Contains("InferenceOperationType.Chat", invokeAsyncBody);
        Assert.Contains("RecordInputMessages", invokeAsyncBody);
        Assert.Contains("RecordOutputMessages", invokeAsyncBody);
        Assert.Contains("RecordInputTokens", invokeAsyncBody);
        Assert.Contains("RecordOutputTokens", invokeAsyncBody);
        Assert.Contains("RecordFinishReasons", invokeAsyncBody);
        Assert.Contains("RecordCancellation()", invokeAsyncBody);
        Assert.Contains("RecordError(ex)", invokeAsyncBody);
    }

    [Fact]
    public void HelperUsesSharedAgent365TelemetryContextForRequestAndAgentDetails()
    {
        var helper = ReadRepoFile("sample-agent", "Telemetry", "InferenceTelemetry.cs");
        var invokeAsyncBody = ExtractMethodBody(helper, "public static async Task<string> InvokeAsync");

        Assert.Contains("var telemetryContext = Agent365TelemetryContext.FromCurrentActivity();", invokeAsyncBody);
        Assert.Contains("request: telemetryContext.ToRequest(content: requestBody)", invokeAsyncBody);
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
