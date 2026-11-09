// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const path = require('node:path');

async function withModule(file, stubs, run) {
    const filename = path.resolve(__dirname, file);
    const original = Module._load;
    delete require.cache[filename];
    Module._load = function (request, parent, ...args) {
        if (parent?.filename === filename && Object.hasOwn(stubs, request)) return stubs[request];
        return original.call(this, request, parent, ...args);
    };
    try { return await run(require(filename)); }
    finally { Module._load = original; delete require.cache[filename]; }
}

function context(caller, value) {
    const messages = [];
    return {
        messages,
        activity: { from: caller ? { aadObjectId: caller } : {}, value,
            getConversationReference: () => ({ conversation: { id: 'private-dm' } }) },
        sendActivity: async message => { messages.push(message); },
    };
}

async function drain() {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
}

test('blocker cards include the bound issue and row identifiers for both authorized actions', () => {
    const { buildBlockerEscalationCard } = require('../src/cards/blocker-escalation.card.ts');
    const card = buildBlockerEscalationCard({
        blockerId: 'blocker-1', issueKey: 'TEAM-1', summary: 'Work', url: 'https://jira.invalid/TEAM-1',
        status: 'To Do', sprintName: 'Sprint', ownerDisplayName: 'Dev', reporterDisplayName: 'Dev', blockerText: 'Help',
    });
    const submits = card.content.actions.filter(action => action.type === 'Action.Submit');
    assert.equal(submits.length, 2);
    for (const action of submits) {
        assert.equal(action.data.issueKey, 'TEAM-1');
        assert.equal(action.data.blockerId, 'blocker-1');
    }
});

test('standup submissions fail closed before writes for unknown sessions, identities and issue assignments', async () => {
    const sessions = require('../src/services/session-store');
    let writes = 0, comments = 0;
    const session = sessions.upsertSession({
        standupId: sessions.makeStandupId(880001), state: 'open', sprintName: 'Assigned sprint',
        expectedResponders: new Set(['dev', 'other']),
        itemsByAssignee: new Map([
            ['dev', [{ key: 'TEAM-1' }]], ['other', [{ key: 'TEAM-2' }]],
        ]),
        responses: new Map(), sentTo: new Set(), unreachable: new Set(),
    });
    const previousDemo = process.env.DEMO_MODE;
    process.env.DEMO_MODE = 'true';
    try {
        await withModule('../src/handlers/standup.ts', {
            '../config': { getJiraMode: () => 'live', getScheduleConfig: () => ({ timezone: 'UTC' }) },
            '../services/jira': { getJiraClient: () => ({ addComment: async () => { comments++; } }) },
            '../services/sharepoint': {
                createItem: async () => { writes++; return { id: 'new' }; },
                claimStandupResponse: async fields => {
                    writes++;
                    return { created: true, item: { id: 'new', fields } };
                },
                updateItem: async () => { writes++; },
                findByTitle: async () => null,
            },
            '../services/team-roster': {},
            '../services/proactive': { sendProactive: async (_ref, logic) => {
                await logic({ sendActivity: async () => {} });
                return { ok: true };
            } },
            '../cards/standup-request.card': { buildStandupSubmittedCard: value => value },
        }, async standup => {
            const value = { standupId: session.standupId, assigneeAadId: 'dev',
                'update_TEAM-1': 'Working', 'blocker_TEAM-1': 'true', 'blockerText_TEAM-1': 'Help' };
            const cases = [
                context('dev', { ...value, standupId: 'unknown' }),
                context(undefined, value),
                context('outsider', { ...value, assigneeAadId: 'outsider' }),
                context('other', value),
                context('dev', { ...value, 'update_TEAM-2': 'Unassigned' }),
                context('dev', { ...value, 'update_PRIVATE-9': 'Foreign' }),
                context('dev', { ...value, 'blocker_PRIVATE-9': 'true' }),
                context('dev', { ...value, 'blockerText_PRIVATE-9': 'Forged' }),
            ];
            cases[1].activity.from.id = 'dev';
            for (const ctx of cases) {
                await standup.handleStandupSubmit(ctx);
                assert.equal(writes, 0);
                assert.equal(session.responses.size, 0);
                assert.equal(ctx.messages.length, 1);
            }
            await drain();
            assert.equal(comments, 0);
            const accepted = context('dev', value);
            await standup.handleStandupSubmit(accepted);
            await drain();
            assert.equal(writes, 2);
            assert.equal(comments, 1);
            assert.deepEqual(session.responses.get('dev').items.map(item => item.issueKey), ['TEAM-1']);
            session.state = 'summarizing';
            await standup.handleStandupSubmit(context('dev', value));
            assert.equal(writes, 2);
        });
    } finally {
        sessions.removeSession(session.standupId);
        if (previousDemo === undefined) delete process.env.DEMO_MODE;
        else process.env.DEMO_MODE = previousDemo;
    }
});

