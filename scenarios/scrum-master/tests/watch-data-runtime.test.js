// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const path = require('node:path');

function load(file, mocks) {
    const filename = path.resolve(__dirname, '..', ...file.split(/[\\/]+/));
    const original = Module._load;
    delete require.cache[filename];
    Module._load = function (request, parent, isMain) {
        if (parent?.filename === filename && Object.hasOwn(mocks, request)) return mocks[request];
        return original.call(this, request, parent, isMain);
    };
    try { return require(filename); }
    finally { Module._load = original; }
}

function pagedSharePoint(emptyMiddlePage = false) {
    const requests = [];
    const graph = {
        api(url) {
            const request = { url, headers: {} };
            requests.push(request);
            return {
                header(name, value) { request.headers[name] = value; return this; },
                async get() {
                    if (url.startsWith('/sites/example.test:')) return { id: 'site' };
                    if (url.endsWith('page=3')) return { value: [{ id: '3', fields: { Title: 'third' } }] };
                    if (url.endsWith('page=2')) return {
                        value: emptyMiddlePage ? [] : [{ id: '2', fields: { Title: 'second' } }],
                        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/items?page=3',
                    };
                    return {
                        value: [{ id: '1', fields: { Title: 'first' } }],
                        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/items?page=2',
                    };
                },
            };
        },
    };
    const sharepoint = load('src\\services\\sharepoint.ts', {
        './graph': { getGraphClient: () => graph },
        '../config': {
            getJiraMode: () => 'live',
            getSharePointConfig: () => ({ siteUrl: 'https://example.test/sites/scrum', listsPrefix: 'SMA_' }),
        },
    });
    return { ...sharepoint, requests };
}

test('listItems follows every opaque nextLink, including after an empty page', async () => {
    const fixture = pagedSharePoint();
    assert.deepEqual((await fixture.listItems('helperRoster')).map(row => row.id), ['1', '2', '3']);
    assert.equal(fixture.requests[2].url, 'https://graph.microsoft.com/v1.0/items?page=2');
    const empty = pagedSharePoint(true);
    assert.deepEqual((await empty.listItems('standupSessions')).map(row => row.id), ['1', '3']);
});

test('findByField preserves non-indexed query Prefer header on every page and escapes filters', async () => {
    const fixture = pagedSharePoint();
    assert.equal((await fixture.findByField('standupResponses', 'StandupId', "s'1#2")).length, 3);
    const requests = fixture.requests.slice(1);
    for (const request of requests) {
        assert.equal(request.headers.Prefer, 'HonorNonIndexedQueriesWarningMayFailRandomly');
    }
    assert.ok(requests[0].url.includes(encodeURIComponent("fields/StandupId eq 's''1#2'")));
});

function warnFixture() {
    const rows = [];
    let rosterError = false;
    let noSm = false;
    let sendOk = false;
    let lookupError = false;
    let sendCalls = 0;
    const handler = load('src\\handlers\\warn.ts', {
        '../services/jira': {
            getJiraClient: () => ({
                getActiveSprint: async () => ({
                    id: 10, name: 'Sprint 10', startDate: '2020-01-01', endDate: '2020-01-14',
                }),
                searchSprintIssues: async () => [{ status: 'To Do', storyPoints: 3 }],
            }),
        },
        '../config': {
            getWarnConfig: () => ({ sprintProgressPct: 0.6, todoPct: 0.4 }),
            getScheduleConfig: () => ({ timezone: 'UTC' }),
        },
        '../services/sharepoint': {
            findByTitle: async (_key, title) => {
                if (lookupError) throw new Error('storage offline');
                return rows.find(row => row.fields.Title === title) ?? null;
            },
            createItem: async (_key, fields) => {
                const row = { id: String(rows.length + 1), fields: { ...fields } };
                rows.push(row);
                return row;
            },
            updateItem: async (_key, id, fields) => Object.assign(rows.find(row => row.id === id).fields, fields),
        },
        '../services/team-roster': {
            listTeamMembers: async () => {
                if (rosterError) throw new Error('roster offline');
                return noSm ? [] : [{ Role: 'SM', conversationReference: { target: 'sm' } }];
            },
        },
        '../services/proactive': {
            sendProactive: async (_ref, callback) => {
                sendCalls++;
                if (!sendOk) return { ok: false, error: 'DM unavailable' };
                await callback({ sendActivity: async () => {} });
                return { ok: true };
            },
        },
    });
    return {
        ...handler, rows,
        get sendCalls() { return sendCalls; },
        set rosterError(value) { rosterError = value; },
        set noSm(value) { noSm = value; },
        set sendOk(value) { sendOk = value; },
        set lookupError(value) { lookupError = value; },
    };
}

