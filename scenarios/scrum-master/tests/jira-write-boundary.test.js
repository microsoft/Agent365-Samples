// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const path = require('node:path');

function loadWithMocks(relative, mocks) {
    const filename = path.resolve(__dirname, relative);
    const cached = require.cache[filename];
    const original = Module._load;
    delete require.cache[filename];
    Module._load = function (request, parent, isMain) {
        if (parent?.filename === filename && Object.hasOwn(mocks, request)) return mocks[request];
        return original.call(this, request, parent, isMain);
    };
    try { return require(filename); }
    finally {
        Module._load = original;
        delete require.cache[filename];
        if (cached) require.cache[filename] = cached;
    }
}

function fixture() {
    const calls = [];
    let resolvedKey = 'TEAM-123';
    let readError;
    const http = {
        get: async url => {
            calls.push(['GET', url]);
            if (readError) throw readError;
            if (url.endsWith('/transitions')) {
                return { data: { transitions: [{ id: '31', name: 'Done', to: { name: 'Done' } }] } };
            }
            return { data: {
                id: '10001', key: resolvedKey,
                fields: { summary: 'Assigned work', status: { name: 'To Do' } },
            } };
        },
        post: async (url, body) => { calls.push(['POST', url, body]); return { data: {} }; },
    };
    const { LiveJiraClient } = loadWithMocks('../src/services/jira.ts', {
        axios: { create: () => http },
        '../config': {},
        '../util/httpLogger': { attachHttpLogging() {} },
    });
    const jira = new LiveJiraClient({
        baseUrl: 'https://jira.example.test', email: 'fixture@example.test',
        apiToken: 'fixture-token', boardId: 7, projectKey: 'TEAM',
    });
    return {
        jira, calls,
        resolveTo: key => { resolvedKey = key; },
        failRead: () => { readError = new Error('Lookup unavailable'); },
        posts: () => calls.filter(([method]) => method === 'POST'),
    };
}

const writes = {
    comment: jira => jira.addComment('TEAM-123', 'Standup update'),
    transition: jira => jira.transitionIssue('TEAM-123', '31', 'Approved update'),
};

for (const [operation, write] of Object.entries(writes)) {
    test(`${operation} rejects an alias moved outside the configured project before any POST`, async () => {
        const f = fixture();
        f.resolveTo('PRIVATE-123');
        await assert.rejects(write(f.jira), /restricted to the configured Jira project/);
        assert.deepEqual(f.calls, [['GET', '/rest/api/3/issue/TEAM-123']]);
    });

    test(`${operation} fails closed when the resolved key is absent or invalid or lookup fails`, async () => {
        for (const key of [undefined, '', 'not-an-issue']) {
            const f = fixture();
            f.resolveTo(key);
            await assert.rejects(write(f.jira), /restricted to the configured Jira project/);
            assert.deepEqual(f.posts(), []);
        }
        const f = fixture();
        f.failRead();
        await assert.rejects(write(f.jira), /Lookup unavailable/);
        assert.deepEqual(f.posts(), []);
    });
}

test('writes reject foreign or malformed requested keys without making a request', async () => {
    const f = fixture();
    for (const key of ['PRIVATE-123', 'TEAM-123/comment', 'TEAM-123?query', '123']) {
        await assert.rejects(f.jira.addComment(key, 'Update'), /restricted/);
        await assert.rejects(f.jira.transitionIssue(key, '31'), /restricted/);
    }
    assert.deepEqual(f.calls, []);
});

test('allowed comments resolve normalized keys and retain multiline ADF payloads', async () => {
    const f = fixture();
    f.resolveTo('TEAM-456');
    await f.jira.addComment(' team-123 ', 'Update\n\nBlocker');
    assert.deepEqual(f.calls.map(([method, url]) => [method, url]), [
        ['GET', '/rest/api/3/issue/TEAM-123'],
        ['POST', '/rest/api/3/issue/TEAM-456/comment'],
    ]);
    assert.deepEqual(f.posts()[0][2], { body: {
        type: 'doc', version: 1, content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Update' }] },
            { type: 'paragraph' },
            { type: 'paragraph', content: [{ type: 'text', text: 'Blocker' }] },
        ],
    } });
});

test('allowed transitions resolve keys and separately validate and post optional comments', async () => {
    const f = fixture();
    f.resolveTo('TEAM-456');
    await f.jira.transitionIssue(' team-123 ', '31', 'Approved update');
    assert.deepEqual(f.calls.map(([method, url]) => [method, url]), [
        ['GET', '/rest/api/3/issue/TEAM-123'],
        ['POST', '/rest/api/3/issue/TEAM-456/transitions'],
        ['GET', '/rest/api/3/issue/TEAM-456'],
        ['POST', '/rest/api/3/issue/TEAM-456/comment'],
    ]);
    assert.deepEqual(f.posts()[0][2], { transition: { id: '31' } });
    assert.equal(f.posts()[1][2].body.content[0].content[0].text, 'Approved update');
    f.calls.length = 0;
    await f.jira.transitionIssue('TEAM-456', '31');
    assert.equal(f.posts().length, 1);
});

