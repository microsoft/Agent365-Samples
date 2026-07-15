// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

namespace W365ComputerUseSample.ScreenShare;

/// <summary>
/// How the screenshare token-exchange endpoint establishes the identity of the user
/// viewing the page. Selected via <c>ScreenShare:AuthMode</c>.
/// </summary>
public enum ScreenShareAuthMode
{
    /// <summary>
    /// PROD / Azure App Service. The page sits behind Azure App Service Authentication
    /// (EasyAuth): the platform signs the browser in through Entra and injects the
    /// authenticated user's object id via the <c>X-MS-CLIENT-PRINCIPAL(-ID)</c> headers,
    /// which the token endpoint matches against the handoff owner. The default.
    /// </summary>
    EasyAuth,

    /// <summary>
    /// LOCAL DEV / Playground only. The token endpoint skips the user-identity (owner)
    /// check so the sample can run end-to-end in a plain browser tab against a local
    /// agent — typically paired with the <c>ARI_BEARER_TOKEN</c> env var so no agentic
    /// token plumbing is required. The handoff burn, HC hash, expiry, and rate limit
    /// still apply. Hard-gated: startup throws if this is selected outside
    /// <c>ASPNETCORE_ENVIRONMENT=Development</c> (or <c>Playground</c>).
    /// </summary>
    DevBypass,
}

/// <summary>
/// Options bound from the "ScreenShare" config section. Drives the static SPA at
/// /screenshare.html and the link the agent posts in chat.
///
/// The user viewing the page is authenticated according to <see cref="AuthMode"/>
/// (EasyAuth in production, DevBypass for local testing). The ARI bearer token is
/// always minted server-side by the agent (see MyAgent.BuildScreenSharePageUrlAsync).
/// Teams SSO (page embedded inside Teams as a tab/dialog/stage) is a documented
/// future extension and is intentionally not implemented in this sample.
/// </summary>
public sealed class ScreenShareOptions
{
    public const string SectionName = "ScreenShare";

    /// <summary>
    /// How the token-exchange endpoint establishes the viewer's identity. Defaults to
    /// <see cref="ScreenShareAuthMode.EasyAuth"/> (production). Set to
    /// <see cref="ScreenShareAuthMode.DevBypass"/> only for local/Playground testing —
    /// startup fails fast if DevBypass is selected outside a development environment.
    /// </summary>
    public ScreenShareAuthMode AuthMode { get; set; } = ScreenShareAuthMode.EasyAuth;

    /// <summary>
    /// Absolute base URL where the SPA is served. When empty, the agent falls back to
    /// <c>WEBSITE_HOSTNAME</c> (auto-populated on Azure App Service); when neither is
    /// available the screenshare link emission is skipped.
    /// </summary>
    public string? PageBaseUrl { get; set; }

    /// <summary>
    /// W365 ScreenShare SDK version path on the CDN — e.g. <c>1.0.0</c> (pinned, preferred for prod)
    /// or <c>latest</c> (~5-minute CDN cache, dev only). The SPA loads
    /// <c>{CdnOrigin}/screenshare-sdk/{SdkVersion}/screenshare-embed.js</c> and passes
    /// <c>{CdnOrigin}/screenshare-sdk/{SdkVersion}</c> as <c>viewerUrl</c> to the SDK so the
    /// iframe is loaded from the CDN (origin already allowlisted by ARI — no partner-side CORS).
    /// </summary>
    public string SdkVersion { get; set; } = "1.0.0";

    /// <summary>
    /// CDN origin serving the W365 ScreenShare SDK and viewer.
    /// <list type="bullet">
    ///   <item><c>https://packages.global.cloudinferenceplatform.azure.com</c> — PROD (default).</item>
    ///   <item><c>https://packages.global.cloudinferenceplatform-int.azure.com</c> — INT.</item>
    /// </list>
    /// Must match the ARI audience environment of the bearer tokens the agent mints.
    /// </summary>
    public string CdnOrigin { get; set; } = "https://packages.global.cloudinferenceplatform.azure.com";

    /// <summary>
    /// Origins allowed to iframe <c>/screenshare.html</c>. Emitted as
    /// <c>Content-Security-Policy: frame-ancestors</c> on the response (the
    /// <c>&lt;meta&gt;</c> form of <c>frame-ancestors</c> is ignored by browsers
    /// per CSP spec). In prod this typically includes <c>https://teams.microsoft.com</c>,
    /// <c>https://*.teams.microsoft.com</c>, and <c>https://*.cloud.microsoft</c> (new Teams).
    /// </summary>
    public string[] AllowedFrameAncestors { get; set; } = Array.Empty<string>();
}
