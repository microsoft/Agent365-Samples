// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

using Agent365SemanticKernelSampleAgent.Plugins;
using Microsoft.Agents.A365.Tooling.Exceptions;
using Microsoft.Agents.A365.Tooling.Extensions.SemanticKernel.Services;
using Microsoft.Agents.A365.Tooling.Models;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App.UserAuth;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.SemanticKernel;
using Microsoft.SemanticKernel.Agents;
using Microsoft.SemanticKernel.ChatCompletion;
using Microsoft.SemanticKernel.Connectors.OpenAI;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Tasks;

namespace Agent365SemanticKernelSampleAgent.Agents;

public class Agent365Agent
{
    private Kernel? _kernel;
    private ChatCompletionAgent? _agent;
    
    /// <summary>
    /// If set, the desktop client needs to register before local file tools can be used.
    /// Contains the protocol URL for registration (e.g., locaproto:?action=register&amp;callback=...)
    /// </summary>
    public string? PendingDesktopRegistrationUrl { get; private set; }
    
    /// <summary>
    /// Information about the active desktop being used for local file access.
    /// </summary>
    public DesktopClientInfo? ActiveDesktop { get; private set; }
    
    /// <summary>
    /// All registered desktops for this user.
    /// </summary>
    public List<DesktopClientInfo>? AllRegisteredDesktops { get; private set; }

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

        MANDATORY FILE ACCESS RULES:
        1. You HAVE access to local files via the file_mcp_server tools (search_files, read_text_file, read_file, etc.)
        2. When asked to read files from a folder, ALWAYS use read_text_file to read the contents - do NOT just list file names.
        3. NEVER say you cannot access local files - you CAN access them using the file tools.
        4. Complete multi-step file tasks fully - search, then read, then process, then respond.
        
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

        MANDATORY FILE ACCESS RULES:
        1. You HAVE access to local files via the file_mcp_server tools (search_files, read_text_file, read_file, etc.)
        2. When asked to read files from a folder, ALWAYS use read_text_file to read the contents - do NOT just list file names.
        3. NEVER say you cannot access local files - you CAN access them using the file tools.
        4. Complete multi-step file tasks fully - search, then read, then process, then respond.
        
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

            var agentInitLogger = service.GetService(typeof(Microsoft.Extensions.Logging.ILogger<Agent365Agent>)) as Microsoft.Extensions.Logging.ILogger;
            var userIdentifier = turnContext.Activity.From?.Name;
            agentInitLogger?.LogInformation("[AGENT-INIT] User identifier: {UserIdentifier}", userIdentifier ?? "NULL");

            // Add MCP servers (email, calendar, local file system, etc.) via ATG
            // Uses the new user-based discovery which automatically finds registered desktops by user email
            try
            {
                var discoveryResult = await toolService.AddToolServersWithUserDiscoveryAsync(
                    kernel, 
                    userAuthorization, 
                    authHandlerName, 
                    turnContext);
                
                // Store the discovery result for use in instructions
                this.ActiveDesktop = discoveryResult.ActiveDesktop;
                this.AllRegisteredDesktops = discoveryResult.AllRegisteredDesktops;
                
                if (discoveryResult.ActiveDesktop != null)
                {
                    agentInitLogger?.LogInformation("[AGENT-INIT] Using desktop '{ClientName}' ({MachineName}) for local file access. Last seen: {LastSeen}",
                        discoveryResult.ActiveDesktop.ClientName,
                        discoveryResult.ActiveDesktop.MachineName,
                        discoveryResult.ActiveDesktop.LastSeen);
                    
                    if (discoveryResult.AllRegisteredDesktops.Count > 1)
                    {
                        agentInitLogger?.LogInformation("[AGENT-INIT] User has {Count} registered desktops: {Desktops}",
                            discoveryResult.AllRegisteredDesktops.Count,
                            string.Join(", ", discoveryResult.AllRegisteredDesktops.Select(d => d.ClientName)));
                    }
                }
            }
            catch (LocalMcpDesktopRegistrationRequiredException regEx)
            {
                // Desktop client not registered - store the registration URL to show to user
                var regLogger = service.GetService(typeof(Microsoft.Extensions.Logging.ILogger<Agent365Agent>)) as Microsoft.Extensions.Logging.ILogger;
                regLogger?.LogWarning("[AGENT] Desktop registration required. URL: {RegistrationUrl}", regEx.RegistrationProtocolUrl);
                
                this.PendingDesktopRegistrationUrl = regEx.RegistrationProtocolUrl;
                
                // Continue loading cloud tools - local tools will show registration message when used
                await turnContext.StreamingResponse.QueueInformativeUpdateAsync("Desktop registration required for local file access...");
            }

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
        
