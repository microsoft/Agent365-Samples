// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Agent365.Samples.Observability;

internal sealed class ObservabilityAppTokenOptions
{
    public string TenantId { get; }
    public string AgentId { get; }
    public string BlueprintClientId { get; }
    public string? BlueprintClientSecret { get; }
    public bool UseManagedIdentity { get; }
    public string? ManagedIdentityClientId { get; }

    public ObservabilityAppTokenOptions(
        string? tenantId,
        string? agentId,
        string? blueprintClientId,
        string? blueprintClientSecret,
        bool useManagedIdentity = false,
        string? managedIdentityClientId = null)
    {
        TenantId = RequireId(tenantId, "TenantId");
        AgentId = RequireId(agentId, "AgentId");
        BlueprintClientId = RequireId(blueprintClientId, "BlueprintClientId");
        if (AgentId == BlueprintClientId)
        {
            throw new InvalidOperationException("Agent365Observability:AgentId must be the agent instance client ID, not the blueprint client ID.");
        }

        UseManagedIdentity = useManagedIdentity;
        if (!useManagedIdentity && IsMissingOrPlaceholder(blueprintClientSecret))
        {
            throw new InvalidOperationException("Agent365Observability:BlueprintClientSecret is required when UseManagedIdentity is false.");
        }

        BlueprintClientSecret = useManagedIdentity ? null : blueprintClientSecret;
        ManagedIdentityClientId = string.IsNullOrEmpty(managedIdentityClientId)
            ? null
            : RequireId(managedIdentityClientId, "ManagedIdentityClientId");
    }

    public static ObservabilityAppTokenOptions FromConfiguration(Func<string, string?> read)
    {
        var useManagedIdentity = read("Agent365Observability:UseManagedIdentity");
        if (!string.IsNullOrEmpty(useManagedIdentity) && !bool.TryParse(useManagedIdentity, out _))
        {
            throw new InvalidOperationException("Agent365Observability:UseManagedIdentity must be true or false.");
        }

        return new(
            read("Agent365Observability:TenantId"),
            read("Agent365Observability:AgentId"),
            read("Agent365Observability:BlueprintClientId"),
            read("Agent365Observability:BlueprintClientSecret"),
            bool.TryParse(useManagedIdentity, out var enabled) && enabled,
            read("Agent365Observability:ManagedIdentityClientId"));
    }

    private static string RequireId(string? value, string name)
    {
        if (!Guid.TryParseExact(value, "D", out var id) || id == Guid.Empty)
        {
            throw new InvalidOperationException($"Agent365Observability:{name} must be an explicit, non-placeholder GUID.");
        }
        return id.ToString();
    }

    private static bool IsMissingOrPlaceholder(string? value) =>
        string.IsNullOrWhiteSpace(value)
        || value.Contains('<') || value.Contains('>') || value.Contains('{') || value.Contains('}')
        || value.Contains("placeholder", StringComparison.OrdinalIgnoreCase)
        || value.StartsWith("your-", StringComparison.OrdinalIgnoreCase)
        || value.StartsWith("your_", StringComparison.OrdinalIgnoreCase)
        || value.Equals("changeme", StringComparison.OrdinalIgnoreCase);
}

/// <summary>
/// A single configured agent's OBS-only app token cache. Never consumes user/OBO tokens.
/// Implements the documented blueprint FMI -> agent client_credentials protocol.
/// </summary>
internal sealed class ObservabilityAppTokenProvider : IDisposable
{
    public const string ObservabilityResource = "9b975845-388f-4429-889e-eab1ef63949c";
    public const string ObservabilityScope = "api://" + ObservabilityResource + "/.default";
    public const string ExchangeScope = "api://AzureADTokenExchange/.default";
    public const string AssertionType = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
    private static readonly TimeSpan RefreshSkew = TimeSpan.FromMinutes(2);
    private readonly ObservabilityAppTokenOptions _options;
    private readonly HttpClient _httpClient;
    private readonly TimeProvider _time;
    private readonly Func<CancellationToken, Task<string>>? _managedIdentityAssertion;
    private readonly TimeSpan _requestTimeout;
    private readonly SemaphoreSlim _refreshLock = new(1, 1);
    private TokenResult? _cachedToken;

