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

function loadRoutingAgent(t, { handled = true, inTeam = true, rejectWorkIQ = true } = {}) {
  setEnv(t, { ...process.env, LEADER_AAD_ID: 'leader', LEADER_UPN: 'leader@example.com' });
  t.mock.method(require('dotenv'), 'configDotenv', () => ({}));
  const clients = [], routes = [], prompts = [];
  const { CosAgent } = loadWithMocks('../dist/agent', {
    '@microsoft/agents-hosting': {
      AgentApplication: class { onAgentNotification() {} onActivity() {} },
      MemoryStorage: class {},
    },
    '@microsoft/agents-a365-notifications': {},
    '../dist/client': { getClient: async (_auth, _handler, context, _name, options) => {
      clients.push({ context, options });
      if (!options.extractionOnly && rejectWorkIQ) throw new Error('Mail audience token exchange failed');
      return {
        resolveUpnToAad: async () => 'leader',
        getPeopleOpts: () => ({ context }),
        invokeAgentWithScope: async (prompt) => { prompts.push(prompt); return 'conversation response'; },
      };
    } },
    '../dist/graph/peopleTools': { resolveUpnToAad: async () => 'leader', isUserInTeam: async () => inTeam },
    '../dist/observability': {
      ensureObservabilityToken: async () => {},
      runWithInvokeAgentScope: async (_ctx, _opts, work) => work(),
      runWithObservabilityContext: async (_ctx, _auth, work) => work(),
    },
    '../dist/scheduler': { cacheConversationReference() {}, startScheduler() {} },
    '../dist/state/conversationRefs': { rememberConversationRef() {} },
    '../dist/cards/actionRouter': { handleCardActionIfAny: async (context, client, leader) => {
      routes.push({ context, client, leader });
      return { handled };
    } },
  });
  // Exercise the actual private handlers without starting the SDK server or
  // constructor registrations. TypeScript private methods remain callable in JS.
  const agent = Object.create(CosAgent.prototype);
  Object.defineProperty(agent, 'authorization', { value: {} });
  return { agent, clients, routes, prompts };
}

for (const mode of ['keyword', 'message-card', 'invoke-card', 'sync-card']) {
  test(`${mode} routing runs without full WorkIQ registration`, { timeout: 5000 }, async (t) => {
    const { agent, clients, routes, prompts } = loadRoutingAgent(t);
    const activity = {
      id: `routing-${mode}`, type: mode === 'invoke-card' ? 'invoke' : 'message',
      text: mode === 'keyword' ? 'ontrack' : '',
      from: { aadObjectId: 'owner', name: 'Owner' },
      getConversationReference: () => ({ conversation: { id: 'personal-chat' } }),
      ...(mode === 'keyword' ? {} : { value: { verb: 'ontrack', followupId: 'pending' } }),
      ...(mode === 'invoke-card' ? { name: 'adaptiveCard/action' } : {}),
    };
    const messages = [];
    const context = { activity, sendActivity: async (message) => messages.push(message) };
    let finish;
    const continued = new Promise((resolve) => { finish = resolve; });
    if (mode === 'message-card' || mode === 'invoke-card') {
      context.adapter = { continueConversation: async (_id, _ref, work) => {
        try {
          await work({ activity: {}, sendActivity: context.sendActivity });
        } finally { finish(); }
      } };
    }
    if (mode === 'invoke-card') await agent.handleInvoke(context, {});
    else await agent.handleUserMessage(context, {});
    if (context.adapter) await continued;
    assert.equal(routes.length, 1, 'the handler must not lose the action in its background catch');
    assert.equal(routes[0].context.activity.from.aadObjectId, 'owner');
    assert.equal(routes[0].leader, 'leader');
    assert.equal(clients.length, 1);
    assert.equal(clients[0].options.extractionOnly, true);
    assert.deepEqual(prompts, []);
    if (mode === 'invoke-card') assert.equal(messages[0].type, 'invokeResponse');
  });
}

test('conversational fallthrough still fails closed on full WorkIQ registration errors', async (t) => {
  const { agent, clients, routes } = loadRoutingAgent(t, { handled: false });
  await assert.rejects(agent.handleUserMessage({
    activity: { id: 'fallthrough-error', text: 'Summarize my inbox', from: { aadObjectId: 'owner', name: 'Owner' } },
    sendActivity: async () => {},
  }, {}), /Mail audience token exchange failed/);
  assert.equal(routes.length, 1);
  assert.equal(clients.length, 2);
  assert.equal(clients[0].options.extractionOnly, true);
  assert.equal(clients[1].options.extractionOnly, undefined);
});

test('conversational fallthrough preserves the restricted sender gate', async (t) => {
  const { agent, clients, routes, prompts } = loadRoutingAgent(t, { handled: false, inTeam: false, rejectWorkIQ: false });
  await agent.handleUserMessage({
    activity: { id: 'restricted-fallthrough', text: 'Show task status', from: { aadObjectId: 'outsider', name: 'User' } },
    sendActivity: async () => {},
  }, {});
  assert.equal(routes.length, 1);
  assert.equal(clients.length, 2);
  assert.equal(clients[0].options.extractionOnly, true);
  assert.ok(clients.every((client) => client.options.restrictedAccess === true));
  assert.equal(prompts.length, 1);
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
  const lookups = [];
  t.mock.method(axios, 'get', async (url, config) => {
    lookups.push({ url, config });
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
  assert.equal(lookups.length, 1);
  assert.match(lookups[0].url, /users\/owner/);
  assert.equal(lookups[0].config.timeout, 30_000);
  assert.ok(lookups[0].config.signal instanceof AbortSignal);
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
