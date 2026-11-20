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
    Module._load = function (request, parent, ...args) {
        if (parent?.filename === filename && Object.hasOwn(mocks, request)) return mocks[request];
        return original.call(this, request, parent, ...args);
    };
    try { return require(filename); }
    finally { Module._load = original; delete require.cache[filename]; }
}

function calendarFixture(run) {
    const calls = { connect: 0, close: 0, run: 0 };
    const calendar = load('src\\services\\calendar.ts', {
        '@openai/agents': {
            Agent: class { constructor() { this.mcpServers = []; } },
            run: async (...args) => { calls.run++; return run(...args); },
        },
        '@microsoft/agents-a365-tooling-extensions-openai': {
            McpToolRegistrationService: class {
                async addToolServersToAgent(agent) {
                    agent.mcpServers = [{
                        connect: async () => { calls.connect++; },
                        close: async () => { calls.close++; },
                    }];
                }
            },
        },
        '../openai-config': { getModelName: () => 'offline-test' },
    });
    return { ...calendar, calls };
}

const booking = {
    subject: 'Unblock T-1', body: 'Help', startIso: '', endIso: '', timezone: 'UTC',
    attendees: [{ email: 'owner@example.test' }, { email: 'OWNER@example.test' }, { email: 'sm@example.test' }],
};

test('calendar retries session loss only for read-only availability, never event creation', async () => {
    for (const message of ['Session not found', 'MCP error -32001']) {
        let attempts = 0;
        const availability = calendarFixture(async () => {
            if (++attempts === 1) throw new Error(message);
            return { finalOutput: { slots: [] } };
        });
        assert.deepEqual(await availability.findUnblockSlots({}, [], 30, 'UTC'), []);
        assert.deepEqual(availability.calls, { connect: 2, close: 1, run: 2 });

        const failure = new Error(message);
        const creation = calendarFixture(async () => { throw failure; });
        await assert.rejects(creation.createUnblockMeeting({}, booking), error => error === failure);
        assert.deepEqual(creation.calls, { connect: 1, close: 1, run: 1 });
    }
});

test('calendar confirms deduplicated invitation count and rejects absent, partial or malformed results', async () => {
    const event = { id: 'event-1', webLink: 'https://outlook.example.test/event-1', attendeeCount: 2 };
    for (const finalOutput of [
        undefined, {}, { ...event, attendeeCount: undefined }, { ...event, attendeeCount: 0 },
        { ...event, attendeeCount: 1 }, { ...event, attendeeCount: 3 },
        { ...event, attendeeCount: '2' }, { ...event, attendeeCount: 1.5 },
        { ...event, id: '' }, { ...event, id: 'error: uncertain' },
    ]) {
        const calendar = calendarFixture(async () => ({ finalOutput }));
        await assert.rejects(calendar.createUnblockMeeting({}, booking), /CALENDAR_VERIFY_FAILED/);
        assert.equal(calendar.calls.run, 1);
        assert.equal(calendar.calls.close, 1);
    }
    const calendar = calendarFixture(async () => ({ finalOutput: event }));
    assert.equal((await calendar.createUnblockMeeting({}, booking)).attendeeCount, 2);
    await assert.rejects(calendar.createUnblockMeeting({}, { ...booking, attendees: [] }), /CALENDAR_VERIFY_FAILED/);
});

