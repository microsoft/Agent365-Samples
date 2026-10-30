// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

function load(file, mocks) {
    const filename = path.resolve(__dirname, '..', file);
    const original = Module._load;
    delete require.cache[filename];
    Module._load = function (request, parent, isMain) {
        return Object.hasOwn(mocks, request) ? mocks[request] : original.call(this, request, parent, isMain);
    };
    try { return require(filename); }
    finally { Module._load = original; }
}

const sprint = { id: 21, name: 'Sprint 21', state: 'closed', startDate: '2020-01-01', endDate: '2020-01-14', goal: null };
function issue(key, issueType, status, summary = key) {
    return { key, id: key, issueType, status, summary, url: `https://example.test/${key}`, assignee: null, storyPoints: 1 };
}
function reportFixture(overrides = {}) {
    const sent = [];
    const updates = [];
    let claimed = false;
    const jira = {
        getSprints: async state => state === 'closed' ? [sprint] : state === 'future'
            ? [{ ...sprint, id: 22, name: 'Quarterly delivery', startDate: '2020-01-15' }] : [],
        getSprint: async () => sprint,
        searchSprintIssues: async () => [issue('T-1', 'Task', 'Done', 'Ship search'), issue('T-2', 'Task', 'To Do', 'Finish search')],
        getSprintSubtasks: async () => [],
    };
    const report = load('src\\handlers\\report.ts', {
        '../services/jira': { getJiraClient: () => jira },
        '../config': { getScheduleConfig: () => ({ timezone: 'UTC' }) },
        '../services/sharepoint': {
            listItems: async () => [],
            findByField: async () => [{ fields: { ConversationRef: '{"target":"channel"}' } }],
            claimSprintReport: async () => {
                if (claimed) return null;
                claimed = true;
                return 'claim-1';
            },
            updateItem: async (...args) => { updates.push(args); if (args[2].State === 'failed') claimed = false; },
        },
        '../services/team-roster': { listTeamMembers: async () => [{ Role: 'SM', conversationReference: { target: 'sm' } }] },
        '../services/proactive': {
            sendProactive: async (ref, callback) => {
                sent.push(ref.target);
                if (overrides.failAll || ref.target === 'channel') return { ok: false };
                await callback({ sendActivity: async text => { sent.push(text); } });
                return { ok: true };
            },
        },
    });
    return { ...report, sent, updates };
}

test('close report chooses closed sprint, falls back after failed channel send, includes Tasks and next sprint', async () => {
    const fixture = reportFixture();
    const result = await fixture.runSprintCloseReport();
    assert.equal(result.uploaded, true);
    assert.equal(result.counts.tasksDone, 1);
    assert.deepEqual(fixture.sent.slice(0, 2), ['channel', 'sm']);
    const markdown = fixture.sent[2];
    assert.match(markdown, /Sprint 21/);
    assert.match(markdown, /Ship search/);
    assert.match(markdown, /Carry-over: Finish search/);
    assert.match(markdown, /Quarterly delivery/);
    assert.doesNotMatch(markdown, /Nothing shipped|Sprint 2\s*\|/);
    assert.equal(fixture.updates[0][2].State, 'sent');
    assert.equal((await fixture.runSprintCloseReport({ force: true })).uploaded, false);
    assert.equal(fixture.sent.length, 3);
});

test('all failed deliveries remain retryable and never report success', async () => {
    const fixture = reportFixture({ failAll: true });
    assert.equal((await fixture.runSprintCloseReport()).uploaded, false);
    assert.equal(fixture.updates[0][2].State, 'failed');
    assert.equal((await fixture.runSprintCloseReport()).uploaded, false);
    assert.equal(fixture.sent.length, 4);
});

test('concurrent report workers acquire one per-sprint delivery claim', async () => {
    const fixture = reportFixture();
    const results = await Promise.all([fixture.runSprintCloseReport(), fixture.runSprintCloseReport()]);
    assert.equal(results.filter(r => r.uploaded).length, 1);
    assert.equal(fixture.sent.filter(s => s === 'sm').length, 1);
});

