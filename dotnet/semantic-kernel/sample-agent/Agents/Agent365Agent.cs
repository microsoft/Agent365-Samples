// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Agent365SemanticKernelSampleAgent.Plugins;
using Agent365SemanticKernelSampleAgent.Services;
using Microsoft.Agents.A365.Tooling.Extensions.SemanticKernel.Services;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App.UserAuth;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.SemanticKernel;
using Microsoft.SemanticKernel.Agents;
using Microsoft.SemanticKernel.ChatCompletion;
using Microsoft.SemanticKernel.Connectors.OpenAI;
using System;
using System.Linq;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Tasks;

namespace Agent365SemanticKernelSampleAgent.Agents;

public class Agent365Agent
{
    private Kernel? _kernel;
    private ChatCompletionAgent? _agent;

    private const string AgentName = "Agent365Agent";
    private const string TermsAndConditionsNotAcceptedInstructions = "The user has not accepted the terms and conditions. You must ask the user to accept the terms and conditions before you can help them with any tasks. You may use the 'accept_terms_and_conditions' function to accept the terms and conditions on behalf of the user. If the user tries to perform any action before accepting the terms and conditions, you must use the 'terms_and_conditions_not_accepted' function to inform them that they must accept the terms and conditions to proceed.";
    private const string TermsAndConditionsAcceptedInstructions = "You may ask follow up questions until you have enough information to answer the user's question.";
    private string AgentInstructions(ITurnContext turnContext) => $@"
        You are a friendly assistant that helps office workers with their daily tasks.
        The current date is {DateTime.Now:MMMM d, yyyy}.
        
        USER EMAIL ADDRESS: {turnContext.Activity.From.Name}
        USER ID: {turnContext.Activity.From.Id}
        When sending emails to the user, use their email address above as the recipient. Do NOT ask the user for their email address.
        
        MANDATORY EMAIL RULES - VIOLATION IS FORBIDDEN:
        1. PROHIBITED: CreateDraftMessageAsync - NEVER call this function. It is forbidden.
        2. REQUIRED: Use SendEmailAsync or SendEmailWithAttachmentsAsync to send emails immediately.
        3. PROHIBITED: directAttachmentFilePaths parameter - NEVER use file paths. The server cannot access local files.
        4. REQUIRED: For attachments, read the file content first using readFile, then pass content via directAttachments with FileName and ContentBase64.
        
        {(MyAgent.TermsAndConditionsAccepted ? TermsAndConditionsAcceptedInstructions : TermsAndConditionsNotAcceptedInstructions)}

        Respond in JSON format with the following JSON schema:
        
        {{
            ""contentType"": ""'Text'"",
            ""content"": ""{{The content of the response in plain text}}""
        }}
        ";

    private string AgentInstructions_Streaming(ITurnContext turnContext) => $@"
        You are a friendly assistant that helps office workers with their daily tasks.
        The current date is {DateTime.Now:MMMM d, yyyy}.
        
        USER EMAIL ADDRESS: {turnContext.Activity.From.Name}
        USER ID: {turnContext.Activity.From.Id}
        When sending emails to the user, use their email address above as the recipient. Do NOT ask the user for their email address.
        
        MANDATORY EMAIL RULES - VIOLATION IS FORBIDDEN:
        1. PROHIBITED: CreateDraftMessageAsync - NEVER call this function. It is forbidden.
        2. REQUIRED: Use SendEmailAsync or SendEmailWithAttachmentsAsync to send emails immediately.
        3. PROHIBITED: directAttachmentFilePaths parameter - NEVER use file paths. The server cannot access local files.
        4. REQUIRED: For attachments, read the file content first using readFile, then pass content via directAttachments with FileName and ContentBase64.
        
        {(MyAgent.TermsAndConditionsAccepted ? TermsAndConditionsAcceptedInstructions : TermsAndConditionsNotAcceptedInstructions)}

        Respond in Markdown format
        ";

