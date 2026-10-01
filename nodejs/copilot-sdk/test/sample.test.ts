// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { context, propagation, trace } from '@opentelemetry/api';
import { ToolSet, type SessionConfig, type SessionEvent } from '@github/copilot-sdk';
import { createTokenResolver, OBSERVABILITY_SCOPE, type AccessToken } from '../src/auth.js';
import { createClient, runCopilot, sessionConfig, type RuntimeClient } from '../src/agent.js';
import { loadConfig, runtimeEnvironment, SDK_VERSION, RUNTIME_VERSION, type LiveIdentity } from '../src/config.js';
import { eventMetadata, runOfflineSmoke } from '../src/smoke.js';
import { createTelemetry, type InvocationTelemetry, type SampleTelemetry } from '../src/telemetry.js';
import { addNumbers, createTools } from '../src/tools.js';

async function withTelemetry(action: (telemetry: SampleTelemetry) => Promise<void>) {
  const telemetry = createTelemetry(loadConfig({}));
  try {
    await action(telemetry);
  } finally {
    await telemetry.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  }
}

function start(toolCallId: string, toolName = 'add_numbers'): SessionEvent {
  return { ...eventMetadata(), type: 'tool.execution_start', data: { toolCallId, toolName } };
}

function complete(toolCallId: string, success = true): SessionEvent {
  return { ...eventMetadata(), type: 'tool.execution_complete', data: { toolCallId, success } };
}

test('released SDK and bundled runtime match the recorded exact pins', async () => {
  const sdk = JSON.parse(await readFile(resolve('node_modules', '@github', 'copilot-sdk', 'package.json'), 'utf8'));
  assert.equal(sdk.version, SDK_VERSION);
  assert.equal(sdk.copilotCliVersion, RUNTIME_VERSION);
  const platforms = [
    'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64',
    'linuxmusl-arm64', 'linuxmusl-x64', 'win32-arm64', 'win32-x64',
  ];
  assert.deepEqual(sdk.optionalDependencies, Object.fromEntries(
    platforms.map(platform => [`@github/copilot-sdk-${platform}`, SDK_VERSION]),
  ));
});

