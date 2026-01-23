// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace Agent365SemanticKernelSampleAgent.Services;

/// <summary>
/// Service for sending Windows Push Notification Service (WNS) notifications
/// </summary>
public class WnsService
{
    private readonly string _tenantId;
    private readonly string _clientId;
    private readonly string _clientSecret;
    private readonly ILogger<WnsService> _logger;
    private string? _accessToken;
    private DateTime _tokenExpiry = DateTime.MinValue;

    public WnsService(IConfiguration config, ILogger<WnsService> logger)
    {
        _logger = logger;
        
        // Use the same pattern as ProtoSite - read directly from IConfiguration
        _tenantId = config["WnsConfiguration:TenantId"] ?? string.Empty;
        _clientId = config["WnsConfiguration:ClientId"] ?? string.Empty;
        _clientSecret = config["WnsConfiguration:ClientSecret"] ?? string.Empty;

        _logger.LogInformation("[WNS SERVICE CONSTRUCTOR] TenantId from config: {TenantId}", 
            string.IsNullOrEmpty(_tenantId) ? "EMPTY/NULL" : _tenantId.Substring(0, Math.Min(8, _tenantId.Length)));
        
        if (string.IsNullOrEmpty(_tenantId) || string.IsNullOrEmpty(_clientId) || string.IsNullOrEmpty(_clientSecret))
        {
            _logger.LogWarning("[WNS SERVICE] WnsConfiguration is incomplete. Local MCP functionality will not be available.");
        }
        else
        {
            _logger.LogInformation("[WNS SERVICE] Initialized successfully with TenantId: {TenantId}, ClientId: {ClientId}",
                _tenantId, _clientId);
        }
    }

