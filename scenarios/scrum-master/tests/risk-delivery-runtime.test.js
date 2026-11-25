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

function sharepoint(graph) {
    return load('src\\services\\sharepoint.ts', {
        './graph': { getGraphClient: () => graph },
        '../config': {
            getJiraMode: () => graph ? 'live' : 'mock',
            getSharePointConfig: () => ({ siteUrl: 'https://example.test/sites/scrum', listsPrefix: 'SMA_' }),
        },
    });
}

function warning(sp, sendProactive) {
    return load('src\\handlers\\warn.ts', {
        '../services/sharepoint': sp,
        '../services/jira': { getJiraClient: () => ({
            getActiveSprint: async () => ({
                id: 91, name: 'Sprint 91', startDate: '2020-01-01', endDate: '2020-01-14',
            }),
            searchSprintIssues: async () => [{ status: 'To Do', storyPoints: 3 }],
        }) },
        '../config': {
            getWarnConfig: () => ({ sprintProgressPct: 0.6, todoPct: 0.4 }),
            getScheduleConfig: () => ({ timezone: 'UTC' }),
        },
        '../services/team-roster': { listTeamMembers: async () => [
            { Role: 'SM', conversationReference: { target: 'sm' } },
        ] },
        '../services/proactive': { sendProactive },
    });
}

function dailyFields() {
    return {
        Title: `91#${new Date().toISOString().slice(0, 10)}`,
        SprintId: '91', DetectedUtc: new Date().toISOString(), State: 'pending',
    };
}

test('overlapping risk runs send once for both pending and simultaneous initial detections', async () => {
    for (const preexisting of [false, true]) {
        const sp = sharepoint();
        if (preexisting) await sp.createItem('sprintRisks', dailyFields());
        let sends = 0;
        const handler = warning(sp, async (_ref, callback) => {
            await callback({ sendActivity: async () => { sends++; } });
            return { ok: true };
        });
        await Promise.all([handler.runWarnCheck(), handler.runWarnCheck(), handler.runWarnCheck()]);
        assert.equal(sends, 1);
        const rows = await sp.listItems('sprintRisks');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].fields.State, 'delivered');
        if (!preexisting) assert.equal(rows[0].fields.RiskKey, dailyFields().Title);
    }
});

test('confirmed risk send rejection releases the claim and permits exactly one retry', async () => {
    for (const status of [undefined, 400, 401, 403, 404, 429]) {
        const sp = sharepoint();
        let attempts = 0;
        const handler = warning(sp, async (_ref, callback) => {
            attempts++;
            if (attempts === 1) {
                if (status !== undefined) {
                    await assert.rejects(callback({ sendActivity: async () => {
                        throw Object.assign(new Error('connector rejection'), { statusCode: status });
                    } }), /connector rejection/);
                }
                return { ok: false, error: 'connector rejection' };
            }
            await callback({ sendActivity: async () => {} });
            return { ok: true };
        });
        await assert.rejects(handler.runWarnCheck(), /connector rejection/);
        assert.equal((await sp.listItems('sprintRisks'))[0].fields.State, 'pending');
        await Promise.all([handler.runWarnCheck(), handler.runWarnCheck()]);
        assert.equal(attempts, 2);
        assert.equal((await sp.listItems('sprintRisks'))[0].fields.State, 'delivered');
    }
});

test('ambiguous risk sends and failures after accepted sends retain the claim without replay', async () => {
    for (const outcome of ['transport', 'timeout', 'server', 'after-send', 'throw-after-send', 'persist', 'persist-applied']) {
        const sp = sharepoint();
        let sends = 0;
        const handler = warning({
            ...sp,
            updateItem: async (...args) => {
                if (outcome === 'persist-applied') await sp.updateItem(...args);
                if (outcome.startsWith('persist')) throw new Error('persistence failed');
                return sp.updateItem(...args);
            },
        }, async (_ref, callback) => {
            try {
                await callback({ sendActivity: async () => {
                    sends++;
                    if (['transport', 'timeout', 'server'].includes(outcome)) {
                        throw Object.assign(new Error('uncertain send'), {
                            statusCode: outcome === 'timeout' ? 408 : outcome === 'server' ? 503 : undefined,
                        });
                    }
                } });
            } catch (error) {
                return { ok: false, error: error.message };
            }
            if (outcome === 'throw-after-send') throw new Error('post-send adapter failure');
            if (outcome === 'after-send') return { ok: false, error: 'post-send adapter failure' };
            return { ok: true };
        });
        await assert.rejects(handler.runWarnCheck(), /uncertain send|post-send adapter failure|persistence failed/);
        await handler.runWarnCheck();
        assert.equal(sends, 1, outcome);
        assert.equal((await sp.listItems('sprintRisks'))[0].fields.State,
            outcome === 'persist-applied' ? 'delivered' : 'claimed', outcome);
    }
});