test('mock writes remain offline and retain their existing behavior', async () => {
    const { getJiraClient } = loadWithMocks('../src/services/jira.ts', {
        '../config': { getJiraConfig: () => ({ mode: 'mock', projectKey: 'TEAM' }) },
    });
    const jira = getJiraClient();
    const issue = (await jira.searchSprintIssues((await jira.getActiveSprint()).id))[0];
    await jira.addComment(issue.key, 'Offline standup');
    assert.ok((await jira.getComments(issue.key)).some(comment => comment.body === 'Offline standup'));
    const transition = (await jira.getTransitions(issue.key))[0];
    await jira.transitionIssue(issue.key, transition.id);
    assert.equal((await jira.getIssue(issue.key)).status, transition.toStatus);
});

for (const moved of [false, true]) {
    test(`approved transition revalidates the project at deferred write time (moved=${moved})`, async () => {
        const f = fixture();
        const messages = [];
        const reconcile = loadWithMocks('../src/handlers/reconcile.ts', {
            '../services/jira': { getJiraClient: () => f.jira },
            '../services/team-roster': { listTeamMembers: async () => [
                { Role: 'SM', AadObjectId: 'sm-aad', conversationReference: {} },
            ] },
            '../services/proactive': { sendProactive: async (_ref, callback) => {
                await callback({ sendActivity: async message => { messages.push(message); } });
                return { ok: true };
            } },
        });
        const standupId = `write-boundary-${moved}`;
        const outcome = await reconcile.reconcileAfterStandup({
            standupId, sprintName: 'Sprint',
            responses: new Map([['dev', { userAadId: 'dev', items: [
                { issueKey: 'TEAM-123', update: 'Done', hasBlocker: false },
            ] }]]),
            itemsByAssignee: new Map([['dev', [
                { key: 'TEAM-123', status: 'To Do', summary: 'Work', url: 'https://jira.example.test' },
            ]]]),
        });
        assert.equal(outcome.needsConfirm.length, 1);
        f.calls.length = 0;
        if (moved) f.resolveTo('PRIVATE-123');
        await reconcile.handleReconcileSubmit({
            activity: {
                from: { aadObjectId: 'sm-aad' },
                value: { action: 'reconcile.apply', standupId, 'approve_TEAM-123': 'true' },
                getConversationReference: () => ({}),
            },
            sendActivity: async message => { messages.push(message); },
        });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.posts().length, moved ? 0 : 2);
        assert.ok(messages.some(message => typeof message === 'string' &&
            (moved ? /Failed: TEAM-123:.*restricted/.test(message) : /Applied: TEAM-123/.test(message))));
    });

    test(`deferred standup comment enforces the resolved project (moved=${moved})`, async () => {
        const f = fixture();
        const sessions = require('../src/services/session-store');
        const session = sessions.upsertSession({
            standupId: `comment-boundary-${moved}`, sprintId: 991234, sprintName: 'Sprint',
            state: 'open', startedUtc: new Date().toISOString(),
            cutoffUtc: new Date(Date.now() + 60000).toISOString(),
            itemsByAssignee: new Map([['dev', [{ key: 'TEAM-123', status: 'To Do' }]]]),
            expectedResponders: new Set(['dev', 'other']), sentTo: new Set(['dev', 'other']),
            unreachable: new Set(), responses: new Map(),
        });
        const standup = loadWithMocks('../src/handlers/standup.ts', {
            '../config': { getJiraMode: () => 'live', getScheduleConfig: () => ({ timezone: 'UTC' }) },
            '../services/jira': { getJiraClient: () => f.jira },
            '../services/sharepoint': { claimStandupResponse: async fields => ({
                created: true, item: { id: 'response', fields },
            }) },
            '../services/team-roster': {},
            '../services/proactive': { sendProactive: async (_ref, callback) => {
                await callback({ sendActivity: async () => {} });
                return { ok: true };
            } },
            '../cards/standup-request.card': { buildStandupSubmittedCard: value => value },
            '../cards/standup-summary.card': {},
        });
        try {
            await standup.handleStandupSubmit({
                activity: {
                    from: { aadObjectId: 'dev', name: 'Developer' },
                    value: { standupId: session.standupId, assigneeAadId: 'dev', 'update_TEAM-123': 'Working on it' },
                    getConversationReference: () => ({}),
                },
                sendActivity: async () => {},
            });
            if (moved) f.resolveTo('PRIVATE-123');
            // Both response persistence and the subsequent Jira comment are deferred.
            for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
            assert.equal(session.responses.get('dev').items[0].issueKey, 'TEAM-123');
            assert.deepEqual(f.calls.map(([method, url]) => [method, url]), [
                ['GET', '/rest/api/3/issue/TEAM-123'],
                ...(moved ? [] : [['POST', '/rest/api/3/issue/TEAM-123/comment']]),
            ]);
        } finally {
            sessions.removeSession(session.standupId);
        }
    });
}