    // The provider owns the dedicated client; it must not be shared with business APIs.
    public ObservabilityAppTokenProvider(
        ObservabilityAppTokenOptions options,
        HttpClient httpClient,
        TimeProvider? timeProvider = null,
        Func<CancellationToken, Task<string>>? managedIdentityAssertion = null,
        TimeSpan? requestTimeout = null)
    {
        _options = options;
        _httpClient = httpClient;
        _time = timeProvider ?? TimeProvider.System;
        _managedIdentityAssertion = managedIdentityAssertion;
        _requestTimeout = requestTimeout ?? TimeSpan.FromSeconds(30);
        if (_requestTimeout <= TimeSpan.Zero || _requestTimeout > TimeSpan.FromMinutes(2))
        {
            throw new ArgumentOutOfRangeException(nameof(requestTimeout));
        }
        if (options.UseManagedIdentity && managedIdentityAssertion is null)
        {
            throw new InvalidOperationException("Observability managed identity assertion provider is required.");
        }
    }

    public Task<string?> ResolveAsync(string agentId, string tenantId) =>
        GetTokenAsync(agentId, tenantId);

    public async Task<string?> GetTokenAsync(string agentId, string tenantId, CancellationToken cancellationToken = default)
    {
        if (!string.Equals(agentId, _options.AgentId, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(tenantId, _options.TenantId, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Observability export tenant/agent does not match the configured OBS identity.");
        }

        // Bound both waiting for another refresh and the complete credential exchange.
        using var timeout = new CancellationTokenSource(_requestTimeout, _time);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
        var lockTaken = false;
        try
        {
            await _refreshLock.WaitAsync(linked.Token).ConfigureAwait(false);
            lockTaken = true;
            if (_cachedToken is not null && _cachedToken.ExpiresAt > _time.GetUtcNow() + RefreshSkew)
            {
                return _cachedToken.AccessToken;
            }

            // A failed refresh must never return the old token, even inside the refresh window.
            _cachedToken = null;
            var blueprintParameters = new Dictionary<string, string>
            {
                ["client_id"] = _options.BlueprintClientId,
                ["scope"] = ExchangeScope,
                ["grant_type"] = "client_credentials",
                ["fmi_path"] = _options.AgentId,
            };
            if (_options.UseManagedIdentity)
            {
                var assertion = await _managedIdentityAssertion!(linked.Token).ConfigureAwait(false);
                if (string.IsNullOrWhiteSpace(assertion))
                {
                    throw new InvalidOperationException();
                }
                blueprintParameters["client_assertion_type"] = AssertionType;
                blueprintParameters["client_assertion"] = assertion;
            }
            else
            {
                blueprintParameters["client_secret"] = _options.BlueprintClientSecret!;
            }

            var blueprintToken = await RequestTokenAsync(blueprintParameters, linked.Token).ConfigureAwait(false);
            var agentToken = await RequestTokenAsync(new Dictionary<string, string>
            {
                ["client_id"] = _options.AgentId,
                ["scope"] = ObservabilityScope,
                ["grant_type"] = "client_credentials",
                ["client_assertion_type"] = AssertionType,
                ["client_assertion"] = blueprintToken.AccessToken,
            }, linked.Token).ConfigureAwait(false);

            var expiresAt = ValidateAgentToken(agentToken);
            linked.Token.ThrowIfCancellationRequested();
            _cachedToken = agentToken with { ExpiresAt = expiresAt };
            return _cachedToken.AccessToken;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw new OperationCanceledException("Observability token acquisition canceled.", cancellationToken);
        }
        catch (Exception)
        {
            // No exception bodies/inner exceptions: identity SDK and HTTP failures can contain credentials.
            throw new InvalidOperationException("Observability app token acquisition failed; check OBS configuration, credentials and application authorization.");
        }
        finally
        {
            if (lockTaken)
            {
                _refreshLock.Release();
            }
        }
    }

    private async Task<TokenResult> RequestTokenAsync(Dictionary<string, string> parameters, CancellationToken cancellationToken)
    {
        // This origin is fixed; redirects are disabled by the production client factory.
        using var request = new HttpRequestMessage(HttpMethod.Post,
            $"https://login.microsoftonline.com/{_options.TenantId}/oauth2/v2.0/token")
        {
            Content = new FormUrlEncodedContent(parameters),
        };
        var requestedAt = _time.GetUtcNow();
        using var response = await _httpClient.SendAsync(request, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException();
        }

        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false));
        var root = document.RootElement;
        var token = root.GetProperty("access_token").GetString();
        if (string.IsNullOrWhiteSpace(token)
            || !string.Equals(root.GetProperty("token_type").GetString(), "Bearer", StringComparison.OrdinalIgnoreCase)
            || !root.GetProperty("expires_in").TryGetInt64(out var expiresIn)
            || expiresIn <= 0)
        {
            throw new InvalidOperationException();
        }
        var expiresAt = requestedAt.AddSeconds(expiresIn);
        if (expiresAt <= _time.GetUtcNow() + RefreshSkew)
        {
            throw new InvalidOperationException();
        }
        return new(token, expiresAt);
    }

