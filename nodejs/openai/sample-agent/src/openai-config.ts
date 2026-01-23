// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * OpenAI/Azure OpenAI Configuration
 * 
 * This module configures the OpenAI SDK to work with either:
 * - Standard OpenAI API (using OPENAI_API_KEY)
 * - Azure OpenAI (using AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT)
 * 
 * Azure OpenAI takes precedence if AZURE_OPENAI_API_KEY is set.
 */

import { AzureOpenAI, OpenAI } from 'openai';
import { setDefaultOpenAIClient, setOpenAIAPI } from '@openai/agents';

/**
 * Determines if Azure OpenAI should be used based on environment variables.
 */
export function isAzureOpenAI(): boolean {
  return Boolean(process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT);
}

/**
 * Gets the model/deployment name to use.
 * For Azure OpenAI, this is the deployment name.
 * For standard OpenAI, this is the model name.
 */
export function getModelName(): string {
  if (isAzureOpenAI()) {
    return process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
  }
  return process.env.OPENAI_MODEL || 'gpt-4o';
}

/**
 * Configures the OpenAI SDK with the appropriate client.
 * Call this function early in your application startup.
 */
export function configureOpenAIClient(): void {
  if (isAzureOpenAI()) {
    console.log('[OpenAI Config] Using Azure OpenAI');
    console.log(`[OpenAI Config] Endpoint: ${process.env.AZURE_OPENAI_ENDPOINT}`);
    console.log(`[OpenAI Config] Deployment: ${process.env.AZURE_OPENAI_DEPLOYMENT}`);
    
    const azureClient = new AzureOpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    });
    
    // Set the Azure client as the default for @openai/agents
    setDefaultOpenAIClient(azureClient as unknown as OpenAI);
    
    // Azure OpenAI requires Chat Completions API (not Responses API)
    setOpenAIAPI('chat_completions');
  } else if (process.env.OPENAI_API_KEY) {
    console.log('[OpenAI Config] Using standard OpenAI API');
    // Standard OpenAI uses OPENAI_API_KEY automatically
    // No need to set client explicitly
  } else {
    console.warn('[OpenAI Config] WARNING: No OpenAI or Azure OpenAI credentials found!');
    console.warn('[OpenAI Config] Set OPENAI_API_KEY for standard OpenAI');
    console.warn('[OpenAI Config] Or set AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT for Azure OpenAI');
  }
}
