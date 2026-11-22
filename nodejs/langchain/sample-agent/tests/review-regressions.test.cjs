// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const readSource = name => fs.readFileSync(path.join(root, 'src', name), 'utf8');

function loadFunctions(names, globals = {}) {
  const tree = ts.createSourceFile('client.ts', readSource('client.ts'), ts.ScriptTarget.Latest, true);
  const functions = tree.statements.filter(node =>
    ts.isFunctionDeclaration(node) && names.includes(node.name.text));
  assert.equal(functions.length, names.length);
  const code = ts.transpileModule(functions.map(node => node.getText(tree)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = vm.createContext({ URL, process: { env: {} }, console: { log() {} }, ...globals });
  vm.runInContext(code, context);
  return context;
}

function loadModule(name, mocks = {}) {
  const filename = path.join(root, 'src', name);
  const compiled = ts.transpileModule(readSource(name), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const realRequire = loaded.require.bind(loaded);
  loaded.require = id => Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id);
  loaded._compile(compiled, filename);
  return loaded.exports;
}

test('Foundry routing matches only a complete v1 path segment and uses one credential', () => {
  class Model {
    constructor(options) { this.options = options; }
  }
  class AzureModel extends Model {}
  const env = {
    AZURE_OPENAI_API_KEY: 'offline-key',
    AZURE_OPENAI_DEPLOYMENT: 'offline-model',
  };
  const context = loadFunctions(['createChatModel'], {
    process: { env }, ChatOpenAI: Model, AzureChatOpenAI: AzureModel,
  });
  for (const [endpoint, expected] of [
    ['https://foundry.example/openai/v1', 'https://foundry.example/openai/v1'],
    ['https://foundry.example/openai/v1/chat/completions?x=1', 'https://foundry.example/openai/v1'],
    ['https://v1-prod.example/v10/openai/v1/', 'https://v1-prod.example/v10/openai/v1'],
  ]) {
    env.AZURE_OPENAI_ENDPOINT = endpoint;
    const model = context.createChatModel();
    assert.ok(!(model instanceof AzureModel));
    assert.equal(model.options.configuration.baseURL, expected);
    assert.equal(model.options.apiKey, 'offline-key');
    assert.equal(model.options.openAIApiKey, undefined);
    assert.equal(model.options.configuration.apiKey, undefined);
    assert.equal(model.options.configuration.defaultHeaders, undefined);
  }
  for (const endpoint of [
    'https://v1-prod.openai.azure.com',
    'https://azure.example/openai/v10',
    'https://azure.example/openai/v1beta',
    'https://azure.example/path?next=/v1',
  ]) {
    env.AZURE_OPENAI_ENDPOINT = endpoint;
    assert.ok(context.createChatModel() instanceof AzureModel);
  }
  env.AZURE_OPENAI_ENDPOINT = 'not-a-url/v1';
  assert.throws(() => context.createChatModel(), /Invalid URL/);
});

test('tool failure logging never reads or logs successful or failed mailbox content', () => {
  const errors = [];
  const context = loadFunctions(['logToolFailures'], {
    console: { error: (...args) => errors.push(args.join(' ')) },
  });
  for (const content of ['Invoice 401', '403 forbidden', 'unauthorized confidential billing details']) {
    context.logToolFailures([{ type: 'tool', status: 'success', content }]);
  }
  assert.deepEqual(errors, []);
  context.logToolFailures([{
    _getType: () => 'tool',
    status: 'error',
    get content() { throw new Error('Tool response bodies must not be accessed'); },
  }]);
  assert.deepEqual(errors, ['MCP tool call failed (status=error).']);
});

test('Foundry requests send only bearer authentication and no api-version', async () => {
  const { ChatOpenAI, AzureChatOpenAI } = require('@langchain/openai');
  const requests = [];
  class OfflineChatOpenAI extends ChatOpenAI {
    constructor(options) {
      super({
        ...options,
        configuration: {
          ...options.configuration,
          fetch: async (url, init) => {
            requests.push({ url: String(url), headers: new Headers(init.headers) });
            return new Response(JSON.stringify({
              id: 'offline-completion', object: 'chat.completion', created: 0, model: 'offline-model',
              choices: [{ index: 0, message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }],
            }), { headers: { 'Content-Type': 'application/json' } });
          },
        },
      });
    }
  }
  const context = loadFunctions(['createChatModel'], {
    ChatOpenAI: OfflineChatOpenAI,
    AzureChatOpenAI,
    process: { env: {
      AZURE_OPENAI_API_KEY: 'offline-key',
      AZURE_OPENAI_DEPLOYMENT: 'offline-model',
      AZURE_OPENAI_ENDPOINT: 'https://foundry.example/openai/v1/chat/completions',
    } },
  });
  await context.createChatModel().invoke('Offline test');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://foundry.example/openai/v1/chat/completions');
  assert.equal(requests[0].headers.get('authorization'), 'Bearer offline-key');
  assert.equal(requests[0].headers.has('api-key'), false);
  assert.equal(new URL(requests[0].url).searchParams.has('api-version'), false);
});

test('agent details require both identities and never use an object ID as email', () => {
  const keys = [
    'AGENT365_OBS_AGENT_ID', 'AGENT365_OBS_TENANT_ID', 'agent365Observability__tenantId',
  ];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  keys.forEach(key => delete process.env[key]);
  try {
    const { buildAgentDetails } = loadModule('observability.ts');
    const recipient = { agenticAppId: 'runtime-agent', agenticUserId: 'user-object-id' };
    const context = { activity: { recipient } };
    assert.equal(buildAgentDetails(context), null);
    recipient.tenantId = 'runtime-tenant';
    const details = buildAgentDetails(context);
    assert.equal(details.agentId, 'runtime-agent');
    assert.equal(details.agentAUID, 'user-object-id');
    assert.equal(details.agentEmail, '');
    recipient.id = 'agent@example.com';
    assert.equal(buildAgentDetails(context).agentEmail, 'agent@example.com');
    recipient.id = '28:channel-specific-id';
    assert.equal(buildAgentDetails(context).agentEmail, '');
    delete recipient.agenticAppId;
    assert.equal(buildAgentDetails(context), null);
    process.env.AGENT365_OBS_AGENT_ID = 'configured-agent';
    process.env.AGENT365_OBS_TENANT_ID = 'configured-tenant';
    assert.equal(buildAgentDetails({ activity: {} }).tenantId, 'configured-tenant');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('a tool-using turn exports one invoke_agent with chat and tool children', async () => {
  const { trace, context } = require('@opentelemetry/api');
  const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
  const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
  const { BaseChatModel } = require('@langchain/core/language_models/chat_models');
  const { AIMessage } = require('@langchain/core/messages');
  const { createAgent, tool } = require('langchain');
  const { z } = require('zod');
  // Exercise real SDK scopes without loading the unrelated Azure networking distro.
  const sdkRoot = path.dirname(require.resolve('@microsoft/opentelemetry'));
  const telemetry = Object.assign({},
    ...['InvokeAgentScope', 'InferenceScope', 'ExecuteToolScope'].map(name =>
      require(path.join(sdkRoot, 'a365', 'scopes', `${name}.js`))),
    require(path.join(sdkRoot, 'a365', 'middleware', 'BaggageBuilder.js')),
    require(path.join(sdkRoot, 'a365', 'hosting', 'baggageBuilderUtils.js')),
    require(path.join(sdkRoot, 'a365', 'contracts.js')));
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const previousKey = process.env.OPENAI_API_KEY;
  const previousAzureKey = process.env.AZURE_OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'offline-test';
  delete process.env.AZURE_OPENAI_API_KEY;
  try {
    // Load the actual startup configuration, without opening a server or external exporter.
    const startup = ts.createSourceFile('index.ts', readSource('index.ts'), ts.ScriptTarget.Latest, true);
    const initialization = startup.statements.find(node =>
      ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
      && node.expression.expression.getText(startup) === 'useMicrosoftOpenTelemetry');
    const configuration = initialization.expression.arguments[0].getText(startup);
    const options = vm.runInNewContext(`(${configuration})`, {
      enableConsoleExporters: false, createObservabilityTokenResolver: () => () => '',
    });
    assert.equal(options.instrumentationOptions.langchain.enabled, false);

    class OfflineModel extends BaseChatModel {
      _llmType() { return 'offline-review-test'; }
      bindTools() { return this; }
      async _generate(messages) {
        const hasToolResult = messages.some(message => message._getType() === 'tool');
        return {
          generations: [{
            text: hasToolResult ? 'Done' : '',
            message: new AIMessage(hasToolResult ? 'Done' : {
              content: '', tool_calls: [{ name: 'lookup', args: {}, id: 'call-1', type: 'tool_call' }],
            }),
          }],
        };
      }
    }
    let failTool = false;
    let observedToolResult;
    let middleware;
    const helpers = loadModule('observability.ts');
    const client = loadModule('client.ts', {
      '@microsoft/opentelemetry': telemetry,
      '@microsoft/agents-a365-tooling': { McpToolServerConfigurationService: class {} },
      '@langchain/openai': { ChatOpenAI: OfflineModel, AzureChatOpenAI: OfflineModel },
      '@microsoft/agents-a365-tooling-extensions-langchain': {
        McpToolRegistrationService: class {
          async addToolServersToAgent(agent) {
            middleware = agent.options.middleware[0];
            return createAgent({
              ...agent.options,
              tools: [tool(async () => {
                if (failTool) throw new Error('Offline MCP failure');
                return 'offline result';
              }, { name: 'lookup', description: 'Offline lookup', schema: z.object({}) })],
            });
          }
        },
      },
      './observability': helpers,
    });
    const { A365Agent } = loadModule('agent.ts', {
      './client': client,
      './observability': helpers,
      '@microsoft/opentelemetry': telemetry,
      '@microsoft/agents-a365-notifications': {
        NotificationType: { EmailNotification: 'email' },
        createEmailResponseActivity: text => ({ text }),
      },
      '@microsoft/agents-hosting': {
        MemoryStorage: class {},
        AgentApplication: class {
          authorization = {};
          onActivity() {}
          onAgentNotification() {}
        },
      },
    });
    const sent = [];
    const turn = {
      activity: {
        type: 'message', text: 'Look it up', channelId: 'msteams',
        conversation: { id: 'offline-conversation' },
        from: { id: 'caller', aadObjectId: 'caller-object', name: 'Offline caller' },
        recipient: {
          agenticAppId: '11111111-1111-1111-1111-111111111111',
          tenantId: '22222222-2222-2222-2222-222222222222',
        },
      },
      sendActivity: async activity => { sent.push(activity); },
    };
    await new A365Agent().handleAgentMessageActivity(turn, {});
    await provider.forceFlush();
    assert.ok(sent.includes('Done'), 'the model and tool loop must complete');
    const spans = exporter.getFinishedSpans();
    const agents = spans.filter(span => span.attributes['gen_ai.operation.name'] === 'invoke_agent');
    const chats = spans.filter(span => span.attributes['gen_ai.operation.name']?.toLowerCase() === 'chat');
    const tools = spans.filter(span => span.attributes['gen_ai.operation.name'] === 'execute_tool');
    assert.equal(agents.length, 1, 'one invoke_agent span');
    assert.equal(chats.length, 1, 'one chat span');
    assert.equal(tools.length, 1, `one tool span; captured: ${spans.map(span => span.name).join(', ')}`);
    assert.equal(chats[0].parentSpanContext.spanId, agents[0].spanContext().spanId);
    assert.equal(tools[0].parentSpanContext.spanId, chats[0].spanContext().spanId);
    assert.ok(spans.every(span => span.spanContext().traceId === agents[0].spanContext().traceId));

    exporter.reset();
    failTool = true;
    const recovered = await client.getClient({}, 'agentic', turn);
    assert.equal(await recovered.invokeInferenceScope('Try a failing tool'), 'Done');
    await provider.forceFlush();
    const failedTools = exporter.getFinishedSpans().filter(span =>
      span.attributes['gen_ai.operation.name'] === 'execute_tool');
    assert.equal(failedTools.length, 1);
    assert.equal(failedTools[0].status.code, 2, 'failed tool span is marked as an error');

    const request = {
      toolCall: { id: 'failed-call', name: 'lookup', args: {} },
      runtime: { signal: new AbortController().signal },
    };
    const failure = new Error('Recoverable MCP failure');
    // Verify the same recovery path without telemetry identity.
    await client.getClient({}, 'agentic', { activity: {} });
    const savedAgent = process.env.AGENT365_OBS_AGENT_ID;
    delete process.env.AGENT365_OBS_AGENT_ID;
    try {
      observedToolResult = await middleware.wrapToolCall(request, async () => { throw failure; });
      assert.equal(observedToolResult.status, 'error');
      assert.equal(observedToolResult.tool_call_id, 'failed-call');
      assert.ok(observedToolResult.content.includes(failure.message));
      const { GraphInterrupt } = require('@langchain/langgraph');
      const interrupt = new GraphInterrupt([]);
      await assert.rejects(middleware.wrapToolCall(request, async () => { throw interrupt; }),
        error => error === interrupt);
      const abort = new Error('Cancelled');
      abort.name = 'AbortError';
      await assert.rejects(middleware.wrapToolCall(request, async () => { throw abort; }),
        error => error === abort);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(middleware.wrapToolCall({
        ...request, runtime: { signal: controller.signal },
      }, async () => { throw failure; }), error => error === failure);
    } finally {
      if (savedAgent !== undefined) process.env.AGENT365_OBS_AGENT_ID = savedAgent;
    }

    exporter.reset();
    failTool = false;
    const emailTurn = {
      ...turn,
      activity: { ...turn.activity, type: 'event', channelId: 'msteams' },
      sendActivity: async activity => { sent.push(activity); },
    };
    await new A365Agent().handleAgentNotificationActivity(emailTurn, {}, {
      notificationType: 'email',
      emailNotification: { id: 'offline-email', conversationId: 'email-conversation' },
    });
    await provider.forceFlush();
    const emailSpans = exporter.getFinishedSpans();
    assert.equal(emailSpans.filter(span => span.attributes['gen_ai.operation.name'] === 'invoke_agent').length, 1);
    assert.equal(emailSpans.filter(span => span.attributes['gen_ai.operation.name'] === 'execute_tool').length, 2);
    assert.ok(emailSpans.every(span => span.attributes['microsoft.channel.name'] === 'outlook'),
      'invocation, inference and tool spans all use the email override');
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousAzureKey === undefined) delete process.env.AZURE_OPENAI_API_KEY;
    else process.env.AZURE_OPENAI_API_KEY = previousAzureKey;
    await provider.shutdown();
    trace.disable();
    context.disable();
  }
});
