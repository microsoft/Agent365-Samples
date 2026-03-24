namespace ProcurementA365Agent.AgentLogic;

using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.State;
using Microsoft.Agents.A365.Notifications.Models;
using ProcurementA365Agent.Models;

public interface IAgentLogicService
{
    /// <summary>
    /// Processes a new message received by the agent. 
    /// Returns a simple string response.
    /// This is invoked by background service and is alternate way to process emails that don't leverage SDK activities.
    /// </summary>
    Task<string> NewEmailReceived(string fromEmail, string subject, string messageBody);

    /// <summary>
    /// Processes a new chat message received by the agent.
    /// Returns a simple string response.
    /// This is invoked by background service and is alternate way to process chat messages that don't leverage SDK activities.
    /// </summary>
    Task<string> NewChatReceived(string chatId, string fromUser, string messageBody);

    /// <summary>
    /// Handles email notification events
    /// </summary>
    Task HandleEmailNotificationAsync(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity emailEvent);

    /// <summary>
    /// Handles document comment notification events (Word, Excel, PowerPoint)
    /// </summary>
    Task HandleCommentNotificationAsync(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity commentEvent);

    /// <summary>
    /// Handles Teams message events
    /// </summary>
    Task HandleTeamsMessageAsync(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity teamsEvent);

    /// <summary>
    /// Handles installation update events
    /// </summary>
    Task HandleInstallationUpdateAsync(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity installationEvent);

    /// <summary>
    /// Handles a standard activity protocol message
    /// </summary>
    /// <returns></returns>
    Task NewActivityReceived(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken);

    Task NewAgentCreatedAsync(ITurnContext turnContext, ITurnState turnState, AgentNotificationActivity agentNotificationActivity, CancellationToken cancellationToken);

    /// <summary>
    /// Notifies the manager about the new agent with retry logic.
    /// Called from the background service when IsGreetingSent is false.
    /// </summary>
    Task NotifyManagerAboutNewAgentAsync(AgentMetadata agentMetadata, CancellationToken cancellationToken);
}