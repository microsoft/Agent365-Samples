// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PerplexitySampleAgent;

/// <summary>
/// Async client for Perplexity AI using the Responses API (/v1/responses) via direct HttpClient.
/// Implements a multi-turn tool-call loop with argument enrichment, nudge retry,
/// and auto-finalize — mirroring the Python reference sample's PerplexityClient.
/// </summary>
public sealed class PerplexityClient
{
    private const int MaxToolRounds = 8;
    private const int MaxTotalSeconds = 120;
    private const int PerRoundTimeoutSeconds = 90;
    private const int ToolFilterThreshold = 20;
    private const int MaxSelectedTools = 15;
    private const int MaxToolResultChars = 4000;

    private static readonly Regex ActionVerbRegex = new(
        @"\b(send|mail|email|schedule|create|book|set\s+up|arrange|cancel|delete|remove|move|forward|reply|update|add|invite)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex SendVerbRegex = new(
        @"\b(send|mail|email|schedule|create|book|invite|forward|reply)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex DraftRegex = new(
        @"\bdraft\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex EmailRegex = new(
        @"[\w.+-]+@[\w.-]+\.\w+", RegexOptions.Compiled);

    private static readonly HashSet<string> SkipEnrichFields = new(StringComparer.OrdinalIgnoreCase)
        { "contenttype", "format", "encoding", "provider", "mode" };

    private static readonly HashSet<string> SkipRegexFields = new(StringComparer.OrdinalIgnoreCase)
        { "type", "format", "encoding", "provider", "mode" };

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly HttpClient _httpClient;
    private readonly string _model;
    private readonly string _apiKey;
    private readonly string _endpoint;
    private readonly ILogger<PerplexityClient> _logger;

    public PerplexityClient(
        HttpClient httpClient,
        string endpoint,
        string apiKey,
        string model,
        ILogger<PerplexityClient> logger)
    {
        _httpClient = httpClient;
        _endpoint = endpoint.TrimEnd('/');
        _apiKey = apiKey;
        _model = model;
        _logger = logger;
    }

