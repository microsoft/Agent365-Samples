// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Azure.Core;
using Azure.Identity;
using Microsoft.Agents.A365.Observability.Hosting.Caching;
using Microsoft.Identity.Client;

namespace GitHubTrending;

// Acquires an Observability API token for A365 observability via a 3-hop FMI chain.
//   Hop 1+2: Blueprint authenticates (MSI in prod, client secret locally) →
//            gets T1 via .WithFmiPath(agentId) to Agent Identity.
//   Hop 3:   Agent Identity uses T1 as assertion → Observability API token.
//            (ServiceIdentity type — AADSTS82001 does not apply.)
//
// Auth strategy is controlled by Agent365Observability:UseManagedIdentity:
//   true  (production)  — MSI → Blueprint FIC → Agent Identity → API
//   false (local dev)   — Client Secret → Blueprint FIC → Agent Identity → API
internal sealed class ObservabilityTokenService : BackgroundService
{
    private static readonly string[] FmiScopes = ["api://AzureADTokenExchange/.default"];
    private static readonly string[] ObservabilityScopes = ["api://9b975845-388f-4429-889e-eab1ef63949c/.default"];
    private static readonly TimeSpan RefreshInterval = TimeSpan.FromMinutes(50);

    private readonly IExporterTokenCache<string> _tokenCache;
    private readonly ILogger<ObservabilityTokenService> _logger;
    private readonly string _blueprintClientId, _blueprintClientSecret, _tenantId, _agentId;
    private readonly bool _useManagedIdentity;

    public ObservabilityTokenService(
        IExporterTokenCache<string> tokenCache,
        ILogger<ObservabilityTokenService> logger,
        IConfiguration configuration)
    {
        _tokenCache = tokenCache;
        _logger = logger;
        var obs = configuration.GetSection("Agent365Observability");
        _tenantId              = obs["TenantId"]     ?? throw new InvalidOperationException("Agent365Observability:TenantId is required.");
        _agentId               = obs["AgentId"]      ?? throw new InvalidOperationException("Agent365Observability:AgentId is required.");
        _blueprintClientId     = obs["ClientId"]     ?? throw new InvalidOperationException("Agent365Observability:ClientId is required.");
        _blueprintClientSecret = obs["ClientSecret"] ?? throw new InvalidOperationException("Agent365Observability:ClientSecret is required.");
        _useManagedIdentity    = obs.GetValue<bool>("UseManagedIdentity", true);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("ObservabilityTokenService started (UseManagedIdentity={UseMsi}).", _useManagedIdentity);
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await AcquireAndRegisterTokenAsync(stoppingToken); }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
            { _logger.LogWarning(ex, "Failed to acquire observability token; will retry in {Interval}.", RefreshInterval); }
            try { await Task.Delay(RefreshInterval, stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
        _logger.LogInformation("ObservabilityTokenService stopped.");
    }

    private async Task AcquireAndRegisterTokenAsync(CancellationToken ct)
    {
        string authority = $"https://login.microsoftonline.com/{_tenantId}";

        // Hop 1+2: Blueprint → T1 via FMI path
        string t1Token = _useManagedIdentity
            ? await AcquireT1ViaMsiAsync(authority, ct)
            : await AcquireT1ViaClientSecretAsync(authority, ct);

        // Hop 3: Agent Identity uses T1 → Observability API token
        var obsResult = await ConfidentialClientApplicationBuilder
            .Create(_agentId)
            .WithClientAssertion((AssertionRequestOptions _) => Task.FromResult(t1Token))
            .WithAuthority(new Uri(authority)).Build()
            .AcquireTokenForClient(ObservabilityScopes)
            .ExecuteAsync(ct);

        _tokenCache.RegisterObservability(_agentId, _tenantId, obsResult.AccessToken, ObservabilityScopes);
        _logger.LogInformation("Observability token registered for agent {AgentId}.", _agentId);
    }

    private async Task<string> AcquireT1ViaMsiAsync(string authority, CancellationToken ct)
    {
        // ManagedIdentityCredential.GetTokenAsync uses a resource URI (no /.default suffix).
        // FmiScopes uses /.default format — correct for MSAL AcquireTokenForClient.
        // These two forms are intentionally different; do not "fix" them to match.
        var assertion = await new ManagedIdentityCredential()
            .GetTokenAsync(new TokenRequestContext(["api://AzureADTokenExchange"]), ct);
        return (await ConfidentialClientApplicationBuilder
            .Create(_blueprintClientId)
            .WithClientAssertion((AssertionRequestOptions _) => Task.FromResult(assertion.Token))
            .WithAuthority(new Uri(authority)).Build()
            .AcquireTokenForClient(FmiScopes).WithFmiPath(_agentId)
            .ExecuteAsync(ct)).AccessToken;
    }

    private async Task<string> AcquireT1ViaClientSecretAsync(string authority, CancellationToken ct)
    {
        return (await ConfidentialClientApplicationBuilder
            .Create(_blueprintClientId)
            .WithClientSecret(_blueprintClientSecret)
            .WithAuthority(new Uri(authority)).Build()
            .AcquireTokenForClient(FmiScopes).WithFmiPath(_agentId)
            .ExecuteAsync(ct)).AccessToken;
    }
}
