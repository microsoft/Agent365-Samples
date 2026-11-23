// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const { Activity } = require('@microsoft/agents-activity');
const { CloudAdapter, TurnContext } = require('@microsoft/agents-hosting');
const {
    buildStandupSummaryCard, splitStandupSummaryActivity, STANDUP_ACTIVITY_BYTE_BUDGET,
} = require('../src/cards/standup-summary.card');

const reference = {
    channelId: 'msteams', serviceUrl: 'https://smba.trafficmanager.net/teams/',
    conversation: { id: '19:channel@thread.tacv2', tenantId: 'tenant', conversationType: 'channel' },
    agent: { id: 'bot', name: 'Scrum master' }, user: { id: 'user', name: 'User' },
};
const size = value => Buffer.byteLength(
    typeof value.toJsonString === 'function' ? value.toJsonString() : JSON.stringify(value), 'utf8');
function params(people, count, text) {
    return {
        sprintName: 'Sprint 42', dateLocal: 'Tuesday, 10 November', respondedCount: people,
        expectedCount: people + 1,
        updatesByPerson: Array.from({ length: people }, (_, person) => ({
            displayName: `Owner ${person}`,
            items: Array.from({ length: count }, (_, issue) => ({
                issueKey: `SCRUM-${person * count + issue}`, url: 'https://jira.invalid/issue',
                title: 'Build something', statusFrom: 'In Progress',
                update: text, blockerText: person === 0 && issue === 0 ? 'Dependency' : undefined,
            })),
        })),
        missed: [{ displayName: 'Absent', neverInstalled: true }], blockers: [],
        scrumMaster: { aadId: 'sm-aad-id', displayName: 'Alex' },
    };
}
function activity(p, ref = reference) {
    return Activity.fromObject({ type: 'message', attachments: [buildStandupSummaryCard(p)] })
        .applyConversationReference(ref);
}
function cells(parts, column) {
    return parts.flatMap(part => part.attachments[0].content.body
        .filter(element => element.type === 'Table')
        .flatMap(table => table.rows.slice(1).map(row => row.cells[column].items[0].text)));
}
function assertBounded(parts) {
    for (const part of parts) {
        assert.ok(size(part) <= STANDUP_ACTIVITY_BYTE_BUDGET, `${size(part)} bytes`);
        assert.ok(size(part) < 100_000);
    }
}

test('normal summary keeps its exact UX, including missed responders and blocker mention', () => {
    const original = activity(params(1, 1, 'Done'));
    assert.deepEqual(splitStandupSummaryActivity(original), [original]);
    assert.match(JSON.stringify(original), /<at>Alex<\/at>/);
    assert.equal(original.attachments[0].content.msteams.entities[0].mentioned.id, 'sm-aad-id');
});

for (const [label, text] of [
    ['10x10x1200 ASCII', 'a'.repeat(1200)],
    ['multibyte Unicode', '漢字🚀e\u0301'.repeat(500)],
    ['JSON-escaped characters', '"\\\n\t'.repeat(500)],
]) {
    test(`${label} splits complete activities with no lost updates`, () => {
        const p = params(10, 10, text);
        const original = activity(p);
        assert.ok(size(original) > 100_000);
        const parts = splitStandupSummaryActivity(original);
        assert.ok(parts.length > 1);
        assertBounded(parts);
        assert.deepEqual(cells(parts, 4), Array(100).fill(text));
        assert.deepEqual(cells(parts, 0), p.updatesByPerson.flatMap(person => person.items.map(() => person.displayName)));
        assert.equal(parts.flatMap(part => part.attachments[0].content.msteams.entities ?? []).length, 1);
        assert.match(JSON.stringify(parts.at(-1)), /\*\*Missed:\*\* Absent/);
        assert.deepEqual(original, activity(p), 'splitting must not mutate the source card');
    });
}

test('an oversized single update and other huge cells continue without dropping Unicode or fields', () => {
    const p = params(1, 1, '🚀漢"\\\n'.repeat(30_000));
    p.updatesByPerson[0].items[0].title = 'Title 🚀'.repeat(20_000);
    p.updatesByPerson[0].items[0].blockerText = 'Blocker 漢'.repeat(20_000);
    const parts = splitStandupSummaryActivity(activity(p));
    assertBounded(parts);
    for (const [column, field] of [[2, 'title'], [4, 'update'], [5, 'blockerText']]) {
        assert.equal(cells(parts, column).join(''), p.updatesByPerson[0].items[0][field]);
    }
    for (const part of parts) assert.doesNotMatch(JSON.stringify(part), /\\ud[89ab][0-9a-f]{2}|\\ud[cdef][0-9a-f]{2}/i);
});

test('long metadata/footer split too, while an impossible envelope fails closed', () => {
    const p = params(0, 0, '');
    p.sprintName = 'Sprint漢'.repeat(30_000);
    p.missed = [{ displayName: 'Absent🚀'.repeat(30_000), neverInstalled: true }];
    const parts = splitStandupSummaryActivity(activity(p));
    assertBounded(parts);
    assert.ok(parts.length > 2);
    assert.throws(() => splitStandupSummaryActivity(activity(params(1, 1, 'hello'), {
        ...reference, conversation: { id: 'x'.repeat(100_000) },
    })), /envelope exceeds/);
    const hugeMention = params(1, 1, 'Blocked update');
    hugeMention.scrumMaster.displayName = '漢'.repeat(40_000);
    assert.throws(() => splitStandupSummaryActivity(activity(hugeMention)), /mention exceeds/);
});

