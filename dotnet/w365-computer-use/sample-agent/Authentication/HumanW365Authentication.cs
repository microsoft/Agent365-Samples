// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Agents.Builder;
using Microsoft.AspNetCore.WebUtilities;

namespace W365ComputerUseSample.Authentication;

public sealed class HumanW365AuthenticationOptions
{
    public const string SectionName = "HumanW365Authentication";
    public bool Enabled { get; set; }
    public string? TenantId { get; set; }
    public string? ApplicationBaseUrl { get; set; }
}

public sealed record HumanW365Owner(Guid TenantId, Guid ObjectId);

public sealed class HumanW365Credential
{
    public required HumanW365Owner Owner { get; init; }
    public required string AccessToken { get; init; }
    public required DateTimeOffset ExpiresAt { get; init; }
    public override string ToString() => nameof(HumanW365Credential);
}

public enum HumanW365Completion
{
    Completed,
    InvalidOrExpiredHandoff,
    WrongOwner
}

// Turn context belongs to a single turn; never retain this in singleton state.
public sealed record HumanW365Turn(
    HumanW365Owner Owner,
    string GatewayUrl,
    ITurnContext TurnContext,
    HumanW365ChatAction? ChatAction = null,
    Action<string, string>? OnAuthorizationRequired = null);

public sealed class HumanW365AuthorizationStore : IDisposable
{
    internal static readonly TimeSpan TokenSafetyMargin = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan HandoffLifetime = TimeSpan.FromMinutes(5);
    private readonly object gate = new();
    private readonly Dictionary<string, Handoff> handoffs = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> pendingConversations = new(StringComparer.Ordinal);
    private readonly Dictionary<string, HumanW365Credential> credentials = new(StringComparer.Ordinal);
    private readonly TimeProvider timeProvider;
    private readonly ITimer cleanupTimer;
    private bool disposed;

    private sealed record Handoff(string ConversationKey, HumanW365Owner Owner, DateTimeOffset ExpiresAt);

    public HumanW365AuthorizationStore(TimeProvider? timeProvider = null)
    {
        this.timeProvider = timeProvider ?? TimeProvider.System;
        cleanupTimer = this.timeProvider.CreateTimer(_ => Cleanup(), null,
            TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
    }

    public string Issue(string conversationKey, HumanW365Owner owner, Uri origin)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(conversationKey);
        ArgumentNullException.ThrowIfNull(owner);
        ArgumentNullException.ThrowIfNull(origin);
        if (!origin.IsAbsoluteUri || origin.Scheme != Uri.UriSchemeHttps ||
            origin.AbsolutePath != "/" || origin.Query.Length != 0 ||
            origin.Fragment.Length != 0 || origin.UserInfo.Length != 0)
        {
            throw new ArgumentException("The configured origin must be an HTTPS root URL.", nameof(origin));
        }

        var code = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var hash = Hash(code);
        var signInPath = HumanW365AuthenticationEndpoints.SignInPath + "?code=" + Uri.EscapeDataString(code);
        var link = new Uri(origin, signInPath).AbsoluteUri;
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            RemoveHandoff(conversationKey);
            handoffs[hash] = new Handoff(conversationKey, owner, timeProvider.GetUtcNow() + HandoffLifetime);
            pendingConversations[conversationKey] = hash;
        }
        return link;
    }

    public bool IsPending(string code)
    {
        if (!IsValidCode(code))
            return false;
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            return handoffs.TryGetValue(Hash(code), out var handoff)
                && handoff.ExpiresAt > timeProvider.GetUtcNow();
        }
    }

    internal static bool IsValidCode(string? code) =>
        code is { Length: 43 } && code.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');

    public bool TryGet(string conversationKey, HumanW365Owner owner, out HumanW365Credential? credential)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            credential = null;
            if (!credentials.TryGetValue(conversationKey, out var saved))
                return false;
            if (saved.ExpiresAt <= timeProvider.GetUtcNow() + TokenSafetyMargin)
            {
                credentials.Remove(conversationKey);
                return false;
            }
            if (saved.Owner != owner)
                return false;
            credential = saved;
            return true;
        }
    }

    public HumanW365Completion Complete(string code, HumanW365Credential credential)
    {
        ArgumentNullException.ThrowIfNull(credential);
        // Generated codes have a fixed size; bound hashing of untrusted callback input.
        if (!IsValidCode(code))
            return HumanW365Completion.InvalidOrExpiredHandoff;
        var hash = Hash(code);
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            var now = timeProvider.GetUtcNow();
            if (!handoffs.TryGetValue(hash, out var handoff))
                return HumanW365Completion.InvalidOrExpiredHandoff;
            if (handoff.ExpiresAt <= now)
            {
                RemoveHandoff(handoff.ConversationKey);
                return HumanW365Completion.InvalidOrExpiredHandoff;
            }
            if (credential.Owner != handoff.Owner)
                return HumanW365Completion.WrongOwner;
            if (string.IsNullOrWhiteSpace(credential.AccessToken) ||
                credential.ExpiresAt <= now + TokenSafetyMargin)
                return HumanW365Completion.InvalidOrExpiredHandoff;
            credentials[handoff.ConversationKey] = credential;
            RemoveHandoff(handoff.ConversationKey);
            return HumanW365Completion.Completed;
        }
    }

    public void InvalidateCredential(string conversationKey)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            credentials.Remove(conversationKey);
        }
    }

    public void Remove(string conversationKey)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            credentials.Remove(conversationKey);
            RemoveHandoff(conversationKey);
        }
    }

    private static string Hash(string code) =>
        Convert.ToHexString(SHA256.HashData(Encoding.ASCII.GetBytes(code)));

    private void RemoveHandoff(string conversationKey)
    {
        if (pendingConversations.Remove(conversationKey, out var hash))
            handoffs.Remove(hash);
    }

    private void Cleanup()
    {
        lock (gate)
        {
            if (disposed)
                return;
            var now = timeProvider.GetUtcNow();
            foreach (var key in handoffs.Values.Where(handoff => handoff.ExpiresAt <= now)
                .Select(handoff => handoff.ConversationKey).ToArray())
                RemoveHandoff(key);
            foreach (var key in credentials.Where(pair => pair.Value.ExpiresAt <= now + TokenSafetyMargin)
                .Select(pair => pair.Key).ToArray())
                credentials.Remove(key);
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (disposed)
                return;
            disposed = true;
            handoffs.Clear();
            pendingConversations.Clear();
            credentials.Clear();
        }
        cleanupTimer.Dispose();
    }
}

