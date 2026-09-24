// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

extern alias ObservabilityIdentity;

using System.Net;
using System.Text;
using System.Text.Json;
using Agent365.Samples.Observability;
using Azure.Core;
using Xunit;
using AuthenticationFailedException = ObservabilityIdentity::Azure.Identity.AuthenticationFailedException;
using CredentialUnavailableException = ObservabilityIdentity::Azure.Identity.CredentialUnavailableException;

namespace Agent365.E2E.Tests;

public sealed class ObservabilityAppTokenTests
{
    private const string Tenant = "11111111-1111-4111-8111-111111111111";
    private const string Agent = "22222222-2222-4222-8222-222222222222";
    private const string Blueprint = "33333333-3333-4333-8333-333333333333";
    private const string Other = "44444444-4444-4444-8444-444444444444";
    private const string Secret = "offline-test-secret+&=";
    private const string ValidRoles = "[\"Observability.ReadWrite.All\"]";

    [Fact]
    public async Task SecretFlowUsesConfiguredIdentitiesAndOnlyClientCredentials()
    {
        var clock = new TestTime();
        var token = AppToken(clock);
        var handler = new TokenHandler(TokenResponse("blueprint-T1"), TokenResponse(token));
        using var provider = Provider(handler, clock);

        Assert.Equal(token, await provider.ResolveAsync(Agent, Tenant));
        Assert.Equal(token, await provider.ResolveAsync(Agent.ToUpperInvariant(), Tenant.ToUpperInvariant()));
        Assert.Equal(2, handler.Requests.Count);
        var first = handler.Requests[0];
        Assert.Equal($"https://login.microsoftonline.com/{Tenant}/oauth2/v2.0/token", first.Uri);
        Assert.Equal("POST", first.Method);
        Assert.Equal("application/x-www-form-urlencoded", first.ContentType);
        Assert.Equal(new[] { "client_id", "client_secret", "fmi_path", "grant_type", "scope" }, first.Form.Keys.Order());
        Assert.Equal(Blueprint, first.Form["client_id"]);
        Assert.Equal(Agent, first.Form["fmi_path"]);
        Assert.Equal(Secret, first.Form["client_secret"]);
        Assert.Equal(ObservabilityAppTokenProvider.ExchangeScope, first.Form["scope"]);

        var second = handler.Requests[1];
        Assert.Equal(first.Uri, second.Uri);
        Assert.Equal(new[] { "client_assertion", "client_assertion_type", "client_id", "grant_type", "scope" }, second.Form.Keys.Order());
        Assert.Equal(Agent, second.Form["client_id"]);
        Assert.Equal("blueprint-T1", second.Form["client_assertion"]);
        Assert.Equal(ObservabilityAppTokenProvider.AssertionType, second.Form["client_assertion_type"]);
        Assert.Equal(ObservabilityAppTokenProvider.ObservabilityScope, second.Form["scope"]);
        Assert.All(handler.Requests, request => Assert.Equal("client_credentials", request.Form["grant_type"]));
    }

    [Fact]
    public async Task ManagedIdentityAssertionUsesFactoryExchangeScopeAndReplacesOnlyBlueprintSecret()
    {
        var clock = new TestTime();
        var handler = new TokenHandler(TokenResponse("blueprint-T1"), TokenResponse(AppToken(clock)));
        var options = new ObservabilityAppTokenOptions(Tenant, Agent, Blueprint, null, true, Other);
        var calls = 0;
        var credential = new TestCredential((context, ct) =>
        {
            Assert.True(ct.CanBeCanceled);
            Assert.Equal(new[] { ObservabilityAppTokenProvider.ExchangeScope }, context.Scopes);
            Assert.Equal("api://AzureADTokenExchange", context.Scopes.Single()[..^"/.default".Length]);
            calls++;
            return ValueTask.FromResult(new AccessToken("managed-identity-assertion", clock.GetUtcNow().AddHours(1)));
        });
        using var provider = new ObservabilityAppTokenProvider(options, new HttpClient(handler), clock,
            ct => ObservabilityAppTokenFactory.GetManagedIdentityAssertionAsync(credential, ct));

        await provider.ResolveAsync(Agent, Tenant);
        Assert.Equal(Other, options.ManagedIdentityClientId);
        Assert.Equal(1, calls);
        Assert.DoesNotContain("client_secret", handler.Requests[0].Form.Keys);
        Assert.Equal("managed-identity-assertion", handler.Requests[0].Form["client_assertion"]);
        Assert.Equal(ObservabilityAppTokenProvider.AssertionType, handler.Requests[0].Form["client_assertion_type"]);
        Assert.Equal(ObservabilityAppTokenProvider.ExchangeScope, handler.Requests[0].Form["scope"]);
        Assert.Equal(Agent, handler.Requests[0].Form["fmi_path"]);
        Assert.Equal("blueprint-T1", handler.Requests[1].Form["client_assertion"]);
        Assert.Equal(ObservabilityAppTokenProvider.ObservabilityScope, handler.Requests[1].Form["scope"]);
    }

