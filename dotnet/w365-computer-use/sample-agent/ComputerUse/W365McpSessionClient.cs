// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Logging;
using ModelContextProtocol;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;

namespace W365ComputerUseSample.ComputerUse;

internal sealed class W365McpSessionClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly IMcpClient mcpClient;
    private readonly ILogger? logger;

    public W365McpSessionClient(IMcpClient mcpClient, ILogger? logger = null)
    {
        this.mcpClient = mcpClient ?? throw new ArgumentNullException(nameof(mcpClient));
        this.logger = logger;
    }

    public async Task<W365McpToolListResult> StartSessionAndListToolsAsync(CancellationToken cancellationToken)
    {
        var startResult = await this.mcpClient.CallToolAsync(
            ComputerUseOrchestrator.W365StartSessionToolName,
            new Dictionary<string, object?>(),
            cancellationToken: cancellationToken);
        var startResultJson = JsonSerializer.Serialize(startResult, JsonOptions);

        if (!TryExtractStringProperty(startResultJson, "sessionId", out var sessionId))
        {
            var snippet = startResultJson.Length > 800 ? startResultJson[..800] : startResultJson;
            throw new InvalidOperationException($"W365 StartSession did not return a sessionId. Raw response: {snippet}");
        }
        var result = await ListToolsAsync(sessionId, cancellationToken);
        return result;
    }

    public async Task<W365McpToolListResult> ListToolsAsync(string sessionId, CancellationToken cancellationToken)
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
        var tools = CreateTools(toolsResult, sessionId);
        return new W365McpToolListResult(sessionId, tools, this.mcpClient);
    }

    private IList<AITool> CreateTools(ListToolsResult toolsResult, string sessionId)
    {
        var tools = new List<AITool>();
        foreach (var tool in toolsResult.Tools)
        {
            if (string.IsNullOrWhiteSpace(tool.Name))
            {
                continue;
            }

            tools.Add(CreateTool(tool.Name, tool.Description ?? string.Empty, sessionId, includeSessionId: true));
        }

        AddLifecycleToolIfMissing(tools, ComputerUseOrchestrator.W365StartSessionToolName, "Starts a W365 Computer Use session.", sessionId, includeSessionId: false);
        AddLifecycleToolIfMissing(tools, ComputerUseOrchestrator.W365GetSessionDetailsToolName, "Returns details for the current W365 Computer Use session.", sessionId, includeSessionId: true);
        AddLifecycleToolIfMissing(tools, ComputerUseOrchestrator.W365EndSessionToolName, "Ends the current W365 Computer Use session.", sessionId, includeSessionId: true);

        return tools;
    }

    private AIFunction CreateTool(string name, string description, string sessionId, bool includeSessionId)
    {
        return AIFunctionFactory.Create(
            async (AIFunctionArguments arguments, CancellationToken cancellationToken) =>
            {
                var callArguments = arguments.ToDictionary(kvp => kvp.Key, kvp => kvp.Value);
                if (includeSessionId && !callArguments.ContainsKey("sessionId"))
                {
                    callArguments["sessionId"] = sessionId;
                }

                var result = await this.mcpClient.CallToolAsync(name, callArguments, cancellationToken: cancellationToken);
                return JsonSerializer.Serialize(result, JsonOptions);
            },
            name,
            description);
    }

    private void AddLifecycleToolIfMissing(List<AITool> tools, string name, string description, string sessionId, bool includeSessionId)
    {
        if (tools.OfType<AIFunction>().Any(tool => string.Equals(tool.Name, name, StringComparison.OrdinalIgnoreCase)))
        {
            return;
        }

        tools.Add(CreateTool(name, description, sessionId, includeSessionId));
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
                foreach (var block in content.EnumerateArray())
                {
                    if (TryGetProperty(block, "text", out var text)
                        && text.ValueKind == JsonValueKind.String)
                    {
                        var nestedText = text.GetString();
                        if (TryExtractStringProperty(nestedText, propertyName, out value))
                        {
                            return true;
                        }
                    }
                }
            }

            foreach (var candidate in element.EnumerateObject())
            {
                if (TryExtractStringProperty(candidate.Value, propertyName, out value))
                {
                    return true;
                }
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in element.EnumerateArray())
            {
                if (TryExtractStringProperty(item, propertyName, out value))
                {
                    return true;
                }
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

    private static bool TryGetProperty(JsonElement element, string propertyName, out JsonElement property)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            foreach (var candidate in element.EnumerateObject())
            {
                if (string.Equals(candidate.Name, propertyName, StringComparison.OrdinalIgnoreCase))
                {
                    property = candidate.Value;
                    return true;
                }
            }
        }

        property = default;
        return false;
    }
}

internal sealed record W365McpToolListResult(string SessionId, IList<AITool> Tools, IMcpClient Client)
{
}
