// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

async function withModule(file, stubs, work) {
    const filename = require.resolve(file);
    const original = Module._load;
    delete require.cache[filename];
    Module._load = function (request, parent, ...args) {
        if (parent?.filename === filename && Object.hasOwn(stubs, request)) return stubs[request];
        return original.call(this, request, parent, ...args);
    };
    try { await work(require(filename)); }
    finally { Module._load = original; delete require.cache[filename]; }
}

function summaryParams(items) {
    return {
        sprintName: 'Sprint', dateLocal: 'Wednesday', respondedCount: 1, expectedCount: 1,
        updatesByPerson: [{ displayName: 'Developer', items }],
        missed: [], blockers: [], scrumMaster: { aadId: 'sm', displayName: 'Scrum Master' },
    };
}

function summaryItem(blockerText) {
    return {
        issueKey: 'TEAM-1', title: 'Work', url: '', statusFrom: 'In Review',
        update: 'Working on it', blockerText,
    };
}

test('summary distinguishes optional blank blocker details from an unblocked item', () => {
    const { buildStandupSummaryCard } = require('../src/cards/standup-summary.card');
    for (const details of ['', '   ', 'Dependency unavailable', undefined]) {
        const card = buildStandupSummaryCard(summaryParams([summaryItem(details)])).content;
        const row = card.body.find(part => part.type === 'Table').rows[1];
        const rendered = row.cells[5].items[0].text;
        assert.equal(rendered, details === undefined ? '' : details.trim() || 'Blocked (no details provided)');
        assert.equal(card.msteams.entities?.length ?? 0, details === undefined ? 0 : 1);
        assert.equal(card.body.some(part => part.text?.includes('see blockers')), details !== undefined);
    }
});

test('a no-op reconciliation refreshes the actual status rendered in the summary', async () => {
    let transitions = 0;
    await withModule('../src/handlers/reconcile', {
        '../services/jira': { getJiraClient: () => ({
            getIssue: async () => ({ status: 'Done' }),
            getTransitions: async () => { transitions++; return []; },
            transitionIssue: async () => { assert.fail('Already done must not transition'); },
        }) },
        '../services/team-roster': {}, '../services/proactive': {},
    }, async ({ runReconciliation }) => {
        const issue = { key: 'TEAM-1', status: 'In Review', summary: 'Work', url: '' };
        const session = {
            responses: new Map([['dev', { userAadId: 'dev', items: [{ issueKey: 'TEAM-1', update: 'Done', hasBlocker: false }] }]]),
            itemsByAssignee: new Map([['dev', [issue]]]),
        };
        const outcome = await runReconciliation(session);
        assert.deepEqual(outcome, { autoApplied: [], needsConfirm: [], errors: [] });
        assert.equal(issue.status, 'Done');
        const { buildStandupSummaryCard } = require('../src/cards/standup-summary.card');
        const card = buildStandupSummaryCard(summaryParams([{ ...summaryItem(), statusFrom: issue.status }])).content;
        assert.equal(card.body.find(part => part.type === 'Table').rows[1].cells[3].items[0].text, 'Done');
        assert.equal(transitions, 0);
    });
});

test('standup retry command passes the exact retained session ID and rejects malformed arguments', async () => {
    const calls = [], messages = [];
    await withModule('../src/handlers/commands', {
        './standup': { triggerStandup: async options => { calls.push(options); } },
        './config': {},
    }, async ({ tryHandleCommand }) => {
        const context = text => ({ activity: { text, from: {} }, sendActivity: async message => { messages.push(message); } });
        await tryHandleCommand(context('/standup retry 101#2026-11-10'));
        assert.equal(calls[0].retryStandupId, '101#2026-11-10');
        assert.equal(calls[0].source, 'command');
        for (const command of ['/standup retry', '/standup retry garbage', '/standup unknown', '/standup retry 101#2026-11-10 extra']) {
            await tryHandleCommand(context(command));
        }
        assert.equal(calls.length, 1);
        assert.equal(messages.length, 4);
        await tryHandleCommand(context('/standup'));
        assert.equal(calls.length, 2);
        assert.equal(calls[1].retryStandupId, undefined);
    });
});
