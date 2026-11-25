// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.Text.Encodings.Web;

namespace W365ComputerUseSample.Authentication;

internal static class HumanW365SignInPages
{
    internal static string Render(string title, string step, string content, bool confirmation = false) => $"""
        <!doctype html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="color-scheme" content="light dark">
        <title>{Encode(title)} | Windows 365 computer use</title>
        <link rel="stylesheet" href="/w365-auth/sign-in.css">
        {(confirmation ? "<script src=\"/w365-human-auth.js\" defer></script>" : "")}
        </head>
        <body>
        <main class="auth-card" aria-labelledby="page-title">
        <header class="product">
        <p class="product-family">Microsoft Agent 365 sample</p>
        <p class="product-name">Windows 365 computer use</p>
        </header>
        <p class="step">{Encode(step)}</p>
        <h1 id="page-title">{Encode(title)}</h1>
        {content}
        <aside class="notice" aria-label="About this sign-in">
        <h2>Two separate sign-ins</h2>
        <p>This authorization lets the agent call Windows 365 as you. If your Cloud PC also needs
        sign-in, a separate link will appear in the original chat. This page does not sign you in
        to the Cloud PC or start a desktop task.</p>
        </aside>
        <footer><p>Keep this link private. To continue or cancel your request, return to the original chat.</p></footer>
        </main>
        </body>
        </html>
        """;

    internal static string SignInAction(string code)
    {
        var completion = HumanW365AuthenticationEndpoints.CompletionPath + "?code=" + Uri.EscapeDataString(code);
        var login = "/.auth/login/aad?post_login_redirect_uri=" + Uri.EscapeDataString(completion);
        return $"""
            <a class="microsoft-sign-in" href="{Encode(login)}">
            <picture>
            <source media="(prefers-color-scheme: dark)" srcset="/w365-auth/ms-signin-dark.svg">
            <img src="/w365-auth/ms-signin-light.svg" width="215" height="41" alt="Sign in with Microsoft">
            </picture>
            </a>
            """;
    }

    internal static string SwitchAccountAction(string code)
    {
        var entry = HumanW365AuthenticationEndpoints.SignInPath + "?code=" + Uri.EscapeDataString(code);
        var logout = "/.auth/logout?post_logout_redirect_uri=" + Uri.EscapeDataString(entry);
        return $"<p><a href=\"{Encode(logout)}\">Sign out and use another account</a></p>";
    }

    internal static string Encode(string value) => HtmlEncoder.Default.Encode(value);
}
