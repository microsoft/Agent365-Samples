// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using W365ComputerUseSample;
using W365ComputerUseSample.Agent;
using W365ComputerUseSample.ComputerUse;
using W365ComputerUseSample.ScreenShare;
using W365ComputerUseSample.Telemetry;
using Microsoft.Agents.A365.Observability;
using Microsoft.Agents.A365.Observability.Extensions.AgentFramework;
using Microsoft.Agents.A365.Observability.Runtime;
using Microsoft.Agents.A365.Tooling.Extensions.AgentFramework.Services;
using Microsoft.Agents.A365.Tooling.Services;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Core;
using Microsoft.Agents.Hosting.AspNetCore;
using Microsoft.Agents.Storage;
using Microsoft.AspNetCore.RateLimiting;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.RateLimiting;

var builder = WebApplication.CreateBuilder(args);

// Setup ASP service defaults, including OpenTelemetry, Service Discovery, Resilience, and Health Checks
builder.ConfigureOpenTelemetry();

builder.Configuration.AddUserSecrets(Assembly.GetExecutingAssembly());
builder.Services.AddControllers();
builder.Services.AddHttpClient("WebClient", client => client.Timeout = TimeSpan.FromSeconds(600));
builder.Services.AddHttpContextAccessor();
builder.Logging.AddConsole();

// **********  Configure A365 Services **********
// Configure observability.
builder.Services.AddAgenticTracingExporter(clusterCategory: "production");

// Add A365 tracing with Agent Framework integration
builder.AddA365Tracing(config =>
{
    config.WithAgentFramework();
});

// Add A365 Tooling Server integration
builder.Services.AddSingleton<IMcpToolRegistrationService, McpToolRegistrationService>();
builder.Services.AddSingleton<IMcpToolServerConfigurationService, McpToolServerConfigurationService>();
// **********  END Configure A365 Services **********

// Register the model provider
builder.Services.AddSingleton<ICuaModelProvider, AzureOpenAIModelProvider>();

// Register the Computer Use orchestrator
builder.Services.AddSingleton<ComputerUseOrchestrator>();

// Bind ScreenShare options consumed by the link the agent posts in chat and by the
// screenshare SPA / token-exchange endpoint.
builder.Services.Configure<ScreenShareOptions>(
    builder.Configuration.GetSection(ScreenShareOptions.SectionName));

// In-memory bridge from chat link (sid + hc) to ARI bearer token. Single-process only;
// for multi-instance hosts swap for a distributed store (Redis, etc.).
builder.Services.AddSingleton<HandoffStore>();

// Add AspNet token validation
builder.Services.AddAgentAspNetAuthentication(builder.Configuration);

// Rate limit the screenshare token endpoint at (sid, ip) = 5 req / 60 s. Defense in depth
// against link-brute-force; real protection is the 256-bit HC.
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy("ScreenShareToken", httpContext =>
    {
        var sid = httpContext.Request.RouteValues["sid"]?.ToString() ?? "unknown";
        // Prefer the client IP from X-Forwarded-For (App Service / reverse proxies terminate the
        // connection, so RemoteIpAddress is the proxy). Take the first (original client) hop; fall
        // back to RemoteIpAddress when the header is absent.
        var forwardedFor = httpContext.Request.Headers["X-Forwarded-For"].FirstOrDefault();
        var ip = !string.IsNullOrWhiteSpace(forwardedFor)
            ? forwardedFor.Split(',')[0].Trim()
            : httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        return RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: $"{sid}|{ip}",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 5,
                Window = TimeSpan.FromSeconds(60),
                QueueLimit = 0,
                AutoReplenishment = true,
            });
    });
});

// Register IStorage. For development, MemoryStorage is suitable.
builder.Services.AddSingleton<IStorage, MemoryStorage>();

// Add AgentApplicationOptions from config.
builder.AddAgentApplicationOptions();

// Add the bot (which is transient)
builder.AddAgent<MyAgent>();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseDeveloperExceptionPage();
}

app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();

// Serve the screenshare SPA (wwwroot/screenshare.html + screenshare.js) so the user can open
// the link the agent posts in chat.
//
// Set frame-ancestors via a real HTTP response header (browsers ignore it when delivered
// through <meta> per CSP spec). Driven by ScreenShare:AllowedFrameAncestors so it's
// env-configurable (Teams + new-Teams in prod). Also strip X-Frame-Options if anything sets it
// — it would conflict with frame-ancestors for Teams.
var ssOpts = builder.Configuration.GetSection(ScreenShareOptions.SectionName).Get<ScreenShareOptions>() ?? new ScreenShareOptions();

