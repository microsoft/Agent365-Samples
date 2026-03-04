// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Microsoft.Agents.Builder;
using System.ComponentModel;
using System.Net.Http.Headers;
using System.Text.Json;

namespace Agent365AgentFrameworkSampleAgent.Tools
{
    /// <summary>
    /// Provides tools for the agent to identify and retrieve information about the current A365 user.
    ///
    /// Two sources of user information are demonstrated:
    ///   1. <see cref="GetCurrentUser"/> — reads from <c>Activity.From</c>, always available with no
    ///      API call. Use this for housekeeping, routing, and personalization at the start of each turn.
    ///   2. <see cref="GetCurrentUserExtendedProfileAsync"/> — calls Microsoft Graph <c>/me</c> using
    ///      the access token already acquired by the auth handler. Returns richer profile data (email,
    ///      job title, department, etc.) not present in the activity payload.
    ///
    /// For app-only (client credentials) token scenarios, replace the <c>/me</c> call with
    /// <c>/users/{AadObjectId}</c>, where <c>AadObjectId</c> comes from <see cref="CurrentUserInfo.AadObjectId"/>.
    /// </summary>
    public class CurrentUserTool(ITurnContext turnContext, string? accessToken, ILogger? logger)
    {
        /// <summary>
        /// Gets the current user's basic identity from the activity payload.
        /// This is the primary way agents identify who they are talking to in A365.
        /// The data is populated by the platform on every incoming activity — no token or API call required.
        /// </summary>
        [Description("Gets the current user's identity from the activity: channel user ID, display name, and Azure AD Object ID.")]
        public CurrentUserInfo GetCurrentUser()
        {
            // Activity.From is set by the A365 platform on every incoming message.
            //   From.Id          — channel-specific user ID (e.g., "29:1AbcXyz..." in Teams)
            //   From.Name        — display name as known to the channel
            //   From.AadObjectId — Azure AD Object ID; use this for Microsoft Graph calls
            var from = turnContext.Activity.From;

            var userInfo = new CurrentUserInfo
            {
                UserId = from?.Id ?? string.Empty,
                DisplayName = from?.Name ?? string.Empty,
                AadObjectId = from?.AadObjectId ?? string.Empty
            };

            logger?.LogDebug(
                "User identity from activity — UserId: {UserId}, DisplayName: {DisplayName}, AadObjectId: {AadObjectId}",
                userInfo.UserId, userInfo.DisplayName, userInfo.AadObjectId);

            return userInfo;
        }

        /// <summary>
        /// Gets the current user's extended profile from Microsoft Graph.
        /// Reuses the access token already acquired by the turn's auth handler — no additional
        /// sign-in is needed. Returns fields not available in the activity payload, such as
        /// email address, job title, department, and office location.
        /// </summary>
        [Description("Gets extended user profile from Microsoft Graph: email, job title, department, office location. Requires a valid Graph access token.")]
        public async Task<string> GetCurrentUserExtendedProfileAsync()
        {
            if (string.IsNullOrEmpty(accessToken))
            {
                logger?.LogWarning("No access token available — cannot retrieve extended user profile from Graph.");
                return "Extended profile unavailable: no access token. Ensure an auth handler with Graph scope is configured.";
            }

            // /me returns the profile of the signed-in user (delegated / OBO token).
            // For app-only tokens (client credentials), call /users/{AadObjectId} instead —
            // the AadObjectId is available from GetCurrentUser().AadObjectId.
            const string graphEndpoint =
                "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName,jobTitle,department,officeLocation";

            // Note: In production, inject IHttpClientFactory via the constructor to avoid socket exhaustion.
            using var httpClient = new HttpClient();
            httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);

            var response = await httpClient.GetAsync(graphEndpoint).ConfigureAwait(false);

            if (!response.IsSuccessStatusCode)
            {
                var error = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                logger?.LogWarning("Graph /me call failed: {StatusCode} — {Error}", response.StatusCode, error);
                return $"Failed to retrieve extended profile: HTTP {(int)response.StatusCode} {response.StatusCode}.";
            }

            var json = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            var parsed = JsonSerializer.Deserialize<JsonElement>(json);
            return JsonSerializer.Serialize(parsed, new JsonSerializerOptions { WriteIndented = true });
        }
    }

    /// <summary>
    /// Basic user identity as provided by the A365 platform in the activity payload.
    /// Available on every turn with no additional API calls.
    /// </summary>
    public class CurrentUserInfo
    {
        /// <summary>Channel-specific user identifier (e.g., Teams AAD ID or WebChat session ID).</summary>
        public string UserId { get; set; } = string.Empty;

        /// <summary>User's display name as reported by the channel.</summary>
        public string DisplayName { get; set; } = string.Empty;

        /// <summary>
        /// Azure Active Directory Object ID of the user.
        /// Use this with Microsoft Graph <c>/users/{AadObjectId}</c> when calling with an app-only
        /// (client credentials) token, or use <c>/me</c> when calling with a delegated (OBO) token.
        /// </summary>
        public string AadObjectId { get; set; } = string.Empty;
    }
}
