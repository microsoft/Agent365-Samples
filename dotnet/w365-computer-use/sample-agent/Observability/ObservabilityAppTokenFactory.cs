// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

extern alias ObservabilityIdentity;

using System;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Azure.Core;
using Microsoft.Extensions.Configuration;
using AuthenticationFailedException = ObservabilityIdentity::Azure.Identity.AuthenticationFailedException;
using ManagedIdentityCredential = ObservabilityIdentity::Azure.Identity.ManagedIdentityCredential;
using ManagedIdentityId = ObservabilityIdentity::Azure.Identity.ManagedIdentityId;

namespace Agent365.Samples.Observability;

internal static class ObservabilityAppTokenFactory
{
    public static ObservabilityAppTokenProvider? CreateIfEnabled(IConfiguration configuration) =>
        IsAgent365ExporterEnabled(configuration) ? Create(configuration) : null;

    public static bool IsAgent365ExporterEnabled(IConfiguration configuration)
    {
        var nodeStyle = configuration["ENABLE_A365_OBSERVABILITY_EXPORTER"];
        if (!string.IsNullOrWhiteSpace(nodeStyle))
        {
            return ParseEnabled(nodeStyle, "ENABLE_A365_OBSERVABILITY_EXPORTER");
        }

        var dotNetStyle = configuration["EnableAgent365Exporter"];
        return !string.IsNullOrWhiteSpace(dotNetStyle)
            && ParseEnabled(dotNetStyle, "EnableAgent365Exporter");
    }

    public static ObservabilityAppTokenProvider Create(IConfiguration configuration)
    {
        var options = ObservabilityAppTokenOptions.FromConfiguration(key => configuration[key]);
        Func<CancellationToken, Task<string>>? assertionProvider = null;
        if (options.UseManagedIdentity)
        {
            var identity = options.ManagedIdentityClientId is null
                ? ManagedIdentityId.SystemAssigned
                : ManagedIdentityId.FromUserAssignedClientId(options.ManagedIdentityClientId);
            var credential = new ManagedIdentityCredential(identity);
            assertionProvider = cancellationToken => GetManagedIdentityAssertionAsync(credential, cancellationToken);
        }

        var httpClient = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
        {
            Timeout = TimeSpan.FromSeconds(30),
        };
        return new ObservabilityAppTokenProvider(options, httpClient, managedIdentityAssertion: assertionProvider);
    }

    internal static async Task<string> GetManagedIdentityAssertionAsync(TokenCredential credential, CancellationToken cancellationToken)
    {
        try
        {
            var assertion = await credential.GetTokenAsync(
                new TokenRequestContext([ObservabilityAppTokenProvider.ExchangeScope]),
                cancellationToken).ConfigureAwait(false);
            return assertion.Token;
        }
        catch (AuthenticationFailedException)
        {
            throw new ObservabilityTokenAcquisitionException();
        }
        catch (Azure.RequestFailedException)
        {
            throw new ObservabilityTokenAcquisitionException();
        }
    }

    private static bool ParseEnabled(string value, string setting) =>
        value.Trim().ToLowerInvariant() switch
        {
            "true" or "1" or "yes" or "on" => true,
            "false" or "0" or "no" or "off" => false,
            _ => throw new InvalidOperationException($"{setting} must be true or false."),
        };
}
