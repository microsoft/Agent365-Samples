// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const path = require('node:path');

function loadWithMocks(relative, mocks) {
    const filename = path.resolve(__dirname, relative);
    const original = Module._load;
    delete require.cache[filename];
    Module._load = function (request, parent, isMain) {
        if (parent?.filename === filename && Object.hasOwn(mocks, request)) return mocks[request];
        return original.call(this, request, parent, isMain);
    };
    try { return require(filename); }
    finally { Module._load = original; }
}

test('reconciliation rejects unsafe inference and preserves clear single-status updates', () => {
    const { classifyUpdateText, isSafeForwardTransition } = loadWithMocks('../src/handlers/reconcile.ts', {
        '../services/jira': {},
        '../services/team-roster': {},
        '../services/proactive': {},
    });
    for (const text of ['Not done yet, still reviewing', 'not started', 'will be finished',
        'going to deploy', 'finished coding and started review', 'done but not deployed']) {
        assert.equal(classifyUpdateText(text, false), 'unchanged', text);
    }
    assert.equal(classifyUpdateText('Merged', false), 'Done');
    assert.equal(classifyUpdateText('Working on the fix', false), 'In Progress');
    assert.equal(classifyUpdateText('PR up', false), 'In Review');
    assert.equal(classifyUpdateText('done', true), 'unchanged');
    assert.equal(isSafeForwardTransition('In Review', 'Done'), true);
    assert.equal(isSafeForwardTransition('To Do', 'Done'), false);
});

test('approval card carries only the proposal identifier and user choices', () => {
    const { buildTransitionConfirmCard } = require('../src/cards/transition-confirm.card.ts');
    const card = buildTransitionConfirmCard({
        standupId: 's1', sprintName: 'Sprint 1', autoAppliedCount: 0,
        transitions: [{ issueKey: 'SCRUM-1', transitionId: '31', statusTo: 'Done' }],
    });
    assert.deepEqual(card.content.actions[0].data, { action: 'reconcile.apply', standupId: 's1' });
});

