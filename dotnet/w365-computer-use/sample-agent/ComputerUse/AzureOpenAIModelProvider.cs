// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Text;

namespace W365ComputerUseSample.ComputerUse;

/// <summary>
/// Sends CUA model requests to Azure OpenAI using an API key.
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
        var endpoint = configuration["AIServices:AzureOpenAI:Endpoint"]
            ?? throw new InvalidOperationException("AIServices:AzureOpenAI:Endpoint is required.");
        _apiKey = configuration["AIServices:AzureOpenAI:ApiKey"]
            ?? throw new InvalidOperationException("AIServices:AzureOpenAI:ApiKey is required.");
        var apiVersion = configuration["AIServices:AzureOpenAI:ApiVersion"] ?? "2025-04-01-preview";

        // DeploymentName = deployment-based URL; ModelName = model-based URL (model sent in body)
        var deploymentName = configuration["AIServices:AzureOpenAI:DeploymentName"];
        ModelName = configuration["AIServices:AzureOpenAI:ModelName"]
            ?? deploymentName
            ?? "computer-use-preview";

        if (!string.IsNullOrEmpty(deploymentName))
        {
            _url = $"{endpoint.TrimEnd('/')}/openai/deployments/{deploymentName}/responses?api-version={apiVersion}";
        }
        else
        {
            // Model-based endpoint — model name goes in the request body, not the URL
            _url = $"{endpoint.TrimEnd('/')}/openai/responses?api-version={apiVersion}";
        }
    }

    public async Task<string> SendAsync(string requestBody, CancellationToken cancellationToken)
    {
        _logger.LogInformation("Azure OpenAI request URL: {Url}", _url);
        using var req = new HttpRequestMessage(HttpMethod.Post, _url);
        req.Headers.Add("api-key", _apiKey);
        req.Content = new StringContent(requestBody, Encoding.UTF8, "application/json");

        var resp = await _httpClient.SendAsync(req, cancellationToken);
        if (!resp.IsSuccessStatusCode)
        {
            var err = await resp.Content.ReadAsStringAsync(cancellationToken);
            throw new HttpRequestException($"Azure OpenAI returned {resp.StatusCode}: {err}");
        }

        return await resp.Content.ReadAsStringAsync(cancellationToken);
    }
}
