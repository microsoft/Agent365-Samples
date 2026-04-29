// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App.UserAuth;
using Microsoft.Agents.Core.Models;
using Microsoft.Agents.CopilotStudio.Client;

namespace Agent365CopilotStudioSampleAgent.Client
{
    /// <summary>
    /// Client interface for interacting with Copilot Studio agents.
    /// </summary>
    public interface ICopilotStudioAgentClient
    {
        /// <summary>
        /// Sends a message to the Copilot Studio agent and returns the response.
        /// </summary>
        Task<string> InvokeAgentAsync(string message);
    }

    /// <summary>
    /// Copilot Studio client wrapper that manages conversation lifecycle
    /// and sends/receives messages via the CopilotClient APIs.
    /// </summary>
    public class CopilotStudioAgentClient : ICopilotStudioAgentClient
    {
        private readonly CopilotClient _client;
        private readonly ILogger _logger;
        private string _conversationId = string.Empty;

        public CopilotStudioAgentClient(CopilotClient client, ILogger logger)
        {
            _client = client;
            _logger = logger;
        }

        /// <summary>
        /// Sends a message to the Copilot Studio agent and collects the response.
        /// </summary>
        public async Task<string> InvokeAgentAsync(string message)
        {
            var responses = new List<string>();

            try
            {
                // If no conversation started yet, start one
                if (string.IsNullOrEmpty(_conversationId))
                {
                    await foreach (var activity in _client.StartConversationAsync(false))
                    {
                        if (activity.Conversation?.Id is not null)
                        {
                            _conversationId = activity.Conversation.Id;
                        }

                        if (activity.Type == ActivityTypes.Message && !string.IsNullOrEmpty(activity.Text))
                        {
                            responses.Add(activity.Text);
                        }
                    }
                }

                // Ask the question and collect streamed responses
                await foreach (var activity in _client.AskQuestionAsync(message, _conversationId))
                {
                    if (activity.Type == ActivityTypes.Message && !string.IsNullOrEmpty(activity.Text))
                    {
                        responses.Add(activity.Text);
                    }
                }

                return responses.Count > 0
                    ? string.Join("\n", responses)
                    : "No response from Copilot Studio agent.";
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error sending message to Copilot Studio");
                throw;
            }
        }
    }

    /// <summary>
    /// Factory for creating configured Copilot Studio client instances.
    /// Acquires an OBO token and initializes the CopilotClient.
    /// </summary>
    public static class CopilotStudioClientFactory
    {
        /// <summary>
        /// Creates a configured Copilot Studio client with the appropriate auth token.
        /// </summary>
        public static Task<ICopilotStudioAgentClient> CreateAsync(
            UserAuthorization authorization,
            string authHandlerName,
            ITurnContext turnContext,
            IConfiguration configuration,
            IHttpClientFactory httpClientFactory,
            ILogger logger)
        {
            // Load connection settings from the "CopilotStudio" config section
            var settings = LoadConnectionSettings(configuration);

            logger.LogInformation(
                "CopilotStudio settings — EnvironmentId: [{EnvironmentId}], SchemaName: [{SchemaName}], Cloud: [{Cloud}], DirectConnectUrl: [{DirectConnectUrl}]",
                settings.EnvironmentId, settings.SchemaName, settings.Cloud, settings.DirectConnectUrl);

            // Create a token provider that acquires tokens via the A365 agentic OBO exchange.
            // This requires testing via A365 Playground (a365 develop-mcp), not the Bot Framework Emulator,
            // because the Playground provides the user token needed for the OBO exchange.
            Func<string, Task<string>> tokenProvider = async (scope) =>
            {
                var token = await authorization.GetTurnTokenAsync(turnContext, authHandlerName);
                if (!string.IsNullOrEmpty(token))
                {
                    return token;
                }

                throw new InvalidOperationException(
                    "Failed to acquire token for Copilot Studio. " +
                    "This sample requires testing via A365 Playground (a365 develop-mcp), not the Bot Framework Emulator. " +
                    "The agentic OBO flow needs a user token that only the Playground provides.");
            };

            var copilotClient = new CopilotClient(settings, httpClientFactory, tokenProvider, logger, "WebClient");
            return Task.FromResult<ICopilotStudioAgentClient>(new CopilotStudioAgentClient(copilotClient, logger));
        }

        private static ConnectionSettings LoadConnectionSettings(IConfiguration configuration)
        {
            var section = configuration.GetSection("CopilotStudio");

            // Use the IConfigurationSection constructor which handles binding automatically
            var settings = new ConnectionSettings(section);

            // Validate that we have enough configuration
            if (string.IsNullOrEmpty(settings.DirectConnectUrl) &&
                (string.IsNullOrEmpty(settings.EnvironmentId) || string.IsNullOrEmpty(settings.SchemaName)))
            {
                throw new InvalidOperationException(
                    "Copilot Studio configuration is missing. Provide either 'DirectConnectUrl' or both 'EnvironmentId' and 'SchemaName' in the 'CopilotStudio' configuration section.");
            }

            return settings;
        }
    }
}
