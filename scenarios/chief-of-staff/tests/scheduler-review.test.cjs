// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
const assert = require('node:assert/strict');
const { test } = require('node:test');

function loadWithMocks(modulePath, mocks) {
  const saved = new Map();
  const target = require.resolve(modulePath);
  saved.set(target, require.cache[target]);
  delete require.cache[target];
  for (const [name, exports] of Object.entries(mocks)) {
    const id = require.resolve(name);
    if (!saved.has(id)) saved.set(id, require.cache[id]);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  try {
    return require(target);
  } finally {
    for (const [id, entry] of saved) {
      if (entry) require.cache[id] = entry;
      else delete require.cache[id];
    }
  }
}

function setEnv(t, env) {
  const original = process.env;
  process.env = env;
  t.after(() => { process.env = original; });
}

class MemoryMap extends Map {
  constructor() { super(); }
}
const logger = { providerError: () => 'provider failure' };

test('all scheduled jobs bypass WorkIQ registration and a failed capture does not block other work', async (t) => {
  setEnv(t, { ...process.env, SCHEDULER_ENABLED: 'true', BRIEF_ENABLED: 'true' });
  const ticks = [];
  const intervals = [];
  t.mock.method(global, 'setInterval', (callback) => { intervals.push(callback); return intervals.length; });
  t.mock.method(global, 'clearInterval', () => {});
  const calls = [];
  const completions = [];
  const failures = [];
  const outcomes = [];
  const scheduler = loadWithMocks('../dist/scheduler', {
    cron: { CronJob: { from: (options) => { ticks.push(options.onTick); return { stop() {} }; } } },
    '../dist/client': { getClient: async (_auth, _handler, _ctx, _name, options) => {
      assert.equal(options.humanInitiated, false);
      assert.equal(options.extractionOnly, true, 'Graph jobs must not attempt WorkIQ registration');
      calls.push('client');
      return { getPeopleOpts: () => ({}) };
    } },
    '../dist/observability': { runWithObservabilityContext: async (_ctx, _auth, work) => work() },
    '../dist/util/logger': logger,
    '../dist/cos/brief': { runBrief: async () => calls.push('brief') },
    '../dist/cos/followup': { runFollowup: async () => calls.push('followup') },
    '../dist/cos/capture': { runCapture: async (payload) => {
      calls.push(payload.eventId);
      if (payload.eventId === 'failed-summary') throw new Error('WorkIQ post unavailable after Graph writes');
    } },
    '../dist/cos/taskComplete': { runTaskComplete: async () => {
      calls.push('task-complete');
      return { complete: true, delivered: ['owner'] };
    } },
    '../dist/graph/transcriptPoller': { pollForNewTranscripts: async () => [
      { eventId: 'failed-summary', transcriptId: 'transcript-1' },
      { eventId: 'next-capture', transcriptId: 'transcript-2' },
    ] },
    '../dist/graph/plannerPoller': {
      pollForCompletedTasks: async () => [{ taskId: 'completed-task', planId: 'plan', alreadyDelivered: [] }],
      acknowledgeCompletion: (...args) => outcomes.push(args),
    },
    '../dist/state/followupStore': { findStaleForEscalation: () => [] },
    '../dist/state/pendingCaptureStore': {
      markCaptureComplete: (id) => completions.push(id),
      markCaptureProcessingFailed: (id) => { failures.push(id); return 'retry'; },
    },
    '../dist/state/conversationRefs': { lookupConversationRef: () => ({ conversation: { id: 'leader-chat' } }) },
    '../dist/state/persistentMap': { PersistentMap: MemoryMap },
    '../dist/cards/followupCards': {},
    '../dist/cards/actionRouter': { retryPendingLeaderDeliveries: async () => {} },
    '../dist/graph/plannerTools': {},
    '../dist/graph/peopleTools': { resolveUpnToAad: async () => null },
  });
  scheduler.startScheduler({
    adapter: { continueConversation: async (_id, _ref, work) => work({}) },
    authorization: {}, authHandlerName: 'test-handler',
  });
  try {
    assert.equal(ticks.length, 2);
    assert.equal(intervals.length, 2);
    for (const tick of ticks) await tick();
    for (const interval of intervals) await interval();
    assert.equal(calls.filter((c) => c === 'client').length, 4);
    for (const job of ['brief', 'followup', 'failed-summary', 'next-capture', 'task-complete']) {
      assert.ok(calls.includes(job), `${job} must run despite unavailable WorkIQ`);
    }
    assert.deepEqual(failures, ['failed-summary']);
    assert.deepEqual(completions, ['next-capture']);
    assert.deepEqual(outcomes, [['completed-task', { complete: true, delivered: ['owner'] }]]);
  } finally {
    scheduler.stopScheduler();
  }
});

test('Planner polling bounds Graph requests and preserves pending completion retries on failure', async (t) => {
  const axios = require('axios').default;
  let fail = false;
  t.mock.method(axios, 'get', async (_url, config) => {
    assert.equal(config.timeout, 30_000);
    assert.ok(config.signal instanceof AbortSignal);
    if (fail) throw new Error('offline');
    return { data: { value: [{ id: 'task', planId: 'plan', percentComplete: 100,
      createdDateTime: new Date(Date.now() + 60_000).toISOString() }] } };
  });
  const poller = loadWithMocks('../dist/graph/plannerPoller', {
    '../dist/graph/peopleTools': { acquireGraphToken: async () => 'test-token' },
    '../dist/graph/plannerConfig': { getPlannerPlanId: async () => 'plan' },
    '../dist/state/persistentMap': { PersistentMap: MemoryMap },
    '../dist/util/logger': logger,
  });
  const opts = { authorization: {}, context: {}, authHandlerName: 'test-handler' };
  assert.deepEqual(await poller.pollForCompletedTasks(opts), [{ taskId: 'task', planId: 'plan', alreadyDelivered: [] }]);
  poller.acknowledgeCompletion('task', { complete: false, delivered: ['owner'] });
  fail = true;
  assert.deepEqual(await poller.pollForCompletedTasks(opts), [{ taskId: 'task', planId: 'plan', alreadyDelivered: ['owner'] }]);
});

test('task completion display-name lookup is bounded and failure still delivers Graph-backed notifications', async (t) => {
  setEnv(t, { ...process.env, LEADER_AAD_ID: 'leader' });
  const axios = require('axios').default;
  t.mock.method(axios, 'get', async (url, config) => {
    assert.match(url, /users\/owner/);
    assert.equal(config.timeout, 30_000);
    assert.ok(config.signal instanceof AbortSignal);
    throw new Error('lookup unavailable');
  });
  const sent = [];
  const { runTaskComplete } = loadWithMocks('../dist/cos/taskComplete', {
    '../dist/graph/graphAppToken': { acquireAppOnlyGraphToken: async () => 'test-token' },
    '../dist/graph/plannerTools': { getPlannerTaskDetails: async () => ({
      ok: true, title: 'Finish report', percentComplete: 100, assigneeAads: ['owner'],
    }) },
    '../dist/cards/followupCards': { sendPlainDmToUser: async (_opts, aad) => { sent.push(aad); return { ok: true }; } },
    '../dist/state/followupStore': { cancelOutstandingRequestsForTask: () => 0 },
    '../dist/util/logger': logger,
  });
  assert.deepEqual(await runTaskComplete({ taskId: 'task' }, {}, {}, { getPeopleOpts: () => ({}) }),
    { complete: true, delivered: ['owner', 'leader'] });
  assert.deepEqual(sent, ['owner', 'leader']);
});

test('extraction clients avoid WorkIQ while interactive registration remains fail-closed by default', async (t) => {
  const env = { ...process.env, ENABLE_A365_OBSERVABILITY_EXPORTER: 'false' };
  delete env.SKIP_TOOLING_ON_ERRORS;
  setEnv(t, env);
  t.mock.method(require('dotenv'), 'configDotenv', () => ({}));
  let registrations = 0;
  const { getClient } = loadWithMocks('../dist/client', {
    '../dist/openai-config': { configureOpenAIClient() {}, getModelName: () => 'test-model', isFoundryEndpoint: () => false },
    '../dist/workiq': { addWorkIqServersToAgent: async () => { registrations++; throw new Error('offline registration'); } },
    '../dist/observability': { instrumentTools: (tools) => tools, instrumentMcpServers() {} },
    '../dist/graph/plannerTools': { createPlannerTools: () => [] },
    '../dist/graph/peopleTools': { createPeopleTools: () => [] },
    '../dist/cards/briefTool': { createBriefCardTool: () => ({}) },
    '../dist/cards/followupCards': { createFollowupCardTools: () => [] },
  });
  const client = await getClient({}, 'test-handler', {}, 'Scheduler', { humanInitiated: false, extractionOnly: true });
  assert.ok(client.getPeopleOpts());
  assert.equal(registrations, 0);
  await assert.rejects(getClient({}, 'test-handler', {}), /WorkIQ MCP registration failed/);
  assert.equal(registrations, 1);
});
