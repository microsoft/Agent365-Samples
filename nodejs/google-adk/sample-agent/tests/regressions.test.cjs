// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { test, after, afterEach } = require('node:test');
const { Agent, Runner, MCPToolset } = require('@google/adk');
const otel = require('@microsoft/opentelemetry');
const { GoogleADKAgent } = require('../dist/agent');
const { McpToolRegistrationService } = require('../dist/mcpToolRegistrationService');
const { createAppTokenResolver } = require('../dist/observability/app-token-resolver');

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

test('personalization retains default security constraints and custom base instructions', async t => {
  const instructions = [];
  t.mock.method(Runner.prototype, 'runEphemeral', async function* () {
    instructions.push(this.agent.instruction);
    yield { content: { parts: [{ text: 'hello back' }] } };
  });
  assert.equal(await new GoogleADKAgent().invokeAgent('hello', null, null, context()), 'hello back');
  await new GoogleADKAgent('custom', 'gemini-2.5-flash', 'custom agent', 'Keep this custom policy.')
    .invokeAgent('hello', null, null, context());
  assert.match(instructions[0], /CRITICAL SECURITY RULES/);
  assert.match(instructions[0], /"Test User"/);
  assert.ok(instructions[1].startsWith('Keep this custom policy.'));
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
    yield { content: { parts: [{ text: 'found it' }] } };
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
  process.env.BEARER_TOKEN = 'local-test-token';
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
    yield { content: { parts: [{ text: 'done' }] } };
  });
  await new GoogleADKAgent().invokeAgentWithScope('lookup', null, null, context());
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
    if (delay === 10_000) timers.push(timer);
    return timer;
  });
  const clear = t.mock.method(globalThis, 'clearTimeout');
  let fail = false;
  t.mock.method(McpToolRegistrationService.prototype, 'addToolServersToAgent', async ({ agent }) => {
    if (fail) throw new Error('test initialization failure');
    return agent;
  });
  t.mock.method(Runner.prototype, 'runEphemeral', async function* () {
    yield { content: { parts: [{ text: 'ok' }] } };
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
