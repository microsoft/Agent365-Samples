// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Agent365TaskPersonalizationSampleAgent.Plugins;
using Microsoft.Agents.A365.Tooling.Extensions.SemanticKernel.Services;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App.UserAuth;
using Microsoft.Extensions.Configuration;
using Microsoft.SemanticKernel;
using Microsoft.SemanticKernel.Agents;
using Microsoft.SemanticKernel.ChatCompletion;
using Microsoft.SemanticKernel.Connectors.OpenAI;
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;

namespace Agent365TaskPersonalizationSampleAgent.Agents;

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

    private string AgentInstructions_Streaming() => $@"
        You are a friendly assistant that helps office workers with their daily tasks.
        {(MyAgent.TermsAndConditionsAccepted ? TermsAndConditionsAcceptedInstructions : TermsAndConditionsNotAcceptedInstructions)}

        Respond in Markdown format
        ";

    public static async Task<Agent365Agent> CreateA365AgentWrapper(Kernel kernel, IServiceProvider service, IMcpToolRegistrationService toolService, string authHandlerName, UserAuthorization userAuthorization, ITurnContext turnContext, IConfiguration configuration)
    {
        var _agent = new Agent365Agent();
        await _agent.InitializeAgent365Agent(kernel, service, toolService, userAuthorization, authHandlerName,  turnContext, configuration).ConfigureAwait(false);
        return _agent;
    }

    public static bool TryGetBearerTokenForDevelopment(out string? bearerToken)
    {
        bearerToken = Environment.GetEnvironmentVariable("BEARER_TOKEN");
        return !string.IsNullOrEmpty(bearerToken);
    }

    /// <summary>
    /// Checks if graceful fallback to bare LLM mode is enabled when MCP tools fail to load.
    /// This is only allowed in Development environment AND when SKIP_TOOLING_ON_ERRORS is explicitly set to "true".
    /// </summary>
    private static bool ShouldSkipToolingOnErrors()
    {
        var environment = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") ?? 
                          Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT") ?? 
                          "Production";
        
        var skipToolingOnErrors = Environment.GetEnvironmentVariable("SKIP_TOOLING_ON_ERRORS");
        
        // Only allow skipping tooling errors in Development mode AND when explicitly enabled
        return environment.Equals("Development", StringComparison.OrdinalIgnoreCase) && 
               !string.IsNullOrEmpty(skipToolingOnErrors) && 
               skipToolingOnErrors.Equals("true", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// 
    /// </summary>
    public Agent365Agent(){}

    /// <summary>
    /// Initializes a new instance of the <see cref="Agent365Agent"/> class.
    /// </summary>
    /// <param name="serviceProvider">The service provider to use for dependency injection.</param>
    public async Task InitializeAgent365Agent(Kernel kernel, IServiceProvider service, IMcpToolRegistrationService toolService, UserAuthorization userAuthorization , string authHandlerName, ITurnContext turnContext, IConfiguration configuration)
    {
        this._kernel = kernel;

        // Only add the A365 tools if the user has accepted the terms and conditions
        if (MyAgent.TermsAndConditionsAccepted)
        {
            // Provide the tool service with necessary parameters to connect to A365
            this._kernel.ImportPluginFromType<TermsAndConditionsAcceptedPlugin>();

            await turnContext.StreamingResponse.QueueInformativeUpdateAsync("Loading tools...");

            try
            {
                if (TryGetBearerTokenForDevelopment(out var bearerToken))
                {
                    // Development mode: Use bearer token from environment variable for simplified local testing
                    await toolService.AddToolServersToAgentAsync(kernel, userAuthorization, authHandlerName, turnContext, bearerToken);
                }
                else
                {
                    // Production mode: Use standard authentication flow (Client Credentials, Managed Identity, or Federated Credentials)
                    await toolService.AddToolServersToAgentAsync(kernel, userAuthorization, authHandlerName, turnContext);
                }
            }
            catch (Exception ex)
            {
                // Only allow graceful fallback in Development mode when SKIP_TOOLING_ON_ERRORS is explicitly enabled
                if (ShouldSkipToolingOnErrors())
                {
                    // Graceful fallback: Log the error but continue without MCP tools
                    // This allows the agent to still respond to basic queries using only the LLM
                    System.Diagnostics.Debug.WriteLine($"Warning: Failed to load MCP tools: {ex.Message}");
                    Console.WriteLine($"Warning: MCP tools unavailable - running in bare LLM mode. Error: {ex.Message}");
                    await turnContext.StreamingResponse.QueueInformativeUpdateAsync("Note: Some tools are not available. Running in basic mode.");
                }
                else
                {
                    // In production or when SKIP_TOOLING_ON_ERRORS is not enabled, fail fast
                    throw;
                }
            }
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
                Instructions = turnContext.StreamingResponse.IsStreamingChannel ? AgentInstructions_Streaming() : AgentInstructions(),
                Name = AgentName,
                Kernel = this._kernel,
                Arguments = new KernelArguments(new OpenAIPromptExecutionSettings()
                {
#pragma warning disable SKEXP0001 // Type is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed.
                    FunctionChoiceBehavior = FunctionChoiceBehavior.Auto(options: new() { RetainArgumentTypes = true }),
#pragma warning restore SKEXP0001 // Type is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed.
                    ResponseFormat = turnContext.StreamingResponse.IsStreamingChannel ? "text" : "json_object", 
                }),
            };
    }

    /// <summary>
    /// Invokes the agent with the given input and returns the response.
    /// </summary>
    /// <param name="input">A message to process.</param>
    /// <returns>An instance of <see cref="Agent365AgentResponse"/></returns>
    public async Task<Agent365AgentResponse> InvokeAgentAsync(string input, ChatHistory chatHistory, ITurnContext? context = null)
    {
        ArgumentNullException.ThrowIfNull(chatHistory);
        AgentThread thread = new ChatHistoryAgentThread();
        ChatMessageContent message = new(AuthorRole.User, input);
        chatHistory.Add(message);

        if (context!.StreamingResponse.IsStreamingChannel)
        {
            await foreach (var response in _agent!.InvokeStreamingAsync(chatHistory, thread: thread))
            {
                if (!string.IsNullOrEmpty(response.Message.Content))
                {
                    context?.StreamingResponse.QueueTextChunk(response.Message.Content);
                }
            }
            return new Agent365AgentResponse()
            {
                Content = "Boo",
                ContentType = Enum.Parse<Agent365AgentResponseContentType>("text", true)
            }; ; 
        }
        else
        {
            StringBuilder sb = new();
            await foreach (ChatMessageContent response in _agent!.InvokeAsync(chatHistory, thread: thread))
            {
                if (!string.IsNullOrEmpty(response.Content))
                {
                    // Try to parse as JSON and extract content, handle different response formats
                    try
                    {
                        var jsonNode = JsonNode.Parse(response.Content);

                        // Check if this is a trigger evaluation response - don't stream these to user
                        var isActiveNode = jsonNode?["isActive"];
                        if (isActiveNode != null)
                        {
                            // Trigger evaluation response - don't stream, just collect
                            // The caller will parse this for internal processing
                        }
                        else
                        {
                            var contentNode = jsonNode?["content"];
                            if (contentNode != null)
                            {
                                context?.StreamingResponse.QueueTextChunk(contentNode.ToString());
                            }
                            else
                            {
                                // Not standard format - stream raw content
                                context?.StreamingResponse.QueueTextChunk(response.Content);
                            }
                        }
                    }
                    catch (JsonException)
                    {
                        // Not valid JSON - stream raw content
                        context?.StreamingResponse.QueueTextChunk(response.Content);
                    }
                }

                chatHistory.Add(response);
                sb.Append(response.Content);
            }

            // Make sure the response is in the correct format and retry if necessary
            try
            {
                string resultContent = sb.ToString();
                var jsonNode = JsonNode.Parse(resultContent);

                // Check if this is a trigger evaluation response (internal use only, not user-facing)
                var isActiveNode = jsonNode?["isActive"];
                if (isActiveNode != null)
                {
                    // This is a trigger evaluation response - return for internal processing
                    // The caller will parse this, it should NOT be shown to the user
                    return new Agent365AgentResponse
                    {
                        Content = resultContent,
                        ContentType = Agent365AgentResponseContentType.Text
                    };
                }

                // Check if this is a standard response format with content/contentType
                var contentNode = jsonNode?["content"];
                var contentTypeNode = jsonNode?["contentType"];

                if (contentNode != null && contentTypeNode != null)
                {
                    Agent365AgentResponse result = new()
                    {
                        Content = contentNode.ToString(),
                        ContentType = Enum.Parse<Agent365AgentResponseContentType>(contentTypeNode.ToString(), true)
                    };
                    return result;
                }

                // Unknown format - return raw content
                return new Agent365AgentResponse
                {
                    Content = resultContent,
                    ContentType = Agent365AgentResponseContentType.Text
                };
            }
            catch (Exception je)
            {
                return await InvokeAgentAsync($"That response did not match the expected format. Please try again. Error: {je.Message}", chatHistory);
            }
        }
    }
}
