// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Text;
using System.Text.Json;
using Microsoft.Extensions.AI;
using W365ComputerUseSample.ComputerUse.Models;

namespace W365ComputerUseSample.ComputerUse;

/// <summary>
/// Thin protocol adapter between OpenAI's computer-use-preview model and W365 MCP tools.
/// The model emits computer_call actions; this class translates them to MCP tool calls
/// and feeds back screenshots. The MCP server manages sessions automatically.
/// </summary>
public class ComputerUseOrchestrator
{
    private readonly HttpClient _httpClient;
    private readonly ILogger<ComputerUseOrchestrator> _logger;
    private readonly string _endpoint;
    private readonly string _apiKey;
    private readonly string _deploymentName;
    private readonly int _maxIterations;
    private readonly List<object> _tools;

    private const string SystemInstructions = """
        You are a computer-using agent that can control a Windows desktop computer.
        After each action, examine the screenshot to verify it worked.
        If you see browser setup or sign-in dialogs, dismiss them (Escape, X, or Skip).
        Once you have completed the task, call the OnTaskComplete function.
        Do NOT continue looping after the task is done.
        """;

    public ComputerUseOrchestrator(
        IHttpClientFactory httpClientFactory,
        IConfiguration configuration,
        ILogger<ComputerUseOrchestrator> logger)
    {
        _httpClient = httpClientFactory.CreateClient("WebClient");
        _logger = logger;

        _endpoint = configuration["AIServices:AzureOpenAI:Endpoint"]
            ?? throw new InvalidOperationException("AIServices:AzureOpenAI:Endpoint is required.");
        _apiKey = configuration["AIServices:AzureOpenAI:ApiKey"]
            ?? throw new InvalidOperationException("AIServices:AzureOpenAI:ApiKey is required.");
        _deploymentName = configuration["AIServices:AzureOpenAI:DeploymentName"] ?? "computer-use-preview";
        _maxIterations = configuration.GetValue("ComputerUse:MaxIterations", 30);

        _tools =
        [
            new ComputerUseTool
            {
                DisplayWidth = configuration.GetValue("ComputerUse:DisplayWidth", 1024),
                DisplayHeight = configuration.GetValue("ComputerUse:DisplayHeight", 768),
                Environment = "windows"
            },
            new FunctionToolDefinition
            {
                Name = "OnTaskComplete",
                Description = "Call this function when the given task has been completed successfully."
            }
        ];
    }

    /// <summary>
    /// Run the CUA loop. The MCP server auto-manages sessions per user context.
    /// </summary>
    public async Task<string> RunAsync(
        string userMessage,
        IList<AITool> w365Tools,
        Action<string>? onStatusUpdate = null,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("Starting CUA loop for: {Message}", Truncate(userMessage, 100));

        // Start a W365 session — the server auto-discovers pools and provisions a VM.
        // Session is tied to the user's identity; no session ID tracking needed.
        onStatusUpdate?.Invoke("Starting W365 computing session...");
        await InvokeToolAsync(w365Tools, "W365_QuickStartSession", new Dictionary<string, object?>(), cancellationToken);
        _logger.LogInformation("W365 session started via QuickStartSession");

        var conversation = new List<JsonElement> { CreateUserMessage(userMessage) };

        for (var i = 0; i < _maxIterations; i++)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var response = await CallModelAsync(conversation, cancellationToken);
            if (response?.Output == null || response.Output.Count == 0)
                break;

            var hasActions = false;

            foreach (var item in response.Output)
            {
                var type = item.GetProperty("type").GetString();
                if (type == "reasoning") continue;

                conversation.Add(item);

                switch (type)
                {
                    case "message":
                        return ExtractText(item);

                    case "computer_call":
                        hasActions = true;
                        conversation.Add(await HandleComputerCallAsync(item, w365Tools, onStatusUpdate, cancellationToken));
                        break;

                    case "function_call":
                        hasActions = true;
                        conversation.Add(CreateFunctionOutput(item.GetProperty("call_id").GetString()!));
                        if (item.GetProperty("name").GetString() == "OnTaskComplete")
                        {
                            await EndSessionAsync(w365Tools, cancellationToken);
                            return "Task completed successfully.";
                        }
                        break;
                }
            }

            if (!hasActions) break;
        }

