// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// IMPORTANT: Load environment variables FIRST before any other imports.
import { configDotenv } from 'dotenv';
configDotenv({ override: true });

import { AzureOpenAI } from 'openai';
import { setDefaultOpenAIClient, setOpenAIAPI } from '@openai/agents';

let cachedClient: AzureOpenAI | null = null;

/**
 * Configure the Azure OpenAI client for the Foundry gpt-4o deployment and
 * register it as the default client for the `@openai/agents` runtime.
 *
 * Env vars:
 *   AZURE_OPENAI_ENDPOINT      — e.g. https://<project>.services.ai.azure.com
 *   AZURE_OPENAI_DEPLOYMENT    — deployment name in Foundry (e.g. gpt-4o)
 *   AZURE_OPENAI_API_KEY       — resource API key (NOT a Foundry agent key)
 *   AZURE_OPENAI_API_VERSION   — e.g. preview, 2024-10-21, 2024-05-01-preview
 *
 * Notes:
 * - Azure OpenAI does not expose the /responses API — we force `chat_completions`.
 * - The `@openai/agents` SDK uses the default client set here for all Agent runs.
 */
export function configureOpenAIClient(): AzureOpenAI {
  if (cachedClient) return cachedClient;

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim();
  const apiKey = process.env.AZURE_OPENAI_API_KEY?.trim();
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT?.trim();
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION?.trim() ?? 'preview';

  if (!endpoint) {
    throw new Error('[openai-config] AZURE_OPENAI_ENDPOINT is not set.');
  }
  if (!apiKey) {
    throw new Error('[openai-config] AZURE_OPENAI_API_KEY is not set.');
  }
  if (!deployment) {
    throw new Error('[openai-config] AZURE_OPENAI_DEPLOYMENT is not set.');
  }

  cachedClient = new AzureOpenAI({
    endpoint,
    apiKey,
    apiVersion,
    deployment,
  });

  // The @openai/agents SDK defaults to the /responses API which is not
  // available on Azure OpenAI — force chat completions.
  setOpenAIAPI('chat_completions');
  setDefaultOpenAIClient(cachedClient as unknown as any);

  console.log(
    `[openai-config] Azure OpenAI client configured (endpoint=${endpoint}, deployment=${deployment}, api-version=${apiVersion})`
  );
  return cachedClient;
}

/** Deployment name used by @openai/agents as the model id. */
export function getModelName(): string {
  return (process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-4o').trim();
}

/** True when the configured endpoint points at Azure AI Foundry. */
export function isFoundryEndpoint(): boolean {
  const url = process.env.AZURE_OPENAI_ENDPOINT ?? '';
  return url.includes('services.ai.azure.com');
}

