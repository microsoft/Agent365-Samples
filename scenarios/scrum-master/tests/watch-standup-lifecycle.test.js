// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const sessions = require('../src/services/session-store');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

let sprintId = 991000;
function makeSession(expected = ['dev']) {
    const id = ++sprintId;
    return sessions.upsertSession({
        standupId: sessions.makeStandupId(id), sprintId: id, sprintName: 'Lifecycle sprint',
        state: 'open', startedUtc: new Date().toISOString(),
        cutoffUtc: new Date(Date.now() - 1000).toISOString(), initiatedByAadId: null,
        itemsByAssignee: new Map(), expectedResponders: new Set(expected),
        sentTo: new Set(expected), unreachable: new Set(), responses: new Map(),
    });
}

function submitContext(session, user = 'dev', blocked = false) {
    const messages = [];
    return {
        messages,
        activity: {
            from: { aadObjectId: user, name: user },
            value: {
                standupId: session.standupId, assigneeAadId: user,
                'update_SCRUM-1': 'Accepted update before cutoff',
                'blocker_SCRUM-1': String(blocked), 'blockerText_SCRUM-1': 'Dependency',
            },
        },
        sendActivity: async message => { messages.push(message); },
    };
}

async function withStandup(overrides, run) {
    const filename = require.resolve('../src/handlers/standup');
    const load = Module._load;
    const stubs = {
        '../config': {
            getJiraMode: () => 'live',
            getScheduleConfig: () => ({ timezone: 'UTC', cutoffHours: 0 }),
        },
        '../services/sharepoint': {
            createItem: async () => ({ id: 'response' }),
            findByTitle: async () => null,
            findByField: async () => [{ fields: { ConversationRef: '{}' } }],
            updateItem: async () => {},
        },
        '../services/jira': { getJiraClient: () => ({ addComment: async () => {} }) },
        '../services/team-roster': { listTeamMembers: async () => [] },
        '../services/proactive': {
            sendProactive: async (_reference, logic) => {
                await logic({ sendActivity: async () => {} });
                return { ok: true };
            },
        },
        '../cards/standup-request.card': { buildStandupRequestCard: value => value },
        '../cards/standup-summary.card': { buildStandupSummaryCard: value => value },
        './reconcile': { reconcileAfterStandup: async () => ({ autoApplied: [], needsConfirm: [], errors: [] }) },
        './chase': { chaseAfterStandup: async () => {} },
    };
    stubs['../cards/standup-request.card'].buildStandupSubmittedCard = value => value;
    for (const [request, values] of Object.entries(overrides)) {
        stubs[request] = { ...stubs[request], ...values };
    }
    delete require.cache[filename];
    Module._load = function (request, parent, ...args) {
        if (parent?.filename === filename && Object.hasOwn(stubs, request)) return stubs[request];
        return load.call(this, request, parent, ...args);
    };
    try { await run(require(filename)); }
    finally {
        await new Promise(resolve => setImmediate(resolve));
        Module._load = load;
        delete require.cache[filename];
    }
}

test('transient roster failure leaves finalization retryable and concurrent retries finalize once', async () => {
    const session = makeSession([]);
    let lookups = 0, summaries = 0, reconciliations = 0;
    await withStandup({
        '../services/team-roster': { listTeamMembers: async () => {
            if (++lookups === 1) throw new Error('Transient roster failure');
            await new Promise(resolve => setImmediate(resolve));
            return [];
        } },
        '../cards/standup-summary.card': { buildStandupSummaryCard: value => { summaries++; return value; } },
        './reconcile': { reconcileAfterStandup: async () => {
            reconciliations++;
            return { autoApplied: [], needsConfirm: [], errors: [] };
        } },
    }, async standup => {
        await assert.rejects(standup.summarizeStandup(session), /Transient roster/);
        assert.equal(session.state, 'open');
        assert.equal(reconciliations, 0);
        assert.equal(summaries, 0);
        await Promise.all([standup.summarizeStandup(session), standup.summarizeStandup(session)]);
        assert.equal(reconciliations, 1);
        assert.equal(summaries, 1);
        assert.ok(sessions.getCompletedSession(session.standupId));
    });
});

test('mock cron and HTTP without a turn context skip before daily session lookup or persistence', async () => {
    const forbidden = () => { throw new Error('Must skip before accessing services'); };
    await withStandup({
        '../config': { getJiraMode: () => 'mock' },
        '../services/jira': { getJiraClient: forbidden },
        '../services/sharepoint': { createItem: forbidden, findByTitle: forbidden },
        '../services/team-roster': { listTeamMembers: forbidden },
        '../services/proactive': { sendProactive: forbidden },
    }, async standup => {
        for (const source of ['cron', 'http']) {
            const result = await standup.triggerStandup({ source });
            assert.equal(result.standupId, '');
            assert.equal(result.sentTo, 0);
            assert.match(result.note, /Mock standup skipped.*\/standup/);
        }
    });
});