    /// <summary>
    /// Send a user message to Perplexity and return the final text response.
    /// When tools and a toolExecutor are provided, runs a multi-turn tool-call loop.
    /// </summary>
    public async Task<string> InvokeAsync(
        string userMessage,
        string systemPrompt,
        List<JsonElement>? tools = null,
        Func<string, Dictionary<string, object?>, Task<string>>? toolExecutor = null,
        CancellationToken cancellationToken = default)
    {
        _logger.LogInformation("Invoking Perplexity model={Model} (tools={ToolCount})", _model, tools?.Count ?? 0);

        // Filter tools to only those relevant to the user's message.
        // 20+ tools can cause Perplexity API timeouts; filter down to ≤15.
        if (tools is { Count: > ToolFilterThreshold })
        {
            tools = await SelectRelevantToolsAsync(userMessage, tools, cancellationToken);
            _logger.LogDebug("After filtering: {Count} relevant tools selected", tools.Count);
        }

        // Build initial request body.
        var requestBody = new Dictionary<string, object?>
        {
            ["model"] = _model,
            ["input"] = userMessage,
            ["instructions"] = systemPrompt,
        };
        if (tools is { Count: > 0 })
        {
            requestBody["tools"] = tools;
            // Force the model to call a tool on the first round when the user wants an action.
            // This eliminates the nudge retry that added a full extra API round.
            if (UserWantsAction(userMessage))
                requestBody["tool_choice"] = "required";
        }
        requestBody["store"] = false; // Don't persist server-side — reduces latency.

        var invokeStart = Stopwatch.StartNew();
        string lastText = "";
        string? pendingResourceId = null;
        bool resourceFinalized = false;
        var executedTools = new HashSet<string>(StringComparer.Ordinal); // Track tool+args to prevent duplicates.
        string? sendToolName = null;

        for (int round = 0; round < MaxToolRounds; round++)
        {
            if (invokeStart.Elapsed.TotalSeconds > MaxTotalSeconds)
            {
                _logger.LogWarning("Wall-clock limit ({Limit}s) hit after {Rounds} rounds", MaxTotalSeconds, round);
                break;
            }

            JsonElement response;
            try
            {
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                cts.CancelAfter(TimeSpan.FromSeconds(PerRoundTimeoutSeconds));
                var roundStart = Stopwatch.StartNew();
                response = await PostResponsesApiAsync(requestBody, cts.Token);
                _logger.LogDebug("Perplexity API round {Round}: {RoundTime:F1}s (total {Total:F1}s)",
                    round + 1, roundStart.Elapsed.TotalSeconds, invokeStart.Elapsed.TotalSeconds);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                _logger.LogWarning("Perplexity API round {Round} timed out ({Timeout}s)", round + 1, PerRoundTimeoutSeconds);
                break;
            }
            catch (HttpRequestException ex) when (tools is { Count: > 0 } && IsToolRejectionError(ex))
            {
                _logger.LogWarning("Tool-call API error — falling back to text-only: {Error}", ex.Message);
                requestBody.Remove("tools");
                var ctx = ToolsAsContext(tools);
                if (!string.IsNullOrEmpty(ctx))
                    requestBody["input"] = $"{userMessage}\n\n{ctx}";
                tools = null;
                response = await PostResponsesApiAsync(requestBody, cancellationToken);
            }

            // Parse output items.
            var functionCalls = new List<JsonElement>();
            var textParts = new List<string>();
            if (response.TryGetProperty("output", out var output))
            {
                foreach (var item in output.EnumerateArray())
                {
                    var type = item.GetProperty("type").GetString();
                    if (type == "function_call")
                    {
                        functionCalls.Add(item);
                    }
                    else if (type == "message")
                    {
                        if (item.TryGetProperty("content", out var content))
                        {
                            foreach (var c in content.EnumerateArray())
                            {
                                if (c.TryGetProperty("text", out var text) && text.ValueKind == JsonValueKind.String)
                                {
                                    var t = text.GetString();
                                    if (!string.IsNullOrEmpty(t)) textParts.Add(t);
                                }
                            }
                        }
                    }
                }
            }

            if (textParts.Count > 0)
                lastText = string.Join("\n", textParts);

            // No function calls → final text response.
            if (functionCalls.Count == 0 || toolExecutor == null)
            {
                // Auto-finalize: resource created but never sent.
                if (pendingResourceId != null && !resourceFinalized && toolExecutor != null && UserWantsToSend(userMessage))
                {
                    var finalizeTool = sendToolName ?? FindFinalizeToolName(tools);
                    if (finalizeTool != null)
                    {
                        _logger.LogDebug("Auto-finalizing resource via '{Tool}'", finalizeTool);
                        try
                        {
                            var idParam = FindIdParam(finalizeTool, tools);
                            await toolExecutor(finalizeTool, new Dictionary<string, object?> { [idParam] = pendingResourceId });
                            resourceFinalized = true;
                            if (lastText.Contains("draft", StringComparison.OrdinalIgnoreCase) || lastText.Contains("would you like", StringComparison.OrdinalIgnoreCase))
                                lastText = $"Done — your request has been completed. {lastText.Split('\n')[0]}";
                        }
                        catch (Exception ex)
                        {
                            _logger.LogWarning(ex, "Auto-finalize failed");
                        }
                    }
                }

                return !string.IsNullOrEmpty(lastText) ? lastText : GetOutputText(response);
            }

            // ---- Tool-call round ----
            // After the first tool call, let the model choose freely (text or more tools).
            requestBody.Remove("tool_choice");

            var nextInput = new List<object>();

            // Add previous output items.
            foreach (var item in output.EnumerateArray())
            {
                nextInput.Add(item);
            }

            foreach (var fc in functionCalls)
            {
                var toolName = fc.GetProperty("name").GetString()!;
                var callId = fc.GetProperty("call_id").GetString()!;
                var argsJson = fc.TryGetProperty("arguments", out var argsEl)
                    ? argsEl.GetString() ?? "{}"
                    : "{}";

                Dictionary<string, object?> arguments;
                try
                {
                    arguments = JsonSerializer.Deserialize<Dictionary<string, object?>>(argsJson, JsonOptions) ?? new();
                    // Unwrap JsonElement values to primitives.
                    arguments = UnwrapArguments(arguments);
                    // Sanitize corrupted values (Perplexity sometimes stuffs entire JSON into one field).
                    arguments = SanitizeArguments(arguments);
                }
                catch
                {
                    arguments = new();
                }

                // Enrich missing/empty arguments via a focused LLM call.
                arguments = await EnrichMissingArgumentsAsync(toolName, arguments, userMessage, tools, cancellationToken);

                // Coerce string values to arrays where the schema expects array type.
                arguments = CoerceArgumentTypes(toolName, arguments, tools);

                // Deduplicate: skip if the same tool+args were already executed.
                var dedupeKey = $"{toolName}:{JsonSerializer.Serialize(arguments, JsonOptions)}";
                if (executedTools.Contains(dedupeKey))
                {
                    _logger.LogDebug("Skipping duplicate tool call: {Tool} (round {Round})", toolName, round + 1);
                    nextInput.Add(new Dictionary<string, object?>
                    {
                        ["type"] = "function_call_output",
                        ["call_id"] = callId,
                        ["output"] = "Already executed — see previous result.",
                    });
                    continue;
                }

                _logger.LogInformation("Executing tool: {Tool} (round {Round})", toolName, round + 1);

                var result = await toolExecutor(toolName, arguments);
                executedTools.Add(dedupeKey);
                _logger.LogDebug("Tool result length={Len}", result.Length);

                // Truncate tool results to prevent Perplexity timeouts on large MCP responses.
                var truncatedResult = result.Length > MaxToolResultChars
                    ? result[..MaxToolResultChars] + "\n... [truncated]"
                    : result;

                // Track resource creation/finalization.
                var toolLower = toolName.ToLowerInvariant();
                if (Regex.IsMatch(toolLower, @"create|new|add|book|schedule"))
                {
                    var rid = ExtractResourceId(result);
                    if (rid != null)
                    {
                        pendingResourceId = rid;
                        _logger.LogDebug("Tracked created resource from {Tool}", toolName);
                    }
                }
                if (Regex.IsMatch(toolLower, @"send|submit|publish|finalize|confirm|dispatch"))
                {
                    resourceFinalized = true;
                    sendToolName = toolName;
                }

                nextInput.Add(new Dictionary<string, object?>
                {
                    ["type"] = "function_call_output",
                    ["call_id"] = callId,
                    ["output"] = truncatedResult,
                });
            }

            requestBody["input"] = nextInput;
        }

        // Exhausted rounds — make a final summary call without tools.
        try
        {
            requestBody.Remove("tools");
            _logger.LogDebug("Max rounds/time reached — making final summary call");
            var summary = await PostResponsesApiAsync(requestBody, cancellationToken);
            var summaryText = GetOutputText(summary);
            if (!string.IsNullOrEmpty(summaryText)) return summaryText;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Final summary call failed");
        }

        return !string.IsNullOrEmpty(lastText)
            ? lastText
            : "I ran out of time processing your request. The actions may have partially completed — please check and try again if needed.";
    }

