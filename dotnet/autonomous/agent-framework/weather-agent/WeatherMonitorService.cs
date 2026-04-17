// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Azure.AI.OpenAI;
using OpenAI.Chat;
using System.Text.Json;

namespace DotNetAutonomous;

/// <summary>
/// Background service that autonomously monitors weather conditions on each cycle.
/// Fetches real-time data from Open-Meteo (no API key required), calls Azure OpenAI
/// to produce a field operations advisory, and logs the result.
/// Interval is controlled by HeartbeatIntervalMs in configuration (default: 60000 ms).
/// </summary>
internal sealed class WeatherMonitorService : BackgroundService
{
    private static readonly Dictionary<int, string> WmoDescriptions = new()
    {
        [0]  = "clear sky",
        [1]  = "mainly clear",
        [2]  = "partly cloudy",
        [3]  = "overcast",
        [45] = "fog",
        [48] = "icy fog",
        [51] = "light drizzle",
        [61] = "light rain",
        [63] = "moderate rain",
        [71] = "light snow",
        [80] = "rain showers",
        [95] = "thunderstorm",
    };

    private readonly ILogger<WeatherMonitorService> _logger;
    private readonly TimeSpan _interval;
    private readonly HttpClient _httpClient;
    private readonly ChatClient _chatClient;
    private readonly string _city;
    private readonly string _lat;
    private readonly string _lon;

    public WeatherMonitorService(
        ILogger<WeatherMonitorService> logger,
        IConfiguration configuration,
        IHttpClientFactory httpClientFactory,
        AzureOpenAIClient openAiClient)
    {
        _logger = logger;
        _httpClient = httpClientFactory.CreateClient();

        var intervalMs = configuration.GetValue<int>("HeartbeatIntervalMs", 60_000);
        _interval = TimeSpan.FromMilliseconds(intervalMs);

        _city = configuration["WeatherMonitor:City"] ?? "Seattle, WA";
        _lat  = configuration["WeatherMonitor:Latitude"] ?? "47.6062";
        _lon  = configuration["WeatherMonitor:Longitude"] ?? "-122.3321";

        var deployment = configuration["AzureOpenAI:Deployment"] ?? "gpt-4o";
        _chatClient = openAiClient.GetChatClient(deployment);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("WeatherMonitorService started for {City}. Interval: {Interval}", _city, _interval);

        using var timer = new PeriodicTimer(_interval);

        while (!stoppingToken.IsCancellationRequested && await timer.WaitForNextTickAsync(stoppingToken))
        {
            var url = $"https://api.open-meteo.com/v1/forecast" +
                      $"?latitude={_lat}&longitude={_lon}" +
                      $"&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m" +
                      $"&temperature_unit=fahrenheit";

            using var weatherResponse = await _httpClient.GetAsync(url, stoppingToken);
            if (!weatherResponse.IsSuccessStatusCode)
            {
                _logger.LogWarning("Weather fetch failed: {Status}", weatherResponse.StatusCode);
                continue;
            }

            using var doc = await JsonDocument.ParseAsync(
                await weatherResponse.Content.ReadAsStreamAsync(stoppingToken),
                cancellationToken: stoppingToken);

            var current     = doc.RootElement.GetProperty("current");
            var temp        = current.GetProperty("temperature_2m").GetDouble();
            var code        = current.GetProperty("weather_code").GetInt32();
            var wind        = current.GetProperty("wind_speed_10m").GetDouble();
            var humidity    = current.GetProperty("relative_humidity_2m").GetDouble();
            var description = WmoDescriptions.TryGetValue(code, out var d) ? d : $"code {code}";
            var timestamp   = DateTimeOffset.UtcNow.ToString("yyyy-MM-dd HH:mm") + " UTC";

            _logger.LogInformation("Weather in {City}: {Temp}F, {Description}, wind {Wind}mph, humidity {Humidity}%",
                _city, temp, description, wind, humidity);

            var completion = await _chatClient.CompleteChatAsync(
                [
                    new SystemChatMessage(
                        "You are an autonomous field operations agent monitoring weather conditions. " +
                        "Never say you are an AI or language model."),
                    new UserChatMessage(
                        $"Conditions in {_city} at {timestamp}: {temp}F, {description}, " +
                        $"wind {wind}mph, humidity {humidity}%. " +
                        "In one sentence, assess conditions and advise whether field operations " +
                        "should proceed normally, with caution, or be postponed.")
                ],
                cancellationToken: stoppingToken);

            var advisory = completion.Value.Content[0].Text;
            _logger.LogInformation("Advisory: {Advisory}", advisory);
        }

        _logger.LogInformation("WeatherMonitorService stopped.");
    }
}