// Fail fast on an unsafe screenshare auth configuration. DevBypass skips the viewer's identity
// (owner) check and must never be reachable in a non-development deployment.
var isDevEnvironment = app.Environment.IsDevelopment() || app.Environment.EnvironmentName == "Playground";
if (ssOpts.AuthMode == ScreenShareAuthMode.DevBypass && !isDevEnvironment)
{
    throw new InvalidOperationException(
        "ScreenShare:AuthMode=DevBypass is only permitted when ASPNETCORE_ENVIRONMENT is Development or Playground. " +
        "Use AuthMode=EasyAuth for production deployments.");
}

var frameAncestors = (ssOpts.AllowedFrameAncestors is { Length: > 0 } fa)
    ? string.Join(' ', fa)
    : "'self'";
app.Use(async (context, next) =>
{
    var path = context.Request.Path;
    var isSpaHtml = path.Equals("/screenshare.html", StringComparison.OrdinalIgnoreCase);
    var isSpaJs = path.Equals("/screenshare.js", StringComparison.OrdinalIgnoreCase);
    if (isSpaHtml || isSpaJs)
    {
        context.Response.OnStarting(() =>
        {
            // Never cache the SPA shell/script — they change between dev iterations and carry no
            // version in the URL. The versioned viewer bundle still caches.
            context.Response.Headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
            if (isSpaHtml)
            {
                context.Response.Headers["Content-Security-Policy"] = $"frame-ancestors {frameAncestors};";
                context.Response.Headers.Remove("X-Frame-Options");
            }
            return Task.CompletedTask;
        });
    }
    await next();
});
app.UseStaticFiles();

// Map the /api/messages endpoint to the AgentApplication
app.MapPost("/api/messages", async (HttpRequest request, HttpResponse response, IAgentHttpAdapter adapter, IAgent agent, CancellationToken cancellationToken) =>
{
    // Allow multiple reads of the request body — tracing/observability middleware may
    // re-read it after the adapter, which otherwise triggers
    // "Reading is not allowed after reader was completed" on the Kestrel pipe reader.
    request.EnableBuffering();

    await AgentMetrics.InvokeObservedHttpOperation("agent.process_message", async () =>
    {
        await adapter.ProcessAsync(request, response, agent, cancellationToken);
    }).ConfigureAwait(false);
});

// Health check endpoint for CI/CD pipelines and monitoring
app.MapGet("/api/health", () => Results.Ok(new { status = "healthy", timestamp = DateTime.UtcNow }));

// SPA config probe so screenshare.js gets the CDN origin + SDK version templated server-side
// (one source of truth — no risk of HTML/JS drift).
app.MapGet("/api/screenshare/config", () => Results.Ok(new
{
    cdnOrigin = ssOpts.CdnOrigin,
    sdkVersion = ssOpts.SdkVersion,
    authMode = ssOpts.AuthMode.ToString(),
}));

