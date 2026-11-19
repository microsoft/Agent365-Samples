// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const startup = require('../src/startup-check.ts');
const config = require('../src/config.ts');

const compiled = ts.transpileModule(
    fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } },
).outputText;

function boot(overrides = {}, schedulerError, hostingAuth = { clientId: 'offline-client' }, agentApplication = {}) {
    const env = {
        NODE_ENV: 'production',
        INTERNAL_TRIGGER_TOKEN: 'test-placeholder',
        JIRA_MODE: 'mock',
        JIRA_BASE_URL: undefined,
        JIRA_EMAIL: undefined,
        JIRA_API_TOKEN: undefined,
        JIRA_PROJECT_KEY: undefined,
        JIRA_BOARD_ID: undefined,
        STANDUP_CUTOFF_HOURS: undefined,
        STANDUP_CRON: undefined,
        NIGHTLY_CRON: undefined,
        TIMEZONE: undefined,
        LOCAL_CRON: 'false',
        WARN_TODO_PCT: undefined,
        WARN_SPRINT_PROGRESS_PCT: undefined,
        ...overrides,
    };
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    const calls = [];
    const errors = [];
    const routes = new Map();
    let exit;
    const stopped = new Error('test exit');
    const server = {
        use() { return this; },
        get() { return this; },
        post(route, handler) { routes.set(route, handler); return this; },
        listen() { calls.push('listen'); return this; },
        on() { return this; },
    };
    const mocks = {
        // Never load a local .env, construct clients, bind sockets, or schedule jobs.
        dotenv: { configDotenv() {} },
        './util/logger': { installConsoleLogging() {} },
        './util/httpLogger': { installHttpLogging() {} },
        './startup-check': { ...startup, printStartupBanner() {} },
        '@microsoft/agents-hosting': { loadAuthConfigFromEnv: () => hostingAuth, authorizeJWT: () => () => {} },
        express: Object.assign(() => server, { json: () => () => {} }),
        './agent': { agentApplication },
        './handlers/standup': {},
        './handlers/warn': {},
        './handlers/report': {},
        './handlers/sprint-summary': {},
        './config': config,
        './cron/local-scheduler': {
            startLocalScheduler() {
                calls.push('scheduler');
                if (schedulerError) throw schedulerError;
            },
        },
    };
    try {
        for (const [key, value] of Object.entries(env)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        vm.runInNewContext(compiled, {
            exports: {},
            require(name) {
                assert.ok(name in mocks, `Unexpected startup dependency: ${name}`);
                if (name === './agent') calls.push('agent');
                return mocks[name];
            },
            process: {
                env: process.env,
                on() {},
                exit(code) { exit = code; throw stopped; },
            },
            console: { log() {}, warn() {}, error(...args) { errors.push(args.join(' ')); } },
        });
    } catch (error) {
        if (error !== stopped) throw error;
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
    return { exit, calls, errors, routes };
}

test('hosting client ID is mandatory in every non-development environment before loading the agent', () => {
    for (const NODE_ENV of ['production', 'staging', 'test', undefined]) {
        for (const clientId of [undefined, '', '   ']) {
            const result = boot({ NODE_ENV }, undefined, { clientId });
            assert.equal(result.exit, 1);
            assert.deepEqual(result.calls, []);
            assert.match(result.errors.join('\n'), /Hosting clientId is required/);
        }
    }
    assert.equal(boot({ NODE_ENV: 'development' }, undefined, {}).exit, undefined);
});

test('messages route lets Express complete real adapter activity-validation failures', async () => {
    const express = require('express');
    const { CloudAdapter } = require('@microsoft/agents-hosting');
    const adapter = new CloudAdapter({});
    const result = boot({ NODE_ENV: 'development' }, undefined, {}, {
        adapter, run: async () => assert.fail('Malformed activities cannot reach the agent'),
    });
    const app = express();
    app.use(express.json());
    app.post('/api/messages', result.routes.get('/api/messages'));
    app.use((error, _req, res, _next) => {
        assert.match(error.message, /text|string/i);
        res.status(400).json({ error: 'Invalid activity' });
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/messages`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'message', text: 42 }),
            signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: 'Invalid activity' });
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

const live = {
    JIRA_MODE: 'live',
    JIRA_BASE_URL: 'https://example.atlassian.net',
    JIRA_EMAIL: 'test@example.com',
    JIRA_API_TOKEN: 'test-placeholder',
    JIRA_PROJECT_KEY: 'TEST',
    JIRA_BOARD_ID: '42',
};

test('actual bootstrap rejects invalid cutoff before clients, scheduler or listen in every environment', () => {
    for (const NODE_ENV of ['development', 'production', 'test', undefined]) {
        for (const LOCAL_CRON of ['true', 'false']) {
            for (const STANDUP_CUTOFF_HOURS of ['invalid', '0', '-1', 'Infinity', '1e-20', '1e308']) {
                const result = boot({ NODE_ENV, LOCAL_CRON, STANDUP_CUTOFF_HOURS });
                assert.equal(result.exit, 1);
                assert.deepEqual(result.calls, []);
                assert.match(result.errors.join('\n'), /STANDUP_CUTOFF_HOURS/);
            }
        }
    }
});

test('actual bootstrap rejects missing live settings and invalid boards before listen', () => {
    for (const NODE_ENV of ['development', 'production']) {
        for (const name of Object.keys(live).filter(name => name !== 'JIRA_MODE')) {
            const result = boot({ ...live, NODE_ENV, [name]: undefined });
            assert.equal(result.exit, 1);
            assert.deepEqual(result.calls, []);
            assert.match(result.errors.join('\n'), new RegExp(name));
        }
        for (const JIRA_BOARD_ID of ['', 'NaN', '0', '-1', '1.5', '9007199254740992']) {
            const result = boot({ ...live, NODE_ENV, JIRA_BOARD_ID });
            assert.equal(result.exit, 1);
            assert.deepEqual(result.calls, []);
            assert.match(result.errors.join('\n'), /JIRA_BOARD_ID/);
        }
    }
});

test('actual bootstrap validates explicit schedule and warning settings even with local cron disabled', () => {
    for (const [name, value] of [
        ['STANDUP_CRON', 'invalid'], ['NIGHTLY_CRON', 'invalid'],
        ['TIMEZONE', 'invalid/timezone'], ['WARN_TODO_PCT', '2'], ['WARN_SPRINT_PROGRESS_PCT', '-1'],
    ]) {
        const result = boot({ [name]: value });
        assert.equal(result.exit, 1);
        assert.deepEqual(result.calls, []);
        assert.match(result.errors.join('\n'), new RegExp(name));
    }
});

test('actual bootstrap accepts offline mock defaults and configured live Jira without network access', () => {
    for (const NODE_ENV of ['development', 'production']) {
        for (const LOCAL_CRON of ['true', 'false']) {
            for (const settings of [{}, { JIRA_BOARD_ID: 'invalid' }, live]) {
                const result = boot({ NODE_ENV, LOCAL_CRON, ...settings });
                assert.equal(result.exit, undefined);
                assert.deepEqual(result.errors, []);
                assert.deepEqual(result.calls, ['agent', 'scheduler', 'listen']);
            }
        }
    }
});

test('actual bootstrap explicitly exits on scheduler startup failure before listen', () => {
    for (const NODE_ENV of ['development', 'production']) {
        const result = boot({ NODE_ENV }, new Error('test scheduler failure'));
        assert.equal(result.exit, 1);
        assert.deepEqual(result.calls, ['agent', 'scheduler']);
        assert.match(result.errors.join('\n'), /Failed to start local scheduler: test scheduler failure/);
    }
});