test('risk send failure propagates, retries the same detection, and dedups only confirmed delivery', async () => {
    const fixture = warnFixture();
    await assert.rejects(fixture.runWarnCheck(), /DM unavailable/);
    assert.equal(fixture.rows[0].fields.State, 'pending');
    assert.equal(fixture.rows[0].fields.DeliveredUtc, undefined);
    fixture.sendOk = true;
    await fixture.runWarnCheck();
    assert.equal(fixture.rows.length, 1);
    assert.equal(fixture.rows[0].fields.State, 'delivered');
    assert.ok(fixture.rows[0].fields.DeliveredUtc);
    await fixture.runWarnCheck();
    assert.equal(fixture.sendCalls, 2);
});

test('roster failure and missing SM remain retryable and explicitly fail the request', async () => {
    const fixture = warnFixture();
    fixture.rosterError = true;
    await assert.rejects(fixture.runWarnCheck(), /roster offline/);
    fixture.rosterError = false;
    fixture.noSm = true;
    await assert.rejects(fixture.runWarnCheck(), /No SM conversation reference/);
    fixture.noSm = false;
    fixture.sendOk = true;
    await fixture.runWarnCheck();
    assert.equal(fixture.rows.length, 1);
    assert.equal(fixture.sendCalls, 1);
});

test('storage lookup failure cannot bypass the delivery guard and legacy detection rows retry', async () => {
    const fixture = warnFixture();
    fixture.lookupError = true;
    await assert.rejects(fixture.runWarnCheck(), /storage offline/);
    assert.equal(fixture.rows.length, 0);
    fixture.lookupError = false;
    await assert.rejects(fixture.runWarnCheck(), /DM unavailable/);
    delete fixture.rows[0].fields.State;
    fixture.sendOk = true;
    await fixture.runWarnCheck();
    assert.equal(fixture.rows.length, 1);
    assert.equal(fixture.rows[0].fields.State, 'delivered');
});

test('forceAlert bypasses delivered daily dedup while still requiring successful delivery', async () => {
    const fixture = warnFixture();
    fixture.sendOk = true;
    await fixture.runWarnCheck();
    fixture.sendOk = false;
    await assert.rejects(fixture.runWarnCheck({ forceAlert: true }), /DM unavailable/);
    assert.equal(fixture.rows.length, 2);
    assert.equal(fixture.rows[1].fields.State, 'pending');
});

test('configured two-letter helper keywords use case-insensitive whole-word matching', async () => {
    const matcher = load('src\\services\\helperMatcher.ts', {
        './sharepoint': {
            listItems: async () => [{ fields: {
                Title: 'Design', Keywords: 'UX, design, a', HelperEmail: 'ux@example.test',
            } }],
        },
    });
    for (const text of ['UX', 'Blocked on ux.', 'Need (UX) review', 'UI/UX']) {
        assert.equal((await matcher.findHelperForBlocker(text))?.reason, 'Matched keyword "ux".', text);
    }
    for (const text of ['luxury feature', 'flux issue', 'ux2', 'ux_team', 'éuxé', 'a problem']) {
        assert.equal(await matcher.findHelperForBlocker(text), null, text);
    }
    assert.equal((await matcher.findHelperForBlocker('redesign required'))?.reason, 'Matched keyword "design".');
});

test('setup adds only missing risk-delivery fields on existing lists, reading all column pages', async () => {
    const writes = [];
    const graph = {
        api(url) {
            return {
                async get() {
                    if (url.endsWith('/columns')) return {
                        value: [{ name: 'Payload' }],
                        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/columns?page=2',
                    };
                    if (url.endsWith('page=2')) return { value: [{ name: 'DeliveredUtc' }] };
                    return { value: [{ id: 'existing-list' }] };
                },
                async post(body) { writes.push({ url, body }); },
            };
        },
    };
    const { provisionSharePoint } = load('src\\scripts\\setup-sharepoint.ts', {
        dotenv: { configDotenv() {} },
        'isomorphic-fetch': {},
        '../services/graph': {
            acquireTokenViaDeviceCode: async () => {},
            getGraphClient: () => graph,
        },
        '../services/sharepoint': {
            DOC_LIBRARY_NAME: 'SprintReports',
            LIST_NAMES: { sprintRisks: 'SprintRisks' },
            LIST_SCHEMAS: {
                sprintRisks: { columns: [
                    { name: 'Payload', type: 'note' },
                    { name: 'State', type: 'text' },
                    { name: 'DeliveredUtc', type: 'dateTime' },
                ] },
                standupSessions: { columns: [{ name: 'UnrelatedMissingColumn', type: 'text' }] },
            },
            getSiteId: async () => 'site',
        },
        '../config': { getSharePointConfig: () => ({ siteUrl: 'https://example.test', listsPrefix: 'SMA_' }) },
    });
    await provisionSharePoint();
    assert.deepEqual(writes, [{
        url: '/sites/site/lists/existing-list/columns',
        body: { name: 'State', text: {} },
    }]);
});
