namespace ProcurementA365Agent.Plugins;

using System.ComponentModel;
using ProcurementA365Agent.Models;
using ProcurementA365Agent.Services;
using Microsoft.SemanticKernel;

public sealed class SharePointPlugin(
    AgentMetadata agent, GraphService graphService)
{
    [KernelFunction,
    Description("Lists all files in a SharePoint site")]
    public async Task<string> ListFilesInSite(
        [Description("The ID of the SharePoint site")]
        string siteId,
        CancellationToken cancellationToken)
    {
        var result = await graphService.ListSharepointFiles(agent, siteId, cancellationToken);
        Console.WriteLine(result);
        return result;
    }
}