async function withAuthorization(run) {
    const members = [
        { AadObjectId: 'sm', Role: 'SM', Title: 'Scrum Master', Email: 'sm@example.test' },
        { AadObjectId: 'dev', Role: 'Dev', Title: 'Developer' },
        { AadObjectId: 'other-sm', Role: 'SM', Title: 'Other Scrum Master' },
    ];
    await withModule('../src/services/authorization.ts', {
        '../config': { getJiraMode: () => 'live' },
        './team-roster': { listTeamMembers: async () => members },
    }, authorization => run(authorization, members));
}

test('channel configuration requires the configured SM and the deployment allowed team before any storage access', async () => {
    const previous = process.env.SMA_ALLOWED_TEAM_ID;
    let reads = 0, writes = 0, stored;
    try {
        await withAuthorization(async authorization => {
            await withModule('../src/handlers/config.ts', {
                '../services/authorization': authorization,
                '../services/sharepoint': {
                    findByField: async () => { reads++; return stored ? [{ id: 'primary', fields: stored }] : []; },
                    createItem: async (_key, fields) => { writes++; stored = fields; },
                    updateItem: async (_key, _id, fields) => { writes++; stored = fields; },
                },
            }, async config => {
                const allowedGuid = '11111111-1111-4111-8111-111111111111';
                function channel(caller, groupId = allowedGuid) {
                    const ctx = context(caller);
                    ctx.activity.channelId = 'msteams';
                    ctx.activity.conversation = { conversationType: 'channel' };
                    ctx.activity.channelData = {
                        team: { id: '19:team@thread.tacv2', aadGroupId: groupId },
                        channel: { id: '19:channel@thread.tacv2' },
                    };
                    return ctx;
                }
                process.env.SMA_ALLOWED_TEAM_ID = allowedGuid;
                await config.handleConfigChannel(channel('dev'));
                await config.handleConfigChannel(channel(undefined));
                await config.handleConfigChannel(channel('sm', '22222222-2222-4222-8222-222222222222'));
                await config.handleConfigChannel(channel('sm', ''));
                const missingGroup = channel('sm');
                delete missingGroup.activity.channelData.team.aadGroupId;
                await config.handleConfigChannel(missingGroup);
                process.env.SMA_ALLOWED_TEAM_ID = '19:team@thread.tacv2';
                await config.handleConfigChannel(channel('sm'));
                delete process.env.SMA_ALLOWED_TEAM_ID;
                await config.handleConfigChannel(channel('sm'));
                process.env.SMA_ALLOWED_TEAM_ID = allowedGuid;
                const spoofed = channel('sm');
                spoofed.activity.channelId = 'emulator';
                await config.handleConfigChannel(spoofed);
                assert.equal(reads, 0);
                assert.equal(writes, 0);
                await config.handleConfigChannel(channel('sm'));
                await config.handleConfigChannel(channel('sm'));
                assert.equal(writes, 2);
                assert.equal(stored.TeamId, '19:team@thread.tacv2');
                assert.equal(stored.ConfiguredByAadId, 'sm');
                assert.equal(JSON.parse(stored.ConversationRef).conversation.id, '19:channel@thread.tacv2');
            });
        });
    } finally {
        if (previous === undefined) delete process.env.SMA_ALLOWED_TEAM_ID;
        else process.env.SMA_ALLOWED_TEAM_ID = previous;
    }
});

