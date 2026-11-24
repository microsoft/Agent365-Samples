// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const sessions = require('../src/services/session-store');

async function withModule(file, mocks, run) {
    const filename = require.resolve(file);
    const original = Module._load;
    delete require.cache[filename];
    Module._load = function (request, parent, ...args) {
        if (parent?.filename === filename && Object.hasOwn(mocks, request)) return mocks[request];
        return original.call(this, request, parent, ...args);
    };
    try { return await run(require(filename)); }
    finally { Module._load = original; delete require.cache[filename]; }
}

function storage() {
    const rows = new Map();
    const copy = value => structuredClone(value);
    const sp = {
        rows,
        findByTitle: async (list, title) => copy(rows.get(`${list}:${title}`) ?? null),
        findByField: async (list, field, value) => copy([...rows.entries()]
            .filter(([key, row]) => key.startsWith(`${list}:`) && row.fields[field] === value).map(([, row]) => row)),
        createItem: async (list, fields) => {
            const key = `${list}:${fields.Title}`;
            if (rows.has(key)) throw new Error('Duplicate key');
            const row = { id: key, fields: copy(fields) };
            rows.set(key, row);
            return copy(row);
        },
        claimItemState: async (_list, id, expected, next) => {
            const row = rows.get(id);
            if (!row || row.fields.State !== expected) return false;
            row.fields.State = next;
            return true;
        },
        updateItem: async (_list, id, fields) => {
            const row = rows.get(id);
            assert.ok(row, `Missing row ${id}`);
            Object.assign(row.fields, copy(fields));
            return copy(row);
        },
        claimStandupSession: async fields => {
            if (rows.has(`standupSessions:${fields.Title}`)) return null;
            return sp.createItem('standupSessions', fields);
        },
    };
    return sp;
}

let sprintId = 880000;
function fixture(send, sp = storage()) {
    const id = ++sprintId;
    const attempts = [];
    const members = ['a', 'b'].map(user => ({
        AadObjectId: user, JiraAccountId: user, Title: user,
        conversationReference: { conversation: { id: user, conversationType: 'personal' } },
    }));
    const issues = members.map(member => ({
        id: member.AadObjectId, key: `WORK-${member.AadObjectId}`, summary: 'Work',
        status: 'To Do', statusCategory: 'new', assignee: { accountId: member.JiraAccountId, displayName: member.Title },
        storyPoints: null, url: 'https://example.test', sprintId: id,
        dueDate: null, parentKey: null, issueType: 'Task',
    }));
    return {
        sp, attempts, id, members, issues,
        async run(callback, overrides = {}) {
            await withModule('../src/services/standup-delivery', { './sharepoint': sp }, async delivery => {
                await withModule('../src/handlers/standup', {
                    '../services/standup-delivery': delivery,
                    '../services/sharepoint': sp,
                    '../config': { getJiraMode: () => 'live', getScheduleConfig: () => ({ timezone: 'UTC', cutoffHours: 4 }) },
                    '../services/jira': { getJiraClient: () => ({
                        getActiveSprint: async () => ({ id, name: 'Delivery sprint' }),
                        searchSprintIssues: async () => issues,
                        getSprintSubtasks: async () => [],
                    }) },
                    '../services/team-roster': { listTeamMembers: async () => members, isReachable: () => true },
                    '../services/proactive': { sendProactive: async (ref, logic) => {
                        attempts.push(ref.conversation.id);
                        return send(ref.conversation.id, logic);
                    } },
                    '../cards/standup-request.card': { buildStandupRequestCard: value => value },
                    ...overrides,
                }, callback);
            });
        },
        cleanup() { sessions.removeSession(sessions.makeStandupId(id)); },
    };
}

