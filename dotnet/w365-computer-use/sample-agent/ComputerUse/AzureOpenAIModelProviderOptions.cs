// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

namespace W365ComputerUseSample.ComputerUse;

internal sealed class AzureOpenAIModelProviderOptions
{
    public required string Url { get; init; }

    public required string ModelName { get; init; }

    public static AzureOpenAIModelProviderOptions FromConfiguration(IConfiguration configuration)
    {
        var endpoint = configuration["AIServices:AzureOpenAI:Endpoint"]
            ?? throw new InvalidOperationException("AIServices:AzureOpenAI:Endpoint is required.");

        var configuredModelName = configuration["AIServices:AzureOpenAI:ModelName"];
        var deploymentName = configuration["AIServices:AzureOpenAI:DeploymentName"];
        var modelName = !string.IsNullOrWhiteSpace(configuredModelName)
            ? configuredModelName
            : !string.IsNullOrWhiteSpace(deploymentName)
                ? deploymentName
                : "computer-use-preview";

        return new AzureOpenAIModelProviderOptions
        {
            ModelName = modelName,
            Url = $"{endpoint.TrimEnd('/')}/openai/v1/responses",
        };
    }
}
