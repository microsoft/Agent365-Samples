// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Net;
using System.Text;
using System.Text.Json;
using Agent365.Samples.Observability;
using Xunit;

namespace Agent365.E2E.Tests;

public sealed class ObservabilityAppTokenTests
{
    private const string Tenant = "11111111-1111-4111-8111-111111111111";
    private const string Agent = "22222222-2222-4222-8222-222222222222";
    private const string Blueprint = "33333333-3333-4333-8333-333333333333";
    private const string Other = "44444444-4444-4444-8444-444444444444";
    private const string Secret = "offline-test-secret+&=";

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
    public async Task ManagedIdentityAssertionReplacesOnlyBlueprintSecret()
    {
        var clock = new TestTime();
        var handler = new TokenHandler(TokenResponse("blueprint-T1"), TokenResponse(AppToken(clock)));
        var options = new ObservabilityAppTokenOptions(Tenant, Agent, Blueprint, null, true, Other);
        var calls = 0;
        using var provider = new ObservabilityAppTokenProvider(options, new HttpClient(handler), clock, ct =>
        {
            Assert.True(ct.CanBeCanceled);
            calls++;
            return Task.FromResult("managed-identity-assertion");
        });

        await provider.ResolveAsync(Agent, Tenant);
        Assert.Equal(Other, options.ManagedIdentityClientId);
        Assert.Equal(1, calls);
        Assert.DoesNotContain("client_secret", handler.Requests[0].Form.Keys);
        Assert.Equal("managed-identity-assertion", handler.Requests[0].Form["client_assertion"]);
        Assert.Equal(ObservabilityAppTokenProvider.AssertionType, handler.Requests[0].Form["client_assertion_type"]);
        Assert.Equal(Agent, handler.Requests[0].Form["fmi_path"]);
        Assert.Equal("blueprint-T1", handler.Requests[1].Form["client_assertion"]);
    }

    [Fact]
    public async Task ManagedIdentityFailureDoesNotFallBackToSecret()
    {
        var handler = new TokenHandler();
        using var provider = new ObservabilityAppTokenProvider(
            new(Tenant, Agent, Blueprint, Secret, true),
            new HttpClient(handler),
            managedIdentityAssertion: _ => throw new InvalidOperationException(Secret));
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
        Assert.DoesNotContain(Secret, error.ToString());
        Assert.Empty(handler.Requests);
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
    [InlineData("scp", "Observability.ReadWrite")]
    [InlineData("scp", "")]
    [InlineData("idtyp", "user")]
    [InlineData("tid", Other)]
    [InlineData("appid", Blueprint)]
    [InlineData("azp", Other)]
    [InlineData("aud", "https://graph.microsoft.com")]
    public async Task DelegatedOrMismatchedResponseTokenIsRejected(string claim, string value)
    {
        var clock = new TestTime();
        var claims = AppClaims(clock);
        claims[claim] = value;
        var handler = new TokenHandler(TokenResponse("T1"), TokenResponse(Jwt(claims)));
        using var provider = Provider(handler, clock);
        await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
    }

    [Theory]
    [InlineData("exp")]
    [InlineData("roles")]
    [InlineData("appid")]
    [InlineData("tid")]
    [InlineData("aud")]
    public async Task MissingRequiredTokenClaimsFailClosed(string claim)
    {
        var clock = new TestTime();
        var claims = AppClaims(clock);
        claims.Remove(claim);
        using var provider = Provider(new TokenHandler(TokenResponse("T1"), TokenResponse(Jwt(claims))), clock);
        await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("[\"\"]")]
    [InlineData("[null]")]
    [InlineData("\"Observability.ReadWrite.All\"")]
    public async Task EmptyOrMalformedApplicationRolesFailClosed(string rolesJson)
    {
        var clock = new TestTime();
        var claims = AppClaims(clock);
        claims["roles"] = JsonSerializer.Deserialize<JsonElement>(rolesJson);
        using var provider = Provider(new TokenHandler(TokenResponse("T1"), TokenResponse(Jwt(claims))), clock);
        await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
    }

    [Fact]
    public async Task V2AzpAppTokenIsAccepted()
    {
        var clock = new TestTime();
        var claims = AppClaims(clock);
        claims.Remove("appid");
        claims["azp"] = Agent;
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
        await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
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
        using var responseProvider = Provider(new TokenHandler(TokenResponse("T1"), TokenResponse(AppToken(clock), expiresIn)), clock);
        await Assert.ThrowsAsync<InvalidOperationException>(() => responseProvider.ResolveAsync(Agent, Tenant));
        var claims = AppClaims(clock);
        claims["exp"] = clock.GetUtcNow().AddSeconds(expiresIn).ToUnixTimeSeconds();
        using var jwtProvider = Provider(new TokenHandler(TokenResponse("T1"), TokenResponse(Jwt(claims))), clock);
        await Assert.ThrowsAsync<InvalidOperationException>(() => jwtProvider.ResolveAsync(Agent, Tenant));
    }

    [Fact]
    public async Task CacheRefreshHonorsEarliestExpiryAndNeverUsesStaleTokenAfterFailure()
    {
        var clock = new TestTime();
        var token = AppToken(clock);
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

        var replacement = AppToken(clock);
        handler.Responses.Enqueue(TokenResponse("replacement-T1"));
        handler.Responses.Enqueue(TokenResponse(replacement));
        Assert.Equal(replacement, await provider.ResolveAsync(Agent, Tenant));
        Assert.Equal(5, handler.Requests.Count);
    }

    [Fact]
    public async Task JwtExpiryCanShortenResponseExpiry()
    {
        var clock = new TestTime();
        var claims = AppClaims(clock);
        claims["exp"] = clock.GetUtcNow().AddSeconds(300).ToUnixTimeSeconds();
        var handler = new TokenHandler(TokenResponse("T1"), TokenResponse(Jwt(claims)), new(HttpStatusCode.Unauthorized));
        using var provider = Provider(handler, clock);
        await provider.ResolveAsync(Agent, Tenant);
        clock.Advance(TimeSpan.FromSeconds(180));
        await Assert.ThrowsAsync<InvalidOperationException>(() => provider.ResolveAsync(Agent, Tenant));
        Assert.Equal(3, handler.Requests.Count);
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
        Assert.Null(error.InnerException);

        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => provider.GetTokenAsync(Agent, Tenant, cancellation.Token));
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

    private static string Fixture(string file) =>
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "ObservabilityFixtures", file));

    private static ObservabilityAppTokenProvider Provider(TokenHandler handler, TimeProvider clock) =>
        new(new(Tenant, Agent, Blueprint, Secret), new HttpClient(handler), clock);

    private static Dictionary<string, object> AppClaims(TimeProvider clock) => new()
    {
        ["tid"] = Tenant, ["appid"] = Agent, ["idtyp"] = "app",
        ["aud"] = ObservabilityAppTokenProvider.ObservabilityResource,
        ["roles"] = new[] { "Observability.ReadWrite.All" },
        ["exp"] = clock.GetUtcNow().AddHours(1).ToUnixTimeSeconds(),
    };

    private static string AppToken(TimeProvider clock) => Jwt(AppClaims(clock));

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
}