        await EndSessionAsync(w365Tools, cancellationToken);
        return "The task could not be completed within the allowed number of steps.";
    }

    private async Task EndSessionAsync(IList<AITool> tools, CancellationToken ct)
    {
        try
        {
            await InvokeToolAsync(tools, "W365_EndSession", new Dictionary<string, object?>(), ct);
            _logger.LogInformation("W365 session ended");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to end W365 session");
        }
    }

    private async Task<ComputerUseResponse?> CallModelAsync(List<JsonElement> conversation, CancellationToken ct)
    {
        var body = JsonSerializer.Serialize(new ComputerUseRequest
        {
            Model = _deploymentName,
            Instructions = SystemInstructions,
            Input = conversation,
            Tools = _tools,
            Truncation = "auto"
        }, new JsonSerializerOptions { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull });

        var url = $"{_endpoint.TrimEnd('/')}/openai/deployments/{_deploymentName}/responses?api-version=2025-03-01-preview";
        using var req = new HttpRequestMessage(HttpMethod.Post, url);
        req.Content = new StringContent(body, Encoding.UTF8, "application/json");
        req.Headers.Add("api-key", _apiKey);

        var resp = await _httpClient.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
        {
            var err = await resp.Content.ReadAsStringAsync(ct);
            throw new HttpRequestException($"Model API returned {resp.StatusCode}: {err}");
        }

        return JsonSerializer.Deserialize<ComputerUseResponse>(await resp.Content.ReadAsStringAsync(ct));
    }

    /// <summary>
    /// Translate a computer_call into an MCP tool call, capture screenshot, return computer_call_output.
    /// </summary>
    private async Task<JsonElement> HandleComputerCallAsync(
        JsonElement call, IList<AITool> tools, Action<string>? onStatus, CancellationToken ct)
    {
        var callId = call.GetProperty("call_id").GetString()!;
        var action = call.GetProperty("action");
        var actionType = action.GetProperty("type").GetString()!;

        onStatus?.Invoke($"Performing: {actionType}...");

        // Execute the action (unless it's just requesting a screenshot)
        if (actionType != "screenshot")
        {
            var (toolName, args) = MapActionToMcpTool(actionType, action);
            await InvokeToolAsync(tools, toolName, args, ct);
        }

        // Always capture screenshot after action
        var screenshot = await CaptureScreenshotAsync(tools, ct);

        var safetyChecks = call.TryGetProperty("pending_safety_checks", out var sc)
            ? sc : JsonSerializer.Deserialize<JsonElement>("[]");

        return ToJsonElement(new
        {
            type = "computer_call_output",
            call_id = callId,
            acknowledged_safety_checks = safetyChecks,
            output = new { type = "computer_screenshot", image_url = $"data:image/png;base64,{screenshot}" }
        });
    }

    /// <summary>
    /// Map OpenAI computer_call action types to W365 MCP tool names and arguments.
    /// sessionId is omitted — the MCP server resolves sessions by user context.
    /// </summary>
    private static (string ToolName, Dictionary<string, object?> Args) MapActionToMcpTool(string actionType, JsonElement action)
    {
        return actionType.ToLowerInvariant() switch
        {
            "click" => ("W365_Click2", new Dictionary<string, object?>
            {
                ["x"] = action.GetProperty("x").GetInt32(),
                ["y"] = action.GetProperty("y").GetInt32(),
                ["button"] = action.TryGetProperty("button", out var b) ? b.GetString() : "left"
            }),
            "double_click" => ("W365_DoubleClick", new Dictionary<string, object?>
            {
                ["x"] = action.GetProperty("x").GetInt32(),
                ["y"] = action.GetProperty("y").GetInt32()
            }),
            "type" => ("W365_WriteText", new Dictionary<string, object?>
            {
                ["text"] = action.GetProperty("text").GetString()
            }),
            "key" or "keys" or "keypress" => ("W365_MultiKeyPress", new Dictionary<string, object?>
            {
                ["keys"] = ExtractKeys(action)
            }),
            "scroll" => ("W365_Scroll", new Dictionary<string, object?>
            {
                ["atX"] = action.GetProperty("x").GetInt32(),
                ["atY"] = action.GetProperty("y").GetInt32(),
                ["deltaX"] = action.TryGetProperty("scroll_x", out var sx) ? sx.GetInt32() : 0,
                ["deltaY"] = action.TryGetProperty("scroll_y", out var sy) ? sy.GetInt32() : 0
            }),
            "move" => ("W365_MoveMouse", new Dictionary<string, object?>
            {
                ["toX"] = action.GetProperty("x").GetInt32(),
                ["toY"] = action.GetProperty("y").GetInt32()
            }),
            "wait" => ("W365_Wait", new Dictionary<string, object?>
            {
                ["milliseconds"] = action.TryGetProperty("ms", out var ms) ? ms.GetInt32() : 500
            }),
            "open_url" => ("W365_OpenUrl", new Dictionary<string, object?>
            {
                ["url"] = action.GetProperty("url").GetString()
            }),
            _ => throw new NotSupportedException($"Unsupported action: {actionType}")
        };
    }

    private async Task<string> CaptureScreenshotAsync(IList<AITool> tools, CancellationToken ct)
    {
        var result = await InvokeToolAsync(tools, "W365_CaptureScreenshot", new Dictionary<string, object?>(), ct);
        var str = result?.ToString() ?? "";

        try
        {
            using var doc = JsonDocument.Parse(str);
            var root = doc.RootElement;
            if (root.TryGetProperty("screenshotData", out var sd)) return sd.GetString() ?? "";
            if (root.TryGetProperty("image", out var img)) return img.GetString() ?? "";
            if (root.TryGetProperty("data", out var d)) return d.GetString() ?? "";
        }
        catch (JsonException) { }

        // Fallback: result might be raw base64
        if (str.Length > 100) return str;

        throw new InvalidOperationException("Failed to extract screenshot from MCP response.");
    }

    private static async Task<object?> InvokeToolAsync(
        IList<AITool> tools, string name, Dictionary<string, object?> args, CancellationToken ct)
    {
        var tool = tools.OfType<AIFunction>().FirstOrDefault(t => t.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
            ?? throw new InvalidOperationException($"Tool '{name}' not found.");
        return await tool.InvokeAsync(new AIFunctionArguments(args), ct);
    }

    private static string[] ExtractKeys(JsonElement action)
    {
        if (action.TryGetProperty("keys", out var k))
        {
            if (k.ValueKind == JsonValueKind.Array)
                return k.EnumerateArray().Select(e => e.GetString() ?? "").ToArray();
            if (k.ValueKind == JsonValueKind.String)
                return [k.GetString() ?? ""];
        }
        if (action.TryGetProperty("key", out var single) && single.ValueKind == JsonValueKind.String)
            return [single.GetString() ?? ""];
        return [];
    }

    private static string ExtractText(JsonElement msg)
    {
        if (msg.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.Array)
            foreach (var item in c.EnumerateArray())
                if (item.TryGetProperty("text", out var t))
                    return t.GetString() ?? "";
        return "";
    }

    private static JsonElement CreateUserMessage(string text) => ToJsonElement(new
    {
        type = "message", role = "user",
        content = new[] { new { type = "input_text", text } }
    });

    private static JsonElement CreateFunctionOutput(string callId) => ToJsonElement(new
    {
        type = "function_call_output", call_id = callId, output = "success"
    });

    private static JsonElement ToJsonElement(object obj) =>
        JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(obj));

    private static string Truncate(string v, int max) => v.Length <= max ? v : v[..max] + "...";
}