    [Theory]
    [InlineData("authentication")]
    [InlineData("unavailable")]
    [InlineData("service")]
    public async Task ManagedIdentityFailureIsSanitizedWithoutFallingBackToSecret(string failureKind)
    {
        Exception failure = failureKind switch
        {
            "authentication" => new AuthenticationFailedException(Secret, new InvalidOperationException(Secret)),
            "unavailable" => new CredentialUnavailableException(Secret),
            _ => new Azure.RequestFailedException(401, Secret, "invalid_client", new IOException(Secret)),
        };
        var credential = new TestCredential((_, _) => throw failure);
        var handler = new TokenHandler();
        using var provider = new ObservabilityAppTokenProvider(
            new(Tenant, Agent, Blueprint, Secret, true),
            new HttpClient(handler),
            managedIdentityAssertion: ct => ObservabilityAppTokenFactory.GetManagedIdentityAssertionAsync(credential, ct));
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
        AssertSanitized(error);
        Assert.Empty(handler.Requests);
    }

    [Theory]
    [InlineData("invalid-operation")]
    [InlineData("null-reference")]
    [InlineData("argument-range")]
    [InlineData("missing-key")]
    [InlineData("overflow")]
    public async Task UnexpectedCredentialFailuresPropagateAndReleaseRefreshLockWithoutReusingStaleToken(string failureKind)
    {
        Exception failure = failureKind switch
        {
            "invalid-operation" => new InvalidOperationException("Programming failure."),
            "null-reference" => new NullReferenceException("Programming failure."),
            "argument-range" => new ArgumentOutOfRangeException("programmingFailure"),
            "missing-key" => new KeyNotFoundException("Programming failure."),
            _ => new OverflowException("Programming failure."),
        };
        var clock = new TestTime();
        var token = AppToken(clock, null);
        var handler = new TokenHandler(TokenResponse("T1"), TokenResponse(token, 600));
        var calls = 0;
        var credential = new TestCredential((_, _) =>
        {
            if (++calls == 2)
            {
                throw failure;
            }
            return ValueTask.FromResult(new AccessToken("managed-identity-assertion", clock.GetUtcNow().AddHours(1)));
        });
        using var provider = new ObservabilityAppTokenProvider(
            new(Tenant, Agent, Blueprint, null, true), new HttpClient(handler), clock,
            ct => ObservabilityAppTokenFactory.GetManagedIdentityAssertionAsync(credential, ct));

        Assert.Equal(token, await provider.ResolveAsync(Agent, Tenant));
        clock.Advance(TimeSpan.FromSeconds(480));
        Assert.Same(failure, await Record.ExceptionAsync(() => provider.ResolveAsync(Agent, Tenant)));
        Assert.Equal(2, handler.Requests.Count);

        var replacement = AppToken(clock, "[]");
        handler.Responses.Enqueue(TokenResponse("replacement-T1"));
        handler.Responses.Enqueue(TokenResponse(replacement));
        Assert.Equal(replacement, await provider.ResolveAsync(Agent, Tenant));
        Assert.Equal(3, calls);
        Assert.Equal(4, handler.Requests.Count);
    }

    [Fact]
    public async Task ManagedIdentityCallerCancellationRemainsCancellationWithoutCredentialDiagnostics()
    {
        using var cancellation = new CancellationTokenSource();
        var credential = new TestCredential((_, ct) =>
        {
            cancellation.Cancel();
            throw new OperationCanceledException(Secret, new IOException(Secret), ct);
        });
        var handler = new TokenHandler();
        using var provider = new ObservabilityAppTokenProvider(
            new(Tenant, Agent, Blueprint, null, true), new HttpClient(handler),
            managedIdentityAssertion: ct => ObservabilityAppTokenFactory.GetManagedIdentityAssertionAsync(credential, ct));

        var error = await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => provider.GetTokenAsync(Agent, Tenant, cancellation.Token));
        Assert.Equal(cancellation.Token, error.CancellationToken);
        Assert.Equal("Observability token acquisition canceled.", error.Message);
        Assert.DoesNotContain(Secret, error.ToString());
        Assert.Null(error.InnerException);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task HttpRequestFailuresAreSanitized()
    {
        var failure = new HttpRequestException(Secret, new IOException(Secret));
        using var provider = new ObservabilityAppTokenProvider(
            new(Tenant, Agent, Blueprint, Secret), new HttpClient(new FailingHandler(failure)));
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
        AssertSanitized(error);
    }

    [Theory]
    [InlineData("cryptographic")]
    [InlineData("io")]
    [InlineData("unexpected-format")]
    public async Task SecretBearingCredentialFailuresAreSanitized(string failureKind)
    {
        Exception failure = failureKind switch
        {
            "cryptographic" => new System.Security.Cryptography.CryptographicException(Secret),
            "io" => new IOException(Secret, new IOException(Secret)),
            _ => new FormatException(Secret, new InvalidDataException(Secret)),
        };
        using var provider = new ObservabilityAppTokenProvider(
            new(Tenant, Agent, Blueprint, Secret), new HttpClient(new FailingHandler(failure)));
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
        AssertSanitized(error);
    }

