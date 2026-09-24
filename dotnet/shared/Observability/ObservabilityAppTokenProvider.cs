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

// Expected credential or token-data failures never retain secret-bearing diagnostics.
internal sealed class ObservabilityTokenAcquisitionException : Exception
{
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
                    throw new ObservabilityTokenAcquisitionException();
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
        catch (OperationCanceledException)
        {
            throw AcquisitionFailure();
        }
        catch (HttpRequestException)
        {
            throw AcquisitionFailure();
        }
        catch (ObservabilityTokenAcquisitionException)
        {
            throw AcquisitionFailure();
        }
        catch (System.Security.Cryptography.CryptographicException)
        {
            // Certificate/assertion failures from the identity SDK can carry secrets.
            throw AcquisitionFailure();
        }
        catch (System.IO.IOException)
        {
            // Network I/O errors can carry request URLs or credentials in messages.
            throw AcquisitionFailure();
        }
        catch (Exception e) when (e is not InvalidOperationException
            && e is not NullReferenceException
            && e is not ArgumentException
            && e is not KeyNotFoundException
            && e is not OverflowException)
        {
            // Programming failures (InvalidOperation/NullReference/Argument/KeyNotFound/Overflow)
            // propagate as-is so bugs are diagnosable. Any other exception type is treated as a
            // credential-adjacent failure and sanitized to preserve the "never leak secrets"
            // guarantee for outward diagnostics.
            throw AcquisitionFailure();
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
            throw new ObservabilityTokenAcquisitionException();
        }

        using var document = ParseResponseJson(await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false));
        var root = document.RootElement;
        var token = RequiredString(root, "access_token");
        var expiresIn = RequiredInt64(root, "expires_in");
        if (string.IsNullOrWhiteSpace(token)
            || !string.Equals(RequiredString(root, "token_type"), "Bearer", StringComparison.OrdinalIgnoreCase)
            || expiresIn <= 0)
        {
            throw new ObservabilityTokenAcquisitionException();
        }
        DateTimeOffset expiresAt;
        try
        {
            expiresAt = requestedAt.AddSeconds(expiresIn);
        }
        catch (ArgumentOutOfRangeException)
        {
            throw new ObservabilityTokenAcquisitionException();
        }
        if (expiresAt <= _time.GetUtcNow() + RefreshSkew)
        {
            throw new ObservabilityTokenAcquisitionException();
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
            throw new ObservabilityTokenAcquisitionException();
        }
        var payload = parts[1].Replace('-', '+').Replace('_', '/');
        payload = payload.PadRight((payload.Length + 3) / 4 * 4, '=');
        using var document = ParseTokenPayload(payload);
        var claims = document.RootElement;
        if (claims.ValueKind != JsonValueKind.Object)
        {
            throw new ObservabilityTokenAcquisitionException();
        }
        var hasClientId = false;
        foreach (var claimName in new[] { "appid", "azp" })
        {
            if (claims.TryGetProperty(claimName, out var clientId))
            {
                hasClientId = true;
                if (clientId.ValueKind != JsonValueKind.String
                    || !string.Equals(clientId.GetString(), _options.AgentId, StringComparison.OrdinalIgnoreCase))
                {
                    throw new ObservabilityTokenAcquisitionException();
                }
            }
        }
        var audience = RequiredString(claims, "aud");
        var hasIdentityType = claims.TryGetProperty("idtyp", out var identityType);
        var hasRoles = claims.TryGetProperty("roles", out var roles);
        // Delegated tokens always carry scp; app-only tokens never do. In addition to
        // idtyp=app and valid nonempty roles, accept oid==sub because Entra emits
        // matching oid/sub only for application principals; delegated tokens have oid != sub.
        var oid = claims.TryGetProperty("oid", out var oidClaim) && oidClaim.ValueKind == JsonValueKind.String
            ? oidClaim.GetString()
            : null;
        var sub = claims.TryGetProperty("sub", out var subClaim) && subClaim.ValueKind == JsonValueKind.String
            ? subClaim.GetString()
            : null;
        var oidEqualsSub = !string.IsNullOrEmpty(oid) && string.Equals(oid, sub, StringComparison.Ordinal);
        var hasAppOnlySignal = (hasIdentityType && identityType.ValueKind == JsonValueKind.String && identityType.GetString() == "app")
            || (!hasIdentityType && hasRoles && roles.ValueKind == JsonValueKind.Array && roles.GetArrayLength() > 0)
            || (!hasIdentityType && oidEqualsSub);
        if (!hasClientId
            || !string.Equals(RequiredString(claims, "tid"), _options.TenantId, StringComparison.OrdinalIgnoreCase)
            || (audience != ObservabilityResource && audience != "api://" + ObservabilityResource)
            || claims.TryGetProperty("scp", out _)
            || (hasIdentityType && (identityType.ValueKind != JsonValueKind.String || identityType.GetString() != "app"))
            || (hasRoles && (roles.ValueKind != JsonValueKind.Array
                || roles.EnumerateArray().Any(role => role.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(role.GetString()))))
            || !hasAppOnlySignal)
        {
            throw new ObservabilityTokenAcquisitionException();
        }

        var expirySeconds = RequiredInt64(claims, "exp");
        DateTimeOffset jwtExpiry;
        try
        {
            jwtExpiry = DateTimeOffset.FromUnixTimeSeconds(expirySeconds);
        }
        catch (ArgumentOutOfRangeException)
        {
            throw new ObservabilityTokenAcquisitionException();
        }
        var expiresAt = jwtExpiry < token.ExpiresAt ? jwtExpiry : token.ExpiresAt;
        if (expiresAt <= _time.GetUtcNow() + RefreshSkew)
        {
            throw new ObservabilityTokenAcquisitionException();
        }
        return expiresAt;
    }

    private static JsonDocument ParseResponseJson(string json)
    {
        try
        {
            return JsonDocument.Parse(json);
        }
        catch (JsonException)
        {
            throw new ObservabilityTokenAcquisitionException();
        }
    }

    private static JsonDocument ParseTokenPayload(string payload)
    {
        try
        {
            return JsonDocument.Parse(Convert.FromBase64String(payload));
        }
        catch (FormatException)
        {
            throw new ObservabilityTokenAcquisitionException();
        }
        catch (JsonException)
        {
            throw new ObservabilityTokenAcquisitionException();
        }
    }

    private static JsonElement RequiredProperty(JsonElement value, string name)
    {
        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty(name, out var property))
        {
            throw new ObservabilityTokenAcquisitionException();
        }
        return property;
    }

    private static string? RequiredString(JsonElement value, string name)
    {
        var property = RequiredProperty(value, name);
        if (property.ValueKind != JsonValueKind.String)
        {
            throw new ObservabilityTokenAcquisitionException();
        }
        return property.GetString();
    }

    private static long RequiredInt64(JsonElement value, string name)
    {
        var property = RequiredProperty(value, name);
        if (property.ValueKind != JsonValueKind.Number || !property.TryGetInt64(out var number))
        {
            throw new ObservabilityTokenAcquisitionException();
        }
        return number;
    }

    // Identity SDK and HTTP failures can contain credentials; never attach them as inner exceptions.
    private static InvalidOperationException AcquisitionFailure() =>
        new("Observability app token acquisition failed; check OBS configuration, credentials and application authorization.");

    public void Dispose()
    {
        _cachedToken = null;
        _refreshLock.Dispose();
        _httpClient.Dispose();
    }

    private sealed record TokenResult(string AccessToken, DateTimeOffset ExpiresAt);
}