// Exchange the chat-link (sid + hc) for the ARI bearer token. How the viewer's identity is
// established depends on ScreenShare:AuthMode:
//   - EasyAuth (prod): the page sits behind Azure App Service Authentication, which authenticates
//     the browser and injects the signed-in user's object id via X-MS-CLIENT-PRINCIPAL(-ID). We
//     match that oid against the handoff owner so only the user who received the link can complete
//     the exchange.
//   - DevBypass (local/Playground only): the owner check is skipped so the sample can run in a
//     plain browser tab. Hard-gated at startup to development environments.
// The handoff record is burned atomically on success — any subsequent valid call returns 403.
app.MapPost("/api/screenshare/{sid}/token", (
        HttpContext http,
        string sid,
        TokenRequest req,
        HandoffStore store,
        ILogger<Program> logger) =>
    {
        var devBypass = ssOpts.AuthMode == ScreenShareAuthMode.DevBypass;
        var oid = devBypass ? null : ScreenShareEasyAuth.GetEasyAuthObjectId(http);

        void Log(string outcome, string? hcHashPrefix = null) =>
            logger.LogInformation(
                "Screenshare token: sid={Sid} authMode={AuthMode} oid={Oid} ip={Ip} outcome={Outcome} hcHashPrefix={HcHashPrefix}",
                sid, ssOpts.AuthMode, oid ?? "(none)", http.Connection.RemoteIpAddress, outcome, hcHashPrefix ?? string.Empty);

        // Defense-in-depth response headers — the body carries the bearer token.
        http.Response.Headers["Cache-Control"] = "no-store";
        http.Response.Headers["X-Frame-Options"] = "DENY";

        if (!Guid.TryParseExact(sid, "D", out _)) { Log("InvalidSid"); return Results.BadRequest(new { error = "invalid sid" }); }
        if (req is null || string.IsNullOrEmpty(req.Hc) || req.Hc.Length < 32 || req.Hc.Length > 64)
        { Log("InvalidHc"); return Results.BadRequest(new { error = "invalid hc" }); }

        // EasyAuth must have authenticated the user. Missing oid means the request did not come
        // through the authenticated edge — refuse rather than skip the owner check. (DevBypass
        // intentionally has no oid; the owner check below is skipped.)
        if (!devBypass && string.IsNullOrEmpty(oid)) { Log("NoOid"); return Results.Unauthorized(); }

        if (!store.TryGet(sid, out var rec) || rec is null) { Log("NotFound"); return Results.NotFound(); }
        if (rec.Burned == 1 || rec.HandoffExpiresAtUtc < DateTime.UtcNow) { Log("ExpiredOrBurned"); return Results.Forbid(); }

        var hcHash = SHA256.HashData(Encoding.UTF8.GetBytes(req.Hc));
        if (!CryptographicOperations.FixedTimeEquals(hcHash, rec.HandoffCodeHash)) { Log("HashMismatch"); return Results.Forbid(); }
        if (!devBypass && !string.Equals(oid, rec.OwnerAadObjectId, StringComparison.Ordinal)) { Log("OidMismatch"); return Results.Forbid(); }
        if (!store.TryBurn(sid)) { Log("RaceLost"); return Results.Forbid(); }

        Log(devBypass ? "IssuedDevBypass" : "Issued", Convert.ToHexString(hcHash, 0, 4));
        return Results.Ok(new
        {
            screenShareUrl = rec.ScreenShareUrl,
            ariToken = rec.AriToken,
            expiresAtUtc = rec.AriTokenExpiresAtUtc
        });
    })
    .RequireRateLimiting("ScreenShareToken");

if (app.Environment.IsDevelopment() || app.Environment.EnvironmentName == "Playground")
{
    app.MapGet("/", () => "W365 Computer Use Sample Agent");
    app.UseDeveloperExceptionPage();
    app.MapControllers().AllowAnonymous();

    // Hard coded for brevity and ease of testing.
    // In production, this should be set in configuration.
    app.Urls.Add("http://localhost:3978");
    // HTTPS listener required for the screenshare SPA (secure context for postMessage to CDN iframe).
    app.Urls.Add("https://localhost:3979");
}
else
{
    app.MapControllers();
}

// End active W365 session on shutdown to release the VM back to the pool
app.Lifetime.ApplicationStopping.Register(() =>
{
    var orchestrator = app.Services.GetRequiredService<ComputerUseOrchestrator>();
    orchestrator.EndSessionOnShutdownAsync().GetAwaiter().GetResult();
});

app.Run();

/// <summary>
/// Reads the signed-in user's Entra object id (oid) from the headers Azure App Service
/// Authentication (EasyAuth) injects after authenticating the browser. Prefers the
/// objectidentifier claim parsed from the base64 <c>X-MS-CLIENT-PRINCIPAL</c> payload; falls back
/// to the <c>X-MS-CLIENT-PRINCIPAL-ID</c> header (the oid for the AAD provider). Returns
/// <c>null</c> when no EasyAuth principal is present.
/// </summary>
static class ScreenShareEasyAuth
{
    internal static string? GetEasyAuthObjectId(HttpContext http)
    {
        var principalB64 = http.Request.Headers["X-MS-CLIENT-PRINCIPAL"].FirstOrDefault();
        if (!string.IsNullOrEmpty(principalB64))
        {
            try
            {
                var json = Encoding.UTF8.GetString(Convert.FromBase64String(principalB64));
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("claims", out var claims)
                    && claims.ValueKind == JsonValueKind.Array)
                {
                    foreach (var c in claims.EnumerateArray())
                    {
                        var typ = c.TryGetProperty("typ", out var t) ? t.GetString() : null;
                        if (typ is "http://schemas.microsoft.com/identity/claims/objectidentifier" or "oid")
                        {
                            return c.TryGetProperty("val", out var v) ? v.GetString() : null;
                        }
                    }
                }
            }
            catch
            {
                // Malformed header — fall through to the principal-id header.
            }
        }

        var principalId = http.Request.Headers["X-MS-CLIENT-PRINCIPAL-ID"].FirstOrDefault();
        return string.IsNullOrEmpty(principalId) ? null : principalId;
    }
}

/// <summary>
/// Body for <c>POST /api/screenshare/{sid}/token</c>. <c>sid</c> stays in the route so the rate
/// limiter can key on it before model binding.
/// </summary>
internal sealed record TokenRequest(string Hc);
