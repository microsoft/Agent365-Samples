// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Agent365CopilotStudioSampleAgent.Client;
using Agent365CopilotStudioSampleAgent.telemetry;
using Microsoft.Agents.A365.Observability.Caching;
using Microsoft.Agents.A365.Runtime.Utils;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App;
using Microsoft.Agents.Builder.State;
using Microsoft.Agents.Core;
using Microsoft.Agents.Core.Models;

namespace Agent365CopilotStudioSampleAgent.Agent
{
    /// <summary>
    /// MyAgent - Agent 365 sample that integrates with Microsoft Copilot Studio.
    /// 
    /// This agent demonstrates how to:
    /// - Receive messages and notifications from Agent 365 (email, Teams, etc.)
    /// - Forward messages to a Copilot Studio agent
    /// - Return responses through the Agent 365 SDK
    /// - Integrate with Agent 365 observability
    /// </summary>
    public class MyAgent : AgentApplication
    {
        private const string AgentWelcomeMessage = "Hello! I'm connected to Copilot Studio. Send me a message and I'll forward it to the agent!";
        private const string AgentHireMessage = "Thank you for hiring me! Looking forward to assisting you in your professional journey!";
        private const string AgentFarewellMessage = "Thank you for your time, I enjoyed working with you.";

        private readonly IConfiguration _configuration;
        private readonly IExporterTokenCache<AgenticTokenStruct>? _agentTokenCache;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<MyAgent> _logger;

        private readonly string? AgenticAuthHandlerName;

        public MyAgent(
            AgentApplicationOptions options,
            IConfiguration configuration,
            IExporterTokenCache<AgenticTokenStruct> agentTokenCache,
            IHttpClientFactory httpClientFactory,
            ILogger<MyAgent> logger) : base(options)
        {
            _configuration = configuration;
            _agentTokenCache = agentTokenCache;
            _httpClientFactory = httpClientFactory;
            _logger = logger;

            AgenticAuthHandlerName = _configuration.GetValue<string>("AgentApplication:AgenticAuthHandlerName");

            // Greet when members are added to the conversation
            OnConversationUpdate(ConversationUpdateEvents.MembersAdded, WelcomeMessageAsync);

            var agenticHandlers = !string.IsNullOrEmpty(AgenticAuthHandlerName) ? [AgenticAuthHandlerName] : Array.Empty<string>();

            // Handle agent install / uninstall events
            OnActivity(ActivityTypes.InstallationUpdate, OnInstallationUpdateAsync, isAgenticOnly: true, autoSignInHandlers: agenticHandlers);
            OnActivity(ActivityTypes.InstallationUpdate, OnInstallationUpdateAsync, isAgenticOnly: false);

            // Listen for messages — agentic and non-agentic
            OnActivity(ActivityTypes.Message, OnMessageAsync, isAgenticOnly: true, autoSignInHandlers: agenticHandlers);
            OnActivity(ActivityTypes.Message, OnMessageAsync, isAgenticOnly: false);
        }

        protected async Task WelcomeMessageAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
        {
            await AgentMetrics.InvokeObservedAgentOperation(
                "WelcomeMessage",
                turnContext,
                async () =>
                {
                    foreach (ChannelAccount member in turnContext.Activity.MembersAdded)
                    {
                        if (member.Id != turnContext.Activity.Recipient.Id)
                        {
                            await turnContext.SendActivityAsync(AgentWelcomeMessage);
                        }
                    }
                });
        }

        protected async Task OnInstallationUpdateAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
        {
            await AgentMetrics.InvokeObservedAgentOperation(
                "InstallationUpdate",
                turnContext,
                async () =>
                {
                    _logger.LogInformation(
                        "InstallationUpdate received — Action: '{Action}', DisplayName: '{Name}', UserId: '{Id}'",
                        turnContext.Activity.Action ?? "(none)",
                        turnContext.Activity.From?.Name ?? "(unknown)",
                        turnContext.Activity.From?.Id ?? "(unknown)");

                    if (turnContext.Activity.Action == InstallationUpdateActionTypes.Add)
                    {
                        await turnContext.SendActivityAsync(MessageFactory.Text(AgentHireMessage), cancellationToken);
                    }
                    else if (turnContext.Activity.Action == InstallationUpdateActionTypes.Remove)
                    {
                        await turnContext.SendActivityAsync(MessageFactory.Text(AgentFarewellMessage), cancellationToken);
                    }
                });
        }

        protected async Task OnMessageAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
        {
            if (turnContext is null)
            {
                throw new ArgumentNullException(nameof(turnContext));
            }

            var fromAccount = turnContext.Activity.From;
            _logger.LogDebug(
                "Turn received from user — DisplayName: '{Name}', UserId: '{Id}', AadObjectId: '{AadObjectId}'",
                fromAccount?.Name ?? "(unknown)",
                fromAccount?.Id ?? "(unknown)",
                fromAccount?.AadObjectId ?? "(none)");

            var userText = turnContext.Activity.Text?.Trim() ?? string.Empty;

            if (string.IsNullOrEmpty(userText))
            {
                await turnContext.SendActivityAsync("Please send me a message and I'll forward it to Copilot Studio!");
                return;
            }

            // Select the appropriate auth handler
            string? authHandlerName;
            if (turnContext.IsAgenticRequest())
            {
                authHandlerName = AgenticAuthHandlerName;
            }
            else
            {
                authHandlerName = _configuration.GetValue<string>("AgentApplication:OboAuthHandlerName") ?? AgenticAuthHandlerName;
            }

            await A365OtelWrapper.InvokeObservedAgentOperation(
                "MessageProcessor",
                turnContext,
                turnState,
                _agentTokenCache,
                UserAuthorization,
                authHandlerName ?? string.Empty,
                _logger,
                async () =>
                {
                    // Send an immediate acknowledgment
                    await turnContext.SendActivityAsync(MessageFactory.Text("Got it — working on it…"), cancellationToken).ConfigureAwait(false);

                    // Send typing indicator
                    await turnContext.SendActivityAsync(Activity.CreateTypingActivity(), cancellationToken).ConfigureAwait(false);

                    // Background typing loop
                    using var typingCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                    var typingTask = Task.Run(async () =>
                    {
                        try
                        {
                            while (!typingCts.IsCancellationRequested)
                            {
                                await Task.Delay(TimeSpan.FromSeconds(4), typingCts.Token).ConfigureAwait(false);
                                await turnContext.SendActivityAsync(Activity.CreateTypingActivity(), typingCts.Token).ConfigureAwait(false);
                            }
                        }
                        catch (OperationCanceledException) { /* expected on cancel */ }
                    }, typingCts.Token);

                    try
                    {
                        // Create the Copilot Studio client and invoke it
                        var client = await CopilotStudioClientFactory.CreateAsync(
                            UserAuthorization,
                            authHandlerName ?? string.Empty,
                            turnContext,
                            _configuration,
                            _httpClientFactory,
                            _logger);

                        var response = await client.InvokeAgentAsync(userText);

                        await turnContext.SendActivityAsync(MessageFactory.Text(response), cancellationToken).ConfigureAwait(false);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "Copilot Studio query error");
                        await turnContext.SendActivityAsync(
                            MessageFactory.Text($"Error communicating with Copilot Studio: {ex.Message}"),
                            cancellationToken).ConfigureAwait(false);
                    }
                    finally
                    {
                        typingCts.Cancel();
                        try
                        {
                            await typingTask.ConfigureAwait(false);
                        }
                        catch (OperationCanceledException)
                        {
                            // Expected
                        }
                    }
                });
        }
    }
}
