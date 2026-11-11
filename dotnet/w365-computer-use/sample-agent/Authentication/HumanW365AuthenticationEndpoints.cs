// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Text;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Primitives;

namespace W365ComputerUseSample.Authentication;

public static class HumanW365Hosting
{
    public static Uri GetOrigin(HumanW365AuthenticationOptions options)
    {
        if (!options.Enabled)
            throw new InvalidOperationException("Enable HumanW365Authentication:Enabled to use human sign-in.");
        if (!Guid.TryParse(options.TenantId, out var tenant) || tenant == Guid.Empty)
            throw new InvalidOperationException("Configure HumanW365Authentication:TenantId with your Entra tenant GUID.");

        var configured = options.ApplicationBaseUrl;
        var platformHost = Environment.GetEnvironmentVariable("WEBSITE_HOSTNAME");
        if (configured is null && string.IsNullOrWhiteSpace(platformHost))
            throw new InvalidOperationException(
                "Configure HumanW365Authentication:ApplicationBaseUrl or host on App Service with WEBSITE_HOSTNAME.");
        if (configured is null && (platformHost!.Contains('/') || platformHost.Contains('\\') ||
            platformHost.Contains(':') || platformHost.Contains('@') || platformHost.Contains('?') ||
            platformHost.Contains('#') || platformHost.Any(char.IsWhiteSpace)))
            throw new InvalidOperationException("WEBSITE_HOSTNAME must be an App Service DNS hostname.");

        var value = configured ?? "https://" + platformHost + "/";
        if (!Uri.TryCreate(value, UriKind.Absolute, out var origin) ||
            origin.Scheme != Uri.UriSchemeHttps || origin.HostNameType != UriHostNameType.Dns ||
            origin.UserInfo.Length != 0 || origin.AbsolutePath != "/" ||
            origin.Query.Length != 0 || origin.Fragment.Length != 0 ||
            value.Any(char.IsWhiteSpace) || value.Contains('\\') ||
            // Reject paths that URI normalization would otherwise silently turn into a root.
            !string.Equals(value.TrimEnd('/'), origin.GetLeftPart(UriPartial.Authority),
                StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException(
                "HumanW365Authentication:ApplicationBaseUrl must be a canonical HTTPS root URL without userinfo, query or fragment.");
        return origin;
    }
}

public static class HumanW365AuthenticationEndpoints
{
    public const string SignInPath = "/w365/sign-in";
    public const string CompletionPath = "/api/w365/human/complete";
    public const string RateLimitPolicy = "HumanW365Completion";
    private const int MaximumBodyLength = 8192;
    private enum Outcome
    {
        Confirmation, Completed, Unavailable, Unauthenticated, TenantMismatch,
        OriginMismatch, InvalidForm, InvalidCredential, WrongOwner, ExpiredHandoff
    }

    public static WebApplication MapHumanW365Authentication(this WebApplication app)
    {
        app.Use(async (context, next) =>
        {
            if (context.Request.Path == CompletionPath || context.Request.Path == SignInPath)
            {
                SetResponseHeaders(context);
                context.Response.OnStarting(() =>
                {
                    SetResponseHeaders(context);
                    return Task.CompletedTask;
                });
            }
            await next(context);
        });
        app.MapGet(SignInPath, SignInAsync);
        app.MapGet(CompletionPath, ConfirmAsync);
        app.MapPost(CompletionPath, CompleteAsync).RequireRateLimiting(RateLimitPolicy);
        return app;
    }

    public static void SetResponseHeaders(HttpContext context)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers["Referrer-Policy"] = "strict-origin";
        context.Response.Headers["X-Frame-Options"] = "DENY";
        context.Response.Headers.ContentSecurityPolicy =
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
    }

    private static Task<IResult> SignInAsync(HttpContext context,
        IOptions<HumanW365AuthenticationOptions> options, HumanW365AuthorizationStore store)
    {
        SetResponseHeaders(context);
        try { _ = HumanW365Hosting.GetOrigin(options.Value); }
        catch (InvalidOperationException exception)
        {
            return Task.FromResult(Page(context, 503, Outcome.Unavailable, exception.Message));
        }
        if (!context.Request.IsHttps)
            return Task.FromResult(Page(context, 503, Outcome.Unavailable, "Sign-in requires a secure HTTPS connection."));
        if (!TryCode(context.Request.Query["code"], out var code))
            return Task.FromResult(Page(context, 400, Outcome.InvalidForm,
                "The sign-in link is invalid. Request a new link in the original chat."));
        if (!store.IsPending(code))
            return Task.FromResult(Page(context, 410, Outcome.ExpiredHandoff,
                "This sign-in link has expired or was already used. Request a new link in the original chat."));
        var content = $"""
            <p>Authorize the agent to call Windows 365 using the same <strong>work or school account</strong>
            as your original chat. Your desktop task and session options are saved.</p>
            <p>You will sign in on Microsoft's hosted page, then return here to confirm authorization.</p>
            {HumanW365SignInPages.SignInAction(code)}
            {HumanW365SignInPages.SwitchAccountAction(code)}
            <p>After confirming, return to the original chat and select <strong>Continue after sign-in</strong>.
            To cancel instead, select <strong>Cancel request</strong> in that chat.</p>
            """;
        Log(context, Outcome.Confirmation);
        return Task.FromResult(Results.Content(
            HumanW365SignInPages.Render("Sign in to authorize this agent", "Agent authorization - Step 1 of 3", content),
            "text/html", Encoding.UTF8, 200));
    }

    private static bool TryBoundary(HttpContext context, HumanW365AuthenticationOptions options,
        out Uri? origin, out HumanW365Owner? owner, out IResult? failure)
    {
        SetResponseHeaders(context);
        origin = null;
        owner = null;
        failure = null;
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("WEBSITE_INSTANCE_ID")) ||
            !context.Request.IsHttps)
        {
            failure = Page(context, 503, Outcome.Unavailable,
                "Human sign-in requires HTTPS behind App Service EasyAuth. Configure its AAD provider and protect this endpoint.");
            return false;
        }
        try { origin = HumanW365Hosting.GetOrigin(options); }
        catch (InvalidOperationException exception)
        {
            // GetOrigin only emits fixed configuration guidance, never configuration values.
            failure = Page(context, 503, Outcome.Unavailable, exception.Message);
            return false;
        }
        // These headers are trustworthy only when App Service EasyAuth authenticates requests
        // and strips/replaces incoming identity headers. Never exclude this route from EasyAuth.
        if (!HumanW365EasyAuth.TryReadOwner(context, out owner))
        {
            TryCode(context.Request.Query["code"], out var code);
            failure = Page(context, 401, Outcome.Unauthenticated,
                "Sign in with the same work or school account as your original chat, then retry.", code);
            return false;
        }
        if (owner!.TenantId != Guid.Parse(options.TenantId!))
        {
            TryCode(context.Request.Query["code"], out var code);
            failure = Page(context, 403, Outcome.TenantMismatch,
                "This account cannot authorize the request. Use the same work or school account as your original chat.", code);
            return false;
        }
        return true;
    }

    private static Task<IResult> ConfirmAsync(HttpContext context,
        IOptions<HumanW365AuthenticationOptions> options, IAntiforgery antiforgery, HumanW365AuthorizationStore store)
    {
        if (!TryBoundary(context, options.Value, out _, out _, out var failure))
            return Task.FromResult(failure!);
        var values = context.Request.Query["code"];
        if (!TryCode(values, out var code))
            return Task.FromResult(Page(context, 400, Outcome.InvalidForm, "The sign-in link is invalid. Request a new link in the original chat."));
        if (!store.IsPending(code))
            return Task.FromResult(Page(context, 410, Outcome.ExpiredHandoff,
                "This sign-in link has expired or was already used. Request a new link in the original chat."));
        context.RequestAborted.ThrowIfCancellationRequested();
        var tokens = antiforgery.GetAndStoreTokens(context);
        var content = $"""
            <p>Authorize the Windows 365 request from your original chat. No session is changed until you confirm.</p>
            <p>Use the same work or school account as that chat. If you signed in with another account,
            sign out and switch accounts before confirming.</p>
            <form id="human-auth-form" method="post" action="{CompletionPath}">
            <input type="hidden" name="code" value="{Encode(code)}">
            <input type="hidden" name="{Encode(tokens.FormFieldName)}" value="{Encode(tokens.RequestToken!)}">
            <button type="submit">Confirm authorization</button>
            </form><p id="status" role="status" aria-live="polite" aria-atomic="true" tabindex="-1"></p>
            <h2>Need to sign in again?</h2>
            {HumanW365SignInPages.SignInAction(code)}
            {HumanW365SignInPages.SwitchAccountAction(code)}
            """;
        Log(context, Outcome.Confirmation);
        return Task.FromResult(Results.Content(
            HumanW365SignInPages.Render("Confirm Windows 365 authorization", "Agent authorization - Step 2 of 3", content, confirmation: true),
            "text/html", Encoding.UTF8, 200));
    }

    private static async Task<IResult> CompleteAsync(HttpContext context,
        IOptions<HumanW365AuthenticationOptions> options, IAntiforgery antiforgery,
        IOptions<AntiforgeryOptions> antiforgeryOptions, HumanW365AuthorizationStore store,
        TimeProvider timeProvider)
    {
        if (!TryBoundary(context, options.Value, out var origin, out _, out var failure))
            return failure!;
        var origins = context.Request.Headers.Origin;
        if (origins.Count != 1 || !string.Equals(origins[0], origin!.GetLeftPart(UriPartial.Authority),
            StringComparison.Ordinal))
            return Page(context, 403, Outcome.OriginMismatch, "Confirmation must come from this application's sign-in page.");
        if (context.Request.ContentType?.Split(';')[0].Trim() != "application/x-www-form-urlencoded" ||
            context.Request.ContentLength > MaximumBodyLength)
            return Page(context, 400, Outcome.InvalidForm, "The confirmation form is invalid.");

        // Bound even chunked requests before form/antiforgery parsing, not just Content-Length.
        var bodyLimit = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (bodyLimit is { IsReadOnly: false })
            bodyLimit.MaxRequestBodySize = MaximumBodyLength;
        var originalBody = context.Request.Body;
        using var buffered = new MemoryStream();
        var buffer = new byte[MaximumBodyLength + 1];
        try
        {
            int count;
            while ((count = await originalBody.ReadAsync(buffer.AsMemory(0,
                MaximumBodyLength + 1 - (int)buffered.Length), context.RequestAborted)) > 0)
            {
                buffered.Write(buffer, 0, count);
                if (buffered.Length > MaximumBodyLength)
                    return Page(context, 400, Outcome.InvalidForm, "The confirmation form is too large.");
            }
            buffered.Position = 0;
            context.Request.Body = buffered;
            context.Features.Set<IFormFeature>(new FormFeature(context.Request, new FormOptions
            {
                ValueCountLimit = 4, KeyLengthLimit = 128, ValueLengthLimit = 2048,
                MultipartBodyLengthLimit = MaximumBodyLength
            }));
            var form = await context.Request.ReadFormAsync(context.RequestAborted);
            if (form.Count != 2 || form[antiforgeryOptions.Value.FormFieldName].Count != 1 ||
                !TryCode(form["code"], out var code))
                return Page(context, 400, Outcome.InvalidForm, "The confirmation code is invalid.");
            await antiforgery.ValidateRequestAsync(context);
            context.RequestAborted.ThrowIfCancellationRequested();
            if (!HasProviderToken(context))
                return Page(context, 401, Outcome.Unauthenticated, "Sign in again to provide Windows 365 authorization.", code);
            if (!HumanW365EasyAuth.TryReadCredential(context, out var credential, timeProvider))
                return Page(context, 403, Outcome.InvalidCredential,
                    "Windows 365 authorization is invalid or expired. Sign in again, then retry.", code);
            var completion = store.Complete(code, credential!);
            return completion switch
            {
                HumanW365Completion.Completed => Page(context, 200, Outcome.Completed,
                    "Authorization confirmed. Return to your original chat to continue."),
                HumanW365Completion.WrongOwner => Page(context, 403, Outcome.WrongOwner,
                    "This sign-in does not belong to the person who requested the link. Sign out and use the same work or school account as your original chat.", code),
                _ => Page(context, 410, Outcome.ExpiredHandoff,
                    "This sign-in link has expired or was already used. Request a new link in the original chat.")
            };
        }
        catch (AntiforgeryValidationException)
        {
            return Page(context, 400, Outcome.InvalidForm, "The confirmation form could not be verified. Reload the sign-in link and retry.");
        }
        catch (InvalidDataException)
        {
            return Page(context, 400, Outcome.InvalidForm, "The confirmation form is invalid.");
        }
        catch (BadHttpRequestException exception) when (exception.StatusCode is 400 or 413)
        {
            return Page(context, 400, Outcome.InvalidForm, "The confirmation form is invalid.");
        }
        finally { context.Request.Body = originalBody; }
    }

    private static bool HasProviderToken(HttpContext context) =>
        context.Request.Headers.TryGetValue("X-MS-TOKEN-AAD-ACCESS-TOKEN", out var values) &&
        values.Count == 1 && !string.IsNullOrWhiteSpace(values[0]);

    private static bool TryCode(StringValues values, out string code)
    {
        code = values.Count == 1 ? values[0] ?? "" : "";
        return HumanW365AuthorizationStore.IsValidCode(code);
    }

    private static string Encode(string value) => HtmlEncoder.Default.Encode(value);

    private static IResult Page(HttpContext context, int status, Outcome outcome, string message, string? code = null)
    {
        SetResponseHeaders(context);
        Log(context, outcome);
        var completed = outcome == Outcome.Completed;
        var content = $"<p role=\"{(completed ? "status" : "alert")}\">{Encode(message)}</p>";
        if (completed)
            content += """
                <p>Select <strong>Continue after sign-in</strong> on the latest card in your original chat
                to resume your saved task. Select <strong>Cancel request</strong> to cancel instead.</p>
                <p>If the buttons are unavailable, reply <strong>continue</strong> or <strong>end my session</strong>.</p>
                <p><a href="/.auth/logout">Sign out</a></p>
                <p>Signing out of this browser does not cancel the request or end a Cloud PC session.
                Use the original chat to cancel.</p>
                """;
        else if (HumanW365AuthorizationStore.IsValidCode(code))
            content += HumanW365SignInPages.SignInAction(code!) + HumanW365SignInPages.SwitchAccountAction(code!);
        else
            content += "<p>Return to the original chat and select <strong>Continue after sign-in</strong> to request a current link, or <strong>Cancel request</strong> to cancel. You can also reply <strong>continue</strong> or <strong>end my session</strong>.</p>";
        return Results.Content(HumanW365SignInPages.Render(
            completed ? "Authorization confirmed" : "Authorization needs attention",
            completed ? "Agent authorization - Step 3 of 3" : "Agent authorization", content),
            "text/html", Encoding.UTF8, status);
    }

    private static void Log(HttpContext context, Outcome outcome) =>
        context.RequestServices.GetRequiredService<ILoggerFactory>()
            .CreateLogger("HumanW365Authentication").LogInformation("Human Windows 365 authorization: {Outcome}", outcome);
}
