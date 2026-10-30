// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

async function withModule(file, stubs, run) {
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
    const dateTime = { setZone() { return this; }, toFormat() { return 'noon'; } };
    await withModule('../src/handlers/standup', {
        luxon: { DateTime: { now: () => dateTime, fromJSDate: () => dateTime } },
        '../config': { getJiraMode: () => 'live', getScheduleConfig: () => ({ cutoffHours: 0, timezone: 'UTC' }) },
        '../services/sharepoint': {
            findByTitle: async (_list, title) => records.get(title) ?? null,
            findByField: async () => [],
            createItem: async (_list, fields) => { records.set(fields.Title, { id: fields.Title, fields }); },
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

test('mock standup sends directly to the Playground caller without proactive credentials', async () => {
    const sessions = require('../src/services/session-store');
    let bound = false;
    const member = {
        AadObjectId: 'playground-user', JiraAccountId: 'acc-alex', Title: 'Alex', Role: 'SM',
        conversationReference: { conversation: { id: 'playground-dm', conversationType: 'personal' } },
    };
    const activities = [];
    const context = {
        activity: { from: { id: member.AadObjectId }, conversation: { id: 'playground-dm' } },
        sendActivity: async activity => { activities.push(activity); },
    };
    const dateTime = { setZone() { return this; }, toFormat() { return 'noon'; } };
    await withModule('../src/handlers/standup', {
        luxon: { DateTime: { fromJSDate: () => dateTime } },
        '../config': { getJiraMode: () => 'mock', getScheduleConfig: () => ({ cutoffHours: 0, timezone: 'UTC' }) },
        '../services/sharepoint': {
            findByTitle: async () => null,
            createItem: async () => ({}),
        },
        '../services/jira': { getJiraClient: () => ({
            getActiveSprint: async () => ({ id: 778901, name: 'Offline sprint' }),
            searchSprintIssues: async () => [{ key: 'SCRUM-6', assignee: { accountId: 'acc-alex' } }],
            getSprintSubtasks: async () => [],
        }) },
        '../services/team-roster': {
            upsertConversationReference: async () => { bound = true; },
            listTeamMembers: async () => { assert.equal(bound, true); return [member]; },
            isReachable: () => true,
        },
        '../services/proactive': { sendProactive: async () => { throw new Error('No bot credentials in mock quick start'); } },
        '../cards/standup-request.card': { buildStandupRequestCard: value => value },
        '../cards/standup-summary.card': {},
    }, async standup => {
        const result = await standup.triggerStandup({ source: 'command', turnContext: context });
        assert.equal(result.sentTo, 1);
        assert.equal(activities[0].attachments[0].assigneeAadId, member.AadObjectId);
        assert.equal(activities[0].attachments[0].items[0].key, 'SCRUM-6');
        sessions.removeSession(result.standupId);
    });
});
