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
    /// Production. The page sits behind Azure App Service Authentication (EasyAuth), which
    /// signs the user in and lets the token endpoint verify their identity. The default.
    /// </summary>
    EasyAuth,

    /// <summary>
    /// Local dev / Playground only. The token endpoint skips the user-identity check so the
    /// sample can run in a plain browser tab, typically with the <c>ARI_BEARER_TOKEN</c> env
    /// var. Startup fails fast if selected outside a development environment.
    /// </summary>
    DevBypass,
}

/// <summary>
/// Options bound from the "ScreenShare" config section. Drives the SPA at /screenshare.html
/// and the link the agent posts in chat.
/// </summary>
public sealed class ScreenShareOptions
{
    public const string SectionName = "ScreenShare";

    /// <summary>
    /// How the token endpoint establishes the viewer's identity. Defaults to
    /// <see cref="ScreenShareAuthMode.EasyAuth"/>; use <see cref="ScreenShareAuthMode.DevBypass"/>
    /// only for local/Playground testing.
    /// </summary>
    public ScreenShareAuthMode AuthMode { get; set; } = ScreenShareAuthMode.EasyAuth;

    /// <summary>
    /// Absolute base URL where the SPA is served. When empty, falls back to
    /// <c>WEBSITE_HOSTNAME</c> (auto-populated on Azure App Service); when neither is set the
    /// screenshare link is not emitted.
    /// </summary>
    public string? PageBaseUrl { get; set; }

    /// <summary>
    /// Screenshare SDK version to load from the CDN — e.g. <c>1.0.0</c>.
    /// </summary>
    public string SdkVersion { get; set; } = "1.0.0";

    /// <summary>
    /// CDN origin serving the screenshare SDK and viewer. Must match the environment of the
    /// ARI bearer tokens the agent mints.
    /// </summary>
    public string CdnOrigin { get; set; } = "https://packages.global.cloudinferenceplatform.azure.com";

    /// <summary>
    /// Origins allowed to iframe <c>/screenshare.html</c>, emitted as the
    /// <c>Content-Security-Policy: frame-ancestors</c> response header. In production this
    /// typically includes the Teams / M365 hosts that embed the page.
    /// </summary>
    public string[] AllowedFrameAncestors { get; set; } = Array.Empty<string>();
}