    /// <summary>
    /// Gets an access token for WNS, using cached token if still valid
    /// </summary>
    public async Task<string> GetAccessTokenAsync()
    {
        // Return cached token if still valid
        if (_accessToken != null && DateTime.UtcNow < _tokenExpiry)
        {
            _logger.LogDebug("[WNS SERVICE] Using cached access token (expires: {Expiry})", _tokenExpiry);
            return _accessToken;
        }

        _logger.LogInformation("[WNS SERVICE] Requesting new access token from Azure AD...");
        _logger.LogDebug("[WNS SERVICE] TenantId: {TenantId}", _tenantId);
        _logger.LogDebug("[WNS SERVICE] ClientId: {ClientId}", _clientId);

        using var client = new HttpClient();

        // Use Azure AD v2.0 endpoint (modern approach per Microsoft docs)
        // See: https://learn.microsoft.com/en-us/windows/apps/develop/notifications/push-notifications/push-quickstart
        var tokenEndpoint = $"https://login.microsoftonline.com/{_tenantId}/oauth2/v2.0/token";

        var content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "client_credentials",
            ["client_id"] = _clientId,
            ["client_secret"] = _clientSecret,
            ["scope"] = "https://wns.windows.com/.default"  // Azure AD scope format
        });

        try
        {
            _logger.LogDebug("[WNS SERVICE] Token endpoint: {Endpoint}", tokenEndpoint);

            var response = await client.PostAsync(tokenEndpoint, content);

            var responseBody = await response.Content.ReadAsStringAsync();

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogError("[WNS SERVICE] Token request failed with status {StatusCode}", response.StatusCode);
                _logger.LogError("[WNS SERVICE] Response body: {ResponseBody}", responseBody);
                response.EnsureSuccessStatusCode();
            }

            var result = JsonSerializer.Deserialize<JsonElement>(responseBody);
            _accessToken = result.GetProperty("access_token").GetString();

            // Handle expires_in as either string or number
            var expiresInProperty = result.GetProperty("expires_in");
            var expiresIn = expiresInProperty.ValueKind == JsonValueKind.String
                ? int.Parse(expiresInProperty.GetString()!)
                : expiresInProperty.GetInt32();

            // Cache token with 5-minute buffer before expiry
            _tokenExpiry = DateTime.UtcNow.AddSeconds(expiresIn - 300);

            _logger.LogInformation("[WNS SERVICE] ? Access token acquired (expires: {Expiry})", _tokenExpiry);
            _logger.LogInformation("[WNS SERVICE] Access token acquired successfully (expires: {Expiry})", _tokenExpiry);

            return _accessToken!;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[WNS SERVICE] Failed to acquire access token");
            _logger.LogError("[WNS SERVICE] Make sure you're using Azure AD App Registration credentials:");
            _logger.LogError("[WNS SERVICE]   - TenantId should be your Azure AD tenant ID");
            _logger.LogError("[WNS SERVICE]   - ClientId should be Application (client) ID from Azure AD");
            _logger.LogError("[WNS SERVICE]   - ClientSecret should be client secret from Azure AD");
            _logger.LogError("[WNS SERVICE]   - App must have WNS API permission in Azure AD");
            throw;
        }
    }

    /// <summary>
    /// Sends a WNS raw notification to the specified channel URI
    /// </summary>
    /// <param name="channelUri">The WNS channel URI to send to</param>
    /// <param name="callbackUrl">The callback URL for the client to connect to</param>
    /// <param name="serverId">Optional MCP server ID to include in the payload</param>
    /// <returns>A tuple indicating success and an optional error message</returns>
    public async Task<(bool Success, string? ErrorMessage)> SendNotificationAsync(string channelUri, string callbackUrl, string? serverId = null)
    {
        _logger.LogInformation("[WNS SERVICE] Sending notification to channel: {ChannelUri}",
            channelUri.Substring(0, Math.Min(60, channelUri.Length)) + "...");
        _logger.LogInformation("[WNS SERVICE] Callback URL: {CallbackUrl}", callbackUrl);
        if (!string.IsNullOrEmpty(serverId))
        {
            _logger.LogInformation("[WNS SERVICE] Server ID: {ServerId}", serverId);
        }

        try
        {
            var accessToken = await GetAccessTokenAsync();
            _logger.LogDebug("[WNS SERVICE] Access token length: {Length}", accessToken.Length);

            // Build notification payload - always include serverId (matching ProtoSite pattern)
            var notification = new
            {
                callback = callbackUrl,
                serverId = serverId,
                timestamp = DateTime.UtcNow
            };

            var payload = JsonSerializer.Serialize(notification);
            _logger.LogInformation("[WNS SERVICE] Payload: {Payload}", payload);

            using var client = new HttpClient();
            client.Timeout = TimeSpan.FromSeconds(30);

            // WNS requires the payload as raw bytes without any encoding wrapper
            var payloadBytes = Encoding.UTF8.GetBytes(payload);

            var request = new HttpRequestMessage(HttpMethod.Post, channelUri);
            request.Content = new ByteArrayContent(payloadBytes);

            // Critical: Set Content-Type to application/octet-stream WITHOUT any parameters
            request.Content.Headers.ContentType =
                System.Net.Http.Headers.MediaTypeHeaderValue.Parse("application/octet-stream");

            // Set Content-Length explicitly
            request.Content.Headers.ContentLength = payloadBytes.Length;

            // Required WNS headers - order matters for some WNS implementations
            request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {accessToken}");
            request.Headers.TryAddWithoutValidation("X-WNS-Type", "wns/raw");
            request.Headers.TryAddWithoutValidation("X-WNS-RequestForStatus", "true");

            _logger.LogInformation("[WNS SERVICE] Sending HTTP POST to WNS...");
            _logger.LogInformation("[WNS SERVICE] Payload size: {Size} bytes", payloadBytes.Length);
            _logger.LogDebug("[WNS SERVICE] Content-Type: {ContentType}",
                request.Content.Headers.ContentType?.ToString() ?? "null");

            var response = await client.SendAsync(request);

            _logger.LogInformation("[WNS SERVICE] WNS response status: {StatusCode}", response.StatusCode);

            // Log all response headers for debugging
            _logger.LogDebug("[WNS SERVICE] Response Headers:");
            foreach (var header in response.Headers)
            {
                _logger.LogDebug("[WNS SERVICE]   {Key}: {Value}",
                    header.Key, string.Join(", ", header.Value));
            }

            // Log content headers too
            if (response.Content?.Headers != null)
            {
                foreach (var header in response.Content.Headers)
                {
                    _logger.LogDebug("[WNS SERVICE]   {Key}: {Value}",
                        header.Key, string.Join(", ", header.Value));
                }
            }

            if (response.IsSuccessStatusCode)
            {
                _logger.LogInformation("[WNS SERVICE] ? Notification sent successfully");
                _logger.LogInformation("[WNS SERVICE] Notification sent successfully");

                // Log notification status from headers
                if (response.Headers.TryGetValues("X-WNS-NotificationStatus", out var notifStatus))
                {
                    _logger.LogInformation("[WNS SERVICE] Notification Status: {Status}",
                        string.Join(", ", notifStatus));
                }

                return (true, null);
            }
            else
            {
                var responseBody = await response.Content.ReadAsStringAsync();
                var errorMessage = $"WNS returned {response.StatusCode}";

                // Collect all WNS error information
                if (response.Headers.TryGetValues("X-WNS-Status", out var wnsStatus))
                {
                    errorMessage += $" | X-WNS-Status: {string.Join(", ", wnsStatus)}";
                    _logger.LogWarning("[WNS SERVICE] X-WNS-Status: {Status}", string.Join(", ", wnsStatus));
                }

                if (response.Headers.TryGetValues("X-WNS-Error-Description", out var wnsError))
                {
                    errorMessage += $" | Error: {string.Join(", ", wnsError)}";
                    _logger.LogWarning("[WNS SERVICE] X-WNS-Error-Description: {Error}",
                        string.Join(", ", wnsError));
                }

                if (response.Headers.TryGetValues("X-WNS-DeviceConnectionStatus", out var deviceStatus))
                {
                    errorMessage += $" | Device: {string.Join(", ", deviceStatus)}";
                    _logger.LogWarning("[WNS SERVICE] X-WNS-DeviceConnectionStatus: {Status}",
                        string.Join(", ", deviceStatus));
                }

                if (response.Headers.TryGetValues("X-WNS-NotificationStatus", out var notifStatus))
                {
                    errorMessage += $" | NotifStatus: {string.Join(", ", notifStatus)}";
                    _logger.LogWarning("[WNS SERVICE] X-WNS-NotificationStatus: {Status}",
                        string.Join(", ", notifStatus));
                }

                if (!string.IsNullOrEmpty(responseBody))
                {
                    errorMessage += $" | Body: {responseBody}";
                    _logger.LogWarning("[WNS SERVICE] Response Body: {Body}", responseBody);
                }

                _logger.LogError("[WNS SERVICE] Notification failed: {ErrorMessage}", errorMessage);
                return (false, errorMessage);
            }
        }
        catch (Exception ex)
        {
            var errorMessage = $"Exception: {ex.Message}";
            _logger.LogError(ex, "[WNS SERVICE] Error sending notification");

            if (ex.InnerException != null)
            {
                _logger.LogError(ex.InnerException, "[WNS SERVICE] Inner exception");
                errorMessage += $" | Inner: {ex.InnerException.Message}";
            }

            return (false, errorMessage);
        }
    }
}
