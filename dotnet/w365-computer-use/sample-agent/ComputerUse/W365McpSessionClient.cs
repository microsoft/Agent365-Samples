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

    public IList<AITool> CreateLifecycleTools(string? conversationId = null, string? channelId = null) =>
        CreateTools(new ListToolsResult { Tools = [] }, string.Empty, conversationId, channelId);

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
        var error = toolsResult.Tools.FirstOrDefault(tool => string.Equals(tool.Name, "Error", StringComparison.OrdinalIgnoreCase));
        if (error != null)
        {
            var message = error.Description ?? "W365 tool discovery failed without error details.";
            if (W365SessionState.IsPendingLoginMessage(message)) throw new W365HumanLoginRequiredException();
            if (W365SessionState.IsEndedMessage(message)) throw new W365SessionEndedException(message);
            throw new InvalidOperationException(message);
        }
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
                includeSessionId: !string.Equals(tool.Name, ComputerUseOrchestrator.W365StartSessionToolName, StringComparison.OrdinalIgnoreCase),
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
                if (includeSessionId && !string.IsNullOrEmpty(sessionId))
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

    private Task<string> CallToolRawAsync(
        string name,
        IReadOnlyDictionary<string, object?> arguments,
        CancellationToken cancellationToken) =>
        CallToolRawAsync(this.mcpClient, name, arguments, cancellationToken);

    internal static async Task<string> CallToolRawAsync(
        IMcpClient client,
        string name,
        IReadOnlyDictionary<string, object?> arguments,
        CancellationToken cancellationToken)
    {
        // Keep additive fields such as structuredContent that the pinned SDK's typed result drops.
        try
        {
            var response = await client.SendRequestAsync(new JsonRpcRequest
            {
                Id = new RequestId($"tools-call-{Guid.NewGuid():N}"),
                Method = RequestMethods.ToolsCall,
                Params = new JsonObject
                {
                    ["name"] = name,
                    ["arguments"] = JsonSerializer.SerializeToNode(arguments, JsonOptions),
                },
            }, cancellationToken).ConfigureAwait(false);
            return response.Result?.ToJsonString()
                ?? throw new InvalidOperationException($"W365 {name} did not return a result.");
        }
        catch (Exception ex) when (ex is not OperationCanceledException && W365SessionState.IsPendingLoginMessage(ex.Message))
        {
            throw new W365HumanLoginRequiredException();
        }
        catch (Exception ex) when (ex is not OperationCanceledException && W365SessionState.IsEndedMessage(ex.Message))
        {
            throw new W365SessionEndedException(ex.Message);
        }
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
}

internal sealed record W365McpToolListResult(string SessionId, IList<AITool> Tools, IMcpClient Client);