const accepted = async logic => {
    await logic({ sendActivity: async () => {} });
    return { ok: true };
};

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('daily and explicit recovery share one restored session, fan-out and summary', async () => {
    const readStarted = deferred(), releaseRead = deferred(), summaryStarted = deferred(), releaseSummary = deferred();
    let recovering = false, summaries = 0, responseReads = 0;
    const reconciled = [];
    const f = fixture(async (_user, logic) => {
        if (!recovering) return accepted(logic);
        summaries++;
        summaryStarted.resolve();
        await releaseSummary.promise;
        await logic({
            activity: { getConversationReference: () => f.members[0].conversationReference },
            sendActivity: async () => {},
        });
        return { ok: true };
    });
    f.members[0].Role = 'SM';
    const id = sessions.makeStandupId(f.id);
    try {
        await f.run(async standup => { await standup.triggerStandup({ source: 'http' }); });
        for (const user of ['a', 'b']) {
            await f.sp.createItem('standupResponses', {
                Title: `${id}#${user}`, StandupId: id, UserAadId: user, SubmittedUtc: new Date().toISOString(),
                Items: JSON.stringify([{ issueKey: `WORK-${user}`, update: `Saved update ${user}`, hasBlocker: false }]),
            });
        }
        sessions.removeSession(id);
        recovering = true;
        const find = f.sp.findByField;
        f.sp.findByField = async (...args) => {
            const rows = await find(...args);
            if (args[0] === 'standupResponses') {
                responseReads++;
                readStarted.resolve();
                await releaseRead.promise;
            }
            return rows;
        };
        await f.run(async standup => {
            const daily = standup.triggerStandup({ source: 'http' });
            await readStarted.promise;
            const retry = standup.triggerStandup({ source: 'command', retryStandupId: id });
            await new Promise(resolve => setImmediate(resolve));
            releaseRead.resolve();
            await summaryStarted.promise;
            const canonical = sessions.getSession(id);
            assert.equal(canonical.responses.size, 2);
            releaseSummary.resolve();
            await Promise.all([daily, retry]);
            assert.equal(responseReads, 1);
            assert.equal(summaries, 1);
            assert.deepEqual(reconciled, [canonical]);
            assert.equal(sessions.getSession(id), undefined);
            assert.ok(sessions.getCompletedSession(id));
        }, {
            './reconcile': { reconcileAfterStandup: async session => {
                reconciled.push(session);
                return { autoApplied: [], needsConfirm: [], errors: [] };
            } },
            './chase': { chaseAfterStandup: async () => {} },
        });
    } finally { releaseRead.resolve(); releaseSummary.resolve(); f.cleanup(); }
});

test('a late restore preserves an installed session and never resurrects a completed run', async () => {
    for (const completed of [false, true]) {
        const f = fixture((_user, logic) => accepted(logic));
        const readStarted = deferred(), releaseRead = deferred();
        const id = sessions.makeStandupId(f.id);
        try {
            let original;
            await f.run(async standup => {
                await standup.triggerStandup({ source: 'http' });
                original = sessions.getSession(id);
            });
            sessions.removeSession(id);
            const find = f.sp.findByField;
            f.sp.findByField = async (...args) => {
                const rows = await find(...args);
                if (args[0] === 'standupResponses') {
                    readStarted.resolve();
                    await releaseRead.promise;
                }
                return rows;
            };
            await f.run(async standup => {
                const restore = standup.triggerStandup({ source: 'http' });
                await readStarted.promise;
                if (completed) {
                    sessions.completeSession(original);
                } else {
                    original.responses.set('a', {
                        userAadId: 'a', submittedUtc: new Date().toISOString(),
                        items: [{ issueKey: 'WORK-a', update: 'Accepted during restore', hasBlocker: false }],
                    });
                    sessions.upsertSession(original);
                }
                releaseRead.resolve();
                await restore;
                if (completed) {
                    assert.equal(sessions.getSession(id), undefined);
                    assert.ok(sessions.getCompletedSession(id));
                } else {
                    assert.equal(sessions.getSession(id), original);
                    assert.equal(original.responses.get('a').items[0].update, 'Accepted during restore');
                }
                assert.deepEqual(f.attempts, ['a', 'b']);
            });
        } finally { releaseRead.resolve(); f.cleanup(); }
    }
});

