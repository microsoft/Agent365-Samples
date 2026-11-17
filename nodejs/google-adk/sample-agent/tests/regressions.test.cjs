// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { test, after, afterEach } = require('node:test');
const { Agent, Runner, MCPToolset } = require('@google/adk');
const otel = require('@microsoft/opentelemetry');
const { GoogleADKAgent } = require('../dist/agent');
const { McpToolRegistrationService } = require('../dist/mcpToolRegistrationService');
const { createAppTokenResolver } = require('../dist/observability/app-token-resolver');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AGENT = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const BLUEPRINT = '33333333-3333-4333-8333-333333333333';
const HUMAN = '44444444-4444-4444-8444-444444444444';
const AGENT_USER = '55555555-5555-4555-8555-555555555555';
const RESOURCE = '9b975845-388f-4429-889e-eab1ef63949c';
const originalEnv = { ...process.env };
const spans = [];

delete process.env.BEARER_TOKEN;
delete process.env.WEBSITE_SITE_NAME;
process.env.NODE_ENV = 'development';
process.env.OTEL_NODE_RESOURCE_DETECTORS = 'env';
process.env.APPLICATIONINSIGHTS_SDKSTATS_DISABLED = 'true';
process.env.ENABLE_OBSERVABILITY = 'true';
process.env.ENABLE_A365_OBSERVABILITY_EXPORTER = 'false';
otel.useMicrosoftOpenTelemetry({
  enableConsoleExporters: false,
  tracesPerSecond: 0,
  samplingRatio: 1,
  a365: { enabled: true, enableObservabilityExporter: false, useS2SEndpoint: true },
  spanProcessors: [{
    onStart() {},
    onEnd(span) { spans.push(span); },
    async shutdown() {},
    async forceFlush() {},
  }],
  instrumentationOptions: {
    http: { enabled: false },
    openaiAgents: { enabled: false },
    langchain: { enabled: false },
  },
});

