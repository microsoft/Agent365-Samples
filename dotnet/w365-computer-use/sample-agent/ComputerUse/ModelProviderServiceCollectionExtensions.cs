// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

namespace W365ComputerUseSample.ComputerUse;

public static class ModelProviderServiceCollectionExtensions
{
    public static IServiceCollection AddConfiguredCuaModelProvider(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        var provider = configuration["AIServices:Provider"] ?? "AzureOpenAI";
        if (provider.Equals("AzureOpenAI", StringComparison.OrdinalIgnoreCase))
        {
            return services.AddSingleton<ICuaModelProvider, AzureOpenAIModelProvider>();
        }

        if (provider.Equals("CustomEndpoint", StringComparison.OrdinalIgnoreCase))
        {
            return services.AddSingleton<ICuaModelProvider, CustomEndpointProvider>();
        }

        throw new InvalidOperationException(
            $"Unsupported AIServices:Provider '{provider}'. Use 'AzureOpenAI' or 'CustomEndpoint'.");
    }
}