    [Fact]
    public async Task UnexpectedHttpFailuresAreNotReclassified()
    {
        var failure = new InvalidOperationException("Programming failure.");
        using var provider = new ObservabilityAppTokenProvider(
            new(Tenant, Agent, Blueprint, Secret), new HttpClient(new FailingHandler(failure)));
        Assert.Same(failure, await Record.ExceptionAsync(() => provider.ResolveAsync(Agent, Tenant)));
    }

    [Fact]
    public async Task EmptyManagedIdentityAssertionCannotAuthenticate()
    {
        var handler = new TokenHandler();
        using var provider = new ObservabilityAppTokenProvider(
            new(Tenant, Agent, Blueprint, null, true), new HttpClient(handler),
            managedIdentityAssertion: _ => Task.FromResult(""));
        await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
        Assert.Empty(handler.Requests);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("{{AGENT_ID}}")]
    [InlineData("<<AGENT_ID>>")]
    [InlineData("00000000-0000-0000-0000-000000000000")]
    public void MissingOrPlaceholderIdsFailClosed(string? value)
    {
        Assert.Throws<InvalidOperationException>(() => new ObservabilityAppTokenOptions(value, Agent, Blueprint, Secret));
        Assert.Throws<InvalidOperationException>(() => new ObservabilityAppTokenOptions(Tenant, value, Blueprint, Secret));
        Assert.Throws<InvalidOperationException>(() => new ObservabilityAppTokenOptions(Tenant, Agent, value, Secret));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("<<YOUR_SECRET>>")]
    [InlineData("{{SECRET}}")]
    [InlineData("your-secret")]
    [InlineData("changeme")]
    public void MissingOrPlaceholderSecretsFailClosed(string? value) =>
        Assert.Throws<InvalidOperationException>(() => new ObservabilityAppTokenOptions(Tenant, Agent, Blueprint, value));

    [Fact]
    public void BlueprintCannotBeUsedAsAgentAndBusinessSettingsAreNotFallbacks()
    {
        Assert.Throws<InvalidOperationException>(() => new ObservabilityAppTokenOptions(Tenant, Blueprint, Blueprint, Secret));
        Assert.Throws<InvalidOperationException>(() => ObservabilityAppTokenOptions.FromConfiguration(
            key => key.StartsWith("Connections:") ? Secret : null));

        var values = new Dictionary<string, string?>
        {
            ["Agent365Observability:TenantId"] = Tenant,
            ["Agent365Observability:AgentId"] = Agent,
            ["Agent365Observability:BlueprintClientId"] = Blueprint,
            ["Agent365Observability:BlueprintClientSecret"] = Secret,
            ["Agent365Observability:UseManagedIdentity"] = "false",
        };
        var options = ObservabilityAppTokenOptions.FromConfiguration(key => values.GetValueOrDefault(key));
        Assert.Equal(Agent, options.AgentId);
        Assert.Equal(Blueprint, options.BlueprintClientId);
        values["Agent365Observability:UseManagedIdentity"] = "not-a-boolean";
        Assert.Throws<InvalidOperationException>(() => ObservabilityAppTokenOptions.FromConfiguration(key => values.GetValueOrDefault(key)));
    }