afterEach(() => {
  delete process.env.BEARER_TOKEN;
  delete process.env.WEBSITE_SITE_NAME;
  process.env.NODE_ENV = 'development';
  spans.length = 0;
});
after(async () => {
  await otel.shutdownMicrosoftOpenTelemetry();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

function context(agentId = AGENT) {
  return {
    activity: {
      type: 'message',
      id: 'activity-1',
      text: 'hello',
      recipient: {
        agenticAppId: agentId, tenantId: TENANT,
        agenticAppBlueprintId: BLUEPRINT, agenticUserId: 'agent@example.test', aadObjectId: AGENT_USER,
      },
      from: { aadObjectId: HUMAN, name: 'Test User' },
      conversation: { id: 'conversation-1', tenantId: TENANT },
      channelId: 'msteams',
      isAgenticRequest: () => Boolean(agentId),
      getAgenticInstanceId: () => agentId,
      getAgenticTenantId: () => TENANT,
      getAgenticUser: () => 'agent@example.test',
    },
    turnState: new Map(),
  };
}

function jwt(overrides = {}) {
  const claims = {
    azp: AGENT, tid: TENANT, aud: RESOURCE,
    exp: Math.floor(Date.now() / 1000) + 3600, ...overrides,
  };
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

test('F5 launch arguments are accepted by Node without starting the server', () => {
  const launch = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.vscode', 'launch.json'), 'utf8'));
  for (const configuration of launch.configurations) {
    const args = configuration.runtimeArgs.filter(arg => !arg.startsWith('--inspect'));
    const result = spawnSync(process.execPath, [...args, '-e', 'process.stdout.write("ready")'], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${configuration.name}: ${result.stderr}`);
    assert.equal(result.stdout, 'ready');
  }
});

test('Playground bootstrap loads ignored user credentials without root environment fallback', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-playground-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, '.env.playground.user');
  fs.writeFileSync(file, 'ENABLE_OBSERVABILITY=false\nGOOGLE_GENAI_API_KEY=test-only-key\nGEMINI_MODEL=test-model\n');
  const env = { ...process.env, AGENT_ENV_FILE: file };
  for (const key of ['ENABLE_OBSERVABILITY', 'GOOGLE_GENAI_API_KEY', 'GEMINI_MODEL',
    'CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID']) delete env[key];
  const result = spawnSync(process.execPath, ['-e', `
    require('./dist/instrumentation');
    console.log(JSON.stringify({
      keyLoaded: process.env.GOOGLE_GENAI_API_KEY === 'test-only-key',
      model: process.env.GEMINI_MODEL,
      rootConnectionLoaded: !!process.env.CONNECTIONS__SERVICE_CONNECTION__SETTINGS__CLIENTID
    }));
  `], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(state, { keyLoaded: true, model: 'test-model', rootConnectionLoaded: false });
  const missing = spawnSync(process.execPath, ['-e', 'require("./dist/instrumentation")'], {
    cwd: path.join(__dirname, '..'), env: { ...env, AGENT_ENV_FILE: path.join(directory, 'missing') }, encoding: 'utf8',
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /ENOENT/);
});

test('personalization retains default security constraints and custom base instructions', async t => {
  const instructions = [];
  t.mock.method(Runner.prototype, 'runEphemeral', async function* () {
    instructions.push(this.agent.instruction);
    yield { actions: {}, content: { parts: [{ text: 'hello back' }] } };
  });
  assert.equal(await new GoogleADKAgent().invokeAgent('hello', null, null, context()), 'hello back');
  await new GoogleADKAgent('custom', 'gemini-2.5-flash', 'custom agent', 'Keep this custom policy.')
    .invokeAgent('hello', null, null, context());
  assert.match(instructions[0], /CRITICAL SECURITY RULES/);
  assert.match(instructions[0], /"Test User"/);
  assert.ok(instructions[1].startsWith('Keep this custom policy.'));
});

test('only final non-thought response text is returned, with every text part preserved', async t => {
  t.mock.method(Runner.prototype, 'runEphemeral', async function* () {
    yield { actions: {}, content: { parts: [{ text: 'intermediate' }, { functionCall: { name: 'lookup' } }] } };
    yield { actions: {}, partial: true, content: { parts: [{ text: 'partial' }] } };
    yield { actions: {}, content: { parts: [
      { text: 'private reasoning', thought: true },
      { text: 'First result\n' }, { text: 'Second result' },
    ] } };
  });
  assert.equal(await new GoogleADKAgent().invokeAgentWithScope('hello', null, null, context()),
    'First result\nSecond result');
  for (const span of spans.filter(span => ['chat', 'output_messages', 'invoke_agent'].includes(span.attributes['gen_ai.operation.name']))) {
    assert.match(span.attributes['gen_ai.output.messages'], /First result/);
    assert.match(span.attributes['gen_ai.output.messages'], /Second result/);
    assert.doesNotMatch(span.attributes['gen_ai.output.messages'], /private reasoning|intermediate|partial/);
  }
});

test('production and App Service reject development bearer tokens before discovery', async t => {
  const discovery = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not discover'); });
  const runner = t.mock.method(Runner.prototype, 'runEphemeral', async function* () {});
  const exchange = t.mock.fn(async () => ({ token: 'agentic-token' }));
  for (const hosted of [false, true]) {
    process.env.NODE_ENV = hosted ? 'development' : 'production';
    if (hosted) process.env.WEBSITE_SITE_NAME = 'test-site';
    process.env.BEARER_TOKEN = 'leftover-dev-token';
    await assert.rejects(new GoogleADKAgent().invokeAgent('hello', { exchangeToken: exchange }, 'agentic', context()),
      /only supported in local development/);
    await assert.rejects(new McpToolRegistrationService().addToolServersToAgent({
      agent: new Agent({ name: 'test' }), agenticAppId: AGENT, context: context(),
      authToken: 'leftover-dev-token', auth: { exchangeToken: exchange }, authHandlerName: 'agentic',
    }), /only supported in local development/);
  }
  assert.equal(discovery.mock.callCount(), 0);
  assert.equal(runner.mock.callCount(), 0);
  assert.equal(exchange.mock.callCount(), 0);
});

test('local bearer discovery resolves configured instance IDs without using them for telemetry', async t => {
  const saved = [process.env.AGENTIC_APP_ID, process.env.A365_AGENT_APP_INSTANCE_ID];
  t.after(() => {
    for (const [i, key] of ['AGENTIC_APP_ID', 'A365_AGENT_APP_INSTANCE_ID'].entries()) {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    }
  });
  process.env.BEARER_TOKEN = 'discovery-token';
  const requested = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requested.push(String(url));
    return Response.json([]);
  });
  t.mock.method(Runner.prototype, 'runEphemeral', async function* () {
    yield { actions: {}, content: { parts: [{ text: 'ok' }] } };
  });
  const agent = new GoogleADKAgent();
  process.env.AGENTIC_APP_ID = AGENT;
  assert.equal(await agent.invokeAgentWithScope('hi', null, null, context('')), 'ok');
  delete process.env.AGENTIC_APP_ID;
  process.env.A365_AGENT_APP_INSTANCE_ID = AGENT;
  assert.equal(await agent.invokeAgentWithScope('hi', null, null, context('')), 'ok');
  process.env.AGENTIC_APP_ID = '<<YOUR_AGENTIC_APP_ID>>';
  await assert.rejects(agent.invokeAgent('hi', null, null, context('')), /Configure AGENTIC_APP_ID/);
  delete process.env.AGENTIC_APP_ID;
  delete process.env.A365_AGENT_APP_INSTANCE_ID;
  await assert.rejects(agent.invokeAgent('hi', null, null, context('')), /Configure AGENTIC_APP_ID/);
  assert.equal(requested.length, 2);
  assert.ok(requested.every(url => url.includes(`/agents/v2/${AGENT}/mcpServers`)));
  assert.equal(spans.length, 0);
});

test('MCP isError results mark tool spans failed and are preserved for the model', async t => {
  process.env.BEARER_TOKEN = 'discovery-token';
  const result = { isError: true, content: [{ type: 'text', text: 'Tool rejected the request' }] };
  t.mock.method(globalThis, 'fetch', async () => Response.json([{ mcpServerName: 'test', url: 'https://tools.example.test/mcp' }]));
  t.mock.method(MCPToolset.prototype, 'getTools', async () => [{
    name: 'lookup', description: 'test', async runAsync() { return result; },
  }]);
  t.mock.method(MCPToolset.prototype, 'close', async () => {});
  t.mock.method(Runner.prototype, 'runEphemeral', async function* () {
    const [tool] = await this.agent.tools[0].getTools();
    assert.equal(await tool.runAsync({ args: {}, toolContext: { functionCallId: 'failed-call' } }), result);
    yield { actions: {}, content: { parts: [{ text: 'The tool could not complete that request.' }] } };
  });
  await new GoogleADKAgent().invokeAgentWithScope('lookup', null, null, context());
  const span = spans.find(span => span.attributes['gen_ai.operation.name'] === 'execute_tool');
  assert.ok(span);
  assert.equal(span.status.code, 2);
  assert.match(span.status.message, /isError=true/);
});

test('slow discovery plus per-resource exchange share a budget longer than ten seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const discoverySignal = [];
  t.mock.method(globalThis, 'fetch', (_url, init) => {
    discoverySignal.push(init.signal);
    return new Promise(resolve => setTimeout(() => resolve(Response.json([
      { mcpServerName: 'mail', url: 'https://tools.example.test/mail', audience: 'api://mail' },
    ])), 9500));
  });
  let exchanges = 0;
  const auth = { async exchangeToken() {
    if (++exchanges > 1) await new Promise(resolve => setTimeout(resolve, 2000));
    return { token: 'agentic-token' };
  } };
  t.mock.method(MCPToolset.prototype, 'close', async () => {});
  t.mock.method(Runner.prototype, 'runEphemeral', async function* () {
    yield { actions: {}, content: { parts: [{ text: 'ok' }] } };
  });
  const turn = new GoogleADKAgent().invokeAgent('hi', auth, 'agentic', context());
  await new Promise(setImmediate);
  t.mock.timers.tick(9500);
  await new Promise(setImmediate);
  t.mock.timers.tick(2000);
  assert.equal(await turn, 'ok');
  assert.equal(exchanges, 2);
  assert.equal(discoverySignal[0].aborted, false);
});

test('deadline closes partial toolsets and ignores late token settlement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const closed = t.mock.method(MCPToolset.prototype, 'close', async () => {});
  let signal;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    signal = init.signal;
    return Response.json([
      { mcpServerName: 'shared', url: 'https://tools.example.test/shared' },
      { mcpServerName: 'mail', url: 'https://tools.example.test/mail', audience: 'api://mail' },
      { mcpServerName: 'calendar', url: 'https://tools.example.test/calendar', audience: 'api://calendar' },
    ]);
  });
  let finishExchange;
  let exchanges = 0;
  const auth = { async exchangeToken() {
    if (++exchanges === 1) return { token: 'discovery-token' };
    return new Promise(resolve => { finishExchange = resolve; });
  } };
  const turn = new GoogleADKAgent().invokeAgent('hi', auth, 'agentic', context());
  const rejected = assert.rejects(turn, /timed out after 60 seconds/);
  await new Promise(setImmediate);
  assert.equal(exchanges, 2);
  t.mock.timers.tick(60_000);
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(closed.mock.callCount(), 1);
  finishExchange({ token: 'late-token' });
  await new Promise(setImmediate);
  assert.equal(exchanges, 2);
  assert.equal(closed.mock.callCount(), 1);
});

test('cancellation aborts discovery and observes late exchange rejection', async t => {
  const service = new McpToolRegistrationService();
  const controller = new AbortController();
  let discoverySignal;
  t.mock.method(globalThis, 'fetch', (_url, init) => {
    discoverySignal = init.signal;
    return new Promise(() => {});
  });
  const discovery = service.addToolServersToAgent({
    agent: new Agent({ name: 'test' }), agenticAppId: AGENT, context: context(),
    authToken: 'local-token', signal: controller.signal,
  });
  const rejected = assert.rejects(discovery, /cancel discovery/);
  controller.abort(new Error('cancel discovery'));
  await rejected;
  assert.equal(discoverySignal, controller.signal);
  assert.equal(discoverySignal.aborted, true);

  const tokenController = new AbortController();
  let rejectToken;
  const token = service.addToolServersToAgent({
    agent: new Agent({ name: 'test' }), agenticAppId: AGENT, context: context(),
    auth: { exchangeToken: () => new Promise((_resolve, reject) => { rejectToken = reject; }) },
    authHandlerName: 'agentic', signal: tokenController.signal,
  });
  const tokenRejected = assert.rejects(token, /cancel token/);
  tokenController.abort(new Error('cancel token'));
  await tokenRejected;
  rejectToken(new Error('late token failure'));
  await new Promise(setImmediate);
});

test('bearer-only V2 mode rejects a different audience instead of reusing the discovery token', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json([
    { mcpServerName: 'mail', url: 'https://tools.example.test/mail', audience: 'api://mail' },
  ]));
  await assert.rejects(new McpToolRegistrationService().addToolServersToAgent({
    agent: new Agent({ name: 'test' }), agenticAppId: AGENT, context: context(),
    authToken: 'discovery-only', authHandlerName: null,
  }), /Configure AUTH_HANDLER_NAME=AGENTIC/);
});

test('semantic spans share runtime identity and correctly parent chat, tool, and output operations', async t => {
  process.env.BEARER_TOKEN = 'local-test-token';
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    mcpServers: [{ mcpServerName: 'test', url: 'https://tools.example.test/mcp' }],
  }));
  const tool = { name: 'lookup', description: 'Test lookup', async runAsync() { return { found: true }; } };
  t.mock.method(MCPToolset.prototype, 'getTools', async () => [tool]);
  t.mock.method(MCPToolset.prototype, 'close', async () => {});
  t.mock.method(Runner.prototype, 'runEphemeral', async function* () {
    const [toolset] = this.agent.tools;
    const [wrapped] = await toolset.getTools();
    await wrapped.runAsync({ args: { query: 'example' }, toolContext: { functionCallId: 'call-1' } });
    yield { actions: {}, content: { parts: [{ text: 'found it' }] } };
  });
  const dispose = t.mock.method(otel.BaggageScope.prototype, 'dispose');
  const result = await new GoogleADKAgent().invokeAgentWithScope('find example', null, null, context());
  assert.equal(result, 'found it');
  assert.equal(dispose.mock.callCount(), 1);
  const byOperation = Object.fromEntries(spans.map(span => [span.attributes['gen_ai.operation.name'], span]));
  for (const operation of ['invoke_agent', 'chat', 'execute_tool', 'output_messages']) {
    assert.ok(byOperation[operation], `missing ${operation}`);
    const attrs = byOperation[operation].attributes;
    assert.equal(attrs['gen_ai.agent.id'], AGENT);
    assert.equal(attrs['microsoft.tenant.id'], TENANT);
    assert.equal(attrs['gen_ai.conversation.id'], 'conversation-1');
    assert.equal(attrs['microsoft.channel.name'], 'msteams');
    assert.equal(attrs['user.id'], HUMAN);
    assert.equal(attrs[otel.OpenTelemetryConstants.GEN_AI_AGENT_AUID_KEY], AGENT_USER);
    assert.equal(byOperation[operation].spanContext().traceId, byOperation.invoke_agent.spanContext().traceId);
  }
  assert.equal(byOperation.chat.parentSpanContext.spanId, byOperation.invoke_agent.spanContext().spanId);
  assert.equal(byOperation.execute_tool.parentSpanContext.spanId, byOperation.chat.spanContext().spanId);
  assert.equal(byOperation.output_messages.parentSpanContext.spanId, byOperation.invoke_agent.spanContext().spanId);
  assert.equal(byOperation.execute_tool.attributes['gen_ai.tool.call.id'], 'call-1');
  assert.match(byOperation.execute_tool.attributes['gen_ai.tool.call.arguments'], /example/);
  assert.match(byOperation.execute_tool.attributes['gen_ai.tool.call.result'], /true/);
  assert.match(byOperation.invoke_agent.attributes['gen_ai.output.messages'], /found it/);
});

test('failed invocation ends error spans and always disposes baggage', async t => {
  t.mock.method(Runner.prototype, 'runEphemeral', async function* () { throw new Error('test failure'); });
  const dispose = t.mock.method(otel.BaggageScope.prototype, 'dispose');
  await assert.rejects(new GoogleADKAgent().invokeAgentWithScope('hello', null, null, context()), /test failure/);
  assert.equal(dispose.mock.callCount(), 1);
  const failed = spans.filter(span => ['invoke_agent', 'chat'].includes(span.attributes['gen_ai.operation.name']));
  assert.equal(failed.length, 2);
  for (const span of failed) {
    assert.equal(span.status.code, 2);
  }
});

test('production tool spans retain metadata without business payloads', async t => {
  process.env.NODE_ENV = 'production';
  t.mock.method(globalThis, 'fetch', async () => Response.json([
    { mcpServerName: 'test', url: 'https://tools.example.test/mcp' },
  ]));
  t.mock.method(MCPToolset.prototype, 'getTools', async () => [{
    name: 'lookup', description: 'Lookup',
    async runAsync() { return { text: 'private-tool-result' }; },
  }]);
  t.mock.method(MCPToolset.prototype, 'close', async () => {});
  t.mock.method(Runner.prototype, 'runEphemeral', async function* () {
    const [toolset] = this.agent.tools;
    const [tool] = await toolset.getTools();
    await tool.runAsync({ args: { text: 'private-tool-argument' }, toolContext: { functionCallId: 'call-1' } });
    yield { actions: {}, content: { parts: [{ text: 'done' }] } };
  });
  await new GoogleADKAgent().invokeAgentWithScope('lookup', {
    async exchangeToken() { return { token: 'agentic-token' }; },
  }, 'agentic', context());
  const toolSpan = spans.find(span => span.attributes['gen_ai.operation.name'] === 'execute_tool');
  assert.ok(toolSpan);
  assert.equal(toolSpan.attributes['gen_ai.tool.name'], 'lookup');
  const attributes = JSON.stringify(spans.map(span => span.attributes));
  assert.ok(!attributes.includes('private-tool-argument'));
  assert.ok(!attributes.includes('private-tool-result'));
});

test('missing or blueprint identity preserves local responses without semantic spans', async t => {
  t.mock.method(GoogleADKAgent.prototype, 'invokeAgent', async () => 'local response');
  const agent = new GoogleADKAgent();
  for (const id of ['', BLUEPRINT]) {
    assert.equal(await agent.invokeAgentWithScope('hello', null, null, context(id)), 'local response');
  }
  assert.equal(spans.length, 0);
});

test('MCP initialization clears its timeout on both success and failure', async t => {
  process.env.BEARER_TOKEN = 'local-test-token';
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const timer = realSetTimeout(callback, delay, ...args);
    if (delay === 60_000) timers.push(timer);
    return timer;
  });
  const clear = t.mock.method(globalThis, 'clearTimeout');
  let fail = false;
  t.mock.method(McpToolRegistrationService.prototype, 'addToolServersToAgent', async ({ agent }) => {
    if (fail) throw new Error('test initialization failure');
    return agent;
  });
  t.mock.method(Runner.prototype, 'runEphemeral', async function* () {
    yield { actions: {}, content: { parts: [{ text: 'ok' }] } };
  });
  for (const shouldFail of [false, true]) {
    fail = shouldFail;
    if (fail) {
      await assert.rejects(new GoogleADKAgent().invokeAgent('hello', null, null, context()), /test initialization failure/);
    } else {
      assert.equal(await new GoogleADKAgent().invokeAgent('hello', null, null, context()), 'ok');
    }
  }
  assert.equal(timers.length, 2);
  for (const timer of timers) {
    assert.ok(clear.mock.calls.some(call => call.arguments[0] === timer));
  }
});

test('ADK error events and empty responses fail the turn and mark spans as errors', async t => {
  let errorEvent = true;
  t.mock.method(Runner.prototype, 'runEphemeral', async function* () {
    if (errorEvent) yield { errorCode: '403', errorMessage: 'Gemini API is disabled.' };
  });
  const agent = new GoogleADKAgent();
  await assert.rejects(agent.invokeAgentWithScope('hello', null, null, context()), /model request failed \(403\)/);
  assert.ok(spans.some(span => span.attributes['gen_ai.operation.name'] === 'chat' && span.status.code === 2));
  assert.ok(!spans.some(span => span.attributes['gen_ai.operation.name'] === 'output_messages'));
  errorEvent = false;
  await assert.rejects(agent.invokeAgent('hello', null, null, context()), /without a text response/);
});

test('agentic handler uses the case-sensitive configured blueprint connection', async t => {
  const { MyAgent } = require('../dist/hosting');
  const { TurnContext } = require('@microsoft/agents-hosting');
  const { Activity } = require('@microsoft/agents-activity');
  const priorHandler = process.env.AUTH_HANDLER_NAME;
  const priorConnection = process.env.agentic_altBlueprintConnectionName;
  process.env.AUTH_HANDLER_NAME = 'AGENTIC';
  process.env.agentic_altBlueprintConnectionName = 'SERVICE_CONNECTION';
  t.after(() => {
    if (priorHandler === undefined) delete process.env.AUTH_HANDLER_NAME;
    else process.env.AUTH_HANDLER_NAME = priorHandler;
    if (priorConnection === undefined) delete process.env.agentic_altBlueprintConnectionName;
    else process.env.agentic_altBlueprintConnectionName = priorConnection;
  });
  const app = new MyAgent({});
  const calls = [];
  t.mock.method(app.cloudAdapter.connectionManager, 'getConnection', name => {
    calls.push(name);
    assert.equal(name, 'SERVICE_CONNECTION');
    return {
      async getAgenticUserToken(tenant, agent, user, scopes) {
        assert.equal(tenant, TENANT);
        assert.equal(agent, AGENT);
        assert.equal(user, 'agent@example.test');
        assert.deepEqual(scopes, ['https://graph.microsoft.com/.default']);
        return 'test-workload-token';
      },
    };
  });
  const activity = Activity.fromObject(context().activity);
  activity.recipient.role = 'agenticUser';
  const result = await app.authorization.exchangeToken(
    new TurnContext(app.cloudAdapter, activity), 'agentic', { scopes: ['https://graph.microsoft.com/.default'] }
  );
  assert.equal(result.token, 'test-workload-token');
  assert.deepEqual(calls, ['SERVICE_CONNECTION']);
});

test('V2 tool servers use per-audience tokens and empty exchanges fail before discovery', async t => {
  const scopes = [];
  const auth = {
    async exchangeToken(_context, handler, options) {
      assert.equal(handler, 'agentic');
      scopes.push(options.scopes[0]);
      return { token: `token-${scopes.length}` };
    },
  };
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer token-1');
    return Response.json([
      { mcpServerName: 'mail', url: 'https://tools.example.test/mail', audience: 'api://mail', scope: 'Tools.ListInvoke.All' },
      { mcpServerName: 'calendar', url: 'https://tools.example.test/calendar', audience: 'api://calendar' },
    ]);
  });
  const service = new McpToolRegistrationService();
  const agent = await service.addToolServersToAgent({
    agent: new Agent({ name: 'test' }), agenticAppId: AGENT, context: context(),
    auth, authHandlerName: 'agentic',
  });
  assert.equal(agent.tools.length, 2);
  assert.deepEqual(scopes.slice(1), ['api://mail/Tools.ListInvoke.All', 'api://calendar/.default']);
  const discovery = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not discover without a token'); });
  await assert.rejects(service.addToolServersToAgent({
    agent: new Agent({ name: 'test' }), agenticAppId: AGENT, context: context(),
    auth: { async exchangeToken() { return {}; } }, authHandlerName: 'agentic',
  }), /MCP authorization failed/);
  assert.equal(discovery.mock.callCount(), 0);
});

test('MCP discovery accepts both gateway shapes and rejects malformed or failed responses without logging bodies', async t => {
  const service = new McpToolRegistrationService();
  const options = { agent: new Agent({ name: 'test' }), agenticAppId: AGENT, context: context(), authToken: 'test' };
  for (const payload of [[], { mcpServers: [] }]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json(payload));
    assert.equal((await service.addToolServersToAgent(options)).tools.length, 0);
    t.mock.restoreAll();
  }
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  t.mock.method(globalThis, 'fetch', async () => new Response('private-upstream-payload', { status: 403 }));
  await assert.rejects(service.addToolServersToAgent(options), /HTTP 403/);
  assert.ok(logged.every(line => !line.includes('private-upstream-payload')));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ unexpected: [] }));
  await assert.rejects(service.addToolServersToAgent(options), /Invalid MCP discovery response/);
  t.mock.method(globalThis, 'fetch', async () => new Response('private-malformed-payload', { status: 200 }));
  await assert.rejects(service.addToolServersToAgent(options), error => {
    assert.equal(error.message, 'Invalid JSON in MCP discovery response.');
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.ok(logged.every(line => !line.includes('private-malformed-payload')));
});

test('app-only resolver reuses hosting FMI assertions, caches by identity, and coalesces concurrent requests', async t => {
  let assertions = 0;
  let requests = 0;
  const token = jwt();
  const resolver = createAppTokenResolver(() => ({
    async getAgenticApplicationToken(tenantId, agentId) {
      assertions++;
      assert.equal(tenantId, TENANT);
      assert.equal(agentId, AGENT);
      return 'fmi-test-assertion';
    },
  }));
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests++;
    const form = new URLSearchParams(init.body);
    assert.equal(form.get('client_assertion'), 'fmi-test-assertion');
    assert.equal(form.get('client_id'), AGENT);
    assert.equal(form.get('grant_type'), 'client_credentials');
    assert.equal(form.get('scope'), `api://${RESOURCE}/.default`);
    return Response.json({ access_token: token });
  });
  assert.deepEqual(await Promise.all([resolver(AGENT, TENANT), resolver(AGENT, TENANT)]), [token, token]);
  assert.equal(await resolver(AGENT, TENANT), token);
  assert.equal(requests, 1);
  assert.equal(assertions, 1);
});

test('resolver rejects delegated, mismatched, expired, and invalid tokens with backoff', async t => {
  for (const token of [
    jwt({ scp: 'OtelWrite' }), jwt({ azp: BLUEPRINT }), jwt({ tid: BLUEPRINT }),
    jwt({ aud: 'wrong-audience' }), jwt({ exp: 1 }), 'not-a-jwt',
  ]) {
    let requests = 0;
    const resolver = createAppTokenResolver(() => ({ async getAgenticApplicationToken() { return 'assertion'; } }));
    t.mock.method(globalThis, 'fetch', async () => {
      requests++;
      return Response.json({ access_token: token });
    });
    assert.equal(await resolver(AGENT, TENANT), '');
    assert.equal(await resolver(AGENT, TENANT), '');
    assert.equal(requests, 1);
    t.mock.restoreAll();
  }
});
