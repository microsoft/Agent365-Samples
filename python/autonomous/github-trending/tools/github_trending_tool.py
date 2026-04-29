# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Tool that fetches trending repositories from the GitHub Search API.
Uses the unauthenticated search endpoint (no API key required, 10 req/min rate limit).
"""

import json
import logging
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import httpx

from microsoft_agents_a365.observability.core import (
    AgentDetails,
    ExecuteToolScope,
    Request,
    ServiceEndpoint,
    ToolCallDetails,
)

logger = logging.getLogger(__name__)

GITHUB_API_ENDPOINT = ServiceEndpoint(hostname="api.github.com")

# Module-level httpx client — reused across tool calls to avoid per-call overhead
_http_client = httpx.AsyncClient(headers={"User-Agent": "GitHubTrendingAgent/1.0"})


async def get_trending_repositories(
    agent_details: AgentDetails,
    language: str = "python",
    min_stars: int = 5,
    max_results: int = 10,
) -> str:
    """Search GitHub for repositories created in the last 7 days that are trending by star count."""

    # A365 Observability — ExecuteTool span wraps the GitHub API call
    request = Request(content=language)
    with ExecuteToolScope.start(
        request=request,
        details=ToolCallDetails(
            tool_name="get_trending_repositories",
            arguments=json.dumps({"language": language, "min_stars": min_stars, "max_results": max_results}),
            tool_type="function",
            description="Search GitHub for trending repositories by star count",
            endpoint=GITHUB_API_ENDPOINT,
        ),
        agent_details=agent_details,
    ) as tool_scope:
        since = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")

        query = f"created:>{since} stars:>={min_stars}"
        if language:
            query += f" language:{language}"

        url = (
            f"https://api.github.com/search/repositories"
            f"?q={quote(query)}&sort=stars&order=desc&per_page={max_results}"
        )

        response = await _http_client.get(url)

        if response.status_code != 200:
            error_result = f"GitHub API request failed: HTTP {response.status_code}"
            tool_scope.record_response(error_result)
            return error_result

        data = response.json()
        items = data.get("items", [])

        if not items:
            empty_result = f"No trending repositories found for language '{language}' in the last 7 days."
            tool_scope.record_response(empty_result)
            return empty_result

        lines = [f"Top {min(len(items), max_results)} trending {language} repositories (created after {since}):", ""]
        for repo in items[:max_results]:
            name = repo["full_name"]
            stars = repo["stargazers_count"]
            description = repo.get("description") or "(no description)"
            html_url = repo["html_url"]
            lines.append(f"- **{name}** ({stars} stars): {description}")
            lines.append(f"  {html_url}")

        result = "\n".join(lines)
        tool_scope.record_response(result)
        return result
