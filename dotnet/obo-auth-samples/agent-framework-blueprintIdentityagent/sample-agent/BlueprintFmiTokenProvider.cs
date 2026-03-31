using Azure.Core;
using Microsoft.Agents.Authentication;
using Microsoft.Agents.Authentication.Msal;
using Microsoft.Agents.Authentication.Msal.Model;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Identity.Client;
using Microsoft.Identity.Client.AppConfig;

namespace Agent365AgentFrameworkSampleAgent;

/// <summary>
/// Custom IAccessTokenProvider that authenticates as the Identity App via the Blueprint FMI path.
/// 
/// Token flow:
/// 1. MI (FIC) → Blueprint ConfidentialClient
/// 2. Blueprint.AcquireTokenForClient("api://AzureAdTokenExchange/.default").WithFmiPath(identityAppId) → T1
/// 3. New ConfidentialClient(identityAppId, T1 as assertion).AcquireTokenForClient(resource) → final token
/// </summary>
public class BlueprintFmiTokenProvider : IAccessTokenProvider
{
    private readonly MsalAuth _msalAuth;
    private readonly string _identityAppId;
    private readonly string _tenantId;
    private readonly ILogger _logger;

    public ImmutableConnectionSettings ConnectionSettings => _msalAuth.ConnectionSettings;

    public BlueprintFmiTokenProvider(
        IServiceProvider serviceProvider,
        IConfigurationSection blueprintConnectionSection,
        string identityAppId,
        string tenantId,
        ILogger<BlueprintFmiTokenProvider> logger)
    {
        _msalAuth = new MsalAuth(serviceProvider, blueprintConnectionSection);
        _identityAppId = identityAppId;
        _tenantId = tenantId;
        _logger = logger;
    }

    public async Task<string> GetAccessTokenAsync(string resourceUrl, IList<string> scopes, bool forceRefresh = false)
    {
        _logger.LogInformation("BlueprintFmiTokenProvider: Acquiring token for resource={Resource} via FMI path (Identity={Identity})",
            resourceUrl, _identityAppId);

        // Step 1: Get Blueprint T1 token with FMI path to Identity
        // MsalAuth uses FederatedCredentials (MI FIC → Blueprint), then WithFmiPath impersonates Identity
        string t1Token = await _msalAuth.GetAgenticApplicationTokenAsync(_tenantId, _identityAppId);
        _logger.LogInformation("BlueprintFmiTokenProvider: Got T1 token (Blueprint→Identity) via FMI path");

        // Step 2: Use T1 as client assertion for Identity App to acquire resource token
        string authority = $"https://login.microsoftonline.com/{_tenantId}";
        var identityClient = ConfidentialClientApplicationBuilder
            .Create(_identityAppId)
            .WithClientAssertion((AssertionRequestOptions _) => Task.FromResult(t1Token))
            .WithAuthority(authority)
            .Build();

        // Resolve scopes: use provided scopes, or default to resourceUrl/.default
        string[] tokenScopes;
        if (scopes != null && scopes.Count > 0)
        {
            tokenScopes = scopes.ToArray();
        }
        else
        {
            tokenScopes = [$"{resourceUrl.TrimEnd('/')}/.default"];
        }

        var result = await identityClient
            .AcquireTokenForClient(tokenScopes)
            .ExecuteAsync();

        _logger.LogInformation("BlueprintFmiTokenProvider: Acquired resource token as Identity App. ExpiresOn={Expiry}",
            result.ExpiresOn);
        return result.AccessToken;
    }

    /// <summary>
    /// Performs an OBO exchange: uses the FMI-path T1 as the client credential and
    /// the caller-supplied user assertion token to acquire a delegated token for the
    /// requested downstream scopes.
    /// </summary>
    public async Task<string> GetOnBehalfOfAccessTokenAsync(IList<string> scopes, string userAssertionToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(userAssertionToken);
        if (scopes == null || scopes.Count == 0)
            throw new ArgumentException("At least one scope is required for OBO token acquisition.", nameof(scopes));

        _logger.LogInformation(
            "BlueprintFmiTokenProvider: Acquiring OBO token via FMI path (Identity={Identity}, ScopeCount={ScopeCount})",
            _identityAppId, scopes.Count);

        // Step 1: Bootstrap the child identity with an FMI-path assertion (T1).
        string t1Token = await _msalAuth.GetAgenticApplicationTokenAsync(_tenantId, _identityAppId);

        // Step 2: OBO exchange as the Identity App using the user assertion.
        string authority = $"https://login.microsoftonline.com/{_tenantId}";
        var identityClient = ConfidentialClientApplicationBuilder
            .Create(_identityAppId)
            .WithClientAssertion((AssertionRequestOptions _) => Task.FromResult(t1Token))
            .WithAuthority(authority)
            .Build();

        var result = await identityClient
            .AcquireTokenOnBehalfOf(scopes.ToArray(), new UserAssertion(userAssertionToken))
            .ExecuteAsync();

        _logger.LogInformation(
            "BlueprintFmiTokenProvider: Acquired OBO resource token. ExpiresOn={Expiry}",
            result.ExpiresOn);
        return result.AccessToken;
    }

    public TokenCredential GetTokenCredential()
    {
        return _msalAuth.GetTokenCredential();
    }
}