        // Add desktop context instructions (which desktop is being used, or registration required)
        if (!string.IsNullOrEmpty(this.PendingDesktopRegistrationUrl))
        {
            instructions += GetDesktopRegistrationInstructions();
            agentLogger?.LogInformation("[AGENT-DEBUG] Added desktop registration instructions. URL: {RegistrationUrl}", this.PendingDesktopRegistrationUrl);
        }
        else if (this.ActiveDesktop != null)
        {
            instructions += GetActiveDesktopInstructions();
            agentLogger?.LogInformation("[AGENT-DEBUG] Added active desktop instructions. Desktop: {Desktop}", this.ActiveDesktop.ClientName);
        }
        
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
                    FunctionChoiceBehavior = FunctionChoiceBehavior.Auto(options: new() { RetainArgumentTypes = true, AllowConcurrentInvocation = true, AllowParallelCalls = true }),
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

        try
        {
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
        catch (LocalMcpReregistrationRequiredException reregEx)
        {
            // Handle re-registration required for local MCP servers
            // Send a user-friendly message with a clickable link to re-register
            var reregistrationMessage = BuildReregistrationMessage(reregEx);
            
            context?.StreamingResponse.QueueTextChunk(reregistrationMessage);
            
            return new Agent365AgentResponse()
            {
                Content = reregistrationMessage,
                ContentType = Agent365AgentResponseContentType.Text
            };
        }
        catch (Exception ex)
        {
            // Handle any other unexpected exceptions
            var errorMessage = $"An error occurred: {ex.Message}";
            context?.StreamingResponse.QueueTextChunk(errorMessage);
            
            return new Agent365AgentResponse()
            {
                Content = errorMessage,
                ContentType = Agent365AgentResponseContentType.Text
            };
        }
    }

    /// <summary>
    /// Builds a user-friendly re-registration message with a clickable protocol link.
    /// </summary>
    private static string BuildReregistrationMessage(LocalMcpReregistrationRequiredException ex)
    {
        var sb = new StringBuilder();
        sb.AppendLine("**Desktop Re-Registration Required**");
        sb.AppendLine();
        sb.AppendLine($"Your desktop needs to re-register to access local files via the **{ex.ServerName}** server.");
        sb.AppendLine();
        
        if (!string.IsNullOrEmpty(ex.ProtocolUrl))
        {
            // Format as a clickable link - Teams/M365 will handle the locaproto: protocol
            sb.AppendLine($"Please click the link below to re-register:");
            sb.AppendLine();
            sb.AppendLine($"[Re-register Desktop]({ex.ProtocolUrl})");
            sb.AppendLine();
            sb.AppendLine("After re-registering, please try your request again.");
        }
        else
        {
            sb.AppendLine("Please contact your administrator to re-register your desktop for local MCP access.");
        }
        
        return sb.ToString();
    }
    
    /// <summary>
    /// Gets instructions about the active desktop being used for local file access.
    /// </summary>
    private string GetActiveDesktopInstructions()
    {
        var sb = new StringBuilder();
        sb.AppendLine();
        sb.AppendLine("        LOCAL DESKTOP ACCESS:");
        sb.AppendLine($"        You are connected to the user's desktop '{this.ActiveDesktop!.MachineName}' for local file access.");
        
        if (this.AllRegisteredDesktops != null && this.AllRegisteredDesktops.Count > 1)
        {
            sb.AppendLine($"        The user has {this.AllRegisteredDesktops.Count} registered desktops:");
            foreach (var desktop in this.AllRegisteredDesktops)
            {
                var isActive = desktop.ClientName == this.ActiveDesktop.ClientName ? " (currently active)" : "";
                sb.AppendLine($"        - {desktop.MachineName}{isActive}");
            }
            sb.AppendLine("        You are using the most recently active desktop. If the user wants to access files from a different desktop, let them know they need to use that desktop and it will become active.");
        }
        
        return sb.ToString();
    }
    
    /// <summary>
    /// Gets instructions for desktop registration when local file access is requested but desktop is not registered.
    /// </summary>
    private string GetDesktopRegistrationInstructions()
    {
        return $@"

        DESKTOP REGISTRATION REQUIRED:
        The user's desktop is not registered with this agent. To enable local file access, the user needs to register their desktop.
        
        When the user asks about local files or file access:
        1. Inform them that their desktop needs to be registered to access local files
        2. Provide them with this registration link: [{this.PendingDesktopRegistrationUrl}]({this.PendingDesktopRegistrationUrl})
        3. Tell them to click the link, which will open their desktop app and register it with this agent
        4. After registration, they should refresh the conversation to enable local file tools
        
        Registration Link: {this.PendingDesktopRegistrationUrl}
        ";
    }
}