    private DateTimeOffset ValidateAgentToken(TokenResult token)
    {
        // Sanity-check the token received directly from Entra. This is not signature validation;
        // the receiving OBS API is responsible for authenticating/authorizing the access token.
        var parts = token.AccessToken.Split('.');
        if (parts.Length != 3 || parts.Any(string.IsNullOrWhiteSpace))
        {
            throw new InvalidOperationException();
        }
        var payload = parts[1].Replace('-', '+').Replace('_', '/');
        payload = payload.PadRight((payload.Length + 3) / 4 * 4, '=');
        using var document = JsonDocument.Parse(Convert.FromBase64String(payload));
        var claims = document.RootElement;
        var hasClientId = false;
        foreach (var claimName in new[] { "appid", "azp" })
        {
            if (claims.TryGetProperty(claimName, out var clientId))
            {
                hasClientId = true;
                if (!string.Equals(clientId.GetString(), _options.AgentId, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException();
                }
            }
        }
        var audience = claims.GetProperty("aud").GetString();
        if (!hasClientId
            || !string.Equals(claims.GetProperty("tid").GetString(), _options.TenantId, StringComparison.OrdinalIgnoreCase)
            || (audience != ObservabilityResource && audience != "api://" + ObservabilityResource)
            || claims.TryGetProperty("scp", out _)
            || (claims.TryGetProperty("idtyp", out var identityType) && identityType.GetString() != "app")
            || !claims.TryGetProperty("roles", out var roles)
            || roles.ValueKind != JsonValueKind.Array
            || !roles.EnumerateArray().Any(role => role.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(role.GetString())))
        {
            throw new InvalidOperationException();
        }

        var jwtExpiry = DateTimeOffset.FromUnixTimeSeconds(claims.GetProperty("exp").GetInt64());
        var expiresAt = jwtExpiry < token.ExpiresAt ? jwtExpiry : token.ExpiresAt;
        if (expiresAt <= _time.GetUtcNow() + RefreshSkew)
        {
            throw new InvalidOperationException();
        }
        return expiresAt;
    }

    public void Dispose()
    {
        _cachedToken = null;
        _refreshLock.Dispose();
        _httpClient.Dispose();
    }

    private sealed record TokenResult(string AccessToken, DateTimeOffset ExpiresAt);
}
