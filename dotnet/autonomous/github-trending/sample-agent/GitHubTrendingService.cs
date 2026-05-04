// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using GitHubTrending.Tools;
using Microsoft.Agents.A365.Observability.Runtime.Common;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Contracts;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Scopes;
using Microsoft.Extensions.AI;

namespace GitHubTrending;

/// <summary>
/// Background service that autonomously produces a trending repository digest each cycle.
/// Uses an IChatClient with the GitHubTrendingTool registered as a plugin so the model
/// decides when and how to call the GitHub Search API.
/// Interval is controlled by HeartbeatIntervalMs in configuration (default: 60 000 ms).
/// </summary>
internal sealed class GitHubTrendingService : BackgroundService
{
    private readonly ILogger<GitHubTrendingService> _logger;
    private readonly IChatClient _chatClient;
    private readonly GitHubTrendingTool _tool;
    private readonly TimeSpan _interval;

    // A365 Observability — injected from Agent365ObservabilityContext
    private readonly AgentDetails _agentDetails;
    private readonly Uri _agentEndpoint;
    private readonly string _modelName;

    public GitHubTrendingService(
        ILogger<GitHubTrendingService> logger,
        IConfiguration configuration,
        IChatClient chatClient,
        GitHubTrendingTool tool,
        Agent365ObservabilityContext obsContext)
    {
        _logger = logger;
        _chatClient = chatClient;
        _tool = tool;

        var intervalMs = configuration.GetValue<int>("HeartbeatIntervalMs", 60_000);
        _interval = TimeSpan.FromMilliseconds(intervalMs);

        _agentDetails = obsContext.AgentDetails;
        _agentEndpoint = new Uri(configuration["AzureOpenAI:Endpoint"] ?? "https://localhost");
        _modelName = configuration["AzureOpenAI:Deployment"] ?? "";
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("GitHubTrendingService started. Interval: {Interval}", _interval);

        using var timer = new PeriodicTimer(_interval);

        while (!stoppingToken.IsCancellationRequested && await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                // A365 Observability — propagate baggage context for this cycle
                using var baggage = new BaggageBuilder()
                    .AgentId(_agentDetails.AgentId)
                    .TenantId(_agentDetails.TenantId)
                    .Build();

                var systemPrompt =
                    "You are an autonomous agent that produces a concise daily digest of trending GitHub repositories. " +
                    "Use the GetTrendingRepositories tool to fetch the latest data, then summarize the results " +
                    "as a short, readable digest with the top highlights. Never say you are an AI or language model.";
                var userPrompt =
                    $"It is {DateTime.UtcNow:yyyy-MM-dd HH:mm} UTC. " +
                    "Fetch today's trending repositories and produce a digest. " +
                    "Highlight what makes the top repos interesting and any notable patterns.";

                // A365 Observability — InvokeAgent span wraps the entire autonomous cycle
                var request = new Request(content: userPrompt);
                using var agentScope = InvokeAgentScope.Start(
                    request,
                    new InvokeAgentScopeDetails(_agentEndpoint),
                    _agentDetails);

                agentScope.RecordInputMessages(new[] { systemPrompt, userPrompt });

                var messages = new List<ChatMessage>
                {
                    new(ChatRole.System, systemPrompt),
                    new(ChatRole.User, userPrompt)
                };

                var options = new ChatOptions
                {
                    Tools = [AIFunctionFactory.Create(_tool.GetTrendingRepositories)]
                };

                // A365 Observability — InferenceCall span wraps the LLM invocation
                // (IChatClient with UseFunctionInvocation may make multiple round-trips)
                using var inferenceScope = InferenceScope.Start(
                    request,
                    new InferenceCallDetails(
                        operationName: InferenceOperationType.Chat,
                        model: _modelName,
                        providerName: "AzureOpenAI"),
                    _agentDetails);

                inferenceScope.RecordInputMessages(new[] { systemPrompt, userPrompt });

                var response = await _chatClient.GetResponseAsync(messages, options, stoppingToken);
                var digest = response.Text;

                // Record token usage if available
                var usage = response.Usage;
                if (usage != null)
                {
                    if (usage.InputTokenCount.HasValue)
                        inferenceScope.RecordInputTokens((int)usage.InputTokenCount.Value);
                    if (usage.OutputTokenCount.HasValue)
                        inferenceScope.RecordOutputTokens((int)usage.OutputTokenCount.Value);
                }

                inferenceScope.RecordOutputMessages(new[] { digest });
                agentScope.RecordResponse(digest);

                _logger.LogInformation("Trending Digest:\n{Digest}", digest);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (HttpRequestException ex)
            {
                _logger.LogWarning(ex, "GitHubTrendingService cycle failed");
            }
            catch (InvalidOperationException ex)
            {
                _logger.LogWarning(ex, "GitHubTrendingService cycle failed");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "GitHubTrendingService cycle failed with unexpected error");
            }
        }

        _logger.LogInformation("GitHubTrendingService stopped.");
    }
}
