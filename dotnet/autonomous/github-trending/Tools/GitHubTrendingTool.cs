// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

using System.ComponentModel;
using System.Text;
using System.Text.Json;
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Contracts; // A365 Observability — ToolCallDetails, AgentDetails, etc.
using Microsoft.Agents.A365.Observability.Runtime.Tracing.Scopes;    // A365 Observability — ExecuteToolScope

namespace GitHubTrending.Tools;

/// <summary>
/// Tool that fetches trending repositories from the GitHub Search API.
/// Uses the unauthenticated search endpoint (no API key required, 10 req/min rate limit).
/// </summary>
public sealed class GitHubTrendingTool
{
    private static readonly Uri GitHubApiEndpoint = new("https://api.github.com");

    private readonly HttpClient _httpClient;
    private readonly string _language;
    private readonly int _minStars;
    private readonly int _maxResults;

    // A365 Observability — injected from Agent365ObservabilityContext
    private readonly AgentDetails _agentDetails;

    public GitHubTrendingTool(
        IHttpClientFactory httpClientFactory,
        IConfiguration configuration,
        Agent365ObservabilityContext obsContext)
    {
        _httpClient = httpClientFactory.CreateClient();
        _httpClient.DefaultRequestHeaders.UserAgent.ParseAdd("GitHubTrendingAgent/1.0");

        _language = configuration["GitHubTrending:Language"] ?? "csharp";
        _minStars = configuration.GetValue<int>("GitHubTrending:MinStars", 5);
        _maxResults = configuration.GetValue<int>("GitHubTrending:MaxResults", 10);

        _agentDetails = obsContext.AgentDetails;
    }

    [Description("Search GitHub for repositories created in the last 7 days that are trending by star count")]
    public async Task<string> GetTrendingRepositories(
        [Description("Optional programming language filter (e.g. 'csharp', 'python', 'typescript'). Leave empty for all languages.")]
        string? language = null)
    {
        var lang = language ?? _language;

        // A365 Observability — ExecuteTool span wraps the GitHub API call
        var request = new Request(content: language);
        using var toolScope = ExecuteToolScope.Start(
            request,
            new ToolCallDetails(
                toolName: nameof(GetTrendingRepositories),
                arguments: language,
                toolType: ToolType.Function,
                description: "Search GitHub for trending repositories by star count",
                endpoint: GitHubApiEndpoint),
            _agentDetails);

        var since = DateTime.UtcNow.AddDays(-7).ToString("yyyy-MM-dd");

        var query = $"created:>{since} stars:>={_minStars}";
        if (!string.IsNullOrWhiteSpace(lang))
            query += $" language:{lang}";

        var url = $"https://api.github.com/search/repositories" +
                  $"?q={Uri.EscapeDataString(query)}" +
                  $"&sort=stars&order=desc&per_page={_maxResults}";

        using var response = await _httpClient.GetAsync(url).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            var errorResult = $"GitHub API request failed: HTTP {response.StatusCode}";
            toolScope.RecordResponse(errorResult);
            return errorResult;
        }

        using var doc = await JsonDocument.ParseAsync(
            await response.Content.ReadAsStreamAsync().ConfigureAwait(false)).ConfigureAwait(false);

        var items = doc.RootElement.GetProperty("items");
        if (items.GetArrayLength() == 0)
        {
            var emptyResult = $"No trending repositories found for language '{lang}' in the last 7 days.";
            toolScope.RecordResponse(emptyResult);
            return emptyResult;
        }

        var sb = new StringBuilder();
        sb.AppendLine($"Top {Math.Min(items.GetArrayLength(), _maxResults)} trending {lang} repositories (created after {since}):");
        sb.AppendLine();

        foreach (var repo in items.EnumerateArray())
        {
            var name = repo.GetProperty("full_name").GetString();
            var stars = repo.GetProperty("stargazers_count").GetInt32();
            var description = repo.TryGetProperty("description", out var desc) && desc.ValueKind != JsonValueKind.Null
                ? desc.GetString() ?? "(no description)"
                : "(no description)";
            var htmlUrl = repo.GetProperty("html_url").GetString();

            sb.AppendLine($"- **{name}** ({stars} stars): {description}");
            sb.AppendLine($"  {htmlUrl}");
        }

        var result = sb.ToString();
        toolScope.RecordResponse(result);
        return result;
    }
}