test('start and runtime preflight share optional .env loading and environment precedence', async () => {
  const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'copilot-env-test-'));
  const env = { ...process.env };
  delete env.COPILOT_MODEL;
  try {
    for (const script of [manifest.scripts.start, manifest.scripts['runtime:check']]) {
      const command: string[] = script.split(' && ').at(-1).split(' ');
      assert.deepEqual(command.slice(0, 3), ['node', '--env-file-if-exists=.env', 'dist/src/index.js']);
      const args = [
        ...command.slice(1, 2), '-p',
        'JSON.stringify({model: process.env.COPILOT_MODEL ?? null})',
      ];
      const run = (childEnv = env) => JSON.parse(execFileSync(process.execPath, args, {
        cwd: directory, env: childEnv, encoding: 'utf8',
      }));
      assert.deepEqual(run(), { model: null });
      await writeFile(join(directory, '.env'), 'COPILOT_MODEL=fixture-model\n');
      assert.deepEqual(run(), { model: 'fixture-model' });
      assert.deepEqual(run({ ...env, COPILOT_MODEL: 'process-model' }), { model: 'process-model' });
      await rm(join(directory, '.env'));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('offline smoke creates real scopes without a runtime or credentials', async () => {
  await withTelemetry(runOfflineSmoke);
});

test('configuration is local by default; live configuration is explicit and strict', () => {
  const config = loadConfig({});
  assert.equal(config.exportToA365, false);
  assert.equal(config.agent.tenantId, 'local-only');
  assert.equal(config.identity, undefined);
  assert.throws(() => loadConfig({ ENABLE_A365_OBSERVABILITY_EXPORTER: 'yes' }), /true or false/);
  assert.throws(() => loadConfig({ ENABLE_A365_OBSERVABILITY_EXPORTER: 'true' }), /AGENT365_TENANT_ID/);
  assert.throws(() => loadConfig({
    ENABLE_A365_OBSERVABILITY_EXPORTER: 'true', ENABLE_A365_OBSERVABILITY: 'false',
  }), /requires/);
  assert.throws(() => loadConfig({ COPILOT_TIMEOUT_MS: 'NaN' }), /integer/);
  assert.throws(() => loadConfig({ COPILOT_TIMEOUT_MS: '999999999' }), /integer/);
});

test('live identity uses agent appId, not the blueprint or a placeholder', () => {
  const env = {
    ENABLE_A365_OBSERVABILITY_EXPORTER: 'true',
    AGENT365_TENANT_ID: '11111111-1111-4111-8111-111111111111',
    AGENT365_BLUEPRINT_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
    AGENT365_AGENT_ID: '33333333-3333-4333-8333-333333333333',
    AGENT365_CLIENT_SECRET: 'unit-test-only-not-a-credential',
  };
  const config = loadConfig(env);
  assert.equal(config.agent.agentId, env.AGENT365_AGENT_ID);
  assert.equal(config.agent.agentBlueprintId, env.AGENT365_BLUEPRINT_CLIENT_ID);
  assert.equal(config.agent.tenantId, env.AGENT365_TENANT_ID);
  assert.throws(() => loadConfig({ ...env, AGENT365_AGENT_ID: env.AGENT365_BLUEPRINT_CLIENT_ID }), /not the blueprint/);
  assert.throws(() => loadConfig({ ...env, AGENT365_CLIENT_SECRET: '<<PLACEHOLDER>>' }), /required/);
  assert.throws(() => createTelemetry(config), /explicit token resolver/);
});

test('Copilot child environment excludes blueprint credentials and ambient telemetry settings', () => {
  const env = runtimeEnvironment({
    PATH: 'safe-path', GH_TOKEN: 'fake-github-token', AGENT365_CLIENT_SECRET: 'fake-blueprint-secret',
    AGENT365_TENANT_ID: 'tenant', OTEL_EXPORTER_OTLP_HEADERS: 'secret-headers',
    AZURE_CLIENT_SECRET: 'fake-azure-secret', ENABLE_A365_OBSERVABILITY_EXPORTER: 'true',
  });
  assert.deepEqual(env, { PATH: 'safe-path', GH_TOKEN: 'fake-github-token' });
  assert.throws(() => createClient({ COPILOT_CLI_PATH: 'unknown-runtime' }), /pinned/);
});

test('finite deterministic addition rejects invalid and overflowing input', () => {
  assert.equal(addNumbers({ a: 19, b: 23 }), 42);
  for (const args of [null, {}, { a: '19', b: 23 }, { a: Infinity, b: 1 }, { a: 1e308, b: 1e308 }]) {
    assert.throws(() => addNumbers(args), /finite/);
  }
});

test('out-of-order concurrent completions and duplicate events correlate by toolCallId', async () => {
  await withTelemetry(async telemetry => {
    await telemetry.invoke('correlation', async events => {
      const first = start('a');
      events.onEvent(first);
      events.onEvent(first);
      events.onEvent(start('b'));
      events.onEvent(complete('b'));
      events.onEvent(complete('a'));
      events.onEvent(complete('a'));
    });
    const spans = telemetry.snapshot();
    assert.equal(spans.length, 3);
    const root = spans.find(span => span.attributes['gen_ai.operation.name'] === 'invoke_agent')!;
    const children = spans.filter(span => span.attributes['gen_ai.operation.name'] === 'execute_tool');
    assert.deepEqual(new Set(children.map(span => span.attributes['gen_ai.tool.call.id'])), new Set(['a', 'b']));
    assert.ok(children.every(span => span.parentSpanId === root.spanId && span.traceId === root.traceId));
    assert.ok(spans.every(span => span.attributes['gen_ai.agent.id'] === 'local-copilot-sdk'));
    assert.ok(spans.every(span => span.attributes['microsoft.tenant.id'] === 'local-only'));
    assert.equal(root.attributes['copilot.correlation.gaps'], 0);
  });
});

test('concurrent sessions have separate traces even when tool IDs match', async () => {
  await withTelemetry(async telemetry => {
    await Promise.all(['one', 'two'].map(session => telemetry.invoke(session, async events => {
      events.onEvent(start('same-id'));
      await Promise.resolve();
      events.onEvent(complete('same-id'));
    })));
    const spans = telemetry.snapshot();
    assert.equal(spans.length, 4);
    assert.equal(new Set(spans.map(span => span.traceId)).size, 2);
    for (const session of ['one', 'two']) {
      const own = spans.filter(span => span.attributes['gen_ai.conversation.id'] === session);
      assert.equal(own.length, 2);
      assert.equal(new Set(own.map(span => span.traceId)).size, 1);
    }
  });
});

test('post-hoc usage stays an event and does not synthesize inference spans', async () => {
  await withTelemetry(async telemetry => {
    await telemetry.invoke('usage', async events => {
      events.onEvent({
        ...eventMetadata(), type: 'assistant.usage', ephemeral: true,
        data: { model: 'test-model', inputTokens: 5, outputTokens: 3, duration: 2000 },
      });
    });
    const [root] = telemetry.snapshot();
    assert.equal(telemetry.snapshot().length, 1);
    const usage = root!.events.find(event => event.name === 'assistant.usage')!;
    assert.equal(usage.attributes?.['gen_ai.usage.input_tokens'], 5);
    assert.equal(usage.attributes?.['copilot.reported.duration_ms'], 2000);
    assert.ok(root!.durationMs < 2000);
  });
});

test('tool errors are marked and raw arguments/results/error messages never enter telemetry', async () => {
  await withTelemetry(async telemetry => {
    await telemetry.invoke('failure', async events => {
      events.onEvent({ ...eventMetadata(), type: 'tool.execution_start', data: {
        toolCallId: 'bad', toolName: 'fail_deliberately', arguments: { secret: 'sensitive-input-marker' },
      } });
      const tool = createTools(events).find(tool => tool.name === 'fail_deliberately')!;
      await assert.rejects(async () => tool.handler!({}, {
        sessionId: 'failure', toolCallId: 'bad', toolName: tool.name, arguments: {},
      }), /Intentional/);
      events.onEvent({ ...eventMetadata(), type: 'tool.execution_complete', data: {
        toolCallId: 'bad', success: false,
        error: { message: 'sensitive-error-marker' }, result: { content: 'sensitive-output-marker' },
      } });
    });
    const spans = telemetry.snapshot();
    assert.equal(spans.filter(span => span.status.code === 2).length, 1);
    assert.doesNotMatch(JSON.stringify(spans), /sensitive-(input|error|output)-marker/);
    assert.doesNotMatch(JSON.stringify(spans), /exception.stacktrace/);
    assert.equal(spans.at(-1)!.attributes['copilot.tool.failures'], 1);
  });
});

test('missing completion closes dangling tools, marks errors and fails the invocation', async () => {
  await withTelemetry(async telemetry => {
    let captured: InvocationTelemetry | undefined;
    await assert.rejects(telemetry.invoke('unfinished', async events => {
      captured = events;
      events.onEvent(start('never-finished'));
    }), /correlation/);
    const before = telemetry.snapshot();
    assert.equal(before.length, 2);
    assert.ok(before.every(span => span.status.code === 2));
    captured!.onEvent(complete('never-finished'));
    assert.equal(telemetry.snapshot().length, 2);
  });
});

test('orphan completion is reported instead of inventing a tool start time', async () => {
  await withTelemetry(async telemetry => {
    await assert.rejects(telemetry.invoke('orphan', async events => events.onEvent(complete('missing'))), /correlation/);
    assert.equal(telemetry.snapshot().length, 1);
    assert.equal(telemetry.snapshot()[0]!.attributes['copilot.correlation.gaps'], 1);
  });
});

test('runtime subagent labels cannot replace tenant or agent identity attribution', async () => {
  await withTelemetry(async telemetry => {
    await telemetry.invoke('subagent', async events => {
      events.onEvent({ ...start('child'), agentId: 'runtime-only-label' });
      events.onEvent({ ...complete('child'), agentId: 'runtime-only-label' });
    });
    const tool = telemetry.snapshot()[0]!;
    assert.equal(tool.attributes['copilot.runtime.agent_id'], 'runtime-only-label');
    assert.equal(tool.attributes['gen_ai.agent.id'], 'local-copilot-sdk');
  });
});

test('standalone session is restricted to deterministic tools with no ambient hosting or discovery', async () => {
  await withTelemetry(async telemetry => {
    await telemetry.invoke('configuration', async events => {
      const config = sessionConfig(loadConfig({}), events);
      assert.ok(config.availableTools instanceof ToolSet);
      assert.deepEqual(config.availableTools.toArray(), ['custom:add_numbers', 'custom:fail_deliberately']);
      assert.equal(config.excludedTools, undefined);
      assert.deepEqual(config.tools?.map(tool => tool.name), ['add_numbers', 'fail_deliberately']);
      assert.ok(config.onPermissionRequest);
      assert.deepEqual(await config.onPermissionRequest({
        kind: 'read', intention: 'fixture permission request', path: 'fixture.txt',
      }, { sessionId: events.sessionId }), {
        kind: 'denied-no-approval-rule-and-could-not-request-from-user',
      });
      assert.equal(config.enableConfigDiscovery, false);
      assert.equal(config.enableOnDemandInstructionDiscovery, false);
      assert.equal(config.enableFileHooks, false);
      assert.equal(config.enableSkills, false);
      assert.equal(config.enableHostGitOperations, false);
      assert.equal(config.enableSessionStore, false);
      assert.equal(config.remoteSession, 'off');
      assert.deepEqual(config.mcpServers, {});
      assert.deepEqual(config.customAgents, []);
      assert.deepEqual(config.infiniteSessions, { enabled: false });
      assert.equal(config.tools?.length, 2);
    });
  });
});

type RuntimeScenario =
  | 'success' | 'start' | 'version' | 'create' | 'send' | 'unauthenticated'
  | 'stop' | 'abort' | 'disconnect' | 'no-response' | 'session-error';

function mockClient(scenario: RuntimeScenario) {
  const calls: string[] = [];
  const client: RuntimeClient = {
    async start() { calls.push('start'); if (scenario === 'start') throw new Error('startup failed'); },
    async getStatus() { return { version: scenario === 'version' ? '0.0.0' : RUNTIME_VERSION, protocolVersion: 3 }; },
    async getAuthStatus() { return { isAuthenticated: scenario !== 'unauthenticated' }; },
    async createSession(config: SessionConfig) {
      calls.push('create');
      if (scenario === 'create') throw new Error('creation failed');
      return {
        async sendAndWait() {
          config.onEvent?.(start('pending'));
          if (scenario === 'send' || scenario === 'abort') throw new Error('request timed out');
          config.onEvent?.(complete('pending'));
          if (scenario === 'no-response') return undefined;
          if (scenario === 'session-error') {
            config.onEvent?.({
              ...eventMetadata(), type: 'session.error',
              data: { errorType: 'query', message: 'sensitive-session-error-marker' },
            });
          }
          return {
            ...eventMetadata(), type: 'assistant.message' as const,
            data: { content: '42', messageId: 'fixture-message' },
          };
        },
        async abort() { calls.push('abort'); if (scenario === 'abort') throw new Error('abort failed'); },
        async disconnect() { calls.push('disconnect'); if (scenario === 'disconnect') throw new Error('disconnect failed'); },
      };
    },
    async stop() { calls.push('stop'); return scenario === 'stop' ? [new Error('stop failed')] : []; },
  };
  return { client, calls };
}

test('successful mocked runtime returns the response and closes session and spans', async () => {
  await withTelemetry(async telemetry => {
    const { client, calls } = mockClient('success');
    assert.equal(await runCopilot(loadConfig({}), telemetry, 'test', client), '42');
    assert.deepEqual(calls, ['start', 'create', 'disconnect', 'stop']);
    assert.equal(telemetry.snapshot().length, 2);
    assert.ok(telemetry.snapshot().every(span => span.status.code !== 2));
  });
});

for (const stage of [
  'start', 'version', 'create', 'send', 'unauthenticated', 'stop',
  'abort', 'disconnect', 'no-response', 'session-error',
] as const) {
  test(`failure cleanup after ${stage} always stops runtime and disconnects any created session`, async () => {
    await withTelemetry(async telemetry => {
      const { client, calls } = mockClient(stage);
      await assert.rejects(runCopilot(loadConfig({}), telemetry, 'test', client));
      assert.equal(calls.at(-1), 'stop');
      if (stage === 'version' || stage === 'unauthenticated') {
        assert.deepEqual(calls, ['start', 'stop']);
      }
      if (['send', 'abort', 'no-response', 'session-error'].includes(stage)) {
        assert.deepEqual(calls.slice(-3), ['abort', 'disconnect', 'stop']);
      }
      if (stage === 'stop' || stage === 'disconnect') {
        assert.deepEqual(calls.slice(-2), ['disconnect', 'stop']);
      }
      if (stage === 'send' || stage === 'abort') {
        assert.equal(telemetry.snapshot().length, 2);
        assert.ok(telemetry.snapshot().every(span => span.status.code === 2));
      }
      assert.doesNotMatch(JSON.stringify(telemetry.snapshot()), /sensitive-session-error-marker/);
    });
  });
}

const identity: LiveIdentity = {
  tenantId: 'unit-tenant', agentId: 'unit-agent', blueprintClientId: 'unit-blueprint',
  clientSecret: 'unit-test-not-a-credential',
};

test('resolver caches until expiry skew and coalesces concurrent requests', async () => {
  let now = 1_000_000;
  let acquisitions = 0;
  const resolver = createTokenResolver(identity, async () => {
    acquisitions++;
    await Promise.resolve();
    return { accessToken: `unit-token-${acquisitions}`, expiresOn: new Date(now + 3600_000) };
  }, () => now);
  const result = await Promise.all(Array.from({ length: 5 }, () => resolver(identity.agentId, identity.tenantId)));
  assert.equal(new Set(result).size, 1);
  assert.equal(acquisitions, 1);
  now += 3400_000;
  assert.equal(await resolver(identity.agentId, identity.tenantId), 'unit-token-2');
  assert.equal(acquisitions, 2);
});

test('resolver rejects mismatched identities/scopes and never returns empty tokens', async () => {
  const resolver = createTokenResolver(identity, async () => null);
  await assert.rejects(resolver('other-agent', identity.tenantId), /mismatch/);
  await assert.rejects(resolver(identity.agentId, 'other-tenant'), /mismatch/);
  await assert.rejects(resolver(identity.agentId, identity.tenantId, ['https://graph.microsoft.com/.default']), /scope/);
  await assert.rejects(resolver(identity.agentId, identity.tenantId, [OBSERVABILITY_SCOPE]), /usable token/);
});

test('failed token acquisition is retried, and stale tokens never fall back to success', async () => {
  let calls = 0;
  const resolver = createTokenResolver(identity, async (): Promise<AccessToken> => {
    calls++;
    if (calls === 1) throw new Error('unit auth failure');
    return { accessToken: 'unit-token', expiresOn: new Date(Date.now() + 3600_000) };
  });
  await assert.rejects(resolver(identity.agentId, identity.tenantId), /unit auth failure/);
  assert.equal(await resolver(identity.agentId, identity.tenantId), 'unit-token');
  const expired = createTokenResolver(identity, async () => ({ accessToken: 'expired', expiresOn: new Date(0) }));
  await assert.rejects(expired(identity.agentId, identity.tenantId), /usable token/);
});