test('report never invents a Sprint 2 target when the next sprint is unknown', () => {
    const fixture = reportFixture();
    const markdown = fixture.buildSprintReportMarkdown({
        sprint,
        stories: [issue('T-2', 'Task', 'To Do', 'Finish search')],
        subtasks: [],
        blockers: [],
        tz: 'UTC',
    });
    assert.match(markdown, /Next sprint \(TBD\)/);
    assert.match(markdown, /Carry-over to Next Sprint/);
    assert.doesNotMatch(markdown, /Sprint 2\s*\|/);
});

test('offline SharePoint CRUD and per-sprint claim are isolated and atomic', async () => {
    const sp = load('src\\services\\sharepoint.ts', {
        './graph': { getGraphClient: () => { throw new Error('Offline mode must not use Graph'); } },
        '../config': { getJiraMode: () => 'mock' },
    });
    const row = await sp.createItem('blockers', { Title: 'TASK-1', State: 'open' });
    const claims = await Promise.all([sp.claimItemState('blockers', row.id, 'open', 'booking'), sp.claimItemState('blockers', row.id, 'open', 'booking')]);
    assert.deepEqual(claims, [true, false]);
    const read = await sp.findByTitle('blockers', 'TASK-1');
    read.fields.State = 'tampered';
    assert.equal((await sp.listItems('blockers'))[0].fields.State, 'booking');
    const reportClaims = await Promise.all([sp.claimSprintReport(21), sp.claimSprintReport(21)]);
    assert.equal(reportClaims.filter(Boolean).length, 1);
    await sp.updateItem('sprintReportsDelivery', reportClaims.find(Boolean), { State: 'failed' });
    assert.ok(await sp.claimSprintReport(21));
    assert.deepEqual(sp.LIST_SCHEMAS.sprintReportsDelivery.columns.find(c => c.name === 'DeliveryKey'), {
        name: 'DeliveryKey', type: 'text', unique: true,
    });
});

test('SharePoint live claims use ETag conditional writes and reject a losing worker', async () => {
    const headers = [];
    const sp = load('src\\services\\sharepoint.ts', {
        '../config': { getJiraMode: () => 'live', getSharePointConfig: () => ({ siteUrl: 'https://example.test/sites/test', listsPrefix: 'SMA_' }) },
        './graph': {
            getGraphClient: () => ({
                api: endpoint => ({
                    get: async () => endpoint.includes('?$expand')
                        ? { fields: { State: 'open' }, eTag: '"1"' } : { id: 'site' },
                    header: (name, value) => {
                        headers.push([name, value]);
                        return { update: async () => { throw Object.assign(new Error('Conflict'), { statusCode: 412 }); } };
                    },
                }),
            }),
        },
    });
    assert.equal(await sp.claimItemState('blockers', '1', 'open', 'booking'), false);
    assert.deepEqual(headers, [['If-Match', '"1"']]);
});

test('meeting cards cannot book twice concurrently, after success, or after resolution', async () => {
    let state = 'open';
    let meetingId;
    let creations = 0;
    const chase = load('src\\handlers\\chase.ts', {
        '../services/jira': {},
        '../services/team-roster': { getMemberByAadId: async () => ({ Email: 'test@example.test', Title: 'Test' }) },
        '../services/proactive': {
            sendProactive: async (_ref, callback) => {
                await callback({ sendActivity: async () => {} });
                return { ok: true };
            },
        },
        '../services/sharepoint': {
            findByField: async () => [{ id: 'blocker-1', fields: { Title: 'T-1', State: state, MeetingEventId: meetingId, OwnerAadId: 'owner', ReporterAadId: 'reporter', BlockerText: 'Help' } }],
            findByTitle: async () => null,
            claimItemState: async (_key, _id, expected, next) => {
                if (state !== expected) return false;
                state = next;
                return true;
            },
            updateItem: async (_key, _id, fields) => { state = fields.State; meetingId = fields.MeetingEventId; },
        },
        '../config': { getScheduleConfig: () => ({ timezone: 'UTC' }), getJiraMode: () => 'live' },
        '../cards/blocker-escalation.card': {},
        '../cards/meeting-propose.card': {},
        '../services/calendar': { createUnblockMeeting: async () => { creations++; return { id: 'event-1', webLink: 'https://example.test/event' }; } },
        '../services/helperMatcher': { findHelperForBlocker: async () => null },
        '../agent': { agentApplication: { authorization: {} } },
    });
    const value = { blockerId: 'blocker-1', issueKey: 'T-1', slot: '2030-01-01T10:00:00Z|2030-01-01T10:30:00Z' };
    await Promise.all([chase.bookMeetingAsync({}, value, 'sm'), chase.bookMeetingAsync({}, value, 'sm')]);
    assert.equal(creations, 1);
    assert.equal(state, 'booked');
    assert.equal(meetingId, 'event-1');
    await chase.bookMeetingAsync({}, value, 'sm');
    state = 'resolved';
    await chase.bookMeetingAsync({}, value, 'sm');
    assert.equal(creations, 1);
});

