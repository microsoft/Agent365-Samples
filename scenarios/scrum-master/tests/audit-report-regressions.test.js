// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const path = require('node:path');

function fixture(handler, issues, subtasks = [], blockers = []) {
    const filename = path.resolve(__dirname, '..', 'src', 'handlers', `${handler}.ts`);
    const sprint = { id: 21, name: 'Sprint 21', startDate: '2020-01-01', endDate: '2020-01-14' };
    const messages = [];
    const parentRequests = [];
    const updates = [];
    const mocks = {
        '../config': { getScheduleConfig: () => ({ timezone: 'UTC' }) },
        '../services/jira': { getJiraClient: () => ({
            getActiveSprint: async () => sprint,
            getSprint: async () => sprint,
            searchSprintIssues: async () => issues,
            getSprintSubtasks: async (_sprintId, keys) => {
                parentRequests.push(keys);
                return subtasks;
            },
        }) },
        '../services/sharepoint': {
            listItems: async () => blockers.map(fields => ({ fields })),
            findByField: async () => [{ fields: { ConversationRef: '{}' } }],
            claimSprintReport: async () => 'delivery-claim',
            updateItem: async (_list, _id, fields) => { updates.push(fields); },
        },
        '../services/team-roster': { listTeamMembers: async () => [] },
        '../services/proactive': { sendProactive: async (_reference, logic) => {
            await logic({ sendActivity: async text => { messages.push(text); } });
            return { ok: true };
        } },
    };
    const original = Module._load;
    delete require.cache[filename];
    Module._load = function (request, parent, ...args) {
        if (parent?.filename === filename && Object.hasOwn(mocks, request)) return mocks[request];
        return original.call(this, request, parent, ...args);
    };
    try {
        const mod = require(filename);
        return {
            messages, parentRequests, updates,
            run: () => handler === 'report'
                ? mod.runSprintCloseReport({ sprintId: 21 })
                : mod.runSprintSummary({ force: true }),
        };
    } finally {
        Module._load = original;
        delete require.cache[filename];
    }
}

function issue(key, issueType, status, parentKey = null, dueDate = null) {
    return {
        id: key, key, summary: key, issueType, status, parentKey, dueDate,
        assignee: null, storyPoints: null, url: `https://example.invalid/${key}`,
    };
}

test('T-2 report counts real Stories and retains standalone overdue work in a mixed hierarchy', async () => {
    const story = issue('SMA-1', 'Story', 'Done');
    const overdue = issue('SMA-2', 'Task', 'To Do', null, '2020-01-01');
    const child = issue('SMA-3', 'Sub-task', 'Done', story.key);
    const bug = issue('SMA-4', 'Bug', 'In Progress');
    const flatStory = issue('SMA-5', 'Story', 'To Do');
    const f = fixture('sprint-summary', [story, overdue, child, bug, flatStory], [child, child]);
    const result = await f.run();
    assert.equal(result.uploaded, true);
    assert.deepEqual(result.counts, { total: 4, pending: 3, red: 1, amber: 0 });
    assert.deepEqual(f.parentRequests, [['SMA-1', 'SMA-2', 'SMA-4', 'SMA-5']]);
    assert.match(f.messages[0], /\| Total user stories \| 2 \|/);
    assert.match(f.messages[0], /\| Total tasks \| 4 \|/);
    assert.match(f.messages[0], /SMA-2/);
    assert.match(f.messages[0], /SMA-4/);
    assert.match(f.messages[0], /SMA-5/);
    assert.match(f.messages[0], /At Risk/);
});

test('T-2 report preserves flat sprint fallback and empty sprint counts', async () => {
    const f = fixture('sprint-summary', [
        issue('SMA-1', 'Story', 'To Do'),
        issue('SMA-2', 'Task', 'Done'),
    ]);
    assert.deepEqual((await f.run()).counts, { total: 2, pending: 1, red: 0, amber: 0 });
    assert.match(f.messages[0], /\| Total user stories \| 1 \|/);
    const empty = fixture('sprint-summary', []);
    assert.deepEqual((await empty.run()).counts, { total: 0, pending: 0, red: 0, amber: 0 });
    assert.match(empty.messages[0], /\| Total user stories \| 0 \|/);
});

test('close report scopes blocker metrics and retro suggestions to its selected sprint', async () => {
    const f = fixture('report', [], [], [
        { Title: 'SMA-1', StandupId: '21#2020-01-10', State: 'resolved' },
        { Title: 'SMA-2', StandupId: '20#2020-01-10', State: 'open' },
        { Title: 'SMA-3', StandupId: '210#2020-01-10', State: 'resolved' },
        { Title: 'legacy-row', State: 'open' },
    ]);
    assert.equal((await f.run()).uploaded, true);
    assert.match(f.messages[0], /\| Blockers Encountered \| \*\*1\*\* \|/);
    assert.doesNotMatch(f.messages[0], /root-cause the top blockers/);
    assert.equal(f.updates[0].State, 'sent');
});

test('close report ignores historical blockers but retains current-sprint blocker history', async () => {
    const historical = fixture('report', [], [], [
        { Title: 'old', StandupId: '20#2020-01-01', State: 'resolved' },
    ]);
    await historical.run();
    assert.doesNotMatch(historical.messages[0], /Blockers Encountered|root-cause the top blockers/);
    const current = fixture('report', [], [], [
        { Title: 'one', StandupId: '21#2020-01-01', State: 'resolved' },
        { Title: 'two', StandupId: '21#2020-01-02', State: 'open' },
    ]);
    await current.run();
    assert.match(current.messages[0], /\| Blockers Encountered \| \*\*2\*\* \|/);
    assert.match(current.messages[0], /root-cause the top blockers/);
});
