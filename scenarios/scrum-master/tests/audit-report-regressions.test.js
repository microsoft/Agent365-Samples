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
        '../config': {
            getScheduleConfig: () => ({ timezone: 'UTC' }),
            getWarnConfig: () => ({ sprintProgressPct: 0.7, todoPct: 0.5 }),
        },
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
            messages, parentRequests, updates, assessSprint: mod.assessSprint,
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

test('T-2 completion categories govern RAG, SLA, rendered sections and returned counts', async () => {
    const f = fixture('sprint-summary', [
        { ...issue('SMA-1', 'Task', 'Closed', null, '2020-01-01'), statusCategory: 'done' },
        { ...issue('SMA-2', 'Task', 'Resolved', null, '2020-01-01'), statusCategory: 'done' },
        issue('SMA-3', 'Task', 'Done', null, '2020-01-01'),
    ]);
    assert.deepEqual((await f.run()).counts, { total: 3, pending: 0, red: 0, amber: 0 });
    const markdown = f.messages[0];
    assert.match(markdown, /\| Completed tasks \| 3 \|/);
    assert.match(markdown, /\| Pending tasks \| 0 \|/);
    assert.match(markdown, /\| SLA breached \| 0 \|/);
    assert.match(markdown, /On Track/);
    assert.doesNotMatch(markdown.split('## ✅ Completed tasks')[0], /SMA-[123]|At Risk|Breached/);
    const completed = markdown.split('## ✅ Completed tasks (3)')[1];
    for (const key of ['SMA-1', 'SMA-2', 'SMA-3']) assert.ok(completed.includes(key));

    const pending = fixture('sprint-summary', [
        { ...issue('SMA-4', 'Task', 'Done', null, '2020-01-01'), statusCategory: 'indeterminate' },
        issue('SMA-5', 'Task', 'Closed', null, '2020-01-01'),
    ]);
    assert.deepEqual((await pending.run()).counts, { total: 2, pending: 2, red: 2, amber: 0 });
    assert.match(pending.messages[0], /Completed tasks \(0\)/);
    assert.match(pending.messages[0], /At Risk/);
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

test('warning uses item counts for partially estimated sprint work', () => {
    const { assessSprint } = fixture('warn', []);
    const sprint = { id: 21, name: 'Sprint 21', startDate: '2020-01-01', endDate: '2020-01-11' };
    const done = { ...issue('SMA-1', 'Story', 'Done'), storyPoints: 5 };
    const todo = Array.from({ length: 9 }, (_, i) => issue(`SMA-${i + 2}`, 'Story', 'To Do'));
    const result = assessSprint(sprint, [done, ...todo], new Date('2020-01-09'));
    assert.equal(result.usePoints, false);
    assert.equal(result.toDoPct, 0.9);
    assert.equal(result.atRisk, true);
    assert.match(result.reason, /90% of items still in To Do/);
});

test('warning requires finite nonnegative estimates for all issues and a positive total', () => {
    const { assessSprint } = fixture('warn', []);
    const sprint = { id: 21, name: 'Sprint 21' };
    const todo = { ...issue('SMA-1', 'Story', 'To Do'), storyPoints: 3 };
    const done = { ...issue('SMA-2', 'Story', 'Done'), storyPoints: 1 };
    const estimated = assessSprint(sprint, [todo, done]);
    assert.equal(estimated.usePoints, true);
    assert.equal(estimated.toDoPct, 0.75);
    for (const invalid of [null, undefined, NaN, Infinity, -1, '5']) {
        const result = assessSprint(sprint, [todo, { ...done, storyPoints: invalid }]);
        assert.equal(result.usePoints, false, String(invalid));
        assert.equal(result.toDoPct, 0.5, String(invalid));
    }
    assert.equal(assessSprint(sprint, [todo, { ...done, storyPoints: 0 }]).usePoints, true);
    const zero = assessSprint(sprint, [{ ...todo, storyPoints: 0 }, { ...done, storyPoints: 0 }]);
    assert.equal(zero.usePoints, false);
    assert.equal(zero.toDoPct, 0.5);
    assert.equal(assessSprint(sprint, []).toDoPct, 0);
});

test('close report uses completion categories throughout metrics, follow-ups and returned counts', async () => {
    const completed = (key, type, status, summary = key) => ({
        ...issue(key, type, status), statusCategory: 'done', summary,
    });
    const f = fixture('report', [
        completed('SMA-1', 'Story', 'Released'),
        completed('SMA-2', 'Bug', 'Resolved'),
        completed('SMA-3', 'Task', 'Closed', 'Production deployment readiness checklist'),
        { ...issue('SMA-4', 'Story', 'Done'), statusCategory: 'indeterminate' },
        { ...issue('SMA-5', 'Bug', 'Done'), statusCategory: 'new' },
        { ...issue('SMA-6', 'Task', 'Done'), statusCategory: 'indeterminate', summary: 'Unfinished deployment' },
    ], [
        completed('SMA-7', 'Sub-task', 'Released', 'E2E regression tests'),
        completed('SMA-8', 'Sub-task', 'Resolved', 'Accessibility checks'),
    ]);
    assert.deepEqual((await f.run()).counts, { stories: 1, tasksDone: 3, deployments: 1, bugs: 1 });
    const markdown = f.messages[0];
    assert.match(markdown, /\| User Stories Delivered \| \*\*1\*\* of 2 committed \|/);
    assert.match(markdown, /\| Tasks Completed \| \*\*3\*\* of 4 \|/);
    assert.match(markdown, /\| Bugs Resolved \| \*\*1\*\*/);
    assert.match(markdown, /\| Production \/ UAT-related Tasks Completed \| \*\*1\*\*/);
    assert.match(markdown, /\| Accessibility-related Tasks Completed \| \*\*1\*\*/);
    assert.match(markdown, /\| E2E-related Tasks Completed \| \*\*1\*\*/);
    const followups = markdown.split('### Action Items for Next Sprint')[1].split('### Sprint Metrics')[0];
    assert.match(followups, /Carry-over: SMA-4/);
    assert.match(followups, /Carry-over: Unfinished deployment/);
    assert.match(followups, /Close open bug: SMA-5/);
    assert.doesNotMatch(followups, /SMA-[12378]|Increase automation|Introduce accessibility|Create deployment readiness/);
    assert.match(markdown.split('✅ **Key Deliverables**')[0], /SMA-1/);
    assert.match(markdown.split('**Bug Fixes**')[1].split('### Action Items')[0], /SMA-2/);
});

test('close report preserves exact Done fallback only when category is absent', async () => {
    const f = fixture('report', [
        issue('SMA-1', 'Story', 'Done'),
        issue('SMA-2', 'Bug', 'Done'),
        issue('SMA-3', 'Task', 'Done'),
        issue('SMA-4', 'Story', 'Closed'),
    ]);
    assert.deepEqual((await f.run()).counts, { stories: 1, tasksDone: 1, deployments: 0, bugs: 1 });
    assert.match(f.messages[0], /Carry-over: SMA-4/);
});

test('completed T-2 tasks show due dates without claiming on-time completion', async () => {
    const f = fixture('sprint-summary', [
        issue('SMA-1', 'Task', 'Done', null, '2020-01-01'),
        issue('SMA-2', 'Task', 'Done', null, '2099-01-01'),
        issue('SMA-3', 'Task', 'Done'),
    ]);
    await f.run();
    const completed = f.messages[0].split('## ✅ Completed tasks (3)')[1].split('---\n')[0];
    assert.match(completed, /\| Task \| User Story \| Owner \| Due date \|/);
    assert.match(completed, /SMA-1.*\| 2020-01-01 \|/);
    assert.match(completed, /SMA-2.*\| 2099-01-01 \|/);
    assert.match(completed, /SMA-3.*\| — \|/);
    assert.doesNotMatch(completed, /Completed by ETA|✅|overdue|\+\d+d/);
});