async function withStandup(stubs, run) {
    const filename = require.resolve('../src/handlers/standup');
    delete require.cache[filename];
    const load = Module._load;
    Module._load = function (request, parent, ...args) {
        if (parent?.filename === filename && Object.hasOwn(stubs, request)) return stubs[request];
        return load.call(this, request, parent, ...args);
    };
    try { await run(require(filename)); }
    finally { Module._load = load; delete require.cache[filename]; }
}

for (const fallback of [false, true]) {
test(`actual SDK activity fits; partial ${fallback ? 'fallback DM' : 'channel'} delivery resumes without duplicates`, async () => {
    const sessions = require('../src/services/session-store');
    const p = params(10, 10, '漢🚀'.repeat(1200));
    const session = sessions.upsertSession({
        standupId: 'budget-standup', sprintId: 334, sprintName: p.sprintName, state: 'open',
        startedUtc: '2026-11-10T09:00:00Z', cutoffUtc: '2026-11-10T10:00:00Z',
        expectedResponders: new Set([...p.updatesByPerson.map(person => person.displayName), 'late-responder']),
        itemsByAssignee: new Map(p.updatesByPerson.map(person => [person.displayName,
            person.items.map(item => ({ key: item.issueKey, summary: item.title, status: item.statusFrom, url: item.url }))])),
        responses: new Map(p.updatesByPerson.map(person => [person.displayName, {
            userAadId: person.displayName, submittedUtc: '2026-11-10T09:01:00Z',
            items: person.items.map(item => ({
                issueKey: item.issueKey, update: item.update,
                hasBlocker: item.blockerText !== undefined, blockerText: item.blockerText,
            })),
        }])),
        sentTo: new Set(), unreachable: new Set(), initiatedByAadId: null,
    });
    const delivered = [];
    const destinations = [];
    let attempts = 0, fail = true, chases = 0, persisted = 0;
    const adapter = new CloudAdapter({});
    adapter.sendActivities = async (_context, messages) => {
        if (++attempts === 2 && fail) throw new Error('Transient connector failure');
        for (const message of messages) {
            assertBounded([message]);
            assert.equal(message.channelId, 'msteams');
            assert.equal(message.conversation.id, fallback ? 'sm-dm' : reference.conversation.id);
            assert.equal(message.from.id, 'bot');
            delivered.push(JSON.parse(JSON.stringify(message)));
        }
        return messages.map(() => ({ id: `sent-${attempts}` }));
    };
    let configuredRef = reference;
    await withStandup({
        '../config': { getJiraMode: () => 'live', getScheduleConfig: () => ({ timezone: 'UTC' }) },
        '../services/sharepoint': {
            findByField: async () => [{ fields: { ConversationRef: JSON.stringify(configuredRef) } }],
            findByTitle: async () => ({ id: 'session' }),
            updateItem: async () => { persisted++; },
        },
        '../services/team-roster': {
            listTeamMembers: async () => [
                ...p.updatesByPerson.map(person => ({ AadObjectId: person.displayName, Title: person.displayName, Role: 'Dev' })),
                { AadObjectId: 'sm-aad-id', Title: 'Alex', Role: 'SM', conversationReference: { ...reference, conversation: { id: 'sm-dm' } } },
            ],
        },
        '../services/jira': {},
        '../services/proactive': { sendProactive: async (ref, logic) => {
            destinations.push(ref.conversation.id);
            if (fallback && ref.conversation.id === reference.conversation.id) {
                return { ok: false, error: 'Channel unavailable before sending any parts' };
            }
            const context = new TurnContext(adapter, Activity.fromObject({
                type: 'message', channelId: ref.channelId, serviceUrl: ref.serviceUrl,
                conversation: ref.conversation, from: ref.user, recipient: ref.agent,
            }), {});
            try { await logic(context); return { ok: true }; }
            catch (error) { return { ok: false, error: error.message }; }
        } },
        './reconcile': { reconcileAfterStandup: async () => ({ autoApplied: [], needsConfirm: [], errors: [] }) },
        './chase': { chaseAfterStandup: async () => { chases++; } },
    }, async standup => {
        await assert.rejects(standup.summarizeStandup(session), /not delivered/);
        assert.equal(session.state, 'open');
        assert.equal(delivered.length, 1);
        assert.equal(chases, 0);
        assert.equal(persisted, 0);
        const lateMessages = [];
        await standup.handleStandupSubmit({
            activity: {
                from: { aadObjectId: 'late-responder' },
                value: { standupId: session.standupId },
            },
            sendActivity: async message => { lateMessages.push(message); },
        });
        assert.match(lateMessages[0], /already being summarized/);
        assert.equal(session.responses.has('late-responder'), false);
        fail = false;
        configuredRef = { ...reference, conversation: { id: 'new-channel' } };
        await standup.summarizeStandup(session);
        assert.deepEqual(destinations, fallback
            ? [reference.conversation.id, 'sm-dm', 'sm-dm']
            : [reference.conversation.id, reference.conversation.id]);
        assert.deepEqual(cells(delivered, 4), Array(100).fill(p.updatesByPerson[0].items[0].update));
        assert.equal(new Set(delivered.map(part => part.attachments[0].content.body[0].text)).size, delivered.length);
        assert.equal(chases, 1);
        assert.equal(persisted, 1);
        assert.ok(sessions.getCompletedSession(session.standupId));
        await standup.summarizeStandup(session);
        assert.equal(chases, 1);
    });
});
}
