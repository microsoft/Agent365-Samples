// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const path = require('node:path');

function load(file, mocks) {
    const filename = path.resolve(__dirname, '..', ...file.split(/[\\/]+/));
    const original = Module._load;
    delete require.cache[filename];
    Module._load = function (request, parent, ...args) {
        if (parent?.filename === filename && Object.hasOwn(mocks, request)) return mocks[request];
        return original.call(this, request, parent, ...args);
    };
    try { return require(filename); }
    finally { Module._load = original; }
}

function offlineSharePoint() {
    return load('src\\services\\sharepoint.ts', {
        '../config': { getJiraMode: () => 'mock' },
        './graph': { getGraphClient: () => { throw new Error('No network allowed'); } },
    });
}

test('daily standup claims are unique, retain completed records and respect legacy Titles', async () => {
    const sp = offlineSharePoint();
    const fields = { Title: '501#2026-11-02', State: 'open' };
    const claims = await Promise.all([sp.claimStandupSession(fields), sp.claimStandupSession(fields)]);
    assert.equal(claims.filter(Boolean).length, 1);
    const winner = claims.find(Boolean);
    assert.equal(winner.fields.RunKey, fields.Title);
    await sp.updateItem('standupSessions', winner.id, { State: 'summarized' });
    assert.equal(await sp.claimStandupSession(fields), null);
    await sp.createItem('standupSessions', { Title: 'legacy', State: 'summarized' });
    assert.equal(await sp.claimStandupSession({ Title: 'legacy' }), null);
    assert.deepEqual(sp.LIST_SCHEMAS.standupSessions.columns.find(c => c.name === 'RunKey'),
        { name: 'RunKey', type: 'text', unique: true });
});

