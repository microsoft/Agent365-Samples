// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SHARE_TOOL, grantEditAccess } from '../src/mcp-tool-policy.ts';
import { shareFailureNote } from '../src/activity-helpers.ts';

const LEAK = 'MCP tool shareFileOrFolderInMyOnedrive on server mcp_OneDriveRemoteServer returned an error: Graph 403 item 01ABCDEF https://graph.microsoft.com/v1.0/drives/b!xyz';
const item = { tool: 'CreateDocument', itemId: 'item-1', name: 'Trip Plan.docx' };

async function withProductionLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const saved = { NODE_ENV: process.env.NODE_ENV, DEBUG: process.env.DEBUG };
  const original = { error: console.error, warn: console.warn };
  const lines: string[] = [];
  process.env.NODE_ENV = 'production';
  delete process.env.DEBUG;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.warn = console.error;
  try {
    return { result: await fn(), logs: lines.join('\n') };
  } finally {
    Object.assign(console, original);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('a failed grant returns a fixed code and logs no error text', async () => {
  const calls: unknown[] = [];
  const share = { name: SHARE_TOOL, invoke: async (args: unknown) => { calls.push(args); throw new Error(LEAK); } };
  const { result, logs } = await withProductionLogs(() => grantEditAccess([share], item as any, 'user@contoso.com'));
  assert.deepEqual(result, { ok: false, error: 'share-failed' });
  assert.equal(calls.length, 1);
  assert.match(logs, /\[Share\] grant failed/);
  assert.doesNotMatch(logs, /Graph 403|01ABCDEF|graph\.microsoft\.com/);
});

test('grant failures without a tool call use fixed codes', async () => {
  assert.deepEqual(await grantEditAccess([], { tool: 'CreateDocument', error: LEAK } as any, 'u@contoso.com'),
    { ok: false, error: 'unidentified-item' });
  assert.deepEqual(await grantEditAccess([], item as any, 'u@contoso.com'), { ok: false, error: 'share-tool-unavailable' });
});

test('the user-facing share failure note carries only the name and the reference id', () => {
  const note = shareFailureNote('Trip Plan.docx', 'corr-123');
  assert.match(note, /could not grant you access/);
  assert.match(note, /Reference: corr-123/);
  assert.doesNotMatch(note, /Graph|error:/);
  // agent.ts must not interpolate the grant error (or any exception text) into the reply.
  const agent = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(agent, /notes \+=[^;]*r\.error/);
  assert.doesNotMatch(agent, /\.message\?*\.slice/);
});
