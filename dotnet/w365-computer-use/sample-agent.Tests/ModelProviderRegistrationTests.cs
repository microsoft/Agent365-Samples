// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using W365ComputerUseSample.ComputerUse;
using Xunit;

namespace W365ComputerUseSample.Tests;

public sealed class ModelProviderRegistrationTests
{
    [Theory]
    [InlineData("AzureOpenAI", typeof(AzureOpenAIModelProvider))]
    [InlineData("CustomEndpoint", typeof(CustomEndpointProvider))]
    public void AddConfiguredCuaModelProvider_registers_selected_provider(
        string provider,
        Type expectedImplementationType)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["AIServices:Provider"] = provider,
            })
            .Build();
        var services = new ServiceCollection();

        services.AddConfiguredCuaModelProvider(configuration);

        var registration = Assert.Single(
            services,
            descriptor => descriptor.ServiceType == typeof(ICuaModelProvider));
        Assert.Equal(expectedImplementationType, registration.ImplementationType);
    }

    [Fact]
    public void AddConfiguredCuaModelProvider_rejects_unknown_provider()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["AIServices:Provider"] = "unknown",
            })
            .Build();

        var exception = Assert.Throws<InvalidOperationException>(
            () => new ServiceCollection().AddConfiguredCuaModelProvider(configuration));

        Assert.Contains("AIServices:Provider", exception.Message);
    }
}