test('successful delayed response insertion crossing cutoff is included once and rejects later submissions', async () => {
    const session = makeSession(['dev', 'late']);
    const entered = deferred(), insertion = deferred();
    const summaries = [];
    let writes = 0;
    await withStandup({
        '../services/sharepoint': { createItem: async () => {
            writes++;
            entered.resolve();
            await insertion.promise;
            return { id: 'response' };
        } },
        '../cards/standup-summary.card': { buildStandupSummaryCard: value => { summaries.push(value); return value; } },
        './reconcile': { reconcileAfterStandup: async current => {
            assert.equal(current.responses.get('dev').items[0].update, 'Accepted update before cutoff');
            return { autoApplied: [], needsConfirm: [], errors: [] };
        } },
    }, async standup => {
        session.cutoffUtc = new Date(Date.now() + 100).toISOString();
        const submission = standup.handleStandupSubmit(submitContext(session));
        await entered.promise;
        assert.ok(Date.now() < Date.parse(session.cutoffUtc));
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(session.cutoffUtc) - Date.now() + 1)));
        assert.equal(session.responses.size, 0);
        const finalization = standup.summarizeStandup(session);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(session.state, 'summarizing');
        assert.equal(summaries.length, 0);
        const late = submitContext(session, 'late');
        await standup.handleStandupSubmit(late);
        assert.match(late.messages[0], /no further updates/);
        assert.equal(writes, 1);
        insertion.resolve();
        await Promise.all([submission, finalization]);
        await standup.summarizeStandup(session);
        assert.equal(summaries.length, 1);
        assert.equal(summaries[0].respondedCount, 1);
        assert.equal(summaries[0].updatesByPerson[0].items[0].update, 'Accepted update before cutoff');
        assert.equal(summaries[0].missed.length, 1);
        assert.ok(sessions.getCompletedSession(session.standupId));
    });
});

test('submission guard releases on blocker failure and preserves the accepted response', async () => {
    const session = makeSession();
    let writes = 0, summary;
    await withStandup({
        '../services/sharepoint': { createItem: async () => {
            if (++writes === 2) throw new Error('Blocker insert failed');
            return { id: 'response' };
        } },
        '../cards/standup-summary.card': { buildStandupSummaryCard: value => { summary = value; return value; } },
    }, async standup => {
        await assert.rejects(standup.handleStandupSubmit(submitContext(session, 'dev', true)), /Blocker insert/);
        await standup.summarizeStandup(session);
        assert.equal(summary.respondedCount, 1);
        assert.equal(session.state, 'summarized');
    });
});

test('finalization guard releases when summary construction fails before delivery', async () => {
    const session = makeSession([]);
    let builds = 0;
    await withStandup({
        '../cards/standup-summary.card': { buildStandupSummaryCard: value => {
            if (++builds === 1) throw new Error('Card build failed');
            return value;
        } },
    }, async standup => {
        await assert.rejects(standup.summarizeStandup(session), /Card build/);
        assert.equal(session.state, 'open');
        await standup.summarizeStandup(session);
        assert.equal(session.state, 'summarized');
    });

});

test('live epic-backed Story expands inherited subtasks and sends the second assignee a card', async () => {
        const jiraFilename = require.resolve('../src/services/jira');
        const cachedJira = require.cache[jiraFilename];
        const load = Module._load;
        const id = ++sprintId;
        const rawIssue = (key, subtask, parent, accountId) => ({
            id: key, key,
            fields: {
                summary: key, status: { name: 'To Do', statusCategory: { key: 'new' } },
                issuetype: { name: subtask ? 'Sub-task' : 'Story', subtask },
                parent: { key: parent }, assignee: { accountId, displayName: accountId },
            },
        });
        const members = ['first', 'second'].map(user => ({
            AadObjectId: user, JiraAccountId: user, Title: user, Role: 'Dev',
            conversationReference: { conversation: { id: `dm-${user}` } },
        }));
        const cards = [];
        let inheritedSearches = 0;
        const http = {
            get: async url => {
                if (url.endsWith('/sprint')) {
                    return { data: { values: [{ id, name: 'Live fixture sprint', state: 'active' }] } };
                }
                assert.match(url, new RegExp(`/sprint/${id}/issue$`));
                return { data: { total: 1, issues: [rawIssue('TEAM-1', false, 'TEAM-100', 'first')] } };
            },
            post: async (url, body) => {
                assert.equal(url, '/rest/api/3/search/jql');
                assert.match(body.jql, /parent in \("TEAM-1"\)/);
                inheritedSearches++;
                return { data: { isLast: true, issues: [rawIssue('TEAM-2', true, 'TEAM-1', 'second')] } };
            },
        };
        delete require.cache[jiraFilename];
        Module._load = function (request, parent, ...args) {
            if (parent?.filename === jiraFilename) {
                if (request === 'axios') return { create: () => http };
                if (request === '../util/httpLogger') return { attachHttpLogging() {} };
            }
            return load.call(this, request, parent, ...args);
        };
        try {
            const { LiveJiraClient } = require(jiraFilename);
            const jira = new LiveJiraClient({
                baseUrl: 'https://jira.example.test', email: 'fixture@example.test',
                apiToken: 'fixture-token', boardId: 7, projectKey: 'TEAM',
            });
            await withStandup({
                '../services/jira': { getJiraClient: () => jira },
                '../services/team-roster': { listTeamMembers: async () => members, isReachable: () => true },
                '../services/proactive': { sendProactive: async (reference, logic) => {
                    await logic({ sendActivity: async message => { cards.push({ reference, card: message.attachments[0] }); } });
                    return { ok: true };
                } },
            }, async standup => {
                const result = await standup.triggerStandup({ source: 'http' });
                assert.equal(result.sentTo, 2);
                assert.equal(inheritedSearches, 1);
                assert.deepEqual(cards.map(entry => entry.reference.conversation.id), ['dm-first', 'dm-second']);
                assert.deepEqual(cards[1].card.items.map(issue => issue.key), ['TEAM-2']);
                assert.equal(sessions.getSession(result.standupId).itemsByAssignee.get('first')[0].parentKey, null);
                sessions.removeSession(result.standupId);
            });
        } finally {
            Module._load = load;
            delete require.cache[jiraFilename];
            if (cachedJira) require.cache[jiraFilename] = cachedJira;
        }
});
