// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Runtime.CompilerServices;
using Microsoft.Extensions.AI;
using ModelContextProtocol;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using W365ComputerUseSample.Telemetry;

namespace W365ComputerUseSample.ComputerUse;

internal sealed class W365McpSessionClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly ConditionalWeakTable<AIFunction, object> TelemetryOwnedTools = new();
    private static readonly object TelemetryOwnedToolMarker = new();

    private readonly IMcpClient mcpClient;

    internal const string ToolCallIdArgumentName = "__agent365_tool_call_id";

    public W365McpSessionClient(IMcpClient mcpClient)
    {
        this.mcpClient = mcpClient ?? throw new ArgumentNullException(nameof(mcpClient));
    }

    public async Task<W365McpToolListResult> StartSessionAndListToolsAsync(
        CancellationToken cancellationToken,
        string? conversationId = null,
        string? channelId = null)
    {
        var startArguments = new Dictionary<string, object?>();
        var startResultJson = await ToolTelemetry.InvokeAsync(
            toolName: ComputerUseOrchestrator.W365StartSessionToolName,
            arguments: startArguments,
            toolCallId: null,
            toolServerName: "w365",
            endpoint: null,
            conversationId: conversationId,
            channelId: channelId,
            invokeAsync: () => this.CallToolRawAsync(
                ComputerUseOrchestrator.W365StartSessionToolName,
                startArguments,
                cancellationToken)).ConfigureAwait(false);

        if (!TryExtractStringProperty(startResultJson, "sessionId", out var sessionId))
        {
            throw new InvalidOperationException("W365 StartSession did not return a sessionId.");
        }

        // Capture the screenShareUrl from the StartSession response so the prestart path can
        // emit a screen-share link. (The in-turn StartSession that normally drives emission
        // is skipped when the session is prestarted out-of-band.)
        TryExtractStringProperty(startResultJson, "screenShareUrl", out var screenShareUrl);

        var result = await ListToolsAsync(sessionId, cancellationToken, conversationId, channelId);
        return string.IsNullOrWhiteSpace(screenShareUrl)
            ? result
            : result with { ScreenShareUrl = screenShareUrl };
    }

    public async Task<W365McpToolListResult> ListToolsAsync(
        string sessionId,
        CancellationToken cancellationToken,
        string? conversationId = null,
        string? channelId = null)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            throw new ArgumentException("A W365 sessionId is required to list tools.", nameof(sessionId));
        }

        var request = new JsonRpcRequest
        {
            Id = new RequestId($"tools-list-{Guid.NewGuid():N}"),
            Method = RequestMethods.ToolsList,
            Params = new JsonObject
            {
                ["_meta"] = new JsonObject
                {
                    ["sessionId"] = sessionId,
                },
            },
        };

        var response = await this.mcpClient.SendRequestAsync(request, cancellationToken);
        var toolsResult = response.Result?.Deserialize<ListToolsResult>(JsonOptions)
            ?? throw new InvalidOperationException("W365 tools/list response did not contain a result.");
        var tools = CreateTools(toolsResult, sessionId, conversationId, channelId);
        return new W365McpToolListResult(sessionId, tools, this.mcpClient);
    }

    internal static bool OwnsTelemetry(AITool tool) =>
        tool is AIFunction function && TelemetryOwnedTools.TryGetValue(function, out _);

    internal static void AttachToolCallId(IDictionary<string, object?> arguments, string? toolCallId)
    {
        ArgumentNullException.ThrowIfNull(arguments);

        if (!string.IsNullOrWhiteSpace(toolCallId))
        {
            arguments[ToolCallIdArgumentName] = toolCallId;
        }
    }

    private IList<AITool> CreateTools(
        ListToolsResult toolsResult,
        string sessionId,
        string? conversationId,
        string? channelId)
    {
        var tools = new List<AITool>();
        foreach (var tool in toolsResult.Tools)
        {
            if (string.IsNullOrWhiteSpace(tool.Name))
            {
                continue;
            }

            tools.Add(CreateTool(
                tool.Name,
                tool.Description ?? string.Empty,
                sessionId,
                includeSessionId: true,
                conversationId,
                channelId));
        }

        AddLifecycleToolIfMissing(
            tools,
            ComputerUseOrchestrator.W365StartSessionToolName,
            "Starts a W365 Computer Use session.",
            sessionId,
            includeSessionId: false,
            conversationId,
            channelId);
        AddLifecycleToolIfMissing(
            tools,
            ComputerUseOrchestrator.W365GetSessionDetailsToolName,
            "Returns details for the current W365 Computer Use session.",
            sessionId,
            includeSessionId: true,
            conversationId,
            channelId);
        AddLifecycleToolIfMissing(
            tools,
            ComputerUseOrchestrator.W365EndSessionToolName,
            "Ends the current W365 Computer Use session.",
            sessionId,
            includeSessionId: true,
            conversationId,
            channelId);

        return tools;
    }

    private AIFunction CreateTool(
        string name,
        string description,
        string sessionId,
        bool includeSessionId,
        string? conversationId,
        string? channelId)
    {
        var tool = AIFunctionFactory.Create(
            async (AIFunctionArguments arguments, CancellationToken cancellationToken) =>
            {
                var callArguments = arguments.ToDictionary(kvp => kvp.Key, kvp => kvp.Value);
                var toolCallId = ExtractToolCallId(callArguments);
                if (includeSessionId && !callArguments.ContainsKey("sessionId"))
                {
                    callArguments["sessionId"] = sessionId;
                }

                return await ToolTelemetry.InvokeAsync(
                    toolName: name,
                    arguments: callArguments,
                    toolCallId: toolCallId,
                    toolServerName: "w365",
                    endpoint: null,
                    conversationId: conversationId,
                    channelId: channelId,
                    invokeAsync: () => this.CallToolRawAsync(name, callArguments, cancellationToken))
                    .ConfigureAwait(false);
            },
            name,
            description);
        TelemetryOwnedTools.Add(tool, TelemetryOwnedToolMarker);
        return tool;
    }

    private void AddLifecycleToolIfMissing(
        List<AITool> tools,
        string name,
        string description,
        string sessionId,
        bool includeSessionId,
        string? conversationId,
        string? channelId)
    {
        if (tools.OfType<AIFunction>().Any(tool => string.Equals(tool.Name, name, StringComparison.OrdinalIgnoreCase)))
        {
            return;
        }

        tools.Add(CreateTool(name, description, sessionId, includeSessionId, conversationId, channelId));
    }

    private async Task<string> CallToolRawAsync(
        string name,
        IReadOnlyDictionary<string, object?> arguments,
        CancellationToken cancellationToken)
    {
        var result = await this.mcpClient
            .CallToolAsync(name, arguments, cancellationToken: cancellationToken)
            .ConfigureAwait(false);
        return JsonSerializer.Serialize(result, JsonOptions);
    }

    private static string? ExtractToolCallId(IDictionary<string, object?> arguments)
    {
        if (!arguments.TryGetValue(ToolCallIdArgumentName, out var value))
        {
            return null;
        }

        arguments.Remove(ToolCallIdArgumentName);
        if (value is null)
        {
            return null;
        }

        return value switch
        {
            string callId => callId,
            JsonElement { ValueKind: JsonValueKind.String } element => element.GetString(),
            _ => value.ToString(),
        };
    }

    private static bool TryExtractStringProperty(string? response, string propertyName, out string value)
    {
        value = string.Empty;
        if (string.IsNullOrWhiteSpace(response))
        {
            return false;
        }

        try
        {
            using var doc = JsonDocument.Parse(response);
            return TryExtractStringProperty(doc.RootElement, propertyName, out value);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool TryExtractStringProperty(JsonElement element, string propertyName, out string value)
    {
        value = string.Empty;
        if (element.ValueKind == JsonValueKind.Object)
        {
            if (TryGetProperty(element, propertyName, out var property)
                && property.ValueKind == JsonValueKind.String)
            {
                value = property.GetString() ?? string.Empty;
                return !string.IsNullOrEmpty(value);
            }

            if (TryGetProperty(element, "content", out var content)
                && content.ValueKind == JsonValueKind.Array)
            {
                var stringTextBlocks = content.EnumerateArray()
                    .Where(b => TryGetProperty(b, "text", out var t) && t.ValueKind == JsonValueKind.String);
                foreach (var block in stringTextBlocks)
                {
                    TryGetProperty(block, "text", out var text);
                    var nestedText = text.GetString();
                    if (TryExtractStringProperty(nestedText, propertyName, out value))
                    {
                        return true;
                    }
                }
            }

            var objectHit = element.EnumerateObject()
                .Select(candidate => TryExtractStringPropertyTuple(candidate.Value, propertyName))
                .FirstOrDefault(r => r.found);
            if (objectHit.found)
            {
                value = objectHit.value;
                return true;
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            var arrayHit = element.EnumerateArray()
                .Select(item => TryExtractStringPropertyTuple(item, propertyName))
                .FirstOrDefault(r => r.found);
            if (arrayHit.found)
            {
                value = arrayHit.value;
                return true;
            }
        }
        else if (element.ValueKind == JsonValueKind.String)
        {
            var text = element.GetString();
            if (!string.IsNullOrWhiteSpace(text))
            {
                try
                {
                    using var nested = JsonDocument.Parse(text);
                    return TryExtractStringProperty(nested.RootElement, propertyName, out value);
                }
                catch (JsonException)
                {
                    return false;
                }
            }
        }

        return false;
    }

    private static (bool found, string value) TryExtractStringPropertyTuple(JsonElement element, string propertyName)
    {
        return TryExtractStringProperty(element, propertyName, out var value)
            ? (true, value)
            : (false, string.Empty);
    }

    private static bool TryGetProperty(JsonElement element, string propertyName, out JsonElement property)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var match = element.EnumerateObject()
                .FirstOrDefault(candidate => string.Equals(candidate.Name, propertyName, StringComparison.OrdinalIgnoreCase));
            if (match.Value.ValueKind != JsonValueKind.Undefined)
            {
                property = match.Value;
                return true;
            }
        }

        property = default;
        return false;
    }
}

internal sealed record W365McpToolListResult(string SessionId, IList<AITool> Tools, IMcpClient Client)
{
    /// <summary>
    /// screenShareUrl captured from the StartSession response (prestart path only). Null when
    /// the session was reused/listed rather than freshly started, or when the platform did not
    /// return a screenShareUrl.
    /// </summary>
    public string? ScreenShareUrl { get; init; }
}