test('partial fan-out fails and retries only the undelivered member across process restart', async () => {
    let failB = true;
    const f = fixture((user, logic) => user === 'b' && failB
        ? { ok: false, error: 'Adapter unavailable before send' } : accepted(logic));
    try {
        await f.run(async standup => {
            await assert.rejects(standup.triggerStandup({ source: 'http' }), /fan-out incomplete.*Adapter unavailable/);
            const id = sessions.makeStandupId(f.id);
            assert.equal(f.sp.rows.get(`standupDeliveries:${id}#a`).fields.State, 'sent');
            assert.equal(f.sp.rows.get(`standupDeliveries:${id}#b`).fields.State, 'pending');
            assert.deepEqual(f.attempts, ['a', 'b']);
            await f.sp.createItem('standupResponses', {
                Title: `${id}#a`, StandupId: id, UserAadId: 'a', SubmittedUtc: new Date().toISOString(),
                Items: JSON.stringify([{ issueKey: 'WORK-a', update: 'Recorded before restart', hasBlocker: false }]),
            });
            sessions.removeSession(id);
        });
        failB = false;
        await f.run(async standup => {
            const messages = [];
            const result = await standup.triggerStandup({
                source: 'command', retryStandupId: sessions.makeStandupId(f.id),
                turnContext: { sendActivity: async message => messages.push(message) },
            });
            assert.equal(result.sentTo, 2);
            assert.equal(sessions.getSession(result.standupId).responses.get('a').items[0].update, 'Recorded before restart');
            assert.deepEqual(f.attempts, ['a', 'b', 'b']);
            assert.equal(messages.length, 1);
            assert.match(messages[0], /collecting/);
            await standup.triggerStandup({ source: 'http' });
            assert.deepEqual(f.attempts, ['a', 'b', 'b']);
        });
    } finally { f.cleanup(); }
});

test('all failed request sends keep throwing until daily retry succeeds without deleting the run claim', async () => {
    let fail = true;
    const f = fixture((_user, logic) => fail ? { ok: false, error: 'Connector unavailable' } : accepted(logic));
    try {
        await f.run(async standup => {
            for (let i = 0; i < 2; i++) {
                await assert.rejects(standup.triggerStandup({ source: 'http' }), /fan-out incomplete/);
            }
            assert.deepEqual(f.attempts, ['a', 'b', 'a', 'b']);
            fail = false;
            const result = await standup.triggerStandup({ source: 'http' });
            assert.equal(result.sentTo, 2);
            assert.equal([...f.sp.rows.keys()].filter(key => key.startsWith('standupSessions:')).length, 1);
        });
    } finally { f.cleanup(); }
});

test('uncertain request acceptance is retained across restart and never replayed', async () => {
    for (const status of [undefined, 408, 500]) {
        const f = fixture(async (_user, logic) => {
            try {
                await logic({ sendActivity: async () => { throw Object.assign(new Error('Acknowledgement lost'), { statusCode: status }); } });
            } catch (error) { return { ok: false, error: error.message }; }
        });
        try {
            await f.run(async standup => {
                await assert.rejects(standup.triggerStandup({ source: 'http' }), /is uncertain/);
                sessions.removeSession(sessions.makeStandupId(f.id));
            });
            await f.run(async standup => {
                await assert.rejects(standup.triggerStandup({ source: 'http' }), /claimed or uncertain/);
                assert.deepEqual(f.attempts, ['a', 'b']);
            });
        } finally { f.cleanup(); }
    }
});