function chaseFixture(creationError) {
    const messages = [], cards = [], bookings = [], checked = [];
    let helperLookups = 0, rosterLookups = 0, state = 'open', changed = false;
    const sm = { AadObjectId: 'sm', Email: 'sm@example.test', Title: 'SM' };
    const slot = { startIso: '2099-01-01T10:00:00Z', endIso: '2099-01-01T10:30:00Z', label: 'Future' };
    const chase = load('src\\handlers\\chase.ts', {
        '../services/jira': {},
        '../services/team-roster': { getMemberByAadId: async () => {
            rosterLookups++;
            return { Email: changed ? 'replacement@example.test' : 'owner@example.test', Title: 'Owner' };
        } },
        '../services/authorization': { requireScrumMaster: async () => sm, getScrumMaster: async () => sm },
        '../services/helperMatcher': { findHelperForBlocker: async () => {
            helperLookups++;
            return { email: changed ? 'new-helper@example.test' : 'helper@example.test',
                displayName: changed ? 'New helper' : 'Helper', topic: 'Database', matchedBy: 'test' };
        } },
        '../services/proactive': { sendProactive: async (_ref, callback) => {
            await callback({ sendActivity: async activity => {
                if (activity?.attachments) cards.push(activity.attachments[0]);
                else messages.push(activity);
            } });
            return { ok: true };
        } },
        '../services/sharepoint': {
            findByField: async () => [{ id: 'blocker-1', fields: {
                Title: 'T-1', State: state, OwnerAadId: 'owner', ReporterAadId: 'owner', BlockerText: 'Help',
            } }],
            claimItemState: async (_list, _id, expected, next) => {
                if (state !== expected) return false;
                state = next;
                return true;
            },
            updateItem: async (_list, _id, fields) => { state = fields.State; },
        },
        '../config': { getJiraMode: () => 'live', getScheduleConfig: () => ({ timezone: 'UTC' }) },
        '../cards/blocker-escalation.card': {},
        '../cards/meeting-propose.card': { buildMeetingProposeCard: value => value },
        '../services/calendar': {
            findUnblockSlots: async (_cc, attendees) => { checked.push(structuredClone(attendees)); return [slot]; },
            createUnblockMeeting: async (_cc, opts) => {
                bookings.push(opts);
                if (creationError) throw creationError;
                return { id: 'event-1', webLink: 'https://outlook.example.test/event-1', attendeeCount: 3 };
            },
        },
        '../agent': { agentApplication: { authorization: {} } },
    });
    const context = value => ({ activity: { value, getConversationReference: () => ({}) },
        sendActivity: async text => { messages.push(text); } });
    const drain = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
    return {
        messages, cards, bookings, checked,
        get state() { return state; },
        get helperLookups() { return helperLookups; },
        get rosterLookups() { return rosterLookups; },
        async propose() {
            await chase.handleBlockerSubmit(context({ action: 'blocker.proposeSlots', blockerId: 'blocker-1', issueKey: 'T-1' }));
            await drain();
        },
        async book() {
            changed = true;
            await chase.handleMeetingSubmit(context({ action: 'meeting.book', proposalId: cards[0].proposalId,
                slot: `${slot.startIso}|${slot.endIso}` }));
            await drain();
        },
    };
}

test('chase books exactly the attendees displayed and availability-checked despite roster/helper changes', async () => {
    const fixture = chaseFixture();
    await fixture.propose();
    assert.deepEqual(fixture.cards[0].attendeeNames, ['Owner', 'SM', 'Helper']);
    await fixture.book();
    assert.deepEqual(fixture.bookings[0].attendees, fixture.checked[0]);
    assert.deepEqual(fixture.bookings[0].attendees.map(person => person.email),
        ['owner@example.test', 'sm@example.test', 'helper@example.test']);
    assert.equal(fixture.helperLookups, 1);
    assert.equal(fixture.rosterLookups, 2);
    assert.equal(fixture.state, 'booked');
    assert.ok(fixture.messages.some(text => text.includes('Helper')));
    assert.ok(!fixture.messages.some(text => text.includes('New helper')));
});

test('chase keeps uncertain booking claims for manual verification without reporting booked or retrying', async () => {
    for (const message of ['Session not found', 'CALENDAR_VERIFY_FAILED: attendees missing']) {
        const fixture = chaseFixture(new Error(message));
        await fixture.propose();
        await fixture.book();
        await fixture.book();
        assert.equal(fixture.state, 'booking');
        assert.equal(fixture.bookings.length, 1);
        assert.ok(fixture.messages.some(text => /Check Outlook before retrying/.test(text)));
        assert.ok(!fixture.messages.some(text => /📅 Booked|most likely created|marked as booked/.test(text)));
    }
});
