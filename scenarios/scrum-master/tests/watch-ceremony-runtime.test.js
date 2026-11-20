// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const { DateTime, Settings } = require('luxon');

async function withModule(file, stubs, run) {
    const filename = require.resolve(file);
    const load = Module._load;
    delete require.cache[filename];
    Module._load = function (request, parent, ...args) {
        if (parent?.filename === filename && Object.hasOwn(stubs, request)) return stubs[request];
        return load.call(this, request, parent, ...args);
    };
    try { await run(require(filename)); }
    finally { Module._load = load; delete require.cache[filename]; }
}

test('nightly T-2 summary compares local dates rather than elapsed hours', async () => {
    const originalNow = Settings.now;
    try {
        for (const [zone, now, end] of [
            ['Asia/Kolkata', '2026-11-11T00:30:00+05:30', '2026-11-13T17:00:00+05:30'],
            ['America/New_York', '2026-10-30T00:30:00-04:00', '2026-11-01T17:00:00-05:00'],
        ]) {
            Settings.now = originalNow;
            const timestamp = DateTime.fromISO(now).toMillis();
            const nextDay = DateTime.fromISO(now).setZone(zone).plus({ days: 1 }).toMillis();
            Settings.now = () => timestamp;
            await withModule('../src/handlers/sprint-summary', {
                '../config': { getScheduleConfig: () => ({ timezone: zone }) },
                '../services/jira': { getJiraClient: () => ({
                    getActiveSprint: async () => ({ id: 101, name: 'Sprint 7', endDate: end }),
                    searchSprintIssues: async () => [], getSprintSubtasks: async () => [],
                }) },
                '../services/sharepoint': { findByField: async () => [{ fields: { ConversationRef: '{}' } }] },
                '../services/team-roster': { listTeamMembers: async () => [] },
                '../services/proactive': { sendProactive: async () => ({ ok: true }) },
            }, async summary => {
                assert.equal((await summary.runSprintSummary()).uploaded, true, zone);
                Settings.now = () => nextDay;
                assert.equal((await summary.runSprintSummary()).uploaded, false, zone);
            });
        }
    } finally { Settings.now = originalNow; }
});

test('failed standup summary stays open and retry summarizes without repeating fan-out', async () => {
    const sessions = require('../src/services/session-store');
    let succeeds = false, sends = 0;
    const states = [];
    const sprintId = 882299;
    const session = {
        standupId: sessions.makeStandupId(sprintId), sprintId, sprintName: 'Sprint 7',
        state: 'open', startedUtc: new Date().toISOString(), cutoffUtc: new Date(Date.now() - 1000).toISOString(),
        initiatedByAadId: null, itemsByAssignee: new Map(), responses: new Map(),
        expectedResponders: new Set(), sentTo: new Set(['dev']), unreachable: new Set(),
    };
    sessions.upsertSession(session);
    await withModule('../src/handlers/standup', {
        '../config': { getJiraMode: () => 'live', getScheduleConfig: () => ({ timezone: 'UTC', cutoffHours: 4 }) },
        '../services/jira': { getJiraClient: () => ({ getActiveSprint: async () => ({ id: sprintId, name: 'Sprint 7' }) }) },
        '../services/team-roster': { listTeamMembers: async () => [
            { Title: 'SM', Role: 'SM', AadObjectId: 'sm', conversationReference: { conversation: { id: 'sm-dm' } } },
        ] },
        '../services/sharepoint': {
            findByField: async () => [{ fields: { ConversationRef: JSON.stringify({ conversation: { id: 'channel' } }) } }],
            findByTitle: async () => ({ id: 'session', fields: { State: 'open' } }),
            updateItem: async (_list, _id, fields) => { states.push(fields.State); },
        },
        '../services/proactive': { sendProactive: async () => { sends++; return { ok: succeeds, error: 'test connector failure' }; } },
        './reconcile': { reconcileAfterStandup: async () => ({ autoApplied: [], needsConfirm: [], errors: [] }) },
        './chase': { chaseAfterStandup: async () => {} },
    }, async standup => {
        await assert.rejects(standup.summarizeStandup(session), /not delivered/);
        assert.equal(session.state, 'open');
        assert.equal(sessions.getCompletedSession(session.standupId), undefined);
        assert.deepEqual(states, []);
        assert.equal(sends, 2);
        succeeds = true;
        const retry = await standup.triggerStandup({ source: 'http' });
        assert.match(retry.note, /without repeating fan-out/);
        assert.equal(sends, 3);
        assert.deepEqual(states, ['summarized']);
        assert.ok(sessions.getCompletedSession(session.standupId));
    });
});

test('a failed board-update follow-up does not retry an already delivered summary card', async () => {
    const sessions = require('../src/services/session-store');
    let sends = 0;
    const session = {
        standupId: sessions.makeStandupId(882300), sprintId: 882300, sprintName: 'Sprint 7',
        state: 'open', startedUtc: new Date().toISOString(), cutoffUtc: new Date().toISOString(),
        initiatedByAadId: null, itemsByAssignee: new Map(), responses: new Map(),
        expectedResponders: new Set(), sentTo: new Set(), unreachable: new Set(),
    };
    sessions.upsertSession(session);
    await withModule('../src/handlers/standup', {
        '../config': { getJiraMode: () => 'live', getScheduleConfig: () => ({ timezone: 'UTC' }) },
        '../services/jira': {},
        '../services/team-roster': { listTeamMembers: async () => [] },
        '../services/sharepoint': {
            findByField: async () => [{ fields: { ConversationRef: '{}' } }],
            findByTitle: async () => null,
        },
        '../services/proactive': { sendProactive: async () => { sends++; return { ok: sends === 1, error: 'follow-up failure' }; } },
        './reconcile': { reconcileAfterStandup: async () => ({
            autoApplied: [{ issueKey: 'SCRUM-1', from: 'To Do', to: 'In Progress' }], needsConfirm: [], errors: [],
        }) },
        './chase': { chaseAfterStandup: async () => {} },
    }, async standup => {
        await standup.summarizeStandup(session);
        assert.equal(sends, 2);
        assert.equal(session.state, 'summarized');
        assert.ok(sessions.getCompletedSession(session.standupId));
    });
});
