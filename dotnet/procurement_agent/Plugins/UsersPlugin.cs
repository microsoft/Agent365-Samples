namespace ProcurementA365Agent.Plugins;

using System.ComponentModel;
using System.Text.Json;
using ProcurementA365Agent.Models;
using ProcurementA365Agent.Services;
using Microsoft.SemanticKernel;

public sealed class UsersPlugin(
    GraphService graphService,
    AgentMetadata agent)
{
    [KernelFunction]
    public async Task<string> GetUserDetails(
        [Description("The user ID of the user to retrieve details for")]
        string userId,
        CancellationToken cancellationToken)
    {
        var user = await graphService.FindUserById(agent, userId, cancellationToken);
        return user != null ? JsonSerializer.Serialize(user) : "User not found";
    }

    [KernelFunction,
     Description("Finds a user by name, email, principalId.")]
    public async Task<string> FindUserByName(
        [Description("The term to search for")]
        string searchTerm,
        CancellationToken cancellationToken)
    {
        var result = await graphService.FindUser(agent, searchTerm, cancellationToken);
        return result ?? "User not found.";
    }

    [KernelFunction,
     Description("Finds the manager of a user by their user principal name")]
    public async Task<string> FindManager(
        [Description("The user principal name of the user to find the manager for")]
        string userPrincipalName,
        CancellationToken cancellationToken)
    {
        var result = await graphService.FindManagerForUser(agent, userPrincipalName, cancellationToken);
        if (result != null)
        {
            return JsonSerializer.Serialize(result);
        }
        
        return "Manager not found.";
    }
}