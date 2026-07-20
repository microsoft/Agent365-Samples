// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace W365ComputerUseSample.ComputerUse;

public static class ModelProviderServiceCollectionExtensions
{
    public static IServiceCollection AddCuaModelProvider(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        var provider = configuration["AIServices:Provider"] ?? "AzureOpenAI";
        if (string.Equals(provider, "AzureOpenAI", StringComparison.OrdinalIgnoreCase))
        {
            services.AddSingleton<ICuaModelProvider, AzureOpenAIModelProvider>();
            return services;
        }

        throw new InvalidOperationException(
            $"Unsupported AIServices:Provider '{provider}'. Only 'AzureOpenAI' is supported.");
    }
}