/// <summary>
/// Checks token/principal consistency only, NOT signatures. Call only behind an independently
/// enforced trusted App Service EasyAuth boundary that authenticates and replaces these headers.
/// Reading headers here does not establish that boundary or authorize a production request.
/// </summary>
public static class HumanW365EasyAuth
{
    private const int MaximumTokenLength = 32 * 1024;
    private const string W365Audience = "da81128c-e5b5-4f9e-8d89-50d906f107c5";
    private const string TenantClaimUri = "http://schemas.microsoft.com/identity/claims/tenantid";
    private const string ObjectClaimUri = "http://schemas.microsoft.com/identity/claims/objectidentifier";

    public static bool TryReadOwner(HttpContext context, out HumanW365Owner? owner)
    {
        owner = null;
        if (!SingleHeader(context, "X-MS-CLIENT-PRINCIPAL", out var principal) ||
            principal.Length > MaximumTokenLength)
            return false;

        try
        {
            using var principalDocument = JsonDocument.Parse(Convert.FromBase64String(principal));
            var identity = principalDocument.RootElement;
            if (!UniqueObject(identity) || !StringProperty(identity, "auth_typ", out var authType) ||
                authType != "aad" || !identity.TryGetProperty("claims", out var claims) ||
                claims.ValueKind != JsonValueKind.Array)
                return false;

            string? tenant = null, objectId = null;
            foreach (var claim in claims.EnumerateArray())
            {
                if (!UniqueObject(claim) || !StringProperty(claim, "typ", out var type) ||
                    !StringProperty(claim, "val", out var value))
                    return false;
                if (type is "tid" or TenantClaimUri)
                {
                    if (tenant is not null) return false;
                    tenant = value;
                }
                if (type is "oid" or ObjectClaimUri)
                {
                    if (objectId is not null) return false;
                    objectId = value;
                }
            }
            if (!Guid.TryParse(tenant, out var tenantId) || !Guid.TryParse(objectId, out var userId))
                return false;
            owner = new HumanW365Owner(tenantId, userId);
            return true;
        }
        catch (FormatException) { return false; }
        catch (JsonException) { return false; }
    }

