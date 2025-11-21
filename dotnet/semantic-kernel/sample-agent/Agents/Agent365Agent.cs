// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using System;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Agent365SemanticKernelSampleAgent.Plugins;
using Microsoft.Agents.A365.Tooling.Extensions.SemanticKernel.Services;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App.UserAuth;
using Microsoft.Agents.Builder.UserAuth;
using Microsoft.Extensions.Configuration;
using Microsoft.SemanticKernel;
using Microsoft.SemanticKernel.Agents;
using Microsoft.SemanticKernel.ChatCompletion;
using Microsoft.SemanticKernel.Connectors.OpenAI;

namespace Agent365SemanticKernelSampleAgent.Agents;

public class Agent365Agent
{
    private Kernel? _kernel;
    private ChatCompletionAgent? _agent;

    private const string AgentName = "Agent365Agent";
    private const string TermsAndConditionsNotAcceptedInstructions = "The user has not accepted the terms and conditions. You must ask the user to accept the terms and conditions before you can help them with any tasks. You may use the 'accept_terms_and_conditions' function to accept the terms and conditions on behalf of the user. If the user tries to perform any action before accepting the terms and conditions, you must use the 'terms_and_conditions_not_accepted' function to inform them that they must accept the terms and conditions to proceed.";
    private const string TermsAndConditionsAcceptedInstructions = "You may ask follow up questions until you have enough information to answer the user's question.";
    private string AgentInstructions() => $@"
        You are a friendly assistant that helps office workers with their daily tasks.
        {(MyAgent.TermsAndConditionsAccepted ? TermsAndConditionsAcceptedInstructions : TermsAndConditionsNotAcceptedInstructions)}

        Respond in JSON format with the following JSON schema:
        
        {{
            ""contentType"": ""'Text'"",
            ""content"": ""{{The content of the response in plain text}}""
        }}
        ";

    /// <summary>
    /// Initializes a new instance of the <see cref="Agent365Agent"/> class.
    /// </summary>
    private Agent365Agent()
    {
    }

    public static async Task<Agent365Agent> CreateA365AgentWrapper(Kernel kernel, IServiceProvider service, IMcpToolRegistrationService toolService, string authHandlerName, UserAuthorization userAuthorization, ITurnContext turnContext, IConfiguration configuration)
    {
        var _agent = new Agent365Agent();
        await _agent.InitializeAgent365Agent(kernel, service, toolService, userAuthorization, authHandlerName, turnContext, configuration).ConfigureAwait(false);
        return _agent;
    }

    public async Task InitializeAgent365Agent(Kernel kernel, IServiceProvider service, IMcpToolRegistrationService toolService, UserAuthorization userAuthorization, string authHandlerName, ITurnContext turnContext, IConfiguration configuration)
    {
        this._kernel = kernel;

        // Only add the A365 tools if the user has accepted the terms and conditions
        if (MyAgent.TermsAndConditionsAccepted)
        {
            // Provide the tool service with necessary parameters to connect to A365
            this._kernel.ImportPluginFromType<TermsAndConditionsAcceptedPlugin>();

            await toolService.AddToolServersToAgentAsync(kernel, userAuthorization, authHandlerName, turnContext).ConfigureAwait(false);
        }
        else
        {
            // If the user has not accepted the terms and conditions, import the plugin that allows them to accept or reject
            this._kernel.ImportPluginFromObject(new TermsAndConditionsNotAcceptedPlugin(), "license");
        }

        // Define the agent
        this._agent =
            new()
            {
                Id = turnContext.Activity.Recipient.AgenticAppId ?? Guid.NewGuid().ToString(),
                Instructions = AgentInstructions(),
                Name = AgentName,
                Kernel = this._kernel,
                Arguments = new KernelArguments(new OpenAIPromptExecutionSettings()
                {
#pragma warning disable SKEXP0001 // Type is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed.
                    FunctionChoiceBehavior = FunctionChoiceBehavior.Auto(options: new() { RetainArgumentTypes = true }),
#pragma warning restore SKEXP0001 // Type is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed.
                    ResponseFormat = "json_object",
                }),
            };
    }

    /// <summary>
    /// Invokes the agent with the given input and returns the response.
    /// </summary>
    /// <param name="input">A message to process.</param>
    /// <returns>An instance of <see cref="Agent365AgentResponse"/></returns>
    public async Task<Agent365AgentResponse> InvokeAgentAsync(string input, ChatHistory chatHistory)
    {
        ArgumentNullException.ThrowIfNull(chatHistory);
        AgentThread thread = new ChatHistoryAgentThread();
        ChatMessageContent message = new(AuthorRole.User, input);
        chatHistory.Add(message);

        StringBuilder sb = new();
        await foreach (ChatMessageContent response in this._agent.InvokeAsync(chatHistory, thread: thread))
        {
            chatHistory.Add(response);
            sb.Append(response.Content);
        }

        // Make sure the response is in the correct format and retry if necessary
        try
        {
            string resultContent = sb.ToString();
            var jsonNode = JsonNode.Parse(resultContent);
            Agent365AgentResponse result = new()
            {
                Content = jsonNode!["content"]!.ToString(),
                ContentType = Enum.Parse<Agent365AgentResponseContentType>(jsonNode["contentType"]!.ToString(), true)
            };
            return result;
        }
        catch (Exception je)
        {
            return await InvokeAgentAsync($"That response did not match the expected format. Please try again. Error: {je.Message}", chatHistory);
        }
    }
}
