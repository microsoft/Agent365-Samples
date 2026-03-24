namespace ProcurementA365Agent.Plugins;

using System.ComponentModel;
using ProcurementA365Agent.Models;
using ProcurementA365Agent.Services;
using Microsoft.SemanticKernel;

public sealed class FilePlugin(AgentMetadata agent, GraphService graphService)
{
    [KernelFunction("ListSharedFiles"),
     Description("Lists all files shared with the agent")]
    public async Task<string> ListSharedFiles(CancellationToken cancellationToken)
    {
        var response = await graphService.ListSharedFiles(agent, cancellationToken);
        Console.WriteLine(response);
        return $"Shared files: \n{response}";
    }

    [KernelFunction,
     Description("Reads the content of a file from a specified file ID in the agent's OneDrive")]
    public async Task<string> ReadFile(
        [Description("The ID of the file in the agent's OneDrive")]
        string fileId,
        CancellationToken cancellationToken)
    {
        var response = await graphService.ReadFile(agent, fileId, cancellationToken);
        Console.WriteLine(response);
        return $"File content: \n{response}";
    }

    [KernelFunction("ReadAttachedFile"),
     Description("Reads the content of a file from a specified OneDrive path using a share link")]
    public async Task<string> ReadAttachedFile(
        [Description("The share link to the file in OneDrive (e.g., 'https://onedrive.live.com/?id=12345')")]
        string sharingUrl,
        CancellationToken cancellationToken)
    {
        var response = await graphService.ReadFileBySharingUrl(agent, sharingUrl, cancellationToken);
        Console.WriteLine(response);
        return $"File content: \n{response}";
    }
}