    // ------------------------------------------------------------------
    // HTTP
    // ------------------------------------------------------------------

    private async Task<JsonElement> PostResponsesApiAsync(Dictionary<string, object?> body, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(body, JsonOptions);
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{_endpoint}/responses")
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

        using var response = await _httpClient.SendAsync(request, ct);
        response.EnsureSuccessStatusCode();

        var responseBody = await response.Content.ReadAsStringAsync(ct);
        return JsonDocument.Parse(responseBody).RootElement.Clone();
    }

    // ------------------------------------------------------------------
    // Tool selection — pick only relevant tools for the user's query
    // ------------------------------------------------------------------

    /// <summary>
    /// Uses a fast LLM call to select only the tools relevant to the user's message.
    /// This dramatically reduces the tool payload sent to Perplexity (e.g., 79 → 5-10),
    /// which prevents timeouts and improves response quality.
    /// </summary>
    private async Task<List<JsonElement>> SelectRelevantToolsAsync(
        string userMessage,
        List<JsonElement> allTools,
        CancellationToken ct)
    {
        // Build a compact tool catalog: index, name, description (one line each).
        var catalog = new StringBuilder();
        var toolIndex = new Dictionary<int, JsonElement>();
        for (int i = 0; i < allTools.Count; i++)
        {
            toolIndex[i] = allTools[i];
            var name = allTools[i].TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
            var desc = allTools[i].TryGetProperty("description", out var d) ? d.GetString() ?? "" : "";
            // Truncate description to keep the prompt small.
            if (desc.Length > 120) desc = desc[..120] + "...";
            catalog.AppendLine($"{i}: {name} — {desc}");
        }

        var selectionPrompt = $"""
            Given the user's request, select ONLY the tools needed to fulfill it.
            Return a JSON array of tool index numbers (integers). Include tools that might be needed for follow-up steps (e.g., if creating a document and sharing a link, include both create and share tools).
            Select at most {MaxSelectedTools} tools. Return ONLY a JSON array like [0, 3, 7], no explanation.

            User request: "{userMessage}"

            Available tools:
            {catalog}
            """;

        try
        {
            var selectRequest = new Dictionary<string, object?>
            {
                ["model"] = _model,
                ["input"] = selectionPrompt,
                ["instructions"] = "You are a tool selector. Return ONLY a JSON array of integers.",
                ["store"] = false,
            };

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(15));
            var selectResponse = await PostResponsesApiAsync(selectRequest, cts.Token);

            var resultText = GetOutputText(selectResponse);
            _logger.LogDebug("Tool selection result: {Result}", resultText);

            // Strip markdown fences.
            resultText = Regex.Replace(resultText, @"^```(?:json)?\s*", "", RegexOptions.Multiline);
            resultText = Regex.Replace(resultText, @"\s*```$", "", RegexOptions.Multiline);
            resultText = resultText.Trim();

            // Extract array from response (may have surrounding text).
            var arrayMatch = Regex.Match(resultText, @"\[[\d,\s]+\]");
            if (arrayMatch.Success)
            {
                var indices = JsonSerializer.Deserialize<List<int>>(arrayMatch.Value);
                if (indices is { Count: > 0 })
                {
                    var selected = new List<JsonElement>();
                    foreach (var idx in indices.Distinct())
                    {
                        if (toolIndex.TryGetValue(idx, out var tool))
                            selected.Add(tool);
                    }
                    if (selected.Count > 0)
                    {
                        _logger.LogDebug("Selected {Count}/{Total} tools: {Names}",
                            selected.Count, allTools.Count,
                            string.Join(", ", selected.Select(t => t.GetProperty("name").GetString())));
                        return selected;
                    }
                }
            }

            _logger.LogWarning("Tool selection returned no valid indices — using all tools");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Tool selection call failed — using all tools");
        }