    [Theory]
    [InlineData(Other, Tenant)]
    [InlineData(Agent, Other)]
    [InlineData(Blueprint, Tenant)]
    [InlineData("", Tenant)]
    [InlineData(Agent, "")]
    public async Task ExportIdentityMismatchIsRejectedBeforeHttp(string agentId, string tenantId)
    {
        var handler = new TokenHandler();
        using var provider = Provider(handler, new TestTime());
        await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(agentId, tenantId));
        Assert.Empty(handler.Requests);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("[]")]
    public async Task RolelessAppTokensAreAcceptedAndCachedOnlyForConfiguredIdentity(string? rolesJson)
    {
        var clock = new TestTime();
        var token = AppToken(clock, rolesJson);
        var handler = new TokenHandler(TokenResponse("T1"), TokenResponse(token));
        using var provider = Provider(handler, clock);

        Assert.Equal(token, await provider.ResolveAsync(Agent, Tenant));
        await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Other, Tenant));
        await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Blueprint, Tenant));
        await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Other));
        Assert.Equal(token, await provider.ResolveAsync(Agent, Tenant));
        Assert.Equal(2, handler.Requests.Count);
    }

    [Theory]
    [InlineData(ValidRoles)]
    [InlineData("[\"Observability.ReadWrite.All\",\"Another.Role\"]")]
    public async Task ValidApplicationRolesDoNotRequireIdentityType(string rolesJson)
    {
        var clock = new TestTime();
        var claims = AppClaims(clock, rolesJson);
        claims.Remove("idtyp");
        var token = Jwt(claims);
        using var provider = Provider(new TokenHandler(TokenResponse("T1"), TokenResponse(token)), clock);
        Assert.Equal(token, await provider.ResolveAsync(Agent, Tenant));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("[]")]
    public async Task RolelessTokensWithoutExplicitAppIdentityFailClosed(string? rolesJson)
    {
        var clock = new TestTime();
        var claims = AppClaims(clock, rolesJson);
        claims.Remove("idtyp");
        using var provider = Provider(new TokenHandler(TokenResponse("T1"), TokenResponse(Jwt(claims))), clock);
        await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("[]")]
    public async Task RolelessTokensWithOidEqualsSubAreAcceptedWithoutIdtyp(string? rolesJson)
    {
        var clock = new TestTime();
        var claims = AppClaims(clock, rolesJson);
        claims.Remove("idtyp");
        claims["oid"] = JsonSerializer.Deserialize<JsonElement>($"\"{Agent}\"");
        claims["sub"] = JsonSerializer.Deserialize<JsonElement>($"\"{Agent}\"");
        var token = Jwt(claims);
        using var provider = Provider(new TokenHandler(TokenResponse("T1"), TokenResponse(token)), clock);
        Assert.Equal(token, await provider.ResolveAsync(Agent, Tenant));
    }

    [Theory]
    [InlineData("\"delegated-user-oid\"", "\"" + Agent + "\"")]
    [InlineData("\"" + Agent + "\"", "\"delegated-user-oid\"")]
    [InlineData("\"\"", "\"\"")]
    [InlineData("null", "null")]
    [InlineData("\"" + Agent + "\"", "null")]
    [InlineData("null", "\"" + Agent + "\"")]
    public async Task RolelessTokensWithoutMatchingOidSubFailClosed(string oidJson, string subJson)
    {
        var clock = new TestTime();
        var claims = AppClaims(clock, null);
        claims.Remove("idtyp");
        claims["oid"] = JsonSerializer.Deserialize<JsonElement>(oidJson);
        claims["sub"] = JsonSerializer.Deserialize<JsonElement>(subJson);
        using var provider = Provider(new TokenHandler(TokenResponse("T1"), TokenResponse(Jwt(claims))), clock);
        await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
    }

    [Fact]
    public async Task DelegatedScpBlocksOidSubFallback()
    {
        var clock = new TestTime();
        var claims = AppClaims(clock, null);
        claims.Remove("idtyp");
        claims["oid"] = JsonSerializer.Deserialize<JsonElement>($"\"{Agent}\"");
        claims["sub"] = JsonSerializer.Deserialize<JsonElement>($"\"{Agent}\"");
        claims["scp"] = JsonSerializer.Deserialize<JsonElement>("\"User.Read\"");
        using var provider = Provider(new TokenHandler(TokenResponse("T1"), TokenResponse(Jwt(claims))), clock);
        await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
    }

    [Theory]
    [InlineData("\"user\"")]
    [InlineData("\"\"")]
    [InlineData("\"APP\"")]
    [InlineData("\" app \"")]
    [InlineData("null")]
    [InlineData("true")]
    [InlineData("42")]
    [InlineData("[]")]
    [InlineData("{}")]
    public async Task ExplicitNonAppIdentityTypesFailClosed(string identityTypeJson)
    {
        var clock = new TestTime();
        foreach (var claims in new[] { null, "[]", ValidRoles }.Select(rolesJson => AppClaims(clock, rolesJson)))
        {
            claims["idtyp"] = JsonSerializer.Deserialize<JsonElement>(identityTypeJson);
            using var provider = Provider(new TokenHandler(TokenResponse("T1"), TokenResponse(Jwt(claims))), clock);
            await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
        }
    }

    [Theory]
    [InlineData("scp", "Observability.ReadWrite")]
    [InlineData("scp", "")]
    [InlineData("scp", null)]
    [InlineData("tid", Other)]
    [InlineData("tid", null)]
    [InlineData("appid", Blueprint)]
    [InlineData("appid", null)]
    [InlineData("azp", Other)]
    [InlineData("azp", null)]
    [InlineData("aud", "https://graph.microsoft.com")]
    [InlineData("aud", null)]
    public async Task DelegatedOrMismatchedResponseTokenIsRejected(string claim, string? value)
    {
        var clock = new TestTime();
        foreach (var claims in new[] { null, "[]", ValidRoles }.Select(rolesJson => AppClaims(clock, rolesJson)))
        {
            claims["azp"] = Agent;
            claims[claim] = JsonSerializer.SerializeToElement(value);
            var handler = new TokenHandler(TokenResponse("T1"), TokenResponse(Jwt(claims)));
            using var provider = Provider(handler, clock);
            await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
        }
    }

    [Theory]
    [InlineData("false")]
    [InlineData("0")]
    [InlineData("[]")]
    [InlineData("{}")]
    public async Task AnyDelegatedScopePropertyFailsClosed(string scopeJson)
    {
        var clock = new TestTime();
        foreach (var claims in new[] { null, "[]", ValidRoles }.Select(rolesJson => AppClaims(clock, rolesJson)))
        {
            claims["scp"] = JsonSerializer.Deserialize<JsonElement>(scopeJson);
            using var provider = Provider(new TokenHandler(TokenResponse("T1"), TokenResponse(Jwt(claims))), clock);
            await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
        }
    }

    [Theory]
    [InlineData("exp")]
    [InlineData("appid")]
    [InlineData("tid")]
    [InlineData("aud")]
    public async Task MissingRequiredTokenClaimsFailClosed(string claim)
    {
        var clock = new TestTime();
        foreach (var claims in new[] { null, "[]", ValidRoles }.Select(rolesJson => AppClaims(clock, rolesJson)))
        {
            claims.Remove(claim);
            using var provider = Provider(new TokenHandler(TokenResponse("T1"), TokenResponse(Jwt(claims))), clock);
            await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
        }
    }

    [Theory]
    [InlineData("null")]
    [InlineData("{}")]
    [InlineData("42")]
    [InlineData("true")]
    [InlineData("\"Observability.ReadWrite.All\"")]
    [InlineData("[\"\"]")]
    [InlineData("[\" \\t\\r\\n\"]")]
    [InlineData("[null]")]
    [InlineData("[42]")]
    [InlineData("[true]")]
    [InlineData("[{}]")]
    [InlineData("[[]]")]
    [InlineData("[\"Observability.ReadWrite.All\",null]")]
    [InlineData("[\"Observability.ReadWrite.All\",42]")]
    [InlineData("[\"Observability.ReadWrite.All\",true]")]
    [InlineData("[\"Observability.ReadWrite.All\",{}]")]
    [InlineData("[\"Observability.ReadWrite.All\",[]]")]
    [InlineData("[\"Observability.ReadWrite.All\",\"\"]")]
    [InlineData("[\"Observability.ReadWrite.All\",\" \\t\"]")]
    [InlineData("[null,\"Observability.ReadWrite.All\"]")]
    public async Task MalformedApplicationRolesFailClosedWithOrWithoutIdentityType(string rolesJson)
    {
        var clock = new TestTime();
        foreach (var includeIdentityType in new[] { true, false })
        {
            var claims = AppClaims(clock, rolesJson);
            if (!includeIdentityType)
            {
                claims.Remove("idtyp");
            }
            using var provider = Provider(new TokenHandler(TokenResponse("T1"), TokenResponse(Jwt(claims))), clock);
            await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
        }
    }

    [Theory]
    [InlineData(null, false)]
    [InlineData("[]", false)]
    [InlineData(ValidRoles, false)]
    [InlineData(null, true)]
    [InlineData("[]", true)]
    [InlineData(ValidRoles, true)]
    public async Task V2AzpAppTokenIsAcceptedWithMatchingOptionalAppId(string? rolesJson, bool includeAppId)
    {
        var clock = new TestTime();
        var claims = AppClaims(clock, rolesJson);
        if (!includeAppId)
        {
            claims.Remove("appid");
        }
        claims["azp"] = Agent;
        claims["aud"] = "api://" + ObservabilityAppTokenProvider.ObservabilityResource;
        var token = Jwt(claims);
        using var provider = Provider(new TokenHandler(TokenResponse("T1"), TokenResponse(token)), clock);
        Assert.Equal(token, await provider.ResolveAsync(Agent, Tenant));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-a-jwt")]
    [InlineData("header.!.signature")]
    public async Task EmptyOrMalformedAppTokensAreNeverReturned(string token)
    {
        using var provider = Provider(new TokenHandler(TokenResponse("T1"), TokenResponse(token)), new TestTime());
        await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
    }

    [Theory]
    [InlineData("access_token")]
    [InlineData("expires_in")]
    [InlineData("token_type")]
    public async Task MalformedSuccessResponsesAreRejected(string field)
    {
        var clock = new TestTime();
        var response = new Dictionary<string, object> { ["access_token"] = AppToken(clock), ["expires_in"] = 3600, ["token_type"] = "Bearer" };
        response.Remove(field);
        using var provider = Provider(new TokenHandler(TokenResponse("T1"), JsonResponse(response)), clock);
        AssertSanitized(await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant)));
    }

    [Theory]
    [InlineData("access_token", "null")]
    [InlineData("access_token", "42")]
    [InlineData("access_token", "[]")]
    [InlineData("token_type", "{}")]
    [InlineData("token_type", "false")]
    [InlineData("expires_in", "null")]
    [InlineData("expires_in", "\"3600\"")]
    [InlineData("expires_in", "[]")]
    [InlineData("expires_in", "1.5")]
    [InlineData("expires_in", "9223372036854775807")]
    [InlineData("expires_in", "9223372036854775808")]
    [InlineData("expires_in", "1e999")]
    public async Task MalformedResponseTypesAndLifetimeOverflowAreSanitized(string field, string valueJson)
    {
        var clock = new TestTime();
        var response = new Dictionary<string, object>
        {
            ["access_token"] = AppToken(clock, null),
            ["token_type"] = "Bearer",
            ["expires_in"] = 3600,
            ["diagnostic"] = Secret,
        };
        response[field] = JsonSerializer.Deserialize<JsonElement>(valueJson);
        using var provider = Provider(new TokenHandler(TokenResponse("T1"), JsonResponse(response)), clock);
        AssertSanitized(await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant)));
    }

    [Theory]
    [InlineData("appid", "42")]
    [InlineData("azp", "[]")]
    [InlineData("tid", "{}")]
    [InlineData("aud", "false")]
    public async Task MalformedIdentityClaimTypesAreSanitized(string claim, string valueJson)
    {
        var clock = new TestTime();
        var claims = AppClaims(clock, null);
        claims[claim] = JsonSerializer.Deserialize<JsonElement>(valueJson);
        using var provider = Provider(new TokenHandler(TokenResponse("T1"), TokenResponse(Jwt(claims))), clock);
        AssertSanitized(await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant)));
    }

    [Theory]
    [InlineData("{")]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("\"not-an-object\"")]
    public async Task MalformedResponseAndTokenPayloadJsonFailClosed(string json)
    {
        var clock = new TestTime();
        using var responseProvider = Provider(new TokenHandler(TokenResponse("T1"), new(HttpStatusCode.OK)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        }), clock);
        AssertSanitized(await Assert.ThrowsAsync<InvalidOperationException>(() => responseProvider.ResolveAsync(Agent, Tenant)));

        var parts = AppToken(clock).Split('.');
        parts[1] = Convert.ToBase64String(Encoding.UTF8.GetBytes(json)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        using var tokenProvider = Provider(new TokenHandler(TokenResponse("T1"), TokenResponse(string.Join(".", parts))), clock);
        AssertSanitized(await Assert.ThrowsAsync<InvalidOperationException>(() => tokenProvider.ResolveAsync(Agent, Tenant)));
    }

    [Fact]
    public async Task FailedSecondExchangeCannotReturnBlueprintOrErrorBodyAsToken()
    {
        var handler = new TokenHandler(TokenResponse("sensitive-T1"), new(HttpStatusCode.Unauthorized)
        {
            Content = new StringContent("sensitive-T1 " + Secret),
        });
        using var provider = Provider(handler, new TestTime());
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
        Assert.DoesNotContain("sensitive-T1", error.ToString());
        Assert.DoesNotContain(Secret, error.ToString());
        Assert.Null(error.InnerException);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    [InlineData(120)]
    public async Task ExpiredOrNearExpiryTokensFailClosed(int expiresIn)
    {
        var clock = new TestTime();
        foreach (var rolesJson in new[] { null, "[]", ValidRoles })
        {
            using var responseProvider = Provider(new TokenHandler(TokenResponse("T1"), TokenResponse(AppToken(clock, rolesJson), expiresIn)), clock);
            await Assert.ThrowsAsync<InvalidOperationException>(() => responseProvider.ResolveAsync(Agent, Tenant));
            var claims = AppClaims(clock, rolesJson);
            claims["exp"] = clock.GetUtcNow().AddSeconds(expiresIn).ToUnixTimeSeconds();
            using var jwtProvider = Provider(new TokenHandler(TokenResponse("T1"), TokenResponse(Jwt(claims))), clock);
            await Assert.ThrowsAsync<InvalidOperationException>(() => jwtProvider.ResolveAsync(Agent, Tenant));
        }
    }

    [Theory]
    [InlineData("null")]
    [InlineData("\"3600\"")]
    [InlineData("1.5")]
    [InlineData("true")]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("9223372036854775807")]
    [InlineData("-9223372036854775808")]
    [InlineData("9223372036854775808")]
    [InlineData("1e999")]
    public async Task MalformedExpiryClaimsFailClosed(string expiryJson)
    {
        var clock = new TestTime();
        foreach (var claims in new[] { null, "[]", ValidRoles }.Select(rolesJson => AppClaims(clock, rolesJson)))
        {
            claims["exp"] = JsonSerializer.Deserialize<JsonElement>(expiryJson);
            using var provider = Provider(new TokenHandler(TokenResponse("T1"), TokenResponse(Jwt(claims))), clock);
            AssertSanitized(await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant)));
        }
    }

    [Theory]
    [InlineData(null)]
    [InlineData("[]")]
    [InlineData(ValidRoles)]
    public async Task CacheRefreshHonorsEarliestExpiryAndNeverUsesStaleTokenAfterFailure(string? rolesJson)
    {
        var clock = new TestTime();
        var token = AppToken(clock, rolesJson);
        var handler = new TokenHandler(
            TokenResponse("T1"), TokenResponse(token, 600),
            new HttpResponseMessage(HttpStatusCode.BadRequest) { Content = new StringContent(Secret) });
        using var provider = Provider(handler, clock);
        Assert.Equal(token, await provider.ResolveAsync(Agent, Tenant));
        clock.Advance(TimeSpan.FromSeconds(479));
        Assert.Equal(token, await provider.ResolveAsync(Agent, Tenant));
        Assert.Equal(2, handler.Requests.Count);
        clock.Advance(TimeSpan.FromSeconds(1));
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
        Assert.DoesNotContain(Secret, error.ToString());
        Assert.Null(error.InnerException);
        Assert.Equal(3, handler.Requests.Count);

        var replacement = AppToken(clock, rolesJson);
        handler.Responses.Enqueue(TokenResponse("replacement-T1"));
        handler.Responses.Enqueue(TokenResponse(replacement));
        Assert.Equal(replacement, await provider.ResolveAsync(Agent, Tenant));
        Assert.Equal(5, handler.Requests.Count);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("[]")]
    [InlineData(ValidRoles)]
    public async Task JwtExpiryCanShortenResponseExpiry(string? rolesJson)
    {
        var clock = new TestTime();
        var claims = AppClaims(clock, rolesJson);
        claims["exp"] = clock.GetUtcNow().AddSeconds(300).ToUnixTimeSeconds();
        var handler = new TokenHandler(TokenResponse("T1"), TokenResponse(Jwt(claims)), new(HttpStatusCode.Unauthorized));
        using var provider = Provider(handler, clock);
        await provider.ResolveAsync(Agent, Tenant);
        clock.Advance(TimeSpan.FromSeconds(180));
        await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
        Assert.Equal(3, handler.Requests.Count);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task RolelessTokenCachesAreIsolatedAcrossProviders(bool differentTenant)
    {
        var clock = new TestTime();
        var token = AppToken(clock, null);
        var handler = new TokenHandler(TokenResponse("T1"), TokenResponse(token));
        using var provider = Provider(handler, clock);
        Assert.Equal(token, await provider.ResolveAsync(Agent, Tenant));

        var claims = AppClaims(clock, "[]");
        claims[differentTenant ? "tid" : "appid"] = Other;
        var otherToken = Jwt(claims);
        var otherHandler = new TokenHandler(TokenResponse("other-T1"), TokenResponse(otherToken));
        var otherTenant = differentTenant ? Other : Tenant;
        var otherAgent = differentTenant ? Agent : Other;
        using var otherProvider = new ObservabilityAppTokenProvider(
            new(otherTenant, otherAgent, Blueprint, Secret), new HttpClient(otherHandler), clock);

        Assert.Equal(otherToken, await otherProvider.ResolveAsync(otherAgent, otherTenant));
        Assert.Equal(token, await provider.ResolveAsync(Agent, Tenant));
        Assert.Equal(otherToken, await otherProvider.ResolveAsync(otherAgent, otherTenant));
        Assert.Equal(2, handler.Requests.Count);
        Assert.Equal(2, otherHandler.Requests.Count);
    }

    [Fact]
    public async Task ConcurrentExportsShareOneRefresh()
    {
        var clock = new TestTime();
        var handler = new TokenHandler(TokenResponse("T1"), TokenResponse(AppToken(clock)));
        using var provider = Provider(handler, clock);
        var tokens = await Task.WhenAll(Enumerable.Range(0, 20).Select(_ => provider.ResolveAsync(Agent, Tenant)));
        Assert.All(tokens, token => Assert.Equal(tokens[0], token));
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task TimeoutIsBoundedAndSanitizedAndCallerCancellationIsPreserved()
    {
        using var provider = new ObservabilityAppTokenProvider(
            new(Tenant, Agent, Blueprint, Secret), new HttpClient(new BlockingHandler()),
            requestTimeout: TimeSpan.FromMilliseconds(20));
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
        AssertSanitized(error);

        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var canceled = await Assert.ThrowsAnyAsync<OperationCanceledException>(() => provider.GetTokenAsync(Agent, Tenant, cancellation.Token));
        Assert.Equal(cancellation.Token, canceled.CancellationToken);
        Assert.Null(canceled.InnerException);
    }

    [Theory]
    [InlineData("AgentFrameworkProgram.cs")]
    [InlineData("SemanticKernelProgram.cs")]
    public void Distro101UsesS2SAndDedicatedAppResolver(string file)
    {
        var source = Fixture(file);
        Assert.Contains("o.Agent365.Exporter.UseS2SEndpoint = true;", source);
        Assert.Contains("o.Agent365.Exporter.TokenResolver = observabilityTokens.ResolveAsync;", source);
        Assert.Contains("ObservabilityAppTokenFactory.Create(builder.Configuration)", source);
        Assert.Contains("AddAgentAspNetAuthentication(builder.Configuration)", source);
    }

    [Fact]
    public void W365Distro106SetsBothExporterOptionPathsToS2S()
    {
        var source = Fixture("W365Observability.cs");
        Assert.Contains("options.Agent365.UseS2SEndpoint = true;", source);
        Assert.Contains("options.Agent365.TokenResolver = observabilityTokenResolver;", source);
        Assert.Contains("services.Configure<Agent365ExporterOptions>", source);
        Assert.Contains("options.UseS2SEndpoint = true;", source);
        Assert.Contains("options.TokenResolver = observabilityTokenResolver;", source);
        Assert.DoesNotContain("ServiceTokenCache", source);
    }

    [Theory]
    [InlineData("AgentFrameworkAgent.cs")]
    [InlineData("W365Wrapper.cs")]
    public void OriginalTurnBaggageRemainsButDelegatedObsRegistrationIsRemoved(string file)
    {
        var source = Fixture(file);
        Assert.DoesNotContain("RegisterObservability", source);
        Assert.DoesNotContain("GetObservabilityToken", source);
        Assert.Contains("GetAgenticInstanceId()", source);
        Assert.Contains("GetTurnTokenAsync", source);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData(".")]
    [InlineData("..")]
    [InlineData("...")]
    [InlineData(".. ")]
    [InlineData("../AgentFrameworkProgram.cs")]
    [InlineData(@"..\AgentFrameworkProgram.cs")]
    [InlineData("child/../AgentFrameworkProgram.cs")]
    [InlineData(@"child\..\AgentFrameworkProgram.cs")]
    [InlineData("/AgentFrameworkProgram.cs")]
    [InlineData(@"\AgentFrameworkProgram.cs")]
    [InlineData(@"C:\AgentFrameworkProgram.cs")]
    [InlineData("C:/AgentFrameworkProgram.cs")]
    [InlineData("C:AgentFrameworkProgram.cs")]
    [InlineData(@"\\server\share\AgentFrameworkProgram.cs")]
    [InlineData(@"\\?\C:\AgentFrameworkProgram.cs")]
    [InlineData(@"\\.\C:\AgentFrameworkProgram.cs")]
    [InlineData("AgentFrameworkProgram.cs:stream")]
    [InlineData("AgentFrameworkProgram.cs.")]
    [InlineData("AgentFrameworkProgram.cs ")]
    [InlineData(" AgentFrameworkProgram.cs")]
    public void FixtureRejectsRootedTraversalAndNonBareFilenames(string? file)
    {
        var error = Assert.Throws<ArgumentException>(() => Fixture(file));
        Assert.Equal("file", error.ParamName);
        Assert.Contains("bare relative filename", error.Message);
    }

    private static string Fixture(string? file)
    {
        if (string.IsNullOrWhiteSpace(file)
            || file != file.Trim()
            || Path.IsPathRooted(file)
            || file.IndexOfAny(['/', '\\', ':']) >= 0
            || file.EndsWith('.')
            || file.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
        {
            throw new ArgumentException("Fixture must be a bare relative filename without rooted paths or traversal.", nameof(file));
        }
        return File.ReadAllText(Path.Join(AppContext.BaseDirectory, "ObservabilityFixtures", file));
    }

    private static void AssertSanitized(InvalidOperationException error)
    {
        Assert.Equal("Observability app token acquisition failed; check OBS configuration, credentials and application authorization.", error.Message);
        Assert.DoesNotContain(Secret, error.ToString());
        Assert.Null(error.InnerException);
    }

    private static ObservabilityAppTokenProvider Provider(TokenHandler handler, TimeProvider clock) =>
        new(new(Tenant, Agent, Blueprint, Secret), new HttpClient(handler), clock);

    private static Dictionary<string, object> AppClaims(TimeProvider clock, string? rolesJson = ValidRoles)
    {
        var claims = new Dictionary<string, object>
        {
            ["tid"] = Tenant, ["appid"] = Agent, ["idtyp"] = "app",
            ["aud"] = ObservabilityAppTokenProvider.ObservabilityResource,
            ["exp"] = clock.GetUtcNow().AddHours(1).ToUnixTimeSeconds(),
        };
        if (rolesJson is not null)
        {
            claims["roles"] = JsonSerializer.Deserialize<JsonElement>(rolesJson);
        }
        return claims;
    }

    private static string AppToken(TimeProvider clock, string? rolesJson = ValidRoles) => Jwt(AppClaims(clock, rolesJson));

    private static string Jwt(Dictionary<string, object> claims) =>
        "eyJhbGciOiJSUzI1NiJ9." + Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(claims)))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_') + ".b2ZmbGluZS10ZXN0LXNpZ25hdHVyZQ";

    private static HttpResponseMessage TokenResponse(string token, int expiresIn = 3600) =>
        JsonResponse(new { access_token = token, expires_in = expiresIn, token_type = "Bearer" });

    private static HttpResponseMessage JsonResponse(object value) =>
        new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json") };

    private sealed class TestTime : TimeProvider
    {
        private DateTimeOffset _now = new(2026, 9, 9, 12, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan delta) => _now += delta;
    }

    private sealed record CapturedRequest(string Uri, string Method, string? ContentType, Dictionary<string, string> Form);

    private sealed class TokenHandler(params HttpResponseMessage[] responses) : HttpMessageHandler
    {
        public Queue<HttpResponseMessage> Responses { get; } = new(responses);
        public List<CapturedRequest> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            await Task.Yield();
            var body = await request.Content!.ReadAsStringAsync(cancellationToken);
            var form = body.Split('&').Select(part => part.Split('=', 2))
                .ToDictionary(pair => WebUtility.UrlDecode(pair[0]), pair => WebUtility.UrlDecode(pair[1]));
            Requests.Add(new(request.RequestUri!.AbsoluteUri, request.Method.Method, request.Content.Headers.ContentType?.MediaType, form));
            return Responses.Dequeue();
        }
    }

    private sealed class BlockingHandler : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new InvalidOperationException("Unreachable");
        }
    }

    private sealed class FailingHandler(Exception failure) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromException<HttpResponseMessage>(failure);
    }

    private sealed class TestCredential(Func<TokenRequestContext, CancellationToken, ValueTask<AccessToken>> acquire) : TokenCredential
    {
        public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("Unexpected synchronous credential request.");

        public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext requestContext, CancellationToken cancellationToken) =>
            acquire(requestContext, cancellationToken);
    }
}
