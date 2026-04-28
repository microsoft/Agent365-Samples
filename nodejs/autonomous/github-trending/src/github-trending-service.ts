// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Background service that autonomously produces a trending repository digest each cycle.
 * Uses Azure OpenAI with the get_trending_repositories tool so the model decides when
 * and how to call the GitHub Search API.
 */

import { AzureOpenAI } from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';

import {
  AgentDetails,
  BaggageBuilder,
  InferenceScope,
  InferenceDetails,
  InferenceOperationType,
  InvokeAgentScope,
  InvokeAgentScopeDetails,
  Request,
} from '@microsoft/agents-a365-observability';

import { getTrendingRepositories, TOOL_DEFINITION } from './tools/github-trending-tool';

const SYSTEM_PROMPT =
  'You are an autonomous agent that produces a concise daily digest of trending GitHub repositories. ' +
  'Use the get_trending_repositories tool to fetch the latest data, then summarize the results ' +
  'as a short, readable digest with the top highlights. Never say you are an AI or language model.';

export interface TrendingServiceConfig {
  endpoint: string;
  apiKey: string;
  deployment: string;
  agentDetails: AgentDetails;
  language: string;
  minStars: number;
  maxResults: number;
  intervalMs: number;
}

export function startTrendingService(config: TrendingServiceConfig): void {
  const client = new AzureOpenAI({
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    apiVersion: '2024-12-01-preview',
    deployment: config.deployment,
  });

  console.log(`GitHubTrendingService started. Interval: ${config.intervalMs}ms`);

  const run = async () => {
    try {
      await runCycle(client, config);
    } catch (error) {
      console.warn('GitHubTrendingService cycle failed', error);
    }
  };

  // First run immediately, then on interval
  run();
  setInterval(run, config.intervalMs);
}

async function runCycle(client: AzureOpenAI, config: TrendingServiceConfig): Promise<void> {
  const { deployment, agentDetails, endpoint, language, minStars, maxResults } = config;

  // A365 Observability — propagate baggage context for this cycle
  new BaggageBuilder()
    .agentId(agentDetails.agentId)
    .tenantId(agentDetails.tenantId)
    .build();

  const now = new Date().toISOString().replace('T', ' ').substring(0, 16);
  const userPrompt =
    `It is ${now} UTC. ` +
    'Fetch today\'s trending repositories and produce a digest. ' +
    'Highlight what makes the top repos interesting and any notable patterns.';

  // A365 Observability — InvokeAgent span wraps the entire autonomous cycle
  const request: Request = { content: userPrompt };
  const endpointHost = endpoint.replace('https://', '').replace('http://', '').replace(/\/$/, '');

  const scopeDetails: InvokeAgentScopeDetails = {
    endpoint: { host: endpointHost, protocol: 'https' },
  };

  const agentScope = InvokeAgentScope.start(request, scopeDetails, agentDetails);

  try {
    await agentScope.withActiveSpanAsync(async () => {
      agentScope.recordInputMessages([SYSTEM_PROMPT, userPrompt]);

      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ];

      const tools: ChatCompletionTool[] = [TOOL_DEFINITION];

      // A365 Observability — InferenceCall span wraps the LLM invocation
      const inferenceDetails: InferenceDetails = {
        operationName: InferenceOperationType.CHAT,
        model: deployment,
        providerName: 'AzureOpenAI',
      };

      const inferenceScope = InferenceScope.start(request, inferenceDetails, agentDetails);
      try {
        await inferenceScope.withActiveSpanAsync(async () => {
          inferenceScope.recordInputMessages([SYSTEM_PROMPT, userPrompt]);

          // Initial LLM call with tools
          let response = await client.chat.completions.create({
            model: deployment,
            messages,
            tools,
            tool_choice: 'auto',
          });

          let choice = response.choices[0];

          // Handle tool calls if the model requests them
          while (choice.finish_reason === 'tool_calls') {
            messages.push(choice.message as ChatCompletionMessageParam);

            for (const toolCall of choice.message.tool_calls || []) {
              if (toolCall.function.name === 'get_trending_repositories') {
                const args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
                const toolResult = await getTrendingRepositories(
                  agentDetails,
                  args.language || language,
                  minStars,
                  maxResults,
                );
                messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult });
              }
            }

            // Follow-up LLM call with tool results
            response = await client.chat.completions.create({
              model: deployment,
              messages,
            });
            choice = response.choices[0];
          }

          const digest = choice.message.content || '';

          // Record token usage if available
          if (response.usage) {
            inferenceScope.recordInputTokens(response.usage.prompt_tokens);
            inferenceScope.recordOutputTokens(response.usage.completion_tokens);
          }

          inferenceScope.recordOutputMessages([digest]);
          agentScope.recordResponse(digest);

          console.log(`Trending Digest:\n${digest}`);
        });
      } finally {
        inferenceScope.dispose();
      }
    });
  } finally {
    agentScope.dispose();
  }
}