    public static bool TryReadCredential(HttpContext context, out HumanW365Credential? credential,
        TimeProvider? timeProvider = null)
    {
        credential = null;
        if (!TryReadOwner(context, out var owner) ||
            !SingleHeader(context, "X-MS-TOKEN-AAD-ACCESS-TOKEN", out var token) ||
            token.Length > MaximumTokenLength)
            return false;

        try
        {
            var segments = token.Split('.');
            if (segments.Length != 3 || segments.Any(segment => segment.Length == 0 ||
                segment.Length % 4 == 1 || segment.Any(c => !char.IsAsciiLetterOrDigit(c) && c != '-' && c != '_')))
                return false;
            using var header = JsonDocument.Parse(WebEncoders.Base64UrlDecode(segments[0]));
            using var payload = JsonDocument.Parse(WebEncoders.Base64UrlDecode(segments[1]));
            var jwt = payload.RootElement;
            if (!UniqueObject(header.RootElement) || !UniqueObject(jwt) ||
                !StringProperty(jwt, "tid", out var jwtTenant) || !Guid.TryParse(jwtTenant, out var tokenTenant) ||
                !StringProperty(jwt, "oid", out var jwtUser) || !Guid.TryParse(jwtUser, out var tokenUser) ||
                tokenTenant != owner!.TenantId || tokenUser != owner.ObjectId ||
                !StringProperty(jwt, "aud", out var audience) ||
                (audience != W365Audience && audience != "api://" + W365Audience) ||
                !StringProperty(jwt, "scp", out var scopes) ||
                !scopes.Split(' ', StringSplitOptions.RemoveEmptyEntries).Contains("Tools.ListInvoke.All",
                    StringComparer.Ordinal))
                return false;
            if (jwt.TryGetProperty("idtyp", out var idtyp) &&
                (idtyp.ValueKind != JsonValueKind.String || idtyp.GetString() == "app"))
                return false;

            var now = (timeProvider ?? TimeProvider.System).GetUtcNow();
            if (!NumericDate(jwt, "exp", out var expiresAt) ||
                (jwt.TryGetProperty("nbf", out _) &&
                    (!NumericDate(jwt, "nbf", out var notBefore) || notBefore > now)))
                return false;
            if (context.Request.Headers.ContainsKey("X-MS-TOKEN-AAD-EXPIRES-ON"))
            {
                if (!SingleHeader(context, "X-MS-TOKEN-AAD-EXPIRES-ON", out var providerExpiry) ||
                    !DateTimeOffset.TryParse(providerExpiry, CultureInfo.InvariantCulture,
                        DateTimeStyles.AssumeUniversal, out var providerExpiresAt))
                    return false;
                if (providerExpiresAt < expiresAt)
                    expiresAt = providerExpiresAt;
            }
            if (expiresAt <= now + HumanW365AuthorizationStore.TokenSafetyMargin)
                return false;
            credential = new HumanW365Credential
            {
                Owner = owner!, AccessToken = token, ExpiresAt = expiresAt
            };
            return true;
        }
        catch (FormatException) { return false; }
        catch (JsonException) { return false; }
        catch (ArgumentOutOfRangeException) { return false; }
    }

    private static bool SingleHeader(HttpContext context, string name, out string value)
    {
        value = string.Empty;
        if (!context.Request.Headers.TryGetValue(name, out var values) ||
            values.Count != 1 || string.IsNullOrWhiteSpace(values[0]))
            return false;
        value = values[0]!;
        return true;
    }

    private static bool UniqueObject(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object)
            return false;
        var names = new HashSet<string>(StringComparer.Ordinal);
        return element.EnumerateObject().All(property => names.Add(property.Name));
    }

    private static bool StringProperty(JsonElement element, string name, out string value)
    {
        value = string.Empty;
        if (!element.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.String)
            return false;
        value = property.GetString()!;
        return true;
    }

    private static bool NumericDate(JsonElement element, string name, out DateTimeOffset value)
    {
        value = default;
        if (!element.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.Number ||
            !property.TryGetInt64(out var seconds))
            return false;
        value = DateTimeOffset.FromUnixTimeSeconds(seconds);
        return true;
    }
}
