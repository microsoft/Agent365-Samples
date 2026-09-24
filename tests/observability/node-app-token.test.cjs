// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// No network: the real sample helper receives an injected, recording fetch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'nodejs/openai/sample-agent/node_modules/typescript'));
const samples = ['openai', 'claude', 'langchain', 'copilot-studio', 'devin', 'perplexity', 'vercel-sdk'];
const legacySamples = new Set(['openai', 'copilot-studio', 'devin', 'perplexity', 'vercel-sdk']);
const file = sample => path.join(root, `nodejs/${sample}/sample-agent/src/observability-token-service.ts`);
const canonical = fs.readFileSync(file('openai'), 'utf8');
function load(sample) {
  const compiled = ts.transpileModule(fs.readFileSync(file(sample), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
  });
  const implementation = new Module(file(sample), module);
  implementation._compile(compiled.outputText, file(sample));
  return implementation.exports;
}
const config = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  agentId: '22222222-2222-2222-2222-222222222222',
  blueprintClientId: '44444444-4444-4444-4444-444444444444',
  blueprintClientSecret: 'offline-blueprint-credential',
};
const clock = 2_000_000_000_000;
const resource = '9b975845-388f-4429-889e-eab1ef63949c';
function token(overrides = {}) {
  const claims = {
    tid: config.tenantId, appid: config.agentId, aud: resource, idtyp: 'app',
    exp: clock / 1000 + 3600,
    ...overrides,
  };
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.offline-signature`;
}
function fixture(sample, overrides = {}, resultOverrides = {}) {
  const calls = [];
  let current = clock;
  const accessToken = token(overrides);
  const fetch = async (url, options) => {
    calls.push({ url, ...options, form: new URLSearchParams(options.body) });
    const result = calls.length % 2
      ? { token_type: 'Bearer', access_token: 'offline-fmi-parent', expires_in: 300 }
      : { token_type: 'Bearer', access_token: accessToken, expires_in: 3600, ...resultOverrides };
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const { ObservabilityTokenService } = load(sample);
  return {
    service: new ObservabilityTokenService(config, fetch, () => current), calls,
    accessToken, advance: value => { current += value; },
  };
}

test('every standalone helper type-checks with the strictest sample settings', () => {
  const program = ts.createProgram(samples.map(file), {
    target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10, strict: true,
    exactOptionalPropertyTypes: true, noPropertyAccessFromIndexSignature: true,
    noUncheckedIndexedAccess: true, noEmit: true, skipLibCheck: true,
    types: ['node'], typeRoots: [path.join(root, 'nodejs/openai/sample-agent/node_modules/@types')],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
});

test('OpenAI application and A365 extensions resolve the same Agents runtime', () => {
  const appRequire = Module.createRequire(path.join(root, 'nodejs/openai/sample-agent/package.json'));
  const agentsPath = appRequire.resolve('@openai/agents');
  const corePath = Module.createRequire(agentsPath).resolve('@openai/agents-core');
  for (const extension of [
    '@microsoft/agents-a365-observability-extensions-openai',
    '@microsoft/agents-a365-tooling-extensions-openai',
  ]) {
    const extensionRequire = Module.createRequire(appRequire.resolve(extension));
    assert.equal(extensionRequire.resolve('@openai/agents'), agentsPath);
    assert.equal(Module.createRequire(extensionRequire.resolve('@openai/agents')).resolve('@openai/agents-core'), corePath);
  }
});

test('OpenAI instrumentation observes both agent invocation and inference', () => {
  // Fixture loads @opentelemetry/api, sdk-trace-base and context-async-hooks
  // as transitive dependencies of @microsoft/agents-a365-observability. If the
  // observability SDK drops those, the fixture must move to a package with
  // direct dependencies. Timeout is generous to tolerate cold-cache package
  // resolution across seven sample node_modules trees.
  execFileSync(process.execPath, [path.join(__dirname, 'fixtures/openai-tracing-smoke.cjs')], {
    cwd: root, timeout: 120_000, stdio: 'pipe',
  });
});

for (const sample of samples) {
  test(`${sample}: standalone helper copies stay identical`, () => {
    assert.equal(fs.readFileSync(file(sample), 'utf8'), canonical);
  });
  test(`${sample}: exporter is wired to the isolated app-only resolver`, () => {
    const entry = sample === 'langchain' ? 'index' : 'otel';
    const source = fs.readFileSync(path.join(root, `nodejs/${sample}/sample-agent/src/${entry}.ts`), 'utf8');
    assert.ok(source.includes('createObservabilityTokenResolver()'));
    assert.ok(source.includes('useS2SEndpoint'));
    assert.equal(source.includes('AgenticTokenCacheInstance.getObservabilityToken'), false);
    const agentFile = path.join(root, `nodejs/${sample}/sample-agent/src/agent.ts`);
    const agent = fs.readFileSync(agentFile, 'utf8');
    assert.equal(/(?:Refresh|refresh)ObservabilityToken\(/.test(agent), false);
    const clientFile = path.join(root, `nodejs/${sample}/sample-agent/src/client.ts`);
    if (fs.existsSync(clientFile)) {
      assert.equal(fs.readFileSync(clientFile, 'utf8').includes('ObservabilityManager.configure'), false);
    }
  });
  for (const scenario of ['AI Teammate', 'human OBO']) {
    test(`${sample}: ${scenario} OBS uses app-only FMI, not business OBO`, async () => {
      const { service, calls, accessToken } = fixture(sample);
      assert.equal(await service.resolve(config.agentId, config.tenantId), accessToken);
      assert.equal(calls.length, 2);
      for (const call of calls) {
        assert.equal(call.url, `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`);
        assert.equal(call.method, 'POST');
        assert.equal(call.redirect, 'error');
        assert.ok(call.signal instanceof AbortSignal);
        assert.equal(call.form.get('grant_type'), 'client_credentials');
        for (const forbidden of ['assertion', 'user_fic', 'requested_token_use']) {
          assert.equal(call.form.has(forbidden), false);
        }
      }
      assert.equal(calls[0].form.get('client_id'), config.blueprintClientId);
      assert.equal(calls[0].form.get('client_secret'), config.blueprintClientSecret);
      assert.equal(calls[0].form.get('fmi_path'), config.agentId);
      assert.equal(calls[0].form.get('scope'), 'api://AzureADTokenExchange/.default');
      assert.equal(calls[1].form.get('client_id'), config.agentId);
      assert.equal(calls[1].form.get('client_assertion'), 'offline-fmi-parent');
      assert.equal(calls[1].form.get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      assert.equal(calls[1].form.get('scope'), `api://${resource}/.default`);
      assert.equal(calls[1].form.has('client_secret'), false);
      assert.equal(calls[1].form.has('fmi_path'), false);
    });
  }
  for (const roles of [undefined, []]) {
    test(`${sample}: accepts explicit app identity with ${roles ? 'empty' : 'absent'} roles`, async () => {
      const { service, accessToken, calls } = fixture(sample, { roles });
      assert.equal(await service.resolve(config.agentId, config.tenantId), accessToken);
      assert.equal(calls.length, 2);
    });
  }
  for (const roles of [undefined, []]) {
    test(`${sample}: accepts oid==sub roleless token without idtyp (${roles ? 'empty' : 'absent'} roles)`, async () => {
      const { service, accessToken } = fixture(sample, {
        roles, idtyp: undefined, oid: config.agentId, sub: config.agentId,
      });
      assert.equal(await service.resolve(config.agentId, config.tenantId), accessToken);
    });
  }
  for (const idtyp of ['app', undefined]) {
    test(`${sample}: accepts application roles with ${idtyp ?? 'legacy absent'} idtyp`, async () => {
      const { service, accessToken } = fixture(sample, {
        idtyp, roles: ['Agent365.Observability.OtelWrite'],
      });
      assert.equal(await service.resolve(config.agentId, config.tenantId), accessToken);
    });
  }
  test(`${sample}: concurrent requests deduplicate; refresh uses actual expiry`, async () => {
    const { service, calls, advance } = fixture(sample);
    const tokens = await Promise.all(Array.from({ length: 8 }, () => service.resolve(config.agentId, config.tenantId)));
    assert.equal(new Set(tokens).size, 1);
    assert.equal(calls.length, 2);
    advance(120_000);
    await service.resolve(config.agentId, config.tenantId);
    assert.equal(calls.length, 2);
    advance(3_421_000);
    await assert.rejects(service.resolve(config.agentId, config.tenantId), /expired|expiry/);
    assert.equal(calls.length, 4);
    await assert.rejects(service.resolve(config.agentId, config.tenantId), /expired|expiry/);
    assert.equal(calls.length, 6, 'failed refresh must not return cached/stale data');
  });
  for (const claims of [
    { scp: 'Agent365.Observability.OtelWrite' }, { scp: '' },
    { roles: undefined, idtyp: undefined }, { roles: [], idtyp: undefined },
    { roles: [''] }, { roles: [' \t'] }, { roles: ['valid-role', ''] },
    { roles: [1] }, { roles: null }, { roles: 'Agent365.Observability.OtelWrite' },
    { idtyp: 'user' }, { idtyp: null },
    { idtyp: 'user', roles: ['Agent365.Observability.OtelWrite'] },
    // oid==sub fallback must not accept delegated tokens even with matching identity.
    { roles: undefined, idtyp: undefined, oid: config.agentId, sub: 'delegated-user-oid' },
    { roles: undefined, idtyp: undefined, oid: config.agentId, sub: '' },
    { roles: undefined, idtyp: undefined, oid: '', sub: '' },
    { roles: undefined, idtyp: undefined, oid: config.agentId, sub: config.agentId, scp: 'User.Read' },
    { roles: undefined, idtyp: 'user', oid: config.agentId, sub: config.agentId },
    { tid: config.agentId }, { appid: config.blueprintClientId },
    { azp: config.blueprintClientId }, { aud: 'https://graph.microsoft.com' },
    { exp: clock / 1000 }, { exp: true },
  ]) {
    test(`${sample}: rejects invalid app-token claims ${JSON.stringify(claims)}`, async () => {
      const { service } = fixture(sample, claims);
      await assert.rejects(service.resolve(config.agentId, config.tenantId));
    });
  }
  for (const malformed of [
    { access_token: '' }, { access_token: 'not-a-jwt' }, { token_type: 'MAC' },
    { error: 'invalid_grant' }, { expires_in: -1 }, { expires_in: 'invalid' },
    { expires_in: true },
  ]) {
    test(`${sample}: fails closed on malformed token response ${JSON.stringify(malformed)}`, async () => {
      const { service } = fixture(sample, {}, malformed);
      await assert.rejects(service.resolve(config.agentId, config.tenantId));
    });
  }
  for (const status of [400, 401, 403, 429, 500]) {
    test(`${sample}: sanitized HTTP ${status}; no fallback or secret in error`, async () => {
      let calls = 0;
      const { ObservabilityTokenService } = load(sample);
      const provider = new ObservabilityTokenService(config, async () => {
        calls++;
        return new Response(config.blueprintClientSecret, { status });
      }, () => clock);
      await assert.rejects(provider.resolve(config.agentId, config.tenantId), error => {
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.equal(error.message.includes(config.blueprintClientSecret), false);
        return true;
      });
      assert.equal(calls, 1);
    });
  }
  test(`${sample}: identity mismatch does not acquire a token`, async () => {
    const { service, calls } = fixture(sample);
    await assert.rejects(service.resolve(config.blueprintClientId, config.tenantId));
    await assert.rejects(service.resolve(config.agentId, config.agentId));
    assert.equal(calls.length, 0);
  });
  for (const setting of ['tenantId', 'agentId', 'blueprintClientId', 'blueprintClientSecret']) {
    test(`${sample}: missing ${setting} is not silently replaced`, () => {
      const { ObservabilityTokenService } = load(sample);
      assert.throws(() => new ObservabilityTokenService({ ...config, [setting]: '' }));
    });
  }
  test(`${sample}: blueprint is never accepted as an agent instance`, () => {
    const { ObservabilityTokenService } = load(sample);
    assert.throws(() => new ObservabilityTokenService({ ...config, agentId: config.blueprintClientId }));
  });
  test(`${sample}: disabled OBS never returns a success-shaped token`, async () => {
    const { createObservabilityTokenResolver } = load(sample);
    const disabled = createObservabilityTokenResolver({});
    await assert.rejects(disabled(config.agentId, config.tenantId), /disabled/);
    assert.throws(() => createObservabilityTokenResolver({ ENABLE_A365_OBSERVABILITY_EXPORTER: 'true' }));
  });
}