test('concurrent explicit forced alerts use independent keys even within one millisecond', async () => {
    const sp = sharepoint();
    let sends = 0;
    const handler = warning(sp, async (_ref, callback) => {
        await callback({ sendActivity: async () => { sends++; } });
        return { ok: true };
    });
    const originalNow = Date.now;
    Date.now = () => 1800000000000;
    try {
        await Promise.all([handler.runWarnCheck({ forceAlert: true }), handler.runWarnCheck({ forceAlert: true })]);
    } finally { Date.now = originalNow; }
    assert.equal(sends, 2);
    const rows = await sp.listItems('sprintRisks');
    assert.equal(new Set(rows.map(row => row.fields.RiskKey)).size, 2);
});

function liveRiskGraph({ pending = false, missingEtag = false, failInsert = false, ambiguousInsert = false } = {}) {
    const rows = pending ? [{ id: '1', fields: dailyFields(), version: 1 }] : [];
    const writes = [];
    return {
        rows, writes,
        api(endpoint) {
            const headers = {};
            return {
                header(name, value) { headers[name] = value; return this; },
                async get() {
                    if (endpoint.startsWith('/sites/example.test:')) return { id: 'site' };
                    const itemId = endpoint.match(/\/items\/(\d+)/)?.[1];
                    if (itemId) {
                        const row = rows.find(r => r.id === itemId);
                        return { fields: { ...row.fields }, ...(missingEtag ? {} : { eTag: String(row.version) }) };
                    }
                    const filter = decodeURIComponent(endpoint).match(/fields\/(Title|RiskKey) eq '([^']+)'/);
                    return { value: rows.filter(row => !filter || row.fields[filter[1]] === filter[2])
                        .map(row => ({ id: row.id, fields: { ...row.fields } })) };
                },
                async post({ fields }) {
                    if (failInsert) throw new Error('storage offline');
                    if (rows.some(row => row.fields.RiskKey === fields.RiskKey)) {
                        throw Object.assign(new Error('duplicate RiskKey'), { statusCode: 409 });
                    }
                    const row = { id: String(rows.length + 1), fields: { ...fields }, version: 1 };
                    rows.push(row);
                    if (ambiguousInsert) throw new Error('insert response lost');
                    return { id: row.id, fields: { ...row.fields } };
                },
                async update(fields) {
                    const id = endpoint.match(/\/items\/(\d+)/)[1];
                    const row = rows.find(r => r.id === id);
                    writes.push({ headers: { ...headers }, fields: { ...fields } });
                    if (headers['If-Match'] && headers['If-Match'] !== String(row.version)) {
                        throw Object.assign(new Error('stale claim'), { statusCode: 412 });
                    }
                    Object.assign(row.fields, fields);
                    row.version++;
                },
            };
        },
    };
}

test('independent live workers send once using unique insertion and ETag delivery claims', async () => {
    for (const pending of [false, true]) {
        const graph = liveRiskGraph({ pending });
        const firstSp = sharepoint(graph);
        const secondSp = sharepoint(graph);
        let sends = 0;
        const send = async (_ref, callback) => {
            await callback({ sendActivity: async () => { sends++; } });
            return { ok: true };
        };
        const first = warning(firstSp, send);
        const second = warning(secondSp, send);
        await Promise.all([first.runWarnCheck(), second.runWarnCheck()]);
        assert.equal(sends, 1);
        assert.equal(graph.rows.length, 1);
        assert.equal(graph.rows[0].fields.State, 'delivered');
        if (pending) {
            const claims = graph.writes.filter(write => write.fields.State === 'claimed');
            assert.equal(claims.length, 2);
            assert.ok(claims.every(write => write.headers['If-Match'] === '1'));
        }
    }
});

test('live risk claims fail closed on missing ETags, failed inserts, and uncertain successful inserts', async () => {
    for (const options of [{ pending: true, missingEtag: true }, { failInsert: true }, { ambiguousInsert: true }]) {
        const graph = liveRiskGraph(options);
        let sends = 0;
        const handler = warning(sharepoint(graph), async () => { sends++; return { ok: true }; });
        if (options.ambiguousInsert) {
            await handler.runWarnCheck();
            await handler.runWarnCheck();
            assert.equal(graph.rows[0].fields.State, 'claimed');
        } else {
            await assert.rejects(handler.runWarnCheck(), /ETag|storage offline/);
        }
        assert.equal(sends, 0);
    }
});

