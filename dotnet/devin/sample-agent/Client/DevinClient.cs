// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Agent365DevinSampleAgent.Client;

/// <summary>
/// Client for interacting with the Devin API.
/// Creates sessions, sends messages, and polls for responses.
/// </summary>
public class DevinClient
{
    private readonly HttpClient _httpClient;
    private readonly ILogger<DevinClient> _logger;
    private readonly string _baseUrl;
    private readonly int _pollingIntervalSeconds;
    private readonly int _timeoutSeconds;
    private string? _currentSessionId;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public DevinClient(HttpClient httpClient, IConfiguration configuration, ILogger<DevinClient> logger)
    {
        _httpClient = httpClient;
        _logger = logger;

        _baseUrl = configuration["Devin:BaseUrl"]
            ?? throw new InvalidOperationException("Devin:BaseUrl configuration is required");

        var apiKey = configuration["Devin:ApiKey"]
            ?? throw new InvalidOperationException("Devin:ApiKey configuration is required");

        _pollingIntervalSeconds = configuration.GetValue("Devin:PollingIntervalSeconds", 10);
        _timeoutSeconds = configuration.GetValue("Devin:TimeoutSeconds", 300);

        _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        _httpClient.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
    }

    /// <summary>
    /// Sends a prompt to Devin and returns the response.
    /// Maintains session across turns for multi-turn conversations.
    /// </summary>
    public async Task<string> InvokeAgentAsync(string prompt, CancellationToken cancellationToken = default)
    {
        _currentSessionId = await PromptDevinAsync(prompt, _currentSessionId, cancellationToken);
        return await PollForResponseAsync(_currentSessionId, cancellationToken);
    }

    private async Task<string> PromptDevinAsync(string prompt, string? sessionId, CancellationToken cancellationToken)
    {
        string requestUrl;
        object requestBody;

        if (sessionId != null)
        {
            requestUrl = $"{_baseUrl}/sessions/{sessionId}/message";
            requestBody = new { message = prompt };
        }
        else
        {
            requestUrl = $"{_baseUrl}/sessions";
            requestBody = new { prompt };
        }

        var json = JsonSerializer.Serialize(requestBody, JsonOptions);
        using var content = new StringContent(json, Encoding.UTF8, "application/json");

        _logger.LogDebug("Sending request to Devin: {Url}", requestUrl);
        var response = await _httpClient.PostAsync(requestUrl, content, cancellationToken);
        response.EnsureSuccessStatusCode();

        var responseJson = await response.Content.ReadAsStringAsync(cancellationToken);
        var data = JsonSerializer.Deserialize<DevinCreateSessionResponse>(responseJson, JsonOptions);

        var rawSessionId = data?.SessionId ?? "";
        var resolvedSessionId = sessionId ?? rawSessionId.Replace("devin-", "");

        _logger.LogDebug("Devin session ID: {SessionId}", resolvedSessionId);
        return resolvedSessionId;
    }

    private async Task<string> PollForResponseAsync(string sessionId, CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow.AddSeconds(_timeoutSeconds);
        var sentMessages = new HashSet<string>();

        _logger.LogDebug("Starting poll for Devin's reply (session: {SessionId})", sessionId);

        while (DateTime.UtcNow < deadline)
        {
            await Task.Delay(TimeSpan.FromSeconds(_pollingIntervalSeconds), cancellationToken);

            var requestUrl = $"{_baseUrl}/sessions/{sessionId}";
            var response = await _httpClient.GetAsync(requestUrl, cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogError("Devin API call failed with status {StatusCode}", response.StatusCode);
                return "There was an error processing your request, please try again.";
            }

            var responseJson = await response.Content.ReadAsStringAsync(cancellationToken);
            _logger.LogInformation("Devin poll response (status check): {Response}",
                responseJson.Length > 500 ? responseJson[..500] + "..." : responseJson);

            var data = JsonSerializer.Deserialize<DevinSessionResponse>(responseJson, JsonOptions);

            if (data == null) continue;

            _logger.LogInformation("Current Devin session status: {Status}, Messages count: {Count}",
                data.Status, data.Messages?.Count ?? 0);

            // Check the last message for a devin_message response
            var latestMessage = data.Messages?.LastOrDefault();
            if (latestMessage != null)
            {
                _logger.LogInformation("Latest message — Type: '{Type}', EventId: '{EventId}', Message: '{Message}'",
                    latestMessage.Type, latestMessage.EventId, 
                    latestMessage.Message?.Length > 100 ? latestMessage.Message[..100] + "..." : latestMessage.Message);
            }

            if (latestMessage?.Type == "devin_message" && !sentMessages.Contains(latestMessage.EventId))
            {
                sentMessages.Add(latestMessage.EventId);
                _logger.LogInformation("Received Devin response: {Message}", latestMessage.Message);
                return latestMessage.Message ?? "No response from Devin.";
            }

            // If status is no longer active, stop polling
            if (data.Status != "new" && data.Status != "claimed" && data.Status != "running")
            {
                _logger.LogWarning("Devin session ended with status: {Status}", data.Status);
                break;
            }
        }

        _logger.LogWarning("Timed out waiting for Devin response");
        return "I'm still working on this. Please try again in a moment.";
    }
}

#region Models

public class DevinCreateSessionResponse
{
    [JsonPropertyName("session_id")]
    public string? SessionId { get; set; }
}

public class DevinSessionResponse
{
    [JsonPropertyName("status")]
    public string Status { get; set; } = "";

    [JsonPropertyName("messages")]
    public List<DevinMessage>? Messages { get; set; }
}

public class DevinMessage
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = "";

    [JsonPropertyName("message")]
    public string? Message { get; set; }

    [JsonPropertyName("event_id")]
    public string EventId { get; set; } = "";
}

#endregion
