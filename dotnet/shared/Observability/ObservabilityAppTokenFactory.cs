// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

extern alias ObservabilityIdentity;

using System;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Azure.Core;
using Microsoft.Extensions.Configuration;
using ManagedIdentityCredential = ObservabilityIdentity::Azure.Identity.ManagedIdentityCredential;
using ManagedIdentityId = ObservabilityIdentity::Azure.Identity.ManagedIdentityId;

namespace Agent365.Samples.Observability;

internal static class ObservabilityAppTokenFactory
{
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
            assertionProvider = async cancellationToken =>
            {
                var assertion = await credential.GetTokenAsync(
                    new TokenRequestContext(["api://AzureADTokenExchange"]),
                    cancellationToken).ConfigureAwait(false);
                return assertion.Token;
            };
        }

        var httpClient = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
        {
            Timeout = TimeSpan.FromSeconds(30),
        };
        return new ObservabilityAppTokenProvider(options, httpClient, managedIdentityAssertion: assertionProvider);
    }
}