const businessAuthContracts = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures/business-auth-contracts.json'), 'utf8',
));
const businessAuthMethods = new Set(['addToolServersToAgent', 'exchangeToken']);
const authPrinter = ts.createPrinter({ removeComments: true });
function isBusinessAuthCall(node) {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && businessAuthMethods.has(node.expression.name.text);
}
function normalizedExpression(node, tree) {
  const result = ts.transform(node, [context => {
    function visit(value) {
      if (ts.isStringLiteral(value)) return ts.factory.createStringLiteral(value.text);
      if (ts.isParenthesizedExpression(value)) return ts.visitNode(value.expression, visit);
      const visited = ts.visitEachChild(value, visit, context);
      if (ts.isObjectLiteralExpression(visited)) {
        return ts.factory.createObjectLiteralExpression(visited.properties, false);
      }
      if (ts.isArrayLiteralExpression(visited)) {
        return ts.factory.createArrayLiteralExpression(visited.elements, false);
      }
      return visited;
    }
    return value => ts.visitNode(value, visit);
  }]);
  try {
    return authPrinter.printNode(ts.EmitHint.Expression, result.transformed[0], tree);
  } finally {
    result.dispose();
  }
}
function businessAuthCalls(text) {
  const tree = ts.createSourceFile('business-auth.ts', text, ts.ScriptTarget.Latest, true);
  assert.equal(tree.parseDiagnostics.length, 0, 'business auth source must parse');
  const found = [];
  function visit(node) {
    if (isBusinessAuthCall(node)) {
      found.push({
        target: normalizedExpression(node.expression, tree),
        arguments: node.arguments.map(arg => normalizedExpression(arg, tree)),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}
function mutateBusinessAuthCall(text, argumentIndex, replacement) {
  const tree = ts.createSourceFile('mutation.ts', text, ts.ScriptTarget.Latest, true);
  const expression = replacement === undefined ? undefined : ts.createSourceFile(
    'replacement.ts', `const value = ${replacement};`, ts.ScriptTarget.Latest, true,
  ).statements[0].declarationList.declarations[0].initializer;
  function synthesize(node) {
    ts.setTextRange(node, { pos: -1, end: -1 });
    ts.forEachChild(node, synthesize);
  }
  if (expression) synthesize(expression);
  let mutations = 0;
  const result = ts.transform(tree, [context => {
    function visit(node) {
      if (isBusinessAuthCall(node)) {
        mutations++;
        if (argumentIndex === undefined) return ts.factory.createVoidZero();
        const args = [...node.arguments];
        assert.ok(argumentIndex < args.length);
        args[argumentIndex] = expression;
        return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, args);
      }
      return ts.visitEachChild(node, visit, context);
    }
    return value => ts.visitNode(value, visit);
  }]);
  try {
    assert.equal(mutations, 1, 'each mutation must change the guarded business call');
    const changed = authPrinter.printFile(result.transformed[0]);
    assert.notDeepEqual(businessAuthCalls(changed), businessAuthCalls(text));
    return changed;
  } finally {
    result.dispose();
  }
}

for (const sample of ['openai', 'claude', 'langchain', 'copilot-studio']) {
  const source = fs.readFileSync(path.join(root, `nodejs/${sample}/sample-agent/src/client.ts`), 'utf8');
  // Reviewed fixtures are independent of HEAD, including in a clean CI checkout.
  const expected = businessAuthCalls(businessAuthContracts[sample]);
  assert.equal(expected.length, 1, `${sample}: fixture must specify the business auth call`);
  const assertContract = text => assert.deepEqual(businessAuthCalls(text), expected);
  test(`${sample}: business tool/OBO authorization matches its reviewed contract`, () => {
    assertContract(source);
  });
  test(`${sample}: business auth contract ignores formatting and string quote style`, () => {
    const tree = ts.createSourceFile('formatted.ts', source, ts.ScriptTarget.Latest, true);
    assertContract(`\n/* formatting-only change */\n${authPrinter.printFile(tree)}`);
    assertContract(businessAuthContracts[sample].replace(/"/g, "'"));
  });
  const copilotStudio = sample === 'copilot-studio';
  for (const mutation of [
    { name: 'auth handler', index: copilotStudio ? 1 : 2, value: '"observability-only"' },
    { name: 'turn context', index: copilotStudio ? 0 : 3, value: 'alternateTurnContext' },
    copilotStudio
      ? { name: 'workload scopes', index: 2, value: '{ scopes: ["api://9b975845-388f-4429-889e-eab1ef63949c/.default"] }' }
      : { name: 'OBS credential substituted for workload token', index: 4, value: 'process.env.AGENT365_OBS_BLUEPRINT_CLIENT_SECRET || ""' },
    { name: 'removed call' },
  ]) {
    test(`${sample}: business auth contract rejects ${mutation.name}`, () => {
      const changed = mutateBusinessAuthCall(source, mutation.index, mutation.value);
      assert.throws(() => assertContract(changed), assert.AssertionError);
    });
  }
}

for (const sample of legacySamples) {
  test(`${sample}: per-request mode cannot bypass the app-only resolver`, () => {
    const directory = path.join(root, `nodejs/${sample}/sample-agent`);
    const text = fs.readFileSync(path.join(directory, 'src/otel.ts'), 'utf8');
    const runtime = require(path.join(directory, 'node_modules/@microsoft/agents-a365-runtime'));
    let started = false;
    const context = {
      exports: {}, process: { env: { ENABLE_A365_OBSERVABILITY_PER_REQUEST_EXPORT: 'true' } },
      require: name => {
        if (name === 'dotenv') return { configDotenv() {} };
        if (name === '@microsoft/agents-a365-runtime') return runtime;
        if (name === './observability-token-service') return {
          createObservabilityTokenResolver() { started = true; throw new Error('must not acquire'); },
        };
        if (name === '@microsoft/agents-a365-observability') return {
          ObservabilityManager: { configure() { started = true; throw new Error('must not initialize'); } },
        };
        if (name === '@microsoft/agents-a365-observability-extensions-openai') return {};
        throw new Error(`Unexpected import ${name}`);
      },
    };
    const compiled = ts.transpileModule(text, {
      compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
    });
    assert.throws(() => vm.runInNewContext(compiled.outputText, context), /PER_REQUEST_EXPORT/);
    assert.equal(started, false);
  });
}

for (const sample of [...samples, 'autonomous/github-trending']) {
  test(`${sample}: its supported published exporter targets S2S with app-only auth`, async () => {
    const autonomous = sample.startsWith('autonomous/');
    const legacy = legacySamples.has(sample);
    const directory = autonomous ? `nodejs/${sample}` : `nodejs/${sample}/sample-agent`;
    const entry = autonomous || sample === 'langchain' ? 'index' : 'otel';
    const name = path.join(root, directory, `src/${entry}.ts`);
    const text = fs.readFileSync(name, 'utf8');
    const tree = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    let expression;
    function visit(node) {
      if (!autonomous && ts.isCallExpression(node)
        && node.expression.getText(tree) === 'useMicrosoftOpenTelemetry') {
        expression = node.arguments[0].getText(tree);
      }
      if (legacy && ts.isCallExpression(node)
        && node.expression.getText(tree) === 'ObservabilityManager.configure') {
        expression = node.arguments[0].getText(tree);
      }
      if (autonomous && ts.isNewExpression(node)
        && node.expression.getText(tree) === 'Agent365Exporter') {
        expression = node.arguments[0].getText(tree);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    assert.ok(expression, 'must configure an explicit S2S exporter');
    const { service } = fixture('openai');
    const context = {
      module: { exports: {} }, process: { env: { ENABLE_A365_OBSERVABILITY_EXPORTER: 'true' } },
      enableConsoleExporters: false, createObservabilityTokenResolver: () => service.resolve,
      tokenResolver: () => token(),
    };
    const compiled = ts.transpileModule(`module.exports = (${expression});`, {
      compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
    });
    let options;
    let Agent365Exporter;
    let tenantAttribute = 'microsoft.tenant.id';
    if (legacy) {
      const packageRoot = path.join(root, directory, 'node_modules/@microsoft/agents-a365-observability');
      context.Agent365ExporterOptions = require(packageRoot).Agent365ExporterOptions;
      context.ClusterCategory = require(path.join(root, directory, 'node_modules/@microsoft/agents-a365-runtime')).ClusterCategory;
      tenantAttribute = require(path.join(packageRoot, 'dist/cjs/tracing/constants.js')).OpenTelemetryConstants.TENANT_ID_KEY;
      vm.runInNewContext(compiled.outputText, context);
      options = {};
      const builder = {
        withService() { return this; },
        withExporterOptions(value) { Object.assign(options, value); return this; },
        withTokenResolver(value) { options.tokenResolver = value; return this; },
        withClusterCategory(value) { options.clusterCategory = value; return this; },
      };
      context.module.exports(builder);
      Agent365Exporter = require(path.join(packageRoot, 'dist/cjs/tracing/exporter/Agent365Exporter.js')).Agent365Exporter;
    } else {
      vm.runInNewContext(compiled.outputText, context);
      options = autonomous ? context.module.exports : context.module.exports.a365;
      Agent365Exporter = require(path.join(root, directory, 'node_modules/@microsoft/opentelemetry')).Agent365Exporter;
    }
    assert.equal(options.useS2SEndpoint, true);
    if (!autonomous && !legacy) assert.equal(options.enabled, true);
    if (sample === 'langchain') {
      assert.equal(options.durableDelivery.enabled, false, 'old stored route choices must not replay');
    }
    if (entry === 'otel') {
      const index = ts.createSourceFile('index.ts',
        fs.readFileSync(path.join(root, directory, 'src/index.ts'), 'utf8'),
        ts.ScriptTarget.Latest, true);
      const imports = index.statements.filter(ts.isImportDeclaration);
      assert.equal(imports[0].moduleSpecifier.text, './otel');
    }
    const sent = [];
    const previousFetch = global.fetch;
    let exporter;
    try {
      global.fetch = async (url, request) => {
        sent.push({ url, request });
        return new Response('{}', { status: 403 });
      };
      exporter = new Agent365Exporter({ ...options, durableDelivery: { enabled: false } });
      const span = {
        name: 'invoke_agent public-route', kind: 0, startTime: [1, 0], endTime: [2, 0],
        duration: [1, 0], status: { code: 0 }, ended: true, events: [], links: [],
        attributes: {
          'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.id': config.agentId,
          [tenantAttribute]: config.tenantId, 'user.id': 'preserved-caller',
        },
        resource: { attributes: { 'service.name': 'public-otlp-regression' } },
        instrumentationScope: { name: 'offline' },
        spanContext: () => ({ traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1 }),
      };
      const result = await new Promise(resolve => exporter.export([span], resolve));
      assert.notEqual(result.code, 0);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].url,
        `https://agent365.svc.cloud.microsoft/observabilityService/tenants/${config.tenantId}/${legacy ? '' : 'otlp/'}agents/${config.agentId}/traces?api-version=1`);
      assert.equal(new Headers(sent[0].request.headers).get('authorization'), `Bearer ${token()}`);
      assert.ok(JSON.stringify(JSON.parse(sent[0].request.body)).includes('preserved-caller'));
    } finally {
      if (exporter) await exporter.shutdown();
      global.fetch = previousFetch;
    }
  });
}

test('autonomous Node OBS resolver rejects missing tokens instead of returning empty', () => {
  const name = path.join(root, 'nodejs/autonomous/github-trending/src/index.ts');
  const tree = ts.createSourceFile(name, fs.readFileSync(name, 'utf8'), ts.ScriptTarget.Latest, true);
  let resolver;
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'tokenResolver') {
      resolver = node.initializer.getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(resolver);
  let cached;
  const context = { module: { exports: {} }, tokenResolver: () => cached };
  const compiled = ts.transpileModule(`module.exports = (${resolver});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
  });
  vm.runInNewContext(compiled.outputText, context);
  assert.throws(() => context.module.exports('agent', 'tenant'), /unavailable/);
  cached = 'offline-application-token';
  assert.equal(context.module.exports('agent', 'tenant'), cached);
});

for (const expiry of [undefined, null, new Date(NaN), new Date(clock), new Date(clock + 3_600_000)]) {
  test(`autonomous Node only caches a real future MSAL expiry: ${String(expiry)}`, async () => {
    const name = path.join(root, 'nodejs/autonomous/github-trending/src/observability-token-service.ts');
    const compiled = ts.transpileModule(fs.readFileSync(name, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
    });
    const cached = [];
    const context = {
      exports: {}, URLSearchParams, Date: { now: () => clock },
      console: { log() {} },
      fetch: async () => new Response(JSON.stringify({ access_token: 'offline-parent' })),
      require: dependency => {
        if (dependency === '@azure/msal-node') return {
          ConfidentialClientApplication: class {
            async acquireTokenByClientCredential() {
              return { accessToken: token(), expiresOn: expiry };
            }
          },
        };
        if (dependency === '@azure/identity') return {};
        if (dependency === './token-cache') return { cacheToken: (...args) => cached.push(args) };
        throw new Error(`Unexpected dependency ${dependency}`);
      },
    };
    vm.runInNewContext(`${compiled.outputText}\nexports.acquireForTest = acquireAndRegisterToken;`, context);
    const operation = context.exports.acquireForTest({
      ...config, blueprintClientSecret: config.blueprintClientSecret, useManagedIdentity: false,
    });
    if (expiry?.getTime() === clock + 3_600_000) {
      await operation;
      assert.equal(cached.length, 1);
      assert.deepEqual(cached[0].slice(0, 3), [config.agentId, config.tenantId, token()]);
      assert.equal(cached[0][3], 3_600_000);
    } else {
      await assert.rejects(operation, /expiry/);
      assert.equal(cached.length, 0);
    }
  });
}

for (const status of [401, 403]) test(`the acquired app-only token stays on S2S after HTTP ${status}`, async () => {
  const { Agent365Exporter } = require(path.join(root, 'nodejs/langchain/sample-agent/node_modules/@microsoft/opentelemetry'));
  const requests = [];
  const previousFetch = global.fetch;
  try {
    global.fetch = async (url, options) => {
      requests.push({ url, options });
      return new Response('{}', { status });
    };
    const { service } = fixture('openai');
    const exporter = new Agent365Exporter({
      useS2SEndpoint: true, tokenResolver: service.resolve,
      durableDelivery: { enabled: false },
      exporterTimeoutMilliseconds: 2000,
    });
    const span = {
      name: 'invoke_agent offline', kind: 0, startTime: [1, 0], endTime: [2, 0],
      duration: [1, 0], status: { code: 0 }, ended: true, events: [], links: [],
      attributes: {
        'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.id': config.agentId,
        'microsoft.tenant.id': config.tenantId, 'user.id': 'offline-user',
      },
      resource: { attributes: { 'service.name': 'offline-s2s' } },
      instrumentationScope: { name: 'offline' },
      spanContext: () => ({ traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1 }),
    };
    const result = await new Promise(resolve => exporter.export([span], resolve));
    assert.notEqual(result.code, 0);
    assert.ok(requests.length >= 1);
    for (const request of requests) {
      assert.match(request.url, /\/observabilityService\/tenants\/.+\/otlp\/agents\//);
    }
    const headers = new Headers(requests[0].options.headers);
    assert.equal(headers.get('authorization'), `Bearer ${token()}`);
    const payload = JSON.parse(requests[0].options.body);
    const serialized = JSON.stringify(payload);
    assert.ok(serialized.includes(config.agentId));
    assert.ok(serialized.includes(config.tenantId));
    assert.ok(serialized.includes('offline-user'));
    await exporter.shutdown();
  } finally {
    global.fetch = previousFetch;
  }
});