test('reconciliation authorizes the SM and consumes a server-side proposal once', async () => {
    const applied = [];
    const members = [{ Role: 'SM', AadObjectId: 'sm-aad', conversationReference: {} }];
    const jira = {
        getTransitions: async () => [{ id: '31', toStatus: 'Done' }],
        transitionIssue: async (...args) => { applied.push(args); },
    };
    const reconcile = loadWithMocks('../src/handlers/reconcile.ts', {
        '../services/jira': { getJiraClient: () => jira },
        '../services/team-roster': { listTeamMembers: async () => members },
        '../services/proactive': {
            sendProactive: async (_ref, callback) => {
                await callback({ sendActivity: async () => {} });
                return { ok: true };
            },
        },
    });
    await reconcile.reconcileAfterStandup({
        standupId: 'approval-test', sprintName: 'Sprint 1',
        responses: new Map([['dev', { userAadId: 'dev', items: [{ issueKey: 'SCRUM-1', update: 'done', hasBlocker: false }] }]]),
        itemsByAssignee: new Map([['dev', [{ key: 'SCRUM-1', status: 'To Do', summary: 'Work', url: 'https://jira.invalid/1' }]]]),
    });
    function context(caller, value) {
        const messages = [];
        return {
            messages, activity: {
                from: { aadObjectId: caller }, value,
                getConversationReference: () => ({}),
            },
            sendActivity: async message => { messages.push(message); },
        };
    }
    const payload = {
        action: 'reconcile.apply', standupId: 'approval-test', 'approve_SCRUM-1': 'true',
        transitions: JSON.stringify([{ issueKey: 'OTHER-9', transitionId: 'malicious' }]),
    };
    const nonSm = context('dev', payload);
    await reconcile.handleReconcileSubmit(nonSm);
    assert.match(nonSm.messages[0], /not its configured Scrum Master/);
    assert.equal(applied.length, 0);
    const unknown = context('sm-aad', { ...payload, 'approve_OTHER-9': 'true' });
    await reconcile.handleReconcileSubmit(unknown);
    assert.match(unknown.messages[0], /unknown issue/);
    const approved = context('sm-aad', payload);
    await Promise.all([reconcile.handleReconcileSubmit(approved), reconcile.handleReconcileSubmit(approved)]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(applied.length, 1);
    assert.equal(applied[0][0], 'SCRUM-1');
    assert.equal(applied[0][1], '31');
    assert.ok(approved.messages.some(message => /unavailable/.test(message)));
});

test('Graph client defaults to the documented public client', () => {
    const previous = process.env.GRAPH_CLIENT_ID;
    delete process.env.GRAPH_CLIENT_ID;
    try {
        assert.equal(require('../src/config.ts').getGraphAuthConfig().clientId,
            '14d82eec-204b-4c2f-b7e8-296a70dab67e');
    } finally {
        if (previous === undefined) delete process.env.GRAPH_CLIENT_ID;
        else process.env.GRAPH_CLIENT_ID = previous;
    }
});

test('proactive token warmup fills the configured custom resolver cache', async () => {
    const previous = process.env.Use_Custom_Resolver;
    process.env.Use_Custom_Resolver = 'true';
    const refreshed = [];
    const { ensureObservabilityToken } = loadWithMocks('../src/observability.ts', {
        '@microsoft/agents-a365-observability-hosting': {
            AgenticTokenCacheInstance: {
                RefreshObservabilityToken: async (...args) => { refreshed.push(args); },
                getObservabilityToken: () => 'test-observability-token',
            },
        },
    });
    try {
        await ensureObservabilityToken({ activity: { recipient: { agenticAppId: 'runtime-agent', tenantId: 'tenant' } } }, {});
        const { tokenResolver } = require('../src/token-cache.ts');
        assert.equal(tokenResolver('runtime-agent', 'tenant'), 'test-observability-token');
        assert.ok(refreshed.some(args => args[0] === 'runtime-agent'));
    } finally {
        if (previous === undefined) delete process.env.Use_Custom_Resolver;
        else process.env.Use_Custom_Resolver = previous;
    }
});

test('HTTP tracing attaches once to a dedicated Jira-style axios instance', () => {
    const previous = process.env.LOG_HTTP;
    process.env.LOG_HTTP = 'true';
    try {
        const axios = require('axios');
        const instance = axios.create();
        const { attachHttpLogging } = require('../src/util/httpLogger.ts');
        attachHttpLogging(instance);
        attachHttpLogging(instance);
        assert.equal(instance.interceptors.request.handlers.filter(Boolean).length, 1);
        assert.equal(instance.interceptors.response.handlers.filter(Boolean).length, 1);
    } finally {
        if (previous === undefined) delete process.env.LOG_HTTP;
        else process.env.LOG_HTTP = previous;
    }
});

test('internal endpoints fail closed outside explicit development mode', async () => {
    const ts = require('typescript');
    const fs = require('node:fs');
    const vm = require('node:vm');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    function boot(nodeEnv, token, failWarn = false) {
        const routes = new Map();
        const calls = [];
        const server = {
            use() { return this; }, get() { return this; },
            post(route, handler) { routes.set(route, handler); return this; },
            listen() { return this; }, on() { return this; },
        };
        const express = Object.assign(() => server, { json: () => () => {} });
        const mocks = {
            dotenv: { configDotenv() {} },
            './util/logger': { installConsoleLogging() {} },
            './util/httpLogger': { installHttpLogging() {} },
            './startup-check': { printStartupBanner() {} },
            '@microsoft/agents-hosting': { loadAuthConfigFromEnv: () => ({}), authorizeJWT: () => () => {} },
            express, './agent': {},
            './handlers/standup': { triggerStandup: async () => ({ sentTo: 1 }) },
            './handlers/warn': { runWarnCheck: async () => {
                calls.push('warn');
                if (failWarn) throw new Error('test warn failure');
                return {};
            } },
            './handlers/report': { runSprintCloseReport: async () => { calls.push('close'); return {}; } },
            './handlers/sprint-summary': { runSprintSummary: async () => { calls.push('summary'); return {}; } },
            './cron/local-scheduler': {}, './config': { getInternalTriggerToken: () => token },
        };
        let exit;
        try {
            vm.runInNewContext(compiled, {
                exports: {}, require: name => {
                    if (!(name in mocks)) throw new Error(`Unexpected dependency ${name}`);
                    return mocks[name];
                },
                process: { env: { NODE_ENV: nodeEnv }, on() {}, exit(code) { exit = code; throw new Error('test-exit'); } },
                console: { log() {}, warn() {}, error() {} },
            });
        } catch (error) {
            if (error.message !== 'test-exit') throw error;
        }
        return { exit, routes, calls };
    }
    for (const mode of [undefined, 'staging', 'production', 'test']) {
        assert.equal(boot(mode, '').exit, 1, String(mode));
    }
    const development = boot('development', '');
    assert.equal(development.exit, undefined);
    async function status(booted, provided) {
        let statusCode;
        const response = { status(code) { statusCode = code; return this; }, json() {} };
        await booted.routes.get('/api/internal/standup-trigger')({ get: () => provided }, response);
        return statusCode;
    }
    assert.equal(await status(development, undefined), 200);
    const staging = boot('staging', 'configured-secret');
    assert.equal(await status(staging, undefined), 401);
    assert.equal(await status(staging, 'wrong'), 401);
    assert.equal(await status(staging, 'configured-secret'), 200);
    for (const failWarn of [false, true]) {
        const nightly = boot('staging', 'configured-secret', failWarn);
        let responseCode, body;
        const response = {
            status(code) { responseCode = code; return this; },
            json(value) { body = value; },
        };
        await nightly.routes.get('/api/internal/nightly-check')({
            get: () => 'configured-secret', query: {},
        }, response);
        assert.deepEqual(nightly.calls, ['warn', 'close', 'summary']);
        assert.equal(responseCode, failWarn ? 500 : 200);
        assert.equal(body.ok, !failWarn);
    }
});

test('LOG_LEVEL filters existing console logging after startup installation', () => {
    const methods = ['error', 'warn', 'log', 'info', 'debug', 'trace'];
    const originals = Object.fromEntries(methods.map(method => [method, console[method]]));
    const previous = process.env.LOG_LEVEL;
    const emitted = [];
    try {
        for (const method of methods) console[method] = (...args) => emitted.push([method, ...args]);
        const { installConsoleLogging } = loadWithMocks('../src/util/logger.ts', {});
        process.env.LOG_LEVEL = 'warn';
        installConsoleLogging();
        console.log('hidden');
        console.debug('hidden');
        console.warn('visible');
        console.error('visible');
        assert.deepEqual(emitted.map(item => item[0]), ['warn', 'error']);
    } finally {
        for (const method of methods) console[method] = originals[method];
        if (previous === undefined) delete process.env.LOG_LEVEL;
        else process.env.LOG_LEVEL = previous;
    }
});

test('T-2 report falls back after failed channel delivery and never reports failed sends as success', async () => {
    let succeeds = true;
    const destinations = [];
    const { runSprintSummary } = loadWithMocks('../src/handlers/sprint-summary.ts', {
        '../services/jira': { getJiraClient: () => ({
            getActiveSprint: async () => ({
                id: 1, name: 'Sprint 1', endDate: new Date(Date.now() + 86400000 * 2).toISOString(),
            }),
            searchSprintIssues: async () => [],
            getSprintSubtasks: async () => [],
        }) },
        '../services/sharepoint': { findByField: async () => [
            { fields: { ConversationRef: JSON.stringify({ target: 'channel' }) } },
        ] },
        '../services/team-roster': { listTeamMembers: async () => [
            { Role: 'SM', conversationReference: { target: 'sm' } },
        ] },
        '../services/proactive': { sendProactive: async reference => {
            destinations.push(reference.target);
            return { ok: reference.target === 'sm' && succeeds, error: 'test send failure' };
        } },
    });
    assert.equal((await runSprintSummary({ force: true })).uploaded, true);
    assert.deepEqual(destinations, ['channel', 'sm']);
    destinations.length = 0;
    succeeds = false;
    assert.equal((await runSprintSummary({ force: true })).uploaded, false);
    assert.deepEqual(destinations, ['channel', 'sm']);
});
