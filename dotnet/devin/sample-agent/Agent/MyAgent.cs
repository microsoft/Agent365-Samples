// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Agent365DevinSampleAgent.Client;
using Agent365DevinSampleAgent.telemetry;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App;
using Microsoft.Agents.Builder.State;
using Microsoft.Agents.Core.Models;
using System.Diagnostics;

namespace Agent365DevinSampleAgent.Agent;

/// <summary>
/// Devin Sample Agent — routes messages to the Devin API and returns responses.
/// Handles installation, notifications, typing indicators, and observability.
/// </summary>
public class MyAgent : AgentApplication
{
    private const string AgentHireMessage = "Thank you for hiring me! Looking forward to assisting you in your professional journey!";
    private const string AgentFarewellMessage = "Thank you for your time, I enjoyed working with you.";

    private readonly DevinClient _devinClient;
    private readonly ILogger<MyAgent> _logger;

    public MyAgent(
        AgentApplicationOptions options,
        DevinClient devinClient,
        ILogger<MyAgent> logger)
        : base(options)
    {
        _devinClient = devinClient;
        _logger = logger;

        // Register message handler for agentic requests
        OnActivity(ActivityTypes.Message, OnMessageAsync, isAgenticOnly: true);

        // Register message handler for non-agentic requests (Playground / WebChat)
        OnActivity(ActivityTypes.Message, OnMessageAsync, isAgenticOnly: false);

        // Register installation handler for agentic requests
        OnActivity(ActivityTypes.InstallationUpdate, OnInstallationUpdateAsync, isAgenticOnly: true);

        // Register installation handler for non-agentic requests (Playground)
        OnActivity(ActivityTypes.InstallationUpdate, OnInstallationUpdateAsync, isAgenticOnly: false);

        // Register conversation update handler
        OnConversationUpdate(ConversationUpdateEvents.MembersAdded, OnMembersAddedAsync);
    }

    private async Task OnMembersAddedAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {
        foreach (var member in turnContext.Activity.MembersAdded ?? [])
        {
            if (member.Id != turnContext.Activity.Recipient?.Id)
            {
                await turnContext.SendActivityAsync(MessageFactory.Text(AgentHireMessage), cancellationToken);
            }
        }
    }

    private async Task OnInstallationUpdateAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {
        using var activity = AgentMetrics.InitializeMessageHandlingActivity("InstallationUpdate", turnContext);
        var stopwatch = Stopwatch.StartNew();

        try
        {
            if (turnContext.Activity.Action == InstallationUpdateActionTypes.Add)
            {
                _logger.LogInformation("Agent installed");
                await turnContext.SendActivityAsync(MessageFactory.Text(AgentHireMessage), cancellationToken);
            }
            else if (turnContext.Activity.Action == InstallationUpdateActionTypes.Remove)
            {
                _logger.LogInformation("Agent uninstalled");
                await turnContext.SendActivityAsync(MessageFactory.Text(AgentFarewellMessage), cancellationToken);
            }

            AgentMetrics.FinalizeMessageHandlingActivity(activity, turnContext, stopwatch.ElapsedMilliseconds, true);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error handling installation update");
            AgentMetrics.FinalizeMessageHandlingActivity(activity, turnContext, stopwatch.ElapsedMilliseconds, false);
            throw;
        }
    }

    private async Task OnMessageAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {
        using var activity = AgentMetrics.InitializeMessageHandlingActivity("MessageHandler", turnContext);
        var stopwatch = Stopwatch.StartNew();

        try
        {
            // Log user identity
            var fromAccount = turnContext.Activity.From;
            _logger.LogDebug(
                "Turn received from user — DisplayName: '{Name}', UserId: '{Id}', AadObjectId: '{AadObjectId}'",
                fromAccount?.Name ?? "(unknown)",
                fromAccount?.Id ?? "(unknown)",
                fromAccount?.AadObjectId ?? "(none)");

            var userMessage = turnContext.Activity.Text?.Trim();
            if (string.IsNullOrEmpty(userMessage))
            {
                await turnContext.SendActivityAsync(
                    MessageFactory.Text("Please send me a message and I'll help you!"), cancellationToken);
                return;
            }

            // Send immediate acknowledgment (discrete Teams message)
            await turnContext.SendActivityAsync(
                MessageFactory.Text("Got it — working on it…"), cancellationToken);

            // Typing indicator loop — refreshes every ~4s for long-running operations
            using var typingCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            var typingTask = Task.Run(async () =>
            {
                try
                {
                    while (!typingCts.IsCancellationRequested)
                    {
                        await Task.Delay(TimeSpan.FromSeconds(4), typingCts.Token);
                        await turnContext.SendActivityAsync(
                            new Microsoft.Agents.Core.Models.Activity { Type = ActivityTypes.Typing }, typingCts.Token);
                    }
                }
                catch (OperationCanceledException) { /* expected on cancel */ }
            }, typingCts.Token);

            try
            {
                // Invoke Devin
                var response = await _devinClient.InvokeAgentAsync(userMessage, cancellationToken);

                // Send the Devin response as a discrete message
                await turnContext.SendActivityAsync(
                    MessageFactory.Text(response), cancellationToken);
            }
            finally
            {
                // Stop typing indicator
                await typingCts.CancelAsync();
                try { await typingTask; } catch (OperationCanceledException) { }
            }

            AgentMetrics.FinalizeMessageHandlingActivity(activity, turnContext, stopwatch.ElapsedMilliseconds, true);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing message");
            AgentMetrics.FinalizeMessageHandlingActivity(activity, turnContext, stopwatch.ElapsedMilliseconds, false);
            await turnContext.SendActivityAsync(
                MessageFactory.Text("There was an error processing your request."), cancellationToken);
        }
    }
}