test('confirmed rejection is retryable and competing workers never send a member twice', async () => {
    const sp = storage();
    await withModule('../src/services/standup-delivery', { './sharepoint': sp }, async delivery => {
        let sends = 0, release;
        const held = new Promise(resolve => { release = resolve; });
        const first = delivery.deliverStandupRequest('run', 'user', async started => {
            sends++;
            started();
            await held;
            return { ok: true };
        });
        await new Promise(resolve => setImmediate(resolve));
        await assert.rejects(delivery.deliverStandupRequest('run', 'user', async () => { sends++; }), /claimed or uncertain/);
        release();
        await first;
        await delivery.deliverStandupRequest('run', 'user', async () => { sends++; });
        assert.equal(sends, 1);
        await assert.rejects(delivery.deliverStandupRequest('other', 'user', async (started, rejected) => {
            started(); rejected();
            return { ok: false, error: '403 rejected' };
        }), /failed; retry/);
        await delivery.deliverStandupRequest('other', 'user', async started => { started(); return { ok: true }; });
        assert.equal(sp.rows.get('standupDeliveries:other#user').fields.State, 'sent');
        const update = sp.updateItem;
        sp.updateItem = async (...args) => {
            if (args[2].State === 'sent') throw new Error('Persistence unavailable after send');
            return update(...args);
        };
        await assert.rejects(delivery.deliverStandupRequest('persistence', 'user', async started => {
            started(); return { ok: true };
        }), /uncertain/);
        await assert.rejects(delivery.deliverStandupRequest('persistence', 'user', async () => {
            assert.fail('An accepted card must not be replayed after persistence failure');
        }), /claimed or uncertain/);
    });
});

test('mock chase uses the supplied local callback for owner and SM, while live ignores it', async () => {
    for (const mode of ['mock', 'live']) {
        const destinations = [];
        await withModule('../src/handlers/chase', {
            '../config': { getJiraMode: () => mode },
            '../agent': {},
            '../services/sharepoint': { findByField: async () => [{
                id: 'blocker', fields: { Title: 'WORK-a', State: 'open', OwnerAadId: 'owner', ReporterAadId: 'reporter' },
            }] },
            '../services/team-roster': { listTeamMembers: async () => [
                { AadObjectId: 'owner', conversationReference: { target: 'owner' } },
                { AadObjectId: 'sm', Role: 'SM', conversationReference: { target: 'sm' } },
            ] },
            '../services/jira': { getJiraClient: () => ({ getIssue: async () => ({ summary: 'Work', status: 'To Do', url: '' }) }) },
            '../services/proactive': { sendProactive: async (ref, logic) => {
                assert.equal(mode, 'live', 'Mock chase must not require hosting credentials');
                destinations.push(`live:${ref.target}`);
                return accepted(logic);
            } },
        }, async chase => {
            const session = { standupId: 'mock-run', sprintName: 'Sprint' };
            const local = async (ref, logic) => {
                assert.equal(mode, 'mock');
                destinations.push(`local:${ref.target}`);
                return accepted(logic);
            };
            await chase.chaseAfterStandup(session, local);
            await chase.chaseAfterStandup(session, local);
            assert.deepEqual(destinations, [`${mode === 'mock' ? 'local' : 'live'}:owner`, `${mode === 'mock' ? 'local' : 'live'}:sm`]);
        });
    }
});

