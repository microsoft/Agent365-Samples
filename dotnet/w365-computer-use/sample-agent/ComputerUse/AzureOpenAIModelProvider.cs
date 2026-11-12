// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Text;
using W365ComputerUseSample.Telemetry;

namespace W365ComputerUseSample.ComputerUse;

/// <summary>
/// Sends CUA model requests to Azure OpenAI using an API key.
/// This is the default provider for external customers.
/// </summary>
public class AzureOpenAIModelProvider : ICuaModelProvider
{
    private readonly HttpClient _httpClient;
    private readonly string _url;
    private readonly string _apiKey;
    private readonly ILogger<AzureOpenAIModelProvider> _logger;

    public string ModelName { get; }

    public AzureOpenAIModelProvider(IHttpClientFactory httpClientFactory, IConfiguration configuration, ILogger<AzureOpenAIModelProvider> logger)
    {
        _httpClient = httpClientFactory.CreateClient("WebClient");
        _logger = logger;
        _apiKey = configuration["AIServices:AzureOpenAI:ApiKey"]
            ?? throw new InvalidOperationException("AIServices:AzureOpenAI:ApiKey is required.");

        var options = AzureOpenAIModelProviderOptions.FromConfiguration(configuration);
        ModelName = options.ModelName;
        _url = options.Url;
    }

    public async Task<string> SendAsync(string requestBody, CancellationToken cancellationToken)
    {
        _logger.LogInformation("Azure OpenAI request URL: {Url}", _url);
        return await InferenceTelemetry.InvokeAsync(requestBody, ModelName, "azure.openai", async () =>
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, _url);
            req.Headers.Add("api-key", _apiKey);
            req.Content = new StringContent(requestBody, Encoding.UTF8, "application/json");

            using var resp = await _httpClient.SendAsync(req, cancellationToken);
            if (!resp.IsSuccessStatusCode)
            {
                var err = await resp.Content.ReadAsStringAsync(cancellationToken);
                throw new HttpRequestException($"Azure OpenAI returned {resp.StatusCode}: {err}");
            }

            return await resp.Content.ReadAsStringAsync(cancellationToken);
        }).ConfigureAwait(false);
    }
}