    public static async Task<Agent365Agent> CreateA365AgentWrapper(Kernel kernel, IServiceProvider service, IMcpToolRegistrationService toolService, string authHandlerName, UserAuthorization userAuthorization, ITurnContext turnContext, IConfiguration configuration)
    {
        var _agent = new Agent365Agent();
        await _agent.InitializeAgent365Agent(kernel, service, toolService, userAuthorization, authHandlerName,  turnContext, configuration).ConfigureAwait(false);
        return _agent;
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

            // Get the local client name from configuration (if configured for local MCP discovery)
            var localClientName = configuration["LocalMcp:ClientName"];

            // Add MCP servers (email, calendar, local file system, etc.) via ATG
            // If localClientName is provided, also discovers local Windows MCP servers dynamically
            await toolService.AddToolServersWithLocalDiscoveryAsync(
                kernel, 
                userAuthorization, 
                authHandlerName, 
                turnContext,
                localClientName);

            // Diagnostic: Log all registered plugins and tools
            var logger = service.GetService(typeof(Microsoft.Extensions.Logging.ILogger<Agent365Agent>)) as Microsoft.Extensions.Logging.ILogger;
            if (logger != null)
            {
                logger.LogInformation("[DIAGNOSTIC] Total plugins registered: {PluginCount}", kernel.Plugins.Count);
                foreach (var plugin in kernel.Plugins)
                {
                    var toolNames = string.Join(", ", plugin.Select(f => f.Name));
                    logger.LogInformation("[DIAGNOSTIC] Plugin '{PluginName}' has {FunctionCount} functions: [{Functions}]",
                        plugin.Name, plugin.Count(), toolNames);
                }
            }
        }
        else
        {
            // If the user has not accepted the terms and conditions, import the plugin that allows them to accept or reject
            this._kernel.ImportPluginFromObject(new TermsAndConditionsNotAcceptedPlugin(), "license");
        }

        // Log user identity information for debugging
        var agentLogger = service.GetService(typeof(Microsoft.Extensions.Logging.ILogger<Agent365Agent>)) as Microsoft.Extensions.Logging.ILogger;
        agentLogger?.LogInformation("[AGENT-DEBUG] Activity.From.Id: {FromId}", turnContext.Activity.From?.Id ?? "NULL");
        agentLogger?.LogInformation("[AGENT-DEBUG] Activity.From.Name: {FromName}", turnContext.Activity.From?.Name ?? "NULL");
        agentLogger?.LogInformation("[AGENT-DEBUG] Activity.From.AadObjectId: {AadObjectId}", turnContext.Activity.From?.AadObjectId ?? "NULL");
        agentLogger?.LogInformation("[AGENT-DEBUG] IsStreamingChannel: {IsStreaming}", turnContext.StreamingResponse.IsStreamingChannel);
        
        var instructions = turnContext.StreamingResponse.IsStreamingChannel ? AgentInstructions_Streaming(turnContext) : AgentInstructions(turnContext);
        agentLogger?.LogInformation("[AGENT-DEBUG] Agent Instructions: {Instructions}", instructions);

        // Define the agent
        this._agent =
            new()
            {
                Id = turnContext.Activity.Recipient.AgenticAppId ?? Guid.NewGuid().ToString(),
                Instructions = instructions,
                Name = AgentName,
                Kernel = this._kernel,
                Arguments = new KernelArguments(new OpenAIPromptExecutionSettings()
                {
#pragma warning disable SKEXP0001 // Type is for evaluation purposes only and is subject to change or removal in future updates. Suppress this diagnostic to proceed.
                    FunctionChoiceBehavior = FunctionChoiceBehavior.Required(options: new() { RetainArgumentTypes = true }),
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
            }; 
        }
        else
        {
            StringBuilder sb = new();
            await foreach (ChatMessageContent response in _agent!.InvokeAsync(chatHistory, thread: thread))
            {
                if (!string.IsNullOrEmpty(response.Content))
                {
                    var jsonNode = JsonNode.Parse(response.Content);
                        context?.StreamingResponse.QueueTextChunk(jsonNode!["content"]!.ToString());
                }

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
}
