// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System.ComponentModel;
using System.Text.Json;

namespace DotNetAutonomous.Tools;

public sealed class WeatherLookupTool
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

    private readonly HttpClient _httpClient;

    public WeatherLookupTool(IHttpClientFactory httpClientFactory)
    {
        _httpClient = httpClientFactory.CreateClient();
    }

    [Description("Get current weather conditions for any city worldwide")]
    public async Task<string> GetCurrentWeather(
        [Description("The name of the city, e.g. 'Chennai', 'Seattle', 'London'")] string city)
    {
        // Geocode the city name to lat/lon via Open-Meteo's free geocoding API (no API key required)
        var geoUrl = $"https://geocoding-api.open-meteo.com/v1/search?name={Uri.EscapeDataString(city)}&count=1";
        using var geoResponse = await _httpClient.GetAsync(geoUrl).ConfigureAwait(false);
        if (!geoResponse.IsSuccessStatusCode)
            return $"Could not geocode '{city}': HTTP {geoResponse.StatusCode}.";

        using var geoDoc = await JsonDocument.ParseAsync(
            await geoResponse.Content.ReadAsStreamAsync().ConfigureAwait(false)).ConfigureAwait(false);

        if (!geoDoc.RootElement.TryGetProperty("results", out var results) || results.GetArrayLength() == 0)
            return $"City '{city}' not found. Please check the spelling or try a nearby major city.";

        var first = results[0];
        var lat = first.GetProperty("latitude").GetDouble();
        var lon = first.GetProperty("longitude").GetDouble();
        var resolvedName = first.TryGetProperty("name", out var nameEl) ? nameEl.GetString() ?? city : city;
        var country = first.TryGetProperty("country", out var countryEl) ? countryEl.GetString() ?? "" : "";

        // Fetch current conditions from Open-Meteo forecast API
        var weatherUrl = $"https://api.open-meteo.com/v1/forecast" +
                         $"?latitude={lat}&longitude={lon}" +
                         $"&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m" +
                         $"&temperature_unit=fahrenheit";

        using var weatherResponse = await _httpClient.GetAsync(weatherUrl).ConfigureAwait(false);
        if (!weatherResponse.IsSuccessStatusCode)
            return $"Could not fetch weather for '{resolvedName}': HTTP {weatherResponse.StatusCode}.";

        using var weatherDoc = await JsonDocument.ParseAsync(
            await weatherResponse.Content.ReadAsStreamAsync().ConfigureAwait(false)).ConfigureAwait(false);

        var current     = weatherDoc.RootElement.GetProperty("current");
        var temp        = current.GetProperty("temperature_2m").GetDouble();
        var code        = current.GetProperty("weather_code").GetInt32();
        var wind        = current.GetProperty("wind_speed_10m").GetDouble();
        var humidity    = current.GetProperty("relative_humidity_2m").GetDouble();
        var description = WmoDescriptions.TryGetValue(code, out var d) ? d : $"weather code {code}";
        var timestamp   = DateTimeOffset.UtcNow.ToString("yyyy-MM-dd HH:mm") + " UTC";
        var location    = string.IsNullOrEmpty(country) ? resolvedName : $"{resolvedName}, {country}";

        return $"Current weather in {location} at {timestamp}: " +
               $"{temp:F1}°F, {description}, wind {wind:F1} mph, humidity {humidity:F0}%.";
    }
}