test('live standup claims handle unique-insert conflicts but never hide unrelated storage failures', async () => {
    let rows = [];
    let fail = false;
    const graph = {
        api(endpoint) {
            const request = {
                header() { return this; },
                get: async () => endpoint.includes('/items')
                    ? { value: endpoint.includes('fields%2FRunKey') ? rows : [] } : { id: 'site' },
                post: async body => {
                    if (fail) throw new Error('storage unavailable');
                    if (rows.length) throw Object.assign(new Error('duplicate key'), { statusCode: 409 });
                    const row = { id: 'winner', fields: body.fields };
                    rows.push(row);
                    return row;
                },
            };
            return request;
        },
    };
    const sp = load('src\\services\\sharepoint.ts', {
        '../config': {
            getJiraMode: () => 'live',
            getSharePointConfig: () => ({ siteUrl: 'https://example.test/sites/team', listsPrefix: 'SMA_' }),
        },
        './graph': { getGraphClient: () => graph },
    });
    const claims = await Promise.all([
        sp.claimStandupSession({ Title: 'daily' }), sp.claimStandupSession({ Title: 'daily' }),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(rows.length, 1);
    rows = [];
    fail = true;
    await assert.rejects(sp.claimStandupSession({ Title: 'failed' }), /storage unavailable/);
});

test('independent standup workers fan out once after competing for the same daily key', async () => {
    const sp = offlineSharePoint();
    const sessions = require('../src/services/session-store');
    let rosterReads = 0, release;
    const rosterGate = new Promise(resolve => { release = resolve; });
    let sends = 0;
    const member = {
        AadObjectId: 'dev', JiraAccountId: 'acc-dev', Role: 'SM',
        conversationReference: { conversation: { id: 'dm' } },
    };
    const mocks = {
        '../config': { getJiraMode: () => 'live', getScheduleConfig: () => ({ timezone: 'UTC', cutoffHours: 0 }) },
        '../services/sharepoint': sp,
        '../services/team-roster': {
            listTeamMembers: async () => {
                if (++rosterReads === 2) release();
                await rosterGate;
                return [member];
            },
            isReachable: () => true,
        },
        '../services/jira': { getJiraClient: () => ({
            getActiveSprint: async () => ({ id: 882001, name: 'Daily race' }),
            searchSprintIssues: async () => [{ key: 'SCRUM-1', assignee: { accountId: 'acc-dev' } }],
            getSprintSubtasks: async () => [],
        }) },
        '../services/proactive': { sendProactive: async () => { sends++; return { ok: true }; } },
        '../cards/standup-request.card': { buildStandupRequestCard: value => value },
    };
    const first = load('src\\handlers\\standup.ts', mocks);
    const second = load('src\\handlers\\standup.ts', mocks);
    try {
        const results = await Promise.all([
            first.triggerStandup({ source: 'http' }), second.triggerStandup({ source: 'cron' }),
        ]);
        assert.equal(sends, 1);
        assert.equal(results.filter(r => r.sentTo === 1).length, 1);
        assert.match(results.find(r => r.sentTo === 0).note, /already/);
        assert.equal((await sp.listItems('standupSessions')).length, 1);
    } finally { sessions.removeSession(sessions.makeStandupId(882001)); }
});

function migrationFixture(rows, columns = [], failUniqueOnce = false) {
    const writes = [];
    const graph = {
        api(endpoint) {
            return {
                get: async () => {
                    if (endpoint.endsWith('/columns')) return { value: columns };
                    if (endpoint.endsWith('page2')) return { value: rows.slice(1) };
                    return { value: rows.slice(0, 1), '@odata.nextLink': '/page2' };
                },
                post: async body => {
                    writes.push(['post', endpoint, body]);
                    const column = { id: 'run-key', ...body };
                    columns.push(column);
                    return column;
                },
                update: async body => {
                    writes.push(['update', endpoint, body]);
                    if (endpoint.includes('/items/')) {
                        const id = endpoint.split('/items/')[1].split('/')[0];
                        Object.assign(rows.find(r => r.id === id).fields, body);
                    } else {
                        if (failUniqueOnce) {
                            failUniqueOnce = false;
                            throw new Error('interrupted uniqueness update');
                        }
                        Object.assign(columns.find(c => c.id === 'run-key'), body);
                    }
                },
            };
        },
    };
    const { migrateStandupRunKeys } = load('src\\scripts\\setup-sharepoint.ts', {
        dotenv: { configDotenv() {} }, 'isomorphic-fetch': {},
        '../services/graph': {}, '../services/sharepoint': {}, '../config': {},
    });
    return { migrate: () => migrateStandupRunKeys(graph, 'site', 'list'), writes, rows };
}

test('standup migration backfills every page before enforcing uniqueness and can be rerun', async () => {
    const fixture = migrationFixture([
        { id: '1', fields: { Title: 'one' } }, { id: '2', fields: { Title: 'two' } },
    ]);
    await fixture.migrate();
    assert.deepEqual(fixture.rows.map(r => r.fields.RunKey), ['one', 'two']);
    assert.deepEqual(fixture.writes.at(-1), [
        'update', '/sites/site/lists/list/columns/run-key', { indexed: true, enforceUniqueValues: true },
    ]);
    const count = fixture.writes.length;
    await fixture.migrate();
    assert.equal(fixture.writes.length, count);
});

test('standup migration rejects duplicate, empty or mismatched legacy keys before any writes', async () => {
    for (const fields of [
        [{ Title: 'same' }, { Title: 'same' }],
        [{ Title: '' }],
        [{ Title: 'one', RunKey: 'other' }],
    ]) {
        const fixture = migrationFixture(fields.map((value, i) => ({ id: String(i), fields: value })));
        await assert.rejects(fixture.migrate(), /distinct nonempty Titles/);
        assert.equal(fixture.writes.length, 0);
    }
});

test('interrupted RunKey migration can resume without losing backfilled history', async () => {
    const fixture = migrationFixture([{ id: '1', fields: { Title: 'one', State: 'summarized' } }], [], true);
    await assert.rejects(fixture.migrate(), /interrupted uniqueness update/);
    assert.equal(fixture.rows[0].fields.RunKey, 'one');
    await fixture.migrate();
    assert.equal(fixture.rows[0].fields.State, 'summarized');
    assert.deepEqual(fixture.writes.at(-1)[2], { indexed: true, enforceUniqueValues: true });
    assert.equal(fixture.writes.filter(w => w[0] === 'post').length, 1);
});

function reportFixture(kind, states = new Map(), failure = true) {
    const selected = [], claims = [], logs = [], destinations = [];
    const current = { id: 3, name: 'Newest', endDate: '2020-03-01' };
    const jira = {
        getSprints: async state => state === 'closed'
            ? [current, { ...current, id: 2, endDate: '2020-02-01' }, { ...current, id: 1, endDate: '2020-01-01' }] : [],
        getActiveSprint: async () => current,
        searchSprintIssues: async id => { selected.push(id); return []; },
        getSprintSubtasks: async () => [],
    };
    const mocks = {
        '../config': { getScheduleConfig: () => ({ timezone: 'UTC' }) },
        '../services/jira': { getJiraClient: () => jira },
        '../services/sharepoint': {
            findByField: async (key, _field, value) => key === 'teamsConfig'
                ? [{ fields: { ConversationRef: '{"target":"channel"}' } }]
                : states.has(value) ? [{ fields: { State: states.get(value) } }] : [],
            listItems: async () => [],
            claimSprintReport: async id => { claims.push(id); return 'claim'; },
            updateItem: async () => {},
        },
        '../services/team-roster': { listTeamMembers: async () => [
            { Role: 'SM', conversationReference: { target: 'sm' } },
        ] },
        '../services/proactive': { sendProactive: async ref => {
            destinations.push(ref.target);
            return ref.target === 'sm' && !failure ? { ok: true }
                : { ok: false, error: `${ref.target}-connector-failed` };
        } },
    };
    const mod = load(`src\\handlers\\${kind}.ts`, mocks);
    const originalWarn = console.warn;
    return {
        selected, claims, destinations, logs,
        async run() {
            console.warn = (...args) => logs.push(args.join(' '));
            try {
                return kind === 'report' ? await mod.runSprintCloseReport()
                    : await mod.runSprintSummary({ force: true });
            } finally { console.warn = originalWarn; }
        },
    };
}

test('automatic close selection skips newer sent and claimed sprints without starving older unreported work', async () => {
    const fixture = reportFixture('report', new Map([
        ['sprint-close:3', 'sent'], ['sprint-close:2', 'claimed'],
    ]), false);
    assert.equal((await fixture.run()).uploaded, true);
    assert.deepEqual(fixture.selected, [1]);
    assert.deepEqual(fixture.claims, [1]);
});

test('explicitly failed close reports remain eligible for a new durable claim', async () => {
    const fixture = reportFixture('report', new Map([['sprint-close:3', 'failed']]), false);
    assert.equal((await fixture.run()).uploaded, true);
    assert.deepEqual(fixture.claims, [3]);
});

test('both report results and logs preserve channel and final fallback connector failures', async () => {
    for (const kind of ['report', 'sprint-summary']) {
        const fixture = reportFixture(kind);
        const result = await fixture.run();
        assert.equal(result.uploaded, false);
        for (const message of ['channel-connector-failed', 'sm-connector-failed']) {
            assert.ok(result.error.includes(message));
            assert.ok(result.note.includes(message));
            assert.ok(fixture.logs.some(log => log.includes(message)));
        }
        assert.deepEqual(fixture.destinations, ['channel', 'sm']);
    }
});

test('successful fallback does not retain an error result but still logs the failed channel send', async () => {
    for (const kind of ['report', 'sprint-summary']) {
        const fixture = reportFixture(kind, new Map(), false);
        const result = await fixture.run();
        assert.equal(result.uploaded, true);
        assert.equal(result.error, undefined);
        assert.equal(result.note, undefined);
        assert.ok(fixture.logs.some(log => log.includes('channel-connector-failed')));
    }
});

test('repeated booked cards safely return a stored-event link without another calendar request', async () => {
    for (const eventId of ['existing-event-123', 'id/with?query#fragment)[bad](javascript:alert(1))', undefined]) {
        const messages = [];
        let state = 'open', proposalId;
        const sm = { AadObjectId: 'sm', Role: 'SM' };
        const chase = load('src\\handlers\\chase.ts', {
            '../services/jira': {},
            '../services/team-roster': { getMemberByAadId: async () => null },
            '../services/helperMatcher': { findHelperForBlocker: async () => null },
            '../services/authorization': { requireScrumMaster: async () => sm, getScrumMaster: async () => sm },
            '../config': { getJiraMode: () => 'live', getScheduleConfig: () => ({ timezone: 'UTC' }) },
            '../cards/meeting-propose.card': { buildMeetingProposeCard: value => value },
            '../services/sharepoint': { findByField: async () => [{
                id: 'blocker', fields: { Title: 'T-1', State: state, MeetingEventId: state === 'booked' ? eventId : undefined },
            }] },
            '../services/calendar': {
                findUnblockSlots: async () => [{ startIso: '2030-01-01T10:00:00Z', endIso: '2030-01-01T10:30:00Z', label: 'Slot' }],
                createUnblockMeeting: () => { throw new Error('Must not rebook'); },
            },
            '../agent': { agentApplication: { authorization: {} } },
            '../services/proactive': { sendProactive: async (_ref, callback) => {
                await callback({ sendActivity: async activity => {
                    if (activity?.attachments) proposalId = activity.attachments[0].proposalId;
                    else messages.push(activity);
                } });
                return { ok: true };
            } },
        });
        const context = value => ({ activity: { value, getConversationReference: () => ({}) }, sendActivity: async () => {} });
        await chase.handleBlockerSubmit(context({ action: 'blocker.proposeSlots', blockerId: 'blocker', issueKey: 'T-1' }));
        for (let i = 0; i < 10 && !proposalId; i++) await new Promise(resolve => setImmediate(resolve));
        assert.ok(proposalId);
        state = 'booked';
        await chase.handleMeetingSubmit(context({
            action: 'meeting.book', proposalId,
            slot: '2030-01-01T10:00:00Z|2030-01-01T10:30:00Z',
        }));
        for (let i = 0; i < 10 && !messages.length; i++) await new Promise(resolve => setImmediate(resolve));
        assert.match(messages[0], /already booked/);
        if (eventId) {
            const encoded = messages[0].match(/\(https:\/\/outlook.office.com\/calendar\/item\/([^)]*)\)/)[1];
            assert.equal(decodeURIComponent(encoded), eventId);
            assert.ok(!messages[0].includes('](javascript:'));
        } else assert.ok(!messages[0].includes('https://'));
    }
});

test('each Functions retry delay exceeds its own real callback timeout', async () => {
    const timers = [];
    const previous = process.env.WEBSITE_TIME_ZONE;
    delete process.env.WEBSITE_TIME_ZONE;
    let timeout;
    try {
        load('azure-functions\\src\\index.ts', {
            '@azure/functions': { app: { timer: (name, options) => timers.push([name, options]) } },
            axios: { post: async (_url, _body, options) => { timeout = options.timeout; return { status: 200 }; } },
        });
        const callback = process.env.AGENT_CALLBACK_URL;
        process.env.AGENT_CALLBACK_URL = 'https://example.test';
        try {
            for (const [, options] of timers) {
                await options.handler({ isPastDue: false }, { log() {}, error() {} });
                assert.ok(options.retry.delayInterval.seconds * 1000 > timeout);
                assert.equal(options.retry.maxRetryCount, 3);
            }
        } finally {
            if (callback === undefined) delete process.env.AGENT_CALLBACK_URL;
            else process.env.AGENT_CALLBACK_URL = callback;
        }
    } finally {
        if (previous === undefined) delete process.env.WEBSITE_TIME_ZONE;
        else process.env.WEBSITE_TIME_ZONE = previous;
    }
});
