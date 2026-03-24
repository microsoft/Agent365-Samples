namespace ProcurementA365Agent.AgentLogic.SemanticKernel;

using Azure.Core;
using Azure.Identity;
using ProcurementA365Agent.AgentLogic.AuthCache;
using ProcurementA365Agent.Mcp;
using ProcurementA365Agent.Models;
using ProcurementA365Agent.Plugins;
using ProcurementA365Agent.Services;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App.UserAuth;
using Microsoft.Agents.A365.Runtime.Utils;
using Microsoft.Agents.A365.Tooling.Extensions.SemanticKernel.Services;
using Microsoft.SemanticKernel;

/// <summary>
/// There are still some work left here:
/// 1- The factory structure doesn't follow the factory pattern.
/// 2- There are constants that need to be moved to configuration (TBD on what configuration).
/// 3- We need a way to dynamically build the MCP server URL. It is environment specific and it won't work in prod as is.
/// 4- still the way we get the AA cert seems hacky.
/// 5- Scope needs to be updated.
/// 6- Remove disabling cert validation.
/// </summary>
public sealed class SemanticKernelAgentLogicServiceFactory(
    IConfiguration configuration,
    IServiceProvider serviceProvider,
    ILogger<SemanticKernelAgentLogicServiceFactory> logger,
    McpToolDiscovery mcpToolDiscovery,
    AgentTokenHelper tokenHelper,
    IMcpToolRegistrationService mcpToolRegistrationService,
    IAgentTokenCache tokenCache,
    IAgentMetadataRepository agentRepository)
{
    private readonly string certificateData = configuration.GetCertificateData() ?? throw new ArgumentNullException("HelloWorldServiceAuth");

    public async Task<IAgentLogicService> CreateAsync(AgentMetadata agent)
    {
        var kernelBuilder = Kernel.CreateBuilder();
        AddModel(kernelBuilder);
        var kernel = kernelBuilder.Build();
        await ConfigureKernelPlugins(agent, kernel);

        // Resolve GraphService for constructor injection
        var scopedServiceProvider = serviceProvider.CreateScope().ServiceProvider;

        var graphService = scopedServiceProvider.GetRequiredService<GraphService>();
        try
        {
            // Attempt to set presence to busy and status message indicating active work
            await graphService.SetPresence(agent, PresenceState.BusyInCall);
            await graphService.SetStatusMessage(agent, "I am working on a user request at the moment, feel free to send me a message and I can pick it up when I am available.");
        } 
        catch (Exception ex) 
        {
            logger.LogError(ex, "Failed to set presence or status message for agent {AgentId}", agent.AgentId);
        }

        return new SemanticKernelAgentLogicService(tokenHelper, agent, kernel, certificateData, configuration, logger, mcpToolRegistrationService, tokenCache, graphService, agentRepository);
    }

    private async Task ConfigureKernelPlugins(AgentMetadata agent, Kernel kernel)
    {
        var scopedServiceProvider = serviceProvider.CreateScope().ServiceProvider;
        var graphService = scopedServiceProvider.GetRequiredService<GraphService>();
        
        if (configuration["McpEnabled"]?.ToLower() == "true")
        {
            var requestContext = new TokenRequestContext([Utility.GetMcpPlatformAuthenticationScope()]);
            var tokenCredential = new AgentTokenCredential(tokenHelper, agent, certificateData);
            var accessToken = tokenCredential.GetTokenAsync(requestContext, CancellationToken.None).GetAwaiter().GetResult();
            string agentUserId = agent.UserId.ToString();
            var environmentId = configuration["McpPlatformEnvironmentId"] ?? Environment.GetEnvironmentVariable("McpPlatformEnvironmentId");
            if (string.IsNullOrEmpty(environmentId))
            {
                environmentId = $"Default-{agent.TenantId.ToString()}";
            }
            UserAuthorization userAuthorization = null;
            ITurnContext turnContext = null;

            try
            {
                mcpToolRegistrationService.AddToolServersToAgent(kernel, agentUserId, environmentId, userAuthorization, turnContext, accessToken.Token);
            } catch (Exception ex) 
            {
                logger.LogError(ex, "Failed to add MCP Tool Servers for agent {AgentId}", agent.AgentId);
                // TODO: Remove this?
            }
            // Add plugins for procurement functionality
            kernel.Plugins.AddFromObject(new FilePlugin(agent, graphService));
            kernel.Plugins.AddFromObject(new SAPPlugin(agent, kernel, scopedServiceProvider.GetRequiredService<ILogger<SAPPlugin>>(), configuration));
            kernel.Plugins.AddFromObject(new GensparkPlugin(agent, kernel, scopedServiceProvider.GetRequiredService<ILogger<GensparkPlugin>>(), configuration));
        } 
        else if (!string.IsNullOrWhiteSpace(agent.McpServerUrl))
        {
            // Fallback to older way of adding MCP server
            logger.LogInformation("MCP tools enabled for agent {AgentId} with server URL {McpServerUrl}", agent.AgentId, agent.McpServerUrl);
            var wrappedFunctions = await mcpToolDiscovery.Discover(agent);
            kernel.Plugins.AddFromFunctions("CCSMCP", wrappedFunctions);
        }
        else
        {
            // Fallback to custom coded plugins
            var agentMessagingService = scopedServiceProvider.GetRequiredService<IAgentMessagingService>();
            
            // Add core plugins
            kernel.Plugins.AddFromObject(new OutlookPlugin(agentMessagingService, agent));
            kernel.Plugins.AddFromObject(new DataversePlugin(scopedServiceProvider.GetRequiredService<DataverseService>(), agent));
            kernel.Plugins.AddFromObject(new FilePlugin(agent, graphService));
            kernel.Plugins.AddFromObject(new SAPPlugin(agent, kernel, scopedServiceProvider.GetRequiredService<ILogger<SAPPlugin>>(), configuration));
            kernel.Plugins.AddFromObject(new KasistoPlugin(agent, scopedServiceProvider.GetRequiredService<ILogger<KasistoPlugin>>(), configuration));
            kernel.Plugins.AddFromObject(new GensparkPlugin(agent, kernel, scopedServiceProvider.GetRequiredService<ILogger<GensparkPlugin>>(), configuration));
        }
    }

    private IKernelBuilder AddModel(IKernelBuilder kernelBuilder)
    {
        var deployment = configuration["ModelDeployment"] ?? throw new ArgumentNullException("ModelDeployment");
        var azureOpenAiEndpoint = configuration["AzureOpenAIEndpoint"] ?? throw new ArgumentNullException("AzureOpenAIEndPoint");
        // Kept this for people who use API key in settings.
        // var apiKey = _configuration["OpenAiApiKey"] ?? throw new ArgumentNullException("OpenAiApiKey");

        return kernelBuilder.AddAzureOpenAIChatCompletion(
            deploymentName: deployment,
            endpoint: azureOpenAiEndpoint,
            // Ensure token is always picked up from terminal
            new DefaultAzureCredential()
        );
    }
}