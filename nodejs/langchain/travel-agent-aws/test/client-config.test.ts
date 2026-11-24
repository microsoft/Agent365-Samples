// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// A missing LLM configuration must not crash startup: /api/health has to stay up.
test('client.ts loads without any LLM configuration', async () => {
  // Present-but-empty values also stop dotenv from filling them from a local .env file.
  for (const key of [
    'LLM_PROVIDER', 'BEDROCK_MODEL_ID', 'OPENAI_API_KEY',
    'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT',
  ]) {
    process.env[key] = '';
  }
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const client = await import('../src/client.ts');
    assert.equal(typeof client.getClient, 'function');
  } finally {
    console.error = original;
  }
  assert.ok(errors.some((args) => String(args[0]).includes('[LLM] Configuration error')));
});