test('Jira reads all sprint, issue and token-based subtask pages', async () => {
    const calls = [];
    const raw = n => ({ id: String(n), key: `T-${n}`, fields: { summary: `Issue ${n}`, status: { name: 'Done' }, issuetype: { name: 'Task' } } });
    const http = {
        get: async (url, options) => {
            calls.push([url, options.params]);
            if (url.endsWith('/sprint')) return { data: options.params.startAt === 0
                ? { values: [sprint], isLast: false } : { values: [{ ...sprint, id: 22 }], isLast: true } };
            return { data: options.params.startAt === 0 ? { issues: [raw(1)], total: 2 } : { issues: [raw(2)], total: 2 } };
        },
        post: async (_url, body) => {
            calls.push(['post', body]);
            return { data: body.nextPageToken ? { issues: [raw(4)], isLast: true } : { issues: [raw(3)], nextPageToken: 'next' } };
        },
    };
    let attached = false;
    const { LiveJiraClient } = load('src\\services\\jira.ts', {
        axios: { create: () => http },
        '../config': {},
        '../mock/jira-mock': {},
        '../util/httpLogger': { attachHttpLogging: client => { attached = client === http; } },
    });
    const client = new LiveJiraClient({ email: 'test', apiToken: 'placeholder', baseUrl: 'https://example.test', boardId: 1 });
    assert.equal(attached, true);
    assert.equal((await client.getSprints('closed')).length, 2);
    assert.deepEqual((await client.searchSprintIssues(21)).map(i => i.key), ['T-1', 'T-2']);
    assert.deepEqual((await client.getSprintSubtasks(21, ['T-1'])).map(i => i.key), ['T-3', 'T-4']);
    assert.equal(calls.find(c => c[0] === 'post' && c[1].nextPageToken)[1].nextPageToken, 'next');
});

test('local schedules use UTC and nightly includes mid-sprint summary even if Warn fails', async () => {
    const jobs = [];
    const calls = [];
    const { startLocalScheduler } = load('src\\cron\\local-scheduler.ts', {
        'node-cron': { schedule: (...args) => jobs.push(args) },
        '../config': { getScheduleConfig: () => ({ localCron: true, timezone: 'Asia/Kolkata', standupCron: 'standup', nightlyCron: 'nightly' }) },
        '../handlers/standup': { triggerStandup: async () => {} },
        '../handlers/warn': { runWarnCheck: async () => { calls.push('warn'); throw new Error('test failure'); } },
        '../handlers/report': { runSprintCloseReport: async () => calls.push('close') },
        '../handlers/sprint-summary': { runSprintSummary: async () => calls.push('mid') },
    });
    startLocalScheduler();
    assert.deepEqual(jobs.map(j => j[2].timezone), ['UTC', 'UTC']);
    await jobs[1][1]();
    assert.deepEqual(calls, ['warn', 'close', 'mid']);
});

test('Functions timers declare explicit retries and reject non-UTC host timezone', () => {
    const timers = [];
    const oldTimezone = process.env.WEBSITE_TIME_ZONE;
    delete process.env.WEBSITE_TIME_ZONE;
    const mocks = { '@azure/functions': { app: { timer: (name, options) => timers.push([name, options]) } }, axios: {} };
    try {
        load('azure-functions\\src\\index.ts', mocks);
        assert.equal(timers.length, 2);
        for (const [, options] of timers) {
            assert.deepEqual(options.retry, { strategy: 'fixedDelay', maxRetryCount: 3, delayInterval: { seconds: 30 } });
        }
        process.env.WEBSITE_TIME_ZONE = 'India Standard Time';
        assert.throws(() => load('azure-functions\\src\\index.ts', mocks), /UTC/);
    } finally {
        if (oldTimezone === undefined) delete process.env.WEBSITE_TIME_ZONE;
        else process.env.WEBSITE_TIME_ZONE = oldTimezone;
    }
});
