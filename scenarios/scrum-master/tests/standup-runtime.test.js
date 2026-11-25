// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

async function withModule(file, stubs, run) {
    if (file.endsWith('/handlers/standup') && !stubs['../services/standup-delivery']) {
        stubs['../services/standup-delivery'] = { deliverStandupRequest: async (_id, _user, send) => {
            const result = await send(() => {}, () => {});
            if (!result.ok) throw new Error(result.error ?? 'Request delivery failed');
        } };
    }
    if (stubs['../cards/standup-summary.card']) {
        stubs['../cards/standup-summary.card'] = {
            ...require('../src/cards/standup-summary.card'),
            ...stubs['../cards/standup-summary.card'],
        };
    }
    const filename = require.resolve(file);
    delete require.cache[filename];
    const original = Module._load;
    Module._load = function (request, parent, ...args) {
        if (parent?.filename === filename && Object.hasOwn(stubs, request)) return stubs[request];
        return original.call(this, request, parent, ...args);
    };
    try {
        return await run(require(filename));
    } finally {
        Module._load = original;
        delete require.cache[filename];
    }
}

test('friendly labels use the real mock project despite the copied template', () => {
    const { toJiraKey } = require('../src/services/issue-labels');
    const previous = { mode: process.env.JIRA_MODE, project: process.env.JIRA_PROJECT_KEY };
    try {
        process.env.JIRA_MODE = 'mock';
        process.env.JIRA_PROJECT_KEY = 'DEMO';
        for (const value of ['Task-1', 'task 1', '#1', '1']) assert.equal(toJiraKey(value), 'SCRUM-1');
        assert.equal(toJiraKey('OTHER-1'), 'OTHER-1');
        process.env.JIRA_MODE = 'live';
        assert.equal(toJiraKey('Task-1'), 'DEMO-1');
    } finally {
        for (const [key, value] of [['JIRA_MODE', previous.mode], ['JIRA_PROJECT_KEY', previous.project]]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('mock roster keeps distinct Jira identities, binds caller SM, and ignores channel turns', async () => {
    const issues = ['alex', 'priya'].map(name => ({
        key: `SCRUM-${name}`, parentKey: null,
        assignee: { accountId: `acc-${name}`, displayName: name },
    }));
    await withModule('../src/services/team-roster', {
        '../config': { getJiraMode: () => 'mock' },
        './jira': { getJiraClient: () => ({
            getActiveSprint: async () => ({ id: 101 }),
            searchSprintIssues: async () => issues,
            getSprintSubtasks: async () => [],
        }) },
        './sharepoint': new Proxy({}, { get: () => () => { throw new Error('Graph must not run'); } }),
    }, async roster => {
        const personal = { conversation: { id: 'dm', conversationType: 'personal', isGroup: false } };
        const context = {
            activity: {
                from: { id: 'playground-user' },
                getConversationReference: () => personal,
            },
        };
        await roster.upsertConversationReference(context);
        const members = await roster.listTeamMembers();
        assert.equal(members.length, 2);
        assert.equal(new Set(members.map(m => m.AadObjectId)).size, 2);
        const sm = await roster.getMemberByAadId('playground-user');
        assert.equal(sm.Role, 'SM');
        assert.equal(sm.JiraAccountId, 'acc-alex');
        assert.equal(roster.isReachable(sm), true);
        context.activity.getConversationReference = () => ({
            conversation: { id: 'channel', conversationType: 'channel', isGroup: true },
        });
        await roster.upsertConversationReference(context);
        assert.equal(sm.conversationReference.conversation.id, 'dm');
        assert.equal(roster.isReachable(members.find(m => m.JiraAccountId === 'acc-priya')), false);
    });
});

test('live channel turns cannot overwrite a saved personal destination', async () => {
    let queries = 0;
    await withModule('../src/services/team-roster', {
        '../config': { getJiraMode: () => 'live' },
        './jira': {},
        './sharepoint': {
            findByField: async () => { queries++; throw new Error('Must not update channel reference'); },
        },
    }, async roster => {
        await roster.upsertConversationReference({
            activity: {
                from: { aadObjectId: 'live-user' },
                getConversationReference: () => ({
                    conversation: { id: 'channel', conversationType: 'channel', isGroup: true },
                }),
            },
        });
        assert.equal(queries, 0);
    });
});

test('seed resolves only an explicit matching email and rejects identity collapse', async () => {
    await withModule('../src/scripts/seed-team', {
        dotenv: { configDotenv() {} },
        'isomorphic-fetch': {},
        '../services/sharepoint': {},
        '../services/graph': {},
    }, async ({ resolveSeedIdentities }) => {
        const rows = [
            { AadObjectId: '00000000-0000-0000-0000-000000000001', Email: 'alice@contoso.com' },
            { AadObjectId: '00000000-0000-0000-0000-000000000002', Email: 'bob@contoso.com' },
        ];
        resolveSeedIdentities(rows, { id: 'signed-in', mail: 'unrelated@contoso.com' });
        assert.equal(new Set(rows.map(r => r.AadObjectId)).size, 2);
        resolveSeedIdentities(rows, { id: 'signed-in', mail: 'ALICE@contoso.com' });
        assert.equal(rows[0].AadObjectId, 'signed-in');
        assert.notEqual(rows[1].AadObjectId, 'signed-in');
        assert.throws(() => resolveSeedIdentities([
            { AadObjectId: 'same', Email: '' }, { AadObjectId: 'same', Email: '' },
        ], null), /duplicate/);
    });
});

test('standup expands inherited subtasks, coalesces triggers, and finalizes once per day', async () => {
    const sessions = require('../src/services/session-store');
    const records = new Map();
    const members = ['a', 'b'].map((id, i) => ({
        AadObjectId: id, JiraAccountId: `acc-${id}`, Title: id, Role: i === 0 ? 'SM' : 'Dev',
        conversationReference: { conversation: { id: `dm-${id}` } },
    }));
    const parent = { key: 'SCRUM-1', parentKey: null, assignee: { accountId: 'acc-a' }, status: 'To Do' };
    const subtask = { key: 'SCRUM-2', parentKey: parent.key, assignee: { accountId: 'acc-b' }, status: 'To Do' };
    let sends = 0;
    let reconciliations = 0;
    let sprintId = 778899;
    await withModule('../src/handlers/standup', {
        '../config': { getJiraMode: () => 'live', getScheduleConfig: () => ({ cutoffHours: 0, timezone: 'UTC' }) },
        '../services/sharepoint': {
            findByTitle: async (_list, title) => records.get(title) ?? null,
            findByField: async () => [],
            createItem: async (_list, fields) => { records.set(fields.Title, { id: fields.Title, fields }); },
            claimStandupSession: async fields => {
                if (records.has(fields.Title)) return null;
                const row = { id: fields.Title, fields: { ...fields, RunKey: fields.Title } };
                records.set(fields.Title, row);
                return row;
            },
            updateItem: async (_list, id, fields) => Object.assign(records.get(id).fields, fields),
        },
        '../services/jira': { getJiraClient: () => ({
            getActiveSprint: async () => ({ id: sprintId, name: 'Test sprint' }),
            searchSprintIssues: async () => [parent],
            getSprintSubtasks: async (_id, keys) => {
                assert.deepEqual(keys, [parent.key]);
                return [parent, subtask];
            },
        }) },
        '../services/team-roster': {
            listTeamMembers: async () => members,
            isReachable: () => true,
        },
        '../services/proactive': { sendProactive: async () => { sends++; return { ok: true }; } },
        '../cards/standup-request.card': { buildStandupRequestCard: value => value },
        '../cards/standup-summary.card': { buildStandupSummaryCard: value => value },
        './reconcile': { reconcileAfterStandup: async () => {
            reconciliations++;
            await new Promise(resolve => setImmediate(resolve));
            return { autoApplied: [], needsConfirm: [], errors: [] };
        } },
        './chase': { chaseAfterStandup: async () => {} },
    }, async standup => {
        const options = { source: 'http' };
        const [first, concurrent] = await Promise.all([
            standup.triggerStandup(options), standup.triggerStandup(options),
        ]);
        assert.equal(first.standupId, concurrent.standupId);
        assert.equal(sends, 2);
        const session = sessions.getSession(first.standupId);
        assert.equal(session.expectedResponders.size, 2);
        assert.deepEqual(session.itemsByAssignee.get('b').map(i => i.key), ['SCRUM-2']);
        assert.equal(session.itemsByAssignee.get('a').length, 1);
        await Promise.all([standup.summarizeStandup(session), standup.summarizeStandup(session)]);
        assert.equal(reconciliations, 1);
        assert.equal(sends, 3);
        assert.equal(sessions.getSession(first.standupId), undefined);
        assert.ok(sessions.getCompletedSession(first.standupId));
        const repeated = await standup.triggerStandup(options);
        assert.match(repeated.note, /already/);
        assert.equal(sends, 3);
        sprintId++;
        const durableId = sessions.makeStandupId(sprintId);
        records.set(durableId, { id: durableId, fields: { State: 'summarized' } });
        const afterRestart = await standup.triggerStandup(options);
        assert.match(afterRestart.note, /already/);
        assert.equal(sends, 3);
    });
});

test('mock standup uses fresh SDK contexts for deferred replies and summaries after the original turn is revoked', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { CloudAdapter, TurnContext } = require('@microsoft/agents-hosting');
    const { Activity } = require('@microsoft/agents-activity');
    const sessions = require('../src/services/session-store');
    let bound = false;
    const member = {
        AadObjectId: 'playground-user', JiraAccountId: 'acc-alex', Title: 'Alex', Role: 'SM',
        conversationReference: {
            serviceUrl: 'http://localhost:5000', channelId: 'emulator',
            conversation: { id: 'playground-dm', conversationType: 'personal' },
            agent: { id: 'bot' }, user: { id: 'playground-user' },
        },
    };
    const activities = [];
    const adapter = new CloudAdapter({});
    adapter.sendActivities = async (_context, messages) => {
        activities.push(...messages);
        return messages.map(() => ({ id: 'offline' }));
    };
    const runTurn = async (value, logic) => {
        const activity = Activity.fromObject({
            type: 'message', from: { id: member.AadObjectId }, recipient: { id: 'bot' },
            conversation: member.conversationReference.conversation,
            serviceUrl: member.conversationReference.serviceUrl, channelId: 'emulator',
            value,
        });
        const context = new TurnContext(adapter, activity, {});
        let proxy;
        await adapter.runMiddleware(context, async ctx => { proxy = ctx; await logic(ctx); });
        assert.throws(() => proxy.activity, /revoked/);
    };
    let sprintId = 778901;
    await withModule('../src/handlers/standup', {
        '../config': { getJiraMode: () => 'mock', getScheduleConfig: () => ({ cutoffHours: 24, timezone: 'UTC' }) },
        '../services/sharepoint': {
            findByTitle: async () => null,
            createItem: async () => ({}),
            claimStandupSession: async fields => ({ id: fields.Title, fields }),
            claimStandupResponse: async fields => ({ created: true, item: { id: 'response', fields } }),
            findByField: async () => [], updateItem: async () => {},
        },
        '../services/jira': { getJiraClient: () => ({
            getActiveSprint: async () => ({ id: sprintId, name: 'Offline sprint' }),
            searchSprintIssues: async () => [{ key: 'SCRUM-6', assignee: { accountId: 'acc-alex' } }],
            getSprintSubtasks: async () => [],
            addComment: async () => {},
        }) },
        '../services/team-roster': {
            upsertConversationReference: async () => { bound = true; },
            listTeamMembers: async () => { assert.equal(bound, true); return [member]; },
            isReachable: () => true,
        },
        '../services/proactive': { sendProactive: async () => { throw new Error('No bot credentials in mock quick start'); } },
        '../cards/standup-request.card': {
            buildStandupRequestCard: value => ({ contentType: 'application/vnd.microsoft.card.adaptive', content: { ...value, kind: 'request' } }),
            buildStandupSubmittedCard: value => ({ contentType: 'application/vnd.microsoft.card.adaptive', content: { ...value, kind: 'submitted' } }),
        },
        '../cards/standup-summary.card': {
            buildStandupSummaryCard: value => ({ contentType: 'application/vnd.microsoft.card.adaptive', content: { ...value, kind: 'summary' } }),
        },
        './reconcile': { reconcileAfterStandup: async () => ({ autoApplied: [], needsConfirm: [], errors: [], approvalDelivered: false }) },
        './chase': { chaseAfterStandup: async () => {} },
    }, async standup => {
        for (const mode of ['submit', 'cutoff']) {
            let result;
            await runTurn(undefined, async context => {
                result = await standup.triggerStandup({ source: 'command', turnContext: context });
            });
            assert.equal(result.sentTo, 1);
            const session = sessions.getSession(result.standupId);
            try {
                if (mode === 'submit') {
                    await runTurn({
                        standupId: result.standupId, assigneeAadId: member.AadObjectId,
                        'update_SCRUM-6': 'Working on the fix',
                    }, context => standup.handleStandupSubmit(context));
                    await sessions.waitForSessionSubmissions(session);
                    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
                    assert.ok(activities.some(activity => activity.attachments?.[0]?.content.kind === 'submitted'));
                } else {
                    t.mock.timers.tick(24 * 3600_000);
                    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
                }
                assert.equal(session.state, 'summarized', mode);
                assert.ok(activities.some(activity => activity.attachments?.[0]?.content.kind === 'summary'), mode);
            } finally {
                sessions.removeSession(result.standupId);
                activities.length = 0;
                sprintId++;
            }
        }
    });
});