test('legacy risk states missing, null, and empty are conditionally claimed in live mode', async () => {
    for (const state of [undefined, null, '']) {
        const graph = liveRiskGraph({ pending: true });
        graph.rows[0].fields.State = state;
        let sends = 0;
        const handler = warning(sharepoint(graph), async (_ref, callback) => {
            await callback({ sendActivity: async () => { sends++; } });
            return { ok: true };
        });
        await handler.runWarnCheck();
        await handler.runWarnCheck();
        assert.equal(sends, 1);
        assert.equal(graph.writes[0].headers['If-Match'], '1');
    }
});

function migrationFixture(fields, { failBackfill = false, failUnique = false } = {}) {
    const rows = fields.map((value, index) => ({ id: String(index + 1), fields: { ...value } }));
    const columns = [{ id: 'payload', name: 'Payload' }, { id: 'delivered', name: 'DeliveredUtc' }];
    const writes = [];
    const graph = {
        api(endpoint) {
            return {
                async get() {
                    if (endpoint.endsWith('/columns')) return {
                        value: columns.slice(0, 1), '@odata.nextLink': '/columns-page2',
                    };
                    if (endpoint === '/columns-page2') return { value: columns.slice(1) };
                    if (endpoint === '/items-page2') return { value: rows.slice(1) };
                    return { value: rows.slice(0, 1), '@odata.nextLink': '/items-page2' };
                },
                async post(body) {
                    writes.push({ endpoint, body });
                    const column = { id: body.name, ...body };
                    columns.push(column);
                    return column;
                },
                async update(body) {
                    writes.push({ endpoint, body });
                    const itemId = endpoint.match(/\/items\/(\d+)/)?.[1];
                    if (itemId) {
                        if (failBackfill) { failBackfill = false; throw new Error('backfill interrupted'); }
                        Object.assign(rows.find(row => row.id === itemId).fields, body);
                    } else {
                        if (failUnique) { failUnique = false; throw new Error('uniqueness interrupted'); }
                        Object.assign(columns.find(column => column.id === 'RiskKey'), body);
                    }
                },
            };
        },
    };
    const setup = load('src\\scripts\\setup-sharepoint.ts', {
        dotenv: { configDotenv() {} }, 'isomorphic-fetch': {},
        '../services/graph': {}, '../services/sharepoint': {}, '../config': {},
    });
    return { rows, columns, writes, migrate: () => setup.migrateSprintRiskKeys(graph, 'site', 'risks') };
}

test('risk migration backfills all pages before enforcing uniqueness, preserving delivery history', async () => {
    const fields = dailyFields();
    const forced = { ...fields, Title: `${fields.Title}#12345678`, State: 'delivered', DeliveredUtc: fields.DetectedUtc };
    for (const interruptions of [{}, { failBackfill: true }, { failUnique: true }]) {
        const fixture = migrationFixture([fields, forced], interruptions);
        if (interruptions.failBackfill || interruptions.failUnique) {
            await assert.rejects(fixture.migrate(), /interrupted/);
        }
        await fixture.migrate();
        assert.deepEqual(fixture.rows.map(row => row.fields.RiskKey), [fields.Title, forced.Title]);
        assert.equal(fixture.rows[0].fields.State, 'pending');
        assert.equal(fixture.rows[1].fields.State, 'delivered');
        assert.equal(fixture.rows[1].fields.DeliveredUtc, forced.DeliveredUtc);
        assert.deepEqual(fixture.writes.at(-1), {
            endpoint: '/sites/site/lists/risks/columns/RiskKey',
            body: { indexed: true, enforceUniqueValues: true },
        });
        assert.equal(fixture.writes.filter(write => write.body.name === 'DeliveredUtc').length, 0);
        const count = fixture.writes.length;
        await fixture.migrate();
        assert.equal(fixture.writes.length, count);
    }
});

test('risk migration conflicts on later pages abort without schema or record mutations', async () => {
    const fields = dailyFields();
    for (const conflict of [
        { ...fields }, { ...fields, Title: '' }, { ...fields, Title: 'malformed' },
        { ...fields, Title: `${fields.Title}#forced`, RiskKey: 'other' },
        { ...fields, Title: `${fields.Title}#forced`, SprintId: '92' },
        { ...fields, Title: `${fields.Title}#forced`, DetectedUtc: '2000-01-01' },
    ]) {
        const fixture = migrationFixture([fields, conflict]);
        await assert.rejects(fixture.migrate(), /distinct canonical Titles/);
        assert.equal(fixture.writes.length, 0);
        assert.equal(fixture.rows[0].fields.RiskKey, undefined);
    }
});
