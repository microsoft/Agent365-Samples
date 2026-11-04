// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * OpenAI/Azure OpenAI Configuration for Semantic Kernel
 *
 * This module configures the OpenAI SDK to work with either:
 * - Standard OpenAI API (using OPENAI_API_KEY)
 * - Azure OpenAI (using AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT)
 *
 * Azure OpenAI takes precedence if AZURE_OPENAI_API_KEY is set.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AzureOpenAI } = require('openai');
import OpenAI from 'openai';
import { setDefaultOpenAIClient, setOpenAIAPI } from '@openai/agents';

/**
 * Determines if Azure OpenAI should be used based on environment variables.
 * All three variables (API_KEY, ENDPOINT, DEPLOYMENT) must be set.
 */
export function isAzureOpenAI(): boolean {
  return Boolean(
    process.env.AZURE_OPENAI_API_KEY &&
    process.env.AZURE_OPENAI_ENDPOINT &&
    process.env.AZURE_OPENAI_DEPLOYMENT
  );
}

/**
 * Gets the model/deployment name to use.
 * For Azure OpenAI, this is the deployment name.
 * For standard OpenAI, this is the model name.
 */
export function getModelName(): string {
  if (isAzureOpenAI()) {
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    if (!deployment) {
      throw new Error('AZURE_OPENAI_DEPLOYMENT is required when using Azure OpenAI');
    }
    return deployment;
  }
  return process.env.OPENAI_MODEL || 'gpt-4o';
}

/**
 * Creates and returns the appropriate OpenAI client based on environment configuration.
 */
export function createOpenAIClient(): OpenAI {
  if (isAzureOpenAI()) {
    console.log('[OpenAI Config] Using Azure OpenAI');
    console.log(`[OpenAI Config] Endpoint: ${process.env.AZURE_OPENAI_ENDPOINT}`);
    console.log(`[OpenAI Config] Deployment: ${process.env.AZURE_OPENAI_DEPLOYMENT}`);

    return new AzureOpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    });
  } else if (process.env.OPENAI_API_KEY) {
    console.log('[OpenAI Config] Using standard OpenAI API');
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  } else {
    console.warn('[OpenAI Config] WARNING: No OpenAI or Azure OpenAI credentials found!');
    console.warn('[OpenAI Config] Set OPENAI_API_KEY for standard OpenAI');
    console.warn('[OpenAI Config] Or set AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT for Azure OpenAI');
    throw new Error('No OpenAI credentials configured. Set OPENAI_API_KEY or Azure OpenAI variables.');
  }
}

/**
 * Configures the @openai/agents SDK default client for Azure OpenAI.
 * This is required for MCP tool registration via the @openai/agents Agent.
 * Call this once before creating Agent instances.
 */
export function configureOpenAIAgentClient(): void {
  if (isAzureOpenAI()) {
    const azureClient = new AzureOpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setDefaultOpenAIClient(azureClient as any);
    setOpenAIAPI('chat_completions');
  }
}
