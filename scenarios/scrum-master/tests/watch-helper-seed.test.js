// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');

async function load(file, mocks, run) {
    const filename = require.resolve(file);
    const original = Module._load;
    delete require.cache[filename];
    Module._load = function (request, parent, isMain) {
        if (parent?.filename === filename && Object.hasOwn(mocks, request)) return mocks[request];
        return original.call(this, request, parent, isMain);
    };
    try { return await run(require(filename)); }
    finally { Module._load = original; delete require.cache[filename]; }
}

test('shipped helper seed order routes design review to Design rather than Security', async () => {
    const rows = [];
    await load('../src/scripts/seed-helper-roster', {
        dotenv: { configDotenv() {} },
        'isomorphic-fetch': {},
        '../services/graph': {
            acquireTokenSilentForGraph: async () => {},
            getGraphClient: () => ({ api: () => ({ get: async () => ({ value: [{ id: 'existing' }] }) }) }),
        },
        '../config': { getSharePointConfig: () => ({ listsPrefix: 'SMA_' }) },
        '../services/sharepoint': {
            LIST_NAMES: { helperRoster: 'HelperRoster' },
            LIST_SCHEMAS: { helperRoster: {} }, getSiteId: async () => 'site',
            upsertItem: async (_list, fields) => { rows.push({ fields }); },
        },
    }, async () => {
        for (let i = 0; i < 10 && rows.length < 3; i++) await new Promise(resolve => setImmediate(resolve));
    });
    assert.equal(rows.length, 3);
    assert.equal(rows[1].fields.Title, 'Security / Compliance');
    await load('../src/services/helperMatcher', {
        './sharepoint': { listItems: async () => rows },
    }, async matcher => {
        const design = await matcher.findHelperForBlocker('Waiting on design review');
        assert.equal(design.email, 'dana@contoso.com');
        const security = await matcher.findHelperForBlocker('Waiting on security review');
        assert.equal(security.email, 'sam@contoso.com');
    });
});
