# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""
Background service that autonomously produces a trending repository digest each cycle.
Uses Azure OpenAI with the get_trending_repositories tool so the model decides when
and how to call the GitHub Search API.
"""

import asyncio
import json
import logging
from datetime import datetime, timezone

from openai import AsyncAzureOpenAI

from microsoft_agents_a365.observability.core import (
    AgentDetails,
    BaggageBuilder,
    InferenceCallDetails,
    InferenceOperationType,
    InferenceScope,
    InvokeAgentScope,
    InvokeAgentScopeDetails,
    Request,
    ServiceEndpoint,
)

from tools.github_trending_tool import get_trending_repositories

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are an autonomous agent that produces a concise daily digest of trending GitHub repositories. "
    "Use the get_trending_repositories tool to fetch the latest data, then summarize the results "
    "as a short, readable digest with the top highlights. Never say you are an AI or language model."
)

# Tool definition for function calling
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_trending_repositories",
            "description": "Search GitHub for repositories created in the last 7 days that are trending by star count",
            "parameters": {
                "type": "object",
                "properties": {
                    "language": {
                        "type": "string",
                        "description": "Optional programming language filter (e.g. 'python', 'csharp', 'typescript'). "
                        "Leave empty for all languages.",
                    }
                },
            },
        },
    }
]


async def run_trending_service(
    client: AsyncAzureOpenAI,
    deployment: str,
    agent_details: AgentDetails,
    endpoint: str,
    language: str,
    min_stars: int,
    max_results: int,
    interval_seconds: float,
) -> None:
    """Run the autonomous trending digest loop."""
    logger.info("GitHubTrendingService started. Interval: %ds", interval_seconds)

    first_run = True
    while True:
        if first_run:
            first_run = False
        else:
            await asyncio.sleep(interval_seconds)

        try:
            await _run_cycle(client, deployment, agent_details, endpoint, language, min_stars, max_results)
        except Exception:
            logger.warning("GitHubTrendingService cycle failed", exc_info=True)


async def _run_cycle(
    client: AsyncAzureOpenAI,
    deployment: str,
    agent_details: AgentDetails,
    endpoint: str,
    language: str,
    min_stars: int,
    max_results: int,
) -> None:
    # A365 Observability — propagate baggage context for this cycle
    BaggageBuilder().agent_id(agent_details.agent_id).tenant_id(agent_details.tenant_id).build()

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    user_prompt = (
        f"It is {now} UTC. "
        "Fetch today's trending repositories and produce a digest. "
        "Highlight what makes the top repos interesting and any notable patterns."
    )

    # A365 Observability — InvokeAgent span wraps the entire autonomous cycle
    request = Request(content=user_prompt)
    endpoint_host = endpoint.replace("https://", "").replace("http://", "").rstrip("/")

    with InvokeAgentScope.start(
        request=request,
        scope_details=InvokeAgentScopeDetails(endpoint=ServiceEndpoint(hostname=endpoint_host)),
        agent_details=agent_details,
    ) as agent_scope:
        agent_scope.record_input_messages([SYSTEM_PROMPT, user_prompt])

        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ]

        # A365 Observability — InferenceCall span wraps the LLM invocation
        with InferenceScope.start(
            request=request,
            details=InferenceCallDetails(
                operationName=InferenceOperationType.CHAT,
                model=deployment,
                providerName="AzureOpenAI",
            ),
            agent_details=agent_details,
        ) as inference_scope:
            inference_scope.record_input_messages([SYSTEM_PROMPT, user_prompt])

            # Initial LLM call with tools
            response = await client.chat.completions.create(
                model=deployment,
                messages=messages,
                tools=TOOLS,
                tool_choice="auto",
            )

            choice = response.choices[0]

            # Handle tool calls if the model requests them
            while choice.finish_reason == "tool_calls":
                messages.append(choice.message.model_dump())

                for tool_call in choice.message.tool_calls:
                    if tool_call.function.name == "get_trending_repositories":
                        args = json.loads(tool_call.function.arguments) if tool_call.function.arguments else {}
                        tool_result = await get_trending_repositories(
                            agent_details=agent_details,
                            language=args.get("language", language),
                            min_stars=min_stars,
                            max_results=max_results,
                        )
                        messages.append({"role": "tool", "tool_call_id": tool_call.id, "content": tool_result})

                # Follow-up LLM call with tool results
                response = await client.chat.completions.create(
                    model=deployment,
                    messages=messages,
                )
                choice = response.choices[0]

            digest = choice.message.content or ""

            # Record token usage if available
            if response.usage:
                inference_scope.record_input_tokens(response.usage.prompt_tokens)
                inference_scope.record_output_tokens(response.usage.completion_tokens)

            inference_scope.record_output_messages([digest])

        agent_scope.record_response(digest)
        logger.info("Trending Digest:\n%s", digest)
