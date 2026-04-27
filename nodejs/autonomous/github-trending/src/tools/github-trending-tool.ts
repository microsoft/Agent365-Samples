// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Tool that fetches trending repositories from the GitHub Search API.
 * Uses the unauthenticated search endpoint (no API key required, 10 req/min rate limit).
 */

import {
  AgentDetails,
  ExecuteToolScope,
  Request,
  ToolCallDetails,
  ServiceEndpoint,
} from '@microsoft/agents-a365-observability';

const GITHUB_API_ENDPOINT: ServiceEndpoint = { host: 'api.github.com', protocol: 'https' };

export async function getTrendingRepositories(
  agentDetails: AgentDetails,
  language: string = 'typescript',
  minStars: number = 5,
  maxResults: number = 10,
): Promise<string> {
  // A365 Observability — ExecuteTool span wraps the GitHub API call
  const request: Request = { content: language };
  const toolDetails: ToolCallDetails = {
    toolName: 'get_trending_repositories',
    arguments: language,
    toolType: 'function',
    description: 'Search GitHub for trending repositories by star count',
    endpoint: GITHUB_API_ENDPOINT,
  };

  const scope = ExecuteToolScope.start(request, toolDetails, agentDetails);
  try {
    return await scope.withActiveSpanAsync(async () => {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      let query = `created:>${since} stars:>=${minStars}`;
      if (language) {
        query += ` language:${language}`;
      }

      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${maxResults}`;

      const response = await fetch(url, {
        headers: { 'User-Agent': 'GitHubTrendingAgent/1.0' },
      });

      if (!response.ok) {
        const errorResult = `GitHub API request failed: HTTP ${response.status}`;
        scope.recordResponse(errorResult);
        return errorResult;
      }

      const data = await response.json() as { items?: Array<{ full_name: string; stargazers_count: number; description?: string; html_url: string }> };
      const items = data.items || [];

      if (items.length === 0) {
        const emptyResult = `No trending repositories found for language '${language}' in the last 7 days.`;
        scope.recordResponse(emptyResult);
        return emptyResult;
      }

      const lines: string[] = [
        `Top ${Math.min(items.length, maxResults)} trending ${language} repositories (created after ${since}):`,
        '',
      ];

      for (const repo of items.slice(0, maxResults)) {
        const description = repo.description || '(no description)';
        lines.push(`- **${repo.full_name}** (${repo.stargazers_count} stars): ${description}`);
        lines.push(`  ${repo.html_url}`);
      }

      const result = lines.join('\n');
      scope.recordResponse(result);
      return result;
    });
  } finally {
    scope.dispose();
  }
}

/**
 * Tool definition for OpenAI function calling.
 */
export const TOOL_DEFINITION = {
  type: 'function' as const,
  function: {
    name: 'get_trending_repositories',
    description: 'Search GitHub for repositories created in the last 7 days that are trending by star count',
    parameters: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          description: "Optional programming language filter (e.g. 'typescript', 'python', 'csharp'). Leave empty for all languages.",
        },
      },
    },
  },
};
