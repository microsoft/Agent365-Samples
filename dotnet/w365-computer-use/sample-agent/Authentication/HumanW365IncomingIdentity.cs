// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Security.Claims;
using System.IdentityModel.Tokens.Jwt;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;

namespace W365ComputerUseSample.Authentication;

internal sealed class HumanW365IncomingIdentity : ClaimsIdentity
{
    private const string Agent365PlatformApplicationId = "5a807f24-c9de-44ee-a3a7-329e88a00ffc";

    internal IReadOnlyList<Claim> ValidatedClaims { get; }

    private HumanW365IncomingIdentity(ClaimsIdentity identity, ClaimsPrincipal principal)
        : base(identity.Claims, identity.AuthenticationType, identity.NameClaimType, identity.RoleClaimType)
    {
        ValidatedClaims = Array.AsReadOnly(principal.Claims.Select(claim => claim.Clone()).ToArray());
    }

    internal bool AttestsTeamsSender(string issuer, Guid tenantId, string? channelId)
    {
        if (!IsAuthenticated || tenantId == Guid.Empty || !IsTeamsChannel(channelId))
            return false;

        var entraIssuer = string.Equals(issuer, $"https://sts.windows.net/{tenantId:D}/", StringComparison.OrdinalIgnoreCase)
            || string.Equals(issuer, $"https://login.microsoftonline.com/{tenantId:D}/v2.0", StringComparison.OrdinalIgnoreCase);
        return entraIssuer && IsAgent365PlatformCaller(GetCallerClaims());
    }

    internal static bool IsTeamsChannel(string? channelId) =>
        string.Equals(channelId, "msteams", StringComparison.OrdinalIgnoreCase)
        || channelId?.StartsWith("msteams:", StringComparison.OrdinalIgnoreCase) == true;

    private Claim[] GetCallerClaims()
    {
        var callerClaims = ValidatedClaims.Where(claim => claim.Type == "azp").ToArray();
        if (callerClaims.Length == 0)
            callerClaims = ValidatedClaims.Where(claim => claim.Type == "appid").ToArray();
        return callerClaims;
    }

    private static bool IsAgent365PlatformCaller(Claim[] callerClaims) =>
        callerClaims.Length == 1
        && string.Equals(callerClaims[0].Value, Agent365PlatformApplicationId, StringComparison.OrdinalIgnoreCase);

    internal void LogSubjectDiagnostics(ILogger logger, IReadOnlyCollection<Guid> configuredAudiences)
    {
        var callerClaims = GetCallerClaims();
        var callerCategory = callerClaims.Length == 0 ? "missing"
            : callerClaims.Length != 1 ? "ambiguous"
            : IsAgent365PlatformCaller(callerClaims) ? "agent365_platform" : "other";
        var types = ValidatedClaims.Where(claim => claim.Type == "idtyp")
            .Select(claim => claim.Value).Distinct(StringComparer.Ordinal).ToArray();
        var identityType = types.Length == 0 ? "missing"
            : types.Length != 1 ? "conflicting"
            : types[0] is "app" or "user" ? types[0] : "other";
        var facets = ValidatedClaims.Where(claim => claim.Type == "xms_sub_fct")
            .SelectMany(claim => claim.Value.Split(' ', StringSplitOptions.RemoveEmptyEntries)).ToArray();
        var agentIdentity = facets.Contains("11", StringComparer.Ordinal);
        var agentUser = facets.Contains("13", StringComparer.Ordinal);
        var subjectFacets = facets.Length == 0 ? "missing"
            : agentIdentity && agentUser ? "agent_identity_and_user"
            : agentIdentity ? "agent_identity"
            : agentUser ? "agent_user" : "other";
        var hasScope = ValidatedClaims.Any(claim =>
            (claim.Type is "scp" or "http://schemas.microsoft.com/identity/claims/scope")
            && !string.IsNullOrWhiteSpace(claim.Value) && claim.Value.Trim() != "/");
        var hasRoles = ValidatedClaims.Any(claim =>
            (claim.Type is "roles" || claim.Type == ClaimTypes.Role)
            && !string.IsNullOrWhiteSpace(claim.Value));
        var objectClaims = ValidatedClaims.Where(claim =>
            claim.Type is "oid" or "http://schemas.microsoft.com/identity/claims/objectidentifier").ToArray();
        var objectIds = objectClaims.Select(claim =>
            Guid.TryParse(claim.Value, out var id) ? id : Guid.Empty).Distinct().ToArray();
        var matchesAudience = objectIds.Length == 1 && objectIds[0] != Guid.Empty
            && configuredAudiences.Contains(objectIds[0]);

        // Categories describe the validated subject, not authority to attest the chat sender.
        logger.LogWarning(
            "Human W365 validated token subject diagnostic. IdentityType={IdentityType}; SubjectFacets={SubjectFacets}; HasDelegatedScope={HasDelegatedScope}; HasApplicationRoles={HasApplicationRoles}; ObjectMatchesConfiguredAudience={ObjectMatchesConfiguredAudience}; CallerCategory={CallerCategory}",
            identityType, subjectFacets, hasScope, hasRoles, matchesAudience, callerCategory);
    }

