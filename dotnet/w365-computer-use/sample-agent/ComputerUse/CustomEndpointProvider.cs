// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Net.Http.Headers;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Microsoft.Identity.Client;

namespace W365ComputerUseSample.ComputerUse;

/// <summary>
/// Sends CUA model requests via a local or custom model endpoint.
/// Supports certificate-based MSAL authentication for secured endpoints.
/// </summary>
public class CustomEndpointProvider : ICuaModelProvider
{
    private readonly HttpClient _httpClient;
    private readonly string _endpoint;
    private readonly string _customerId;
    private readonly string? _modelTenantId;
    private readonly string? _clientPrincipalId;
    private readonly string? _partnerSource;
    private readonly IConfidentialClientApplication? _msalApp;
    private readonly string _scope;
    private string? _cachedToken;
    private DateTime _tokenExpiry = DateTime.MinValue;

    public string ModelName { get; }

    public CustomEndpointProvider(IHttpClientFactory httpClientFactory, IConfiguration configuration, ILogger<CustomEndpointProvider> logger)
    {
        _httpClient = httpClientFactory.CreateClient("WebClient");
        _endpoint = configuration["AIServices:CustomEndpoint:Endpoint"]
            ?? throw new InvalidOperationException("AIServices:CustomEndpoint:Endpoint is required.");
        _customerId = configuration["AIServices:CustomEndpoint:CustomerId"]
            ?? throw new InvalidOperationException("AIServices:CustomEndpoint:CustomerId is required.");
        _scope = configuration["AIServices:CustomEndpoint:Scope"]
            ?? throw new InvalidOperationException("AIServices:CustomEndpoint:Scope is required.");
        ModelName = configuration["AIServices:CustomEndpoint:Model"] ?? "computer-use-preview-2025-03-11";
        _modelTenantId = configuration["AIServices:CustomEndpoint:ModelTenantId"];
        _clientPrincipalId = configuration["AIServices:CustomEndpoint:ClientPrincipalId"];
        _partnerSource = configuration["AIServices:CustomEndpoint:PartnerSource"];

        // Initialize MSAL with certificate
        var certSubject = configuration["AIServices:CustomEndpoint:CertificateSubject"] ?? "";
        var clientId = configuration["AIServices:CustomEndpoint:ClientId"] ?? "";
        var tenantId = configuration["AIServices:CustomEndpoint:TenantId"] ?? "";

        var cert = LoadCertificate(certSubject);
        if (cert != null)
        {
            _msalApp = ConfidentialClientApplicationBuilder
                .Create(clientId)
                .WithAuthority($"https://login.microsoftonline.com/{tenantId}")
                .WithCertificate(cert)
                .Build();
            logger.LogInformation("CustomEndpoint MSAL initialized with certificate '{Subject}'", certSubject);
        }
        else
        {
            logger.LogWarning("CustomEndpoint certificate '{Subject}' not found. Auth will fail at runtime.", certSubject);
        }
    }

    public async Task<string> SendAsync(string requestBody, CancellationToken cancellationToken)
    {
        var url = $"{_endpoint.TrimEnd('/')}/v0/resourceproxy/tenantId.{_customerId}/azureopenai/responses";
        var token = await GetTokenAsync();

        using var req = new HttpRequestMessage(HttpMethod.Post, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.TryAddWithoutValidation("x-ms-client-principal-id", _clientPrincipalId);
        req.Headers.TryAddWithoutValidation("x-ms-client-tenant-id", _modelTenantId);
        req.Headers.TryAddWithoutValidation("X-ms-Source",
            JsonSerializer.Serialize(new { consumptionSource = "Api", partnerSource = _partnerSource ?? "BICEvaluationService" }));
        req.Content = new StringContent(requestBody, Encoding.UTF8, "application/json");

        var resp = await _httpClient.SendAsync(req, cancellationToken);
        if (!resp.IsSuccessStatusCode)
        {
            var err = await resp.Content.ReadAsStringAsync(cancellationToken);
            throw new HttpRequestException($"CustomEndpoint returned {resp.StatusCode}: {err}");
        }

        return await resp.Content.ReadAsStringAsync(cancellationToken);
    }

    private async Task<string> GetTokenAsync()
    {
        if (!string.IsNullOrEmpty(_cachedToken) && DateTime.UtcNow < _tokenExpiry.AddMinutes(-5))
            return _cachedToken;

        if (_msalApp == null)
            throw new InvalidOperationException("MSAL not initialized. Check CustomEndpoint certificate configuration.");

        var result = await _msalApp
            .AcquireTokenForClient(new[] { _scope })
            .WithSendX5C(true)
            .ExecuteAsync();

        _cachedToken = result.AccessToken;
        _tokenExpiry = result.ExpiresOn.DateTime;
        return _cachedToken;
    }

    private static X509Certificate2? LoadCertificate(string subject)
    {
        if (string.IsNullOrEmpty(subject)) return null;
        foreach (var location in new[] { StoreLocation.CurrentUser, StoreLocation.LocalMachine })
        {
            using var store = new X509Store(StoreName.My, location);
            store.Open(OpenFlags.ReadOnly);
            var certs = store.Certificates.Find(X509FindType.FindBySubjectName, subject, false);
            if (certs.Count > 0) return certs[0];
        }
        return null;
    }
}
