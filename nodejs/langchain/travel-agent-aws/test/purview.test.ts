// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProcessContentBody,
  evaluatePrompt,
  evaluateResponse,
  isBlockAction,
  policyAppId,
  purviewChecksOutput,
} from '../src/purview.ts';

const SECRET_TEXT = 'My card is 4111 1111 1111 1111';
const TURN = { blueprintId: 'bp-tenant-b', agentId: 'agent-1', conversationId: 'conv-1' };
const ENV_KEYS = ['PURVIEW_DLP_ENABLED', 'PURVIEW_FAIL_MODE', 'PURVIEW_CHECK_OUTPUT', 'PURVIEW_TIMEOUT_MS', 'PURVIEW_APP_ID',
  'PURVIEW_APP_NAME', 'PURVIEW_DEBUG', 'NODE_ENV', 'DEBUG', 'agent365Observability__agentBlueprintId',
  'connections__service_connection__settings__clientId'];

const realFetch = globalThis.fetch;
const saved: Record<string, string | undefined> = {};
let calls: Array<{ url: string; init: any }> = [];
let logs: string[] = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };

function respond(status: number, body: unknown) {
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const token = async () => 'tok';

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.NODE_ENV = 'production';
  process.env.PURVIEW_DLP_ENABLED = 'true';
  calls = [];
  logs = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    (console as any)[level] = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  globalThis.fetch = realFetch;
  Object.assign(console, realConsole);
});

test('disabled by default: no call, nothing blocked', async () => {
  delete process.env.PURVIEW_DLP_ENABLED;
  respond(200, {});
  assert.deepEqual(await evaluatePrompt(SECRET_TEXT, TURN, token), { blocked: false, decision: 'disabled' });
  assert.equal(calls.length, 0);
  assert.equal(purviewChecksOutput(), false);
});

test('a block action stops the turn; the request names the turn blueprint and the agent token', async () => {
  respond(200, { protectionScopeState: 'modified', policyActions: [{ action: 'restrictAccess', restrictionAction: 'block' }] });
  const v = await evaluatePrompt(SECRET_TEXT, TURN, token);
  assert.deepEqual(v, { blocked: true, decision: 'blocked', reason: 'policy-block' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/beta\/me\/dataSecurityAndGovernance\/processContent$/);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  const body = JSON.parse(calls[0].init.body);
  const entry = body.contentToProcess.contentEntries[0];
  assert.equal(entry.content.data, SECRET_TEXT);
  assert.ok(entry.name.trim(), 'content entry name must be non-empty');
  assert.equal(body.contentToProcess.activityMetadata.activity, 'uploadText');
  assert.equal(body.contentToProcess.protectedAppMetadata.applicationLocation.value, 'bp-tenant-b');
  assert.equal(entry.agents[0].identifier, 'agent-1');
  assert.ok(logs.some((l) => l.includes('[purview] uploadText -> BLOCKED (HTTP 200, 1 policyAction(s), scopeState=modified, errors=0)')));
});

test('no policy action: allowed', async () => {
  respond(200, { protectionScopeState: 'notModified', policyActions: [] });
  assert.deepEqual(await evaluatePrompt('Plan a trip to Lisbon', TURN, token), { blocked: false, decision: 'allowed' });
});

test('processingErrors count as a failure: blocked when closed, allowed when open', async () => {
  respond(200, { policyActions: [], processingErrors: [{ message: 'The provided data for Name is invalid' }] });
  assert.deepEqual(await evaluatePrompt('x', TURN, token), { blocked: true, decision: 'error', reason: 'processing-errors' });
  process.env.PURVIEW_FAIL_MODE = 'open';
  assert.deepEqual(await evaluatePrompt('x', TURN, token), { blocked: false, decision: 'error', reason: 'processing-errors' });
});

test('HTTP errors and token failures fail closed by default', async () => {
  respond(403, { error: { code: 'Forbidden' } });
  assert.deepEqual(await evaluatePrompt('x', TURN, token), { blocked: true, decision: 'error', reason: 'graph-403' });
  const noToken = await evaluatePrompt('x', TURN, async () => { throw new Error('consent missing'); });
  assert.equal(noToken.blocked, true);
  assert.equal(noToken.decision, 'error');
  assert.equal((await evaluatePrompt('x', TURN, async () => '')).reason, 'no-token');
});

test('a slow Purview call times out and fails closed', async () => {
  process.env.PURVIEW_TIMEOUT_MS = '50';
  globalThis.fetch = ((_url: any, init: any) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  })) as typeof fetch;
  const v = await evaluatePrompt('x', TURN, token);
  assert.deepEqual(v, { blocked: true, decision: 'error', reason: 'timeout-50ms' });
});

test('content over 100,000 characters is blocked even when failing open', async () => {
  process.env.PURVIEW_FAIL_MODE = 'open';
  respond(200, { policyActions: [] });
  const v = await evaluatePrompt('a'.repeat(100_001), TURN, token);
  assert.equal(v.blocked, true);
  assert.equal(calls.length, 0);
});

test('the turn blueprint is the policy location; configured ids are only fallbacks', () => {
  process.env.PURVIEW_APP_ID = 'bp-configured';
  process.env.connections__service_connection__settings__clientId = 'bp-env-connection';
  assert.equal(policyAppId(TURN), 'bp-tenant-b');
  assert.equal(policyAppId({}), 'bp-configured');
  delete process.env.PURVIEW_APP_ID;
  assert.equal(policyAppId({}), 'bp-env-connection');
});

test('no blueprint id at all fails closed without calling Graph', async () => {
  respond(200, {});
  const v = await evaluatePrompt('x', {}, token);
  assert.deepEqual(v, { blocked: true, decision: 'error', reason: 'no-app-id' });
  assert.equal(calls.length, 0);
});

test('response audit uses downloadText and can be turned off', async () => {
  respond(200, { policyActions: [] });
  assert.equal(purviewChecksOutput(), true);
  await evaluateResponse('Here is your itinerary', TURN, token);
  assert.equal(JSON.parse(calls[0].init.body).contentToProcess.activityMetadata.activity, 'downloadText');
  process.env.PURVIEW_CHECK_OUTPUT = 'false';
  assert.equal(purviewChecksOutput(), false);
});

test('production logs never contain the checked text or Graph error bodies', async () => {
  respond(400, { error: { message: `echo: ${SECRET_TEXT}` } });
  await evaluatePrompt(SECRET_TEXT, TURN, token);
  respond(200, { policyActions: [], processingErrors: [{ message: SECRET_TEXT }] });
  await evaluatePrompt(SECRET_TEXT, TURN, token);
  assert.ok(logs.length >= 2);
  assert.ok(logs.every((l) => !l.includes('4111')), logs.join('\n'));
});

test('isBlockAction and the body name helper', () => {
  assert.equal(isBlockAction([{ restrictionAction: 'Block' }]), true);
  assert.equal(isBlockAction([{ restrictionAction: 'warn' }]), false);
  assert.equal(isBlockAction(undefined), false);
  process.env.PURVIEW_APP_NAME = '  ';
  const body = buildProcessContentBody('uploadText', 'x', TURN, 'bp');
  assert.equal(body.contentToProcess.contentEntries[0].name, 'Travel Agent AWS message');
});