    internal static async Task<string?> BindAsync(HttpContext http)
    {
        var schemes = http.RequestServices.GetService<IAuthenticationSchemeProvider>();
        var scheme = schemes == null ? null : await schemes.GetSchemeAsync(JwtBearerDefaults.AuthenticationScheme);
        if (scheme == null)
            return "incoming_jwt_bearer_scheme_missing";
        if (!typeof(JwtBearerHandler).IsAssignableFrom(scheme.HandlerType))
            return "incoming_jwt_bearer_handler_unexpected";

        var authentication = await http.AuthenticateAsync(JwtBearerDefaults.AuthenticationScheme).ConfigureAwait(false);
        if (!authentication.Succeeded)
        {
            return authentication.Failure switch
            {
                SecurityTokenExpiredException => "incoming_jwt_token_expired",
                SecurityTokenNotYetValidException => "incoming_jwt_token_not_yet_valid",
                SecurityTokenInvalidAudienceException invalidAudience => ClassifyAudienceFailure(http, invalidAudience.InvalidAudience),
                SecurityTokenInvalidIssuerException => "incoming_jwt_issuer_invalid",
                SecurityTokenSignatureKeyNotFoundException => "incoming_jwt_signing_key_not_found",
                SecurityTokenInvalidSignatureException => "incoming_jwt_signature_invalid",
                not null => "incoming_jwt_authentication_failed",
                _ => string.IsNullOrEmpty(http.Request.Headers.Authorization.ToString())
                    ? "incoming_jwt_bearer_token_missing"
                    : "incoming_jwt_authentication_no_result"
            };
        }
        if (authentication.Ticket?.AuthenticationScheme != JwtBearerDefaults.AuthenticationScheme)
            return "incoming_jwt_ticket_scheme_unexpected";
        if (authentication.Principal?.Identity is not ClaimsIdentity { IsAuthenticated: true } identity)
            return "incoming_jwt_principal_unauthenticated";

        // CloudAdapter queues this identity, not HttpContext. The private runtime type proves
        // validation at ingress; neither activity JSON nor an unvalidated JWT can create it.
        http.User = new ClaimsPrincipal(authentication.Principal.Identities.Select(candidate =>
            ReferenceEquals(candidate, identity)
                ? new HumanW365IncomingIdentity(identity, authentication.Principal)
                : candidate));
        return null;
    }

    private static string ClassifyAudienceFailure(HttpContext http, string? rejectedAudience)
    {
        var configuration = http.RequestServices.GetService<IConfiguration>();
        if (configuration == null)
            return "incoming_jwt_audience_invalid";

        // IdentityModel scrubs InvalidAudience by default. Inspect only for a fixed
        // diagnostic classification after rejection; this never authenticates the token.
        if (string.IsNullOrEmpty(rejectedAudience))
        {
            var authorization = http.Request.Headers.Authorization.ToString();
            if (!authorization.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
                return "incoming_jwt_audience_invalid";

            var token = authorization["Bearer ".Length..].Trim();
            var handler = new JwtSecurityTokenHandler();
            if (!handler.CanReadToken(token))
                return "incoming_jwt_audience_invalid";
            try
            {
                var audiences = handler.ReadJwtToken(token).Audiences.Take(2).ToArray();
                if (audiences.Length != 1)
                    return "incoming_jwt_audience_invalid";
                rejectedAudience = audiences[0];
            }
            catch (ArgumentException)
            {
                return "incoming_jwt_audience_invalid";
            }
            catch (SecurityTokenException)
            {
                return "incoming_jwt_audience_invalid";
            }
        }

        foreach (var audience in configuration.GetSection("TokenValidation:Audiences").Get<string[]>() ?? [])
        {
            if (string.Equals(rejectedAudience, $"api://{audience}", StringComparison.OrdinalIgnoreCase))
                return "incoming_jwt_audience_matches_configured_uri";
            if (string.Equals(rejectedAudience, audience, StringComparison.OrdinalIgnoreCase)
                && !string.Equals(rejectedAudience, audience, StringComparison.Ordinal))
                return "incoming_jwt_audience_matches_configured_case_variant";
        }

        var clientId = configuration["Connections:ServiceConnection:Settings:ClientId"];
        if (!string.IsNullOrEmpty(clientId))
        {
            if (string.Equals(rejectedAudience, clientId, StringComparison.OrdinalIgnoreCase))
                return "incoming_jwt_audience_matches_service_connection";
            if (string.Equals(rejectedAudience, $"api://{clientId}", StringComparison.OrdinalIgnoreCase))
                return "incoming_jwt_audience_matches_service_connection_uri";
        }

        return "incoming_jwt_audience_invalid";
    }
}