test('blocker and meeting actions enforce SM role, proposal ownership, offered slots, expiry and single consumption', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T09:00:00Z') });
    await withAuthorization(async (authorization, members) => {
        let state = 'open', reads = 0, claims = 0, invitations = 0, lookups = 0;
        const cards = [], bookings = [];
        await withModule('../src/handlers/chase.ts', {
            '../services/authorization': authorization,
            '../services/jira': {},
            '../services/team-roster': { getMemberByAadId: async () => members[1] },
            '../services/sharepoint': {
                findByField: async () => { reads++; return [{
                    id: 'blocker-1', fields: { Title: 'TEAM-1', State: state, OwnerAadId: 'dev', ReporterAadId: 'dev' },
                }]; },
                claimItemState: async (_key, _id, expected, next) => {
                    if (state !== expected) return false;
                    claims++; state = next; return true;
                },
                updateItem: async (_key, _id, fields) => { state = fields.State; },
            },
            '../services/proactive': { sendProactive: async (_ref, callback) => {
                await callback({ sendActivity: async message => {
                    if (message?.attachments) cards.push(message.attachments[0]);
                } });
                return { ok: true };
            } },
            '../config': { getJiraMode: () => 'live', getScheduleConfig: () => ({ timezone: 'UTC' }) },
            '../services/helperMatcher': { findHelperForBlocker: async () => null },
            '../services/calendar': {
                findUnblockSlots: async () => {
                    lookups++;
                    return [{ startIso: '2030-01-01T10:00:00Z', endIso: '2030-01-01T10:30:00Z', label: 'Offered' }];
                },
                createUnblockMeeting: async (_cc, options) => {
                    invitations++; bookings.push(options); return { id: 'event-1', webLink: 'https://outlook.invalid/event' };
                },
            },
            '../agent': { agentApplication: { authorization: {} } },
        }, async chase => {
            const blocker = { blockerId: 'blocker-1', issueKey: 'TEAM-1' };
            for (const caller of ['dev', undefined]) {
                for (const action of ['blocker.dismiss', 'blocker.proposeSlots']) {
                    await chase.handleBlockerSubmit(context(caller, { action, ...blocker }));
                }
                for (const action of ['meeting.book', 'meeting.cancel']) {
                    await chase.handleMeetingSubmit(context(caller, { action, proposalId: 'forged' }));
                }
            }
            assert.equal(reads, 0);
            assert.equal(claims, 0);
            assert.equal(lookups, 0);
            await chase.handleBlockerSubmit(context('sm', {
                action: 'blocker.proposeSlots', ...blocker, blockerId: 'different-blocker',
            }));
            assert.equal(lookups, 0);
            async function propose() {
                await chase.handleBlockerSubmit(context('sm', { action: 'blocker.proposeSlots', ...blocker }));
                await drain();
                const card = cards.at(-1);
                const data = card.content.actions[0].data;
                assert.deepEqual(Object.keys(data).sort(), ['action', 'proposalId']);
                return { ...data, slot: card.content.body.find(item => item.id === 'slot').choices[0].value };
            }
            const proposal = await propose();
            for (const caller of ['dev', 'other-sm']) {
                await chase.handleMeetingSubmit(context(caller, proposal));
                await chase.handleMeetingSubmit(context(caller, { ...proposal, action: 'meeting.cancel' }));
            }
            await chase.handleMeetingSubmit(context('sm', { ...proposal, proposalId: 'unknown' }));
            await chase.handleMeetingSubmit(context('sm', { ...proposal, slot: '2030-01-01T11:00:00Z|2030-01-01T11:30:00Z' }));
            assert.equal(invitations, 0);
            const forgedIdentifiers = { ...proposal, blockerId: 'foreign', issueKey: 'PRIVATE-9' };
            await Promise.all([
                chase.handleMeetingSubmit(context('sm', forgedIdentifiers)),
                chase.handleMeetingSubmit(context('sm', proposal)),
            ]);
            await drain();
            assert.equal(invitations, 1);
            assert.equal(claims, 1);
            assert.equal(state, 'booked');
            assert.equal(bookings[0].subject, 'Unblock TEAM-1');
            assert.equal(bookings[0].startIso, proposal.slot.split('|')[0]);
            await chase.handleMeetingSubmit(context('sm', proposal));
            assert.equal(invitations, 1);

            state = 'open';
            const expired = await propose();
            t.mock.timers.tick(30 * 60_000 + 1);
            await chase.handleMeetingSubmit(context('sm', expired));
            assert.equal(invitations, 1);
            const cancelled = await propose();
            await chase.handleMeetingSubmit(context('sm', { ...cancelled, action: 'meeting.cancel' }));
            await chase.handleMeetingSubmit(context('sm', cancelled));
            assert.equal(invitations, 1);
            const revoked = await propose();
            await chase.handleMeetingSubmit(context('sm', revoked));
            members[0].Role = 'Dev';
            await drain();
            assert.equal(invitations, 1);
            assert.equal(state, 'open');
            members[0].Role = 'SM';
            await chase.handleBlockerSubmit(context('sm', { action: 'blocker.dismiss', ...blocker }));
            assert.equal(state, 'resolved');
            assert.equal(claims, 2);
            await drain();
        });
    });
});