test('a two-person Playground standup delivers both personal requests and completes local blocker chase', async () => {
    const { CloudAdapter, TurnContext } = require('@microsoft/agents-hosting');
    const { Activity } = require('@microsoft/agents-activity');
    const sp = storage();
    const id = ++sprintId;
    const standupId = sessions.makeStandupId(id);
    const reference = {
        serviceUrl: 'http://localhost:5000', channelId: 'emulator',
        conversation: { id: 'playground', conversationType: 'personal' },
        agent: { id: 'bot' }, user: { id: 'caller' },
    };
    const member = { AadObjectId: 'caller', JiraAccountId: 'caller', Title: 'Caller', Role: 'SM', conversationReference: reference };
    const otherReference = { ...reference, conversation: { ...reference.conversation, id: 'other-playground' }, user: { id: 'other' } };
    const otherMember = { ...member, AadObjectId: 'other', JiraAccountId: 'other', Title: 'Other', Role: 'Dev', conversationReference: otherReference };
    const issue = {
        id: '1', key: 'WORK-1', summary: 'Work', status: 'To Do', statusCategory: 'new',
        assignee: { accountId: 'caller', displayName: 'Caller' }, storyPoints: null,
        url: 'https://example.test/WORK-1', sprintId: id, dueDate: null, parentKey: null, issueType: 'Task',
    };
    const otherIssue = { ...issue, id: '2', key: 'WORK-2', assignee: { accountId: 'other', displayName: 'Other' } };
    const common = {
        '../config': { getJiraMode: () => 'mock', getScheduleConfig: () => ({ timezone: 'UTC', cutoffHours: 4 }) },
        '../services/sharepoint': sp,
        '../services/jira': { getJiraClient: () => ({
            getActiveSprint: async () => ({ id, name: 'Offline sprint' }),
            searchSprintIssues: async () => [issue, otherIssue], getSprintSubtasks: async () => [],
            getIssue: async () => issue, addComment: async () => {},
        }) },
        '../services/team-roster': { listTeamMembers: async () => [member, otherMember], upsertConversationReference: async () => {}, isReachable: () => true },
        '../services/proactive': { sendProactive: () => { assert.fail('Mock flows must never use live proactive authentication'); } },
        '../agent': {},
    };
    const activities = [];
    const adapter = new CloudAdapter({});
    adapter.sendActivities = async (_context, messages) => {
        activities.push(...messages);
        return messages.map(() => ({ id: 'offline' }));
    };
    const runTurn = async (value, logic) => {
        const activity = Activity.fromObject({
            type: 'message', from: reference.user, recipient: reference.agent,
            conversation: reference.conversation, serviceUrl: reference.serviceUrl, channelId: 'emulator', value,
        });
        let proxy;
        await adapter.runMiddleware(new TurnContext(adapter, activity, {}), async context => {
            proxy = context;
            await logic(context);
        });
        assert.throws(() => proxy.activity, /revoked/);
    };
    try {
        await withModule('../src/services/standup-delivery', { './sharepoint': sp }, async delivery => {
            await withModule('../src/handlers/chase', common, async chase => {
                await withModule('../src/handlers/standup', {
                    ...common,
                    '../services/standup-delivery': delivery,
                    './chase': chase,
                    './reconcile': { reconcileAfterStandup: async () => ({ autoApplied: [], needsConfirm: [], errors: [] }) },
                }, async standup => {
                    await runTurn(undefined, context => standup.triggerStandup({ source: 'command', turnContext: context }));
                    const session = sessions.getSession(standupId);
                    assert.deepEqual([...session.sentTo], ['caller', 'other']);
                    assert.ok(activities.some(activity => activity.conversation?.id === 'other-playground'));
                    session.responses.set('caller', {
                        userAadId: 'caller', submittedUtc: new Date().toISOString(),
                        items: [{ issueKey: issue.key, update: 'Blocked by dependency', hasBlocker: true, blockerText: 'Dependency' }],
                    });
                    session.responses.set('other', {
                        userAadId: 'other', submittedUtc: new Date().toISOString(),
                        items: [{ issueKey: otherIssue.key, update: 'Working on it', hasBlocker: false }],
                    });
                    await sp.createItem('blockers', {
                        Title: issue.key, StandupId: standupId, OwnerAadId: 'caller', ReporterAadId: 'caller',
                        BlockerText: 'Dependency', State: 'open',
                    });
                    await standup.summarizeStandup(session);
                    assert.equal(session.state, 'summarized');
                    assert.equal(session.chaseState, 'complete');
                    assert.equal(sessions.getSession(standupId), undefined);
                    assert.ok(activities.some(activity => activity.attachments?.[0]?.content.actions?.some(
                        action => action.data?.action === 'blocker.proposeSlots')));
                });
            });
        });
    } finally { sessions.removeSession(standupId); }
});