        return allTools;
    }

    // ------------------------------------------------------------------
    // Argument enrichment (matches Python _enrich_arguments)
    // ------------------------------------------------------------------

    /// <summary>
    /// General-purpose argument enrichment: detects missing/empty required arguments
    /// by comparing against the tool schema, then makes a focused LLM call to extract
    /// the correct values from the user message. Works for ANY tool, not just specific fields.
    /// </summary>
    private async Task<Dictionary<string, object?>> EnrichMissingArgumentsAsync(
        string toolName,
        Dictionary<string, object?> arguments,
        string userMessage,
        List<JsonElement>? tools,
        CancellationToken ct)
    {
        if (tools == null) return arguments;

        // Find the schema for this tool.
        JsonElement? schema = null;
        foreach (var t in tools)
        {
            if (t.TryGetProperty("name", out var n) && n.GetString() == toolName &&
                t.TryGetProperty("parameters", out var p))
            {
                schema = p;
                break;
            }
        }
        if (schema == null) return arguments;

        if (!schema.Value.TryGetProperty("properties", out var props))
            return arguments;

        // Get the list of required parameters from the schema.
        var requiredSet = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (schema.Value.TryGetProperty("required", out var reqArray) && reqArray.ValueKind == JsonValueKind.Array)
        {
            foreach (var r in reqArray.EnumerateArray())
            {
                if (r.ValueKind == JsonValueKind.String)
                    requiredSet.Add(r.GetString()!);
            }
        }

        // Key content fields worth enriching even if not explicitly "required".
        var alwaysEnrichHints = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            { "body", "content", "text", "subject", "title", "message", "description", "to" };

        // Collect missing/empty parameters — only required ones or key content fields.
        var missingParams = new Dictionary<string, string>(); // paramName -> description
        foreach (var prop in props.EnumerateObject())
        {
            var paramName = prop.Name;
            var paramType = prop.Value.TryGetProperty("type", out var typeEl) ? typeEl.GetString() ?? "string" : "string";
            var desc = prop.Value.TryGetProperty("description", out var descEl) ? descEl.GetString() ?? "" : "";

            // Only enrich if parameter is required or is a key content field.
            var isRequired = requiredSet.Contains(paramName);
            var isKeyField = alwaysEnrichHints.Any(h => paramName.Contains(h, StringComparison.OrdinalIgnoreCase));
            if (!isRequired && !isKeyField) continue;

            // Skip fields that have non-empty values.
            if (arguments.TryGetValue(paramName, out var val))
            {
                if (val is string s && !string.IsNullOrWhiteSpace(s)) continue;
                if (val is IList<object?> list && list.Count > 0) continue;
                if (val is not null and not string && val is not IList<object?>) continue;
            }

            // Skip enum/format/type fields that shouldn't be inferred.
            var fieldLower = paramName.ToLowerInvariant();
            if (SkipEnrichFields.Contains(fieldLower))
                continue;

            missingParams[paramName] = $"{paramType}: {desc}";
        }

        if (missingParams.Count == 0) return arguments;

        _logger.LogDebug("Tool '{Tool}' has {Count} missing arguments: {Params}",
            toolName, missingParams.Count, string.Join(", ", missingParams.Keys));

        // Make a focused LLM call to extract the missing values.
        var paramList = string.Join("\n", missingParams.Select(kv => $"- {kv.Key} ({kv.Value})"));
        var extractionPrompt = $"""
            Extract the values for these parameters from the user's message.
            Return ONLY a JSON object with the parameter names as keys and extracted values.
            If a value is clearly mentioned or can be inferred from context, include it.
            For "subject" or "title" fields: generate a short, appropriate subject line based on the message content. Never leave subject empty.
            For fields that are truly not applicable (like cc, bcc, attachments), use an empty string "".

            Tool: {toolName}
            User message: "{userMessage}"

            Parameters to extract:
            {paramList}

            Already provided arguments: {JsonSerializer.Serialize(arguments, JsonOptions)}

            Return ONLY valid JSON, no explanation.
            """;

        try
        {
            var extractRequest = new Dictionary<string, object?>
            {
                ["model"] = _model,
                ["input"] = extractionPrompt,
                ["instructions"] = "You are a JSON extraction assistant. Return ONLY valid JSON.",
                ["store"] = false,
            };

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(15));
            var extractResponse = await PostResponsesApiAsync(extractRequest, cts.Token);

            var extractedText = GetOutputText(extractResponse);
            _logger.LogDebug("LLM extraction completed for '{Tool}'", toolName);

            // Strip markdown code fences if present.
            extractedText = Regex.Replace(extractedText, @"^```(?:json)?\s*", "", RegexOptions.Multiline);
            extractedText = Regex.Replace(extractedText, @"\s*```$", "", RegexOptions.Multiline);
            extractedText = extractedText.Trim();

            var extracted = JsonSerializer.Deserialize<Dictionary<string, object?>>(extractedText, JsonOptions);
            if (extracted != null)
            {
                extracted = UnwrapArguments(extracted);
                int patchedCount = 0;
                foreach (var kvp in extracted)
                {
                    if (!missingParams.ContainsKey(kvp.Key)) continue; // Only fill params we identified as missing.
                    if (kvp.Value is string sv && string.IsNullOrWhiteSpace(sv)) continue;
                    if (kvp.Value == null) continue;

                    arguments[kvp.Key] = kvp.Value;
                    patchedCount++;
                }
                _logger.LogDebug("Enriched {Count} missing arguments for '{Tool}' via LLM extraction", patchedCount, toolName);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "LLM argument extraction failed for '{Tool}' — falling back to regex enrichment", toolName);
            // Fall back to regex-based enrichment.
            arguments = EnrichArgumentsRegex(toolName, arguments, userMessage, tools);
        }

        return arguments;
    }

    /// <summary>
    /// Fallback regex-based enrichment for common field patterns (body, subject, to, content).
    /// </summary>
    private static Dictionary<string, object?> EnrichArgumentsRegex(
        string toolName,
        Dictionary<string, object?> arguments,
        string userMessage,
        List<JsonElement>? tools)
    {
        if (tools == null) return arguments;

        JsonElement? schema = null;
        foreach (var t in tools)
        {
            if (t.TryGetProperty("name", out var n) && n.GetString() == toolName &&
                t.TryGetProperty("parameters", out var p))
            {
                schema = p;
                break;
            }
        }
        if (schema == null) return arguments;
        if (!schema.Value.TryGetProperty("properties", out var props)) return arguments;

        var content = ExtractContent(userMessage);

        var bodyHints = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            { "body", "comment", "content", "text", "description", "message", "subject", "title" };

        if (!string.IsNullOrEmpty(content))
        {
            foreach (var prop in props.EnumerateObject())
            {
                if (!prop.Value.TryGetProperty("type", out var typeEl) || typeEl.GetString() != "string") continue;
                if (arguments.TryGetValue(prop.Name, out var val) && val is string s && !string.IsNullOrWhiteSpace(s)) continue;
                var fieldLower = prop.Name.ToLowerInvariant();
                if (SkipRegexFields.Any(kw => fieldLower.Contains(kw))) continue;
                if (bodyHints.Any(h => fieldLower.Contains(h)))
                {
                    arguments[prop.Name] = content;
                }
            }
        }

        // Enrich "to" fields with email addresses.
        if (props.TryGetProperty("to", out _))
        {
            if (!arguments.ContainsKey("to") || arguments["to"] is not IList<object?> { Count: > 0 })
            {
                var emails = ExtractEmails(userMessage);
                if (emails.Count > 0) arguments["to"] = emails;
            }
        }

        return arguments;
    }

    private static string ExtractContent(string userMessage)
    {
        string[] patterns =
        [
            @"(?:saying|say)\s+(.+?)(?:\s+and\s+send|\s+right\s+away|$)",
            @"(?:with\s+(?:message|body|text|content|subject))\s+(.+?)$",
            @"(?:that\s+says?)\s+(.+?)$",
            @"(?:content\s+(?:write|is|should\s+be|contains?))\s+(.+?)(?:\s+and\s+share|$)",
            @"(?:write|put|add|include|insert)\s+(.+?)(?:\s+and\s+share|\s+in\s+(?:it|the)|$)",
            @"(?:contain(?:s|ing)?)\s+(.+?)$",
            @"(?:about)\s+(.+?)$",
            @"(?:titled?)\s+(.+?)$",
        ];
        foreach (var pattern in patterns)
        {
            var match = Regex.Match(userMessage, pattern, RegexOptions.IgnoreCase);
            if (match.Success)
                return match.Groups[match.Groups.Count - 1].Value.Trim();
        }
        return "";
    }

    private static List<object?> ExtractEmails(string userMessage)
    {
        var emails = new List<object?>();
        foreach (Match m in EmailRegex.Matches(userMessage))
        {
            emails.Add(m.Value);
        }
        return emails;
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private static Dictionary<string, object?> UnwrapArguments(Dictionary<string, object?> args)
    {
        var result = new Dictionary<string, object?>();
        foreach (var kvp in args)
        {
            result[kvp.Key] = kvp.Value is JsonElement je ? UnwrapJsonElement(je) : kvp.Value;
        }
        return result;
    }

    /// <summary>
    /// Coerces argument values to match the schema-expected types.
    /// Perplexity often provides a string where the schema expects an array (e.g., "to" as string vs array).
    /// This wraps such values in a single-element list.
    /// </summary>
    private static Dictionary<string, object?> CoerceArgumentTypes(
        string toolName, Dictionary<string, object?> arguments, List<JsonElement>? tools)
    {
        if (tools == null) return arguments;

        JsonElement? schema = null;
        foreach (var t in tools)
        {
            if (t.TryGetProperty("name", out var n) && n.GetString() == toolName &&
                t.TryGetProperty("parameters", out var p))
            {
                schema = p;
                break;
            }
        }
        if (schema == null) return arguments;
        if (!schema.Value.TryGetProperty("properties", out var props)) return arguments;

        var result = new Dictionary<string, object?>(arguments);
        foreach (var prop in props.EnumerateObject())
        {
            var expectedType = prop.Value.TryGetProperty("type", out var typeEl) ? typeEl.GetString() : null;
            if (expectedType != "array") continue;
            if (!result.TryGetValue(prop.Name, out var val)) continue;

            // If the value is a string but the schema expects array, wrap it.
            if (val is string sv && !string.IsNullOrWhiteSpace(sv))
            {
                result[prop.Name] = new List<object?> { sv };
            }
        }

        return result;
    }

    /// <summary>
    /// Sanitizes argument values corrupted by Perplexity.
    /// The model sometimes packs the entire JSON payload into a single field value,
    /// e.g. "to" = "user@example.com\",\"body\":\"hello\",\"subject\":\"hi\"}}garbage".
    /// This detects such corruption and extracts embedded key-value pairs as separate arguments,
    /// and cleans the original field to just the clean prefix.
    /// </summary>
    private static Dictionary<string, object?> SanitizeArguments(Dictionary<string, object?> args)
    {
        var result = new Dictionary<string, object?>(args);
        var extracted = new Dictionary<string, string>();

        foreach (var kvp in args)
        {
            if (kvp.Value is not string sv) continue;

            // Detect corruption: value contains escaped quotes or embedded JSON keys.
            // Pattern: realValue","otherKey":"otherValue"  or  realValue\u0022,\u0022otherKey...
            var corruptionIdx = sv.IndexOf("\",\"", StringComparison.Ordinal);
            if (corruptionIdx < 0)
                corruptionIdx = sv.IndexOf("\\u0022", StringComparison.OrdinalIgnoreCase);

            if (corruptionIdx > 0)
            {
                // The clean value is everything before the first corruption marker.
                var cleanValue = sv[..corruptionIdx].Trim();
                result[kvp.Key] = cleanValue;

                // Try to extract embedded key-value pairs from the garbage.
                // Pattern: "key":"value"
                foreach (Match m in Regex.Matches(sv[corruptionIdx..],
                    @"""(\w+)""\s*:\s*""([^""]*?)""", RegexOptions.None))
                {
                    var embeddedKey = m.Groups[1].Value;
                    var embeddedVal = m.Groups[2].Value;
                    // Only use if we don't already have a good value for this key.
                    if (!string.IsNullOrWhiteSpace(embeddedVal))
                        extracted[embeddedKey] = embeddedVal;
                }
            }

            // Also detect if an email field has trailing garbage after the email.
            if (kvp.Key.Equals("to", StringComparison.OrdinalIgnoreCase) ||
                kvp.Key.Equals("cc", StringComparison.OrdinalIgnoreCase) ||
                kvp.Key.Equals("bcc", StringComparison.OrdinalIgnoreCase))
            {
                var currentVal = result[kvp.Key] as string ?? "";
                var emailMatch = Regex.Match(currentVal, @"^([\w.+-]+@[\w.-]+\.\w+)");
                if (emailMatch.Success && emailMatch.Value.Length < currentVal.Length)
                {
                    result[kvp.Key] = emailMatch.Groups[1].Value;
                }
            }
        }

        // Merge extracted embedded values (only for keys that are empty/missing).
        foreach (var kvp in extracted)
        {
            if (!result.TryGetValue(kvp.Key, out var existing) ||
                existing is null ||
                (existing is string es && string.IsNullOrWhiteSpace(es)))
            {
                result[kvp.Key] = kvp.Value;
            }
        }

        return result;
    }

    private static object? UnwrapJsonElement(JsonElement el) => el.ValueKind switch
    {
        JsonValueKind.String => el.GetString(),
        JsonValueKind.Number => el.TryGetInt64(out var l) ? l : el.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Null => null,
        JsonValueKind.Array => el.EnumerateArray().Select(UnwrapJsonElement).ToList(),
        JsonValueKind.Object => el.EnumerateObject().ToDictionary(p => p.Name, p => UnwrapJsonElement(p.Value)),
        _ => el.GetRawText(),
    };

    private static string GetOutputText(JsonElement response)
    {
        if (response.TryGetProperty("output_text", out var ot) && ot.ValueKind == JsonValueKind.String)
            return ot.GetString() ?? "";

        if (response.TryGetProperty("output", out var output))
        {
            foreach (var item in output.EnumerateArray())
            {
                if (item.TryGetProperty("type", out var t) && t.GetString() == "message" &&
                    item.TryGetProperty("content", out var content))
                {
                    foreach (var c in content.EnumerateArray())
                    {
                        if (c.TryGetProperty("text", out var text) && text.ValueKind == JsonValueKind.String)
                            return text.GetString() ?? "";
                    }
                }
            }
        }
        return "";
    }

    private static bool UserWantsAction(string userMessage) =>
        ActionVerbRegex.IsMatch(userMessage);

    private static bool UserWantsToSend(string userMessage) =>
        SendVerbRegex.IsMatch(userMessage) &&
        !DraftRegex.IsMatch(userMessage);

    private static string? ExtractResourceId(string result)
    {
        try
        {
            using var doc = JsonDocument.Parse(result);
            var root = doc.RootElement;
            var data = root.TryGetProperty("data", out var d) ? d : root;
            foreach (var key in new[] { "messageId", "id", "eventId", "itemId", "draftId", "resourceId" })
            {
                if (data.TryGetProperty(key, out var val) && val.ValueKind == JsonValueKind.String)
                    return val.GetString();
                if (root.TryGetProperty(key, out val) && val.ValueKind == JsonValueKind.String)
                    return val.GetString();
            }
        }
        catch { }
        return null;
    }

    private static string? FindFinalizeToolName(List<JsonElement>? tools)
    {
        if (tools == null) return null;
        foreach (var t in tools)
        {
            var name = t.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
            if (Regex.IsMatch(name, @"send.*draft|send.*message|submit|publish|dispatch", RegexOptions.IgnoreCase))
                return name;
        }
        return null;
    }

    private static string FindIdParam(string toolName, List<JsonElement>? tools)
    {
        if (tools == null) return "id";
        foreach (var t in tools)
        {
            if (t.TryGetProperty("name", out var n) && n.GetString() == toolName &&
                t.TryGetProperty("parameters", out var p))
            {
                if (p.TryGetProperty("required", out var req))
                {
                    foreach (var r in req.EnumerateArray())
                    {
                        var rs = r.GetString() ?? "";
                        if (rs.Contains("id", StringComparison.OrdinalIgnoreCase)) return rs;
                    }
                }
                if (p.TryGetProperty("properties", out var props))
                {
                    foreach (var prop in props.EnumerateObject())
                    {
                        if (prop.Name.Contains("id", StringComparison.OrdinalIgnoreCase)) return prop.Name;
                    }
                }
            }
        }
        return "id";
    }

    private static bool IsToolRejectionError(HttpRequestException ex) =>
        new[] { "not supported", "unrecognized", "tool", "parameter", "function" }
            .Any(kw => (ex.Message ?? "").Contains(kw, StringComparison.OrdinalIgnoreCase));

    private static string ToolsAsContext(List<JsonElement>? tools)
    {
        if (tools == null || tools.Count == 0) return "";
        var lines = new List<string>();
        foreach (var t in tools)
        {
            var name = t.TryGetProperty("name", out var n) ? n.GetString() ?? "tool" : "tool";
            var desc = t.TryGetProperty("description", out var d) ? d.GetString() ?? "" : "";
            lines.Add($"- {name}: {desc}");
        }
        return "[Available tools for context:\n" + string.Join("\n", lines) + "]";
    }

    // ------------------------------------------------------------------
}
