// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

function load(file, mocks = {}) {
    const filename = path.resolve(__dirname, '..', ...file.split(/[\\/]+/));
    const original = Module._load;
    delete require.cache[filename];
    Module._load = function (request, parent, isMain) {
        return Object.hasOwn(mocks, request) ? mocks[request] : original.call(this, request, parent, isMain);
    };
    try { return require(filename); }
    finally { Module._load = original; }
}

function answerFixture() {
    const inputs = [];
    const { handleAnswer } = load('src\\handlers\\answer.ts', {
        '@openai/agents': {
            Agent: class {},
            run: async (_agent, input) => {
                inputs.push(input);
                return { finalOutput: 'Grounded answer' };
            },
        },
        '../openai-config': { getModelName: () => 'offline-test' },
        '../services/jira-tool': { JIRA_TOOLS: [] },
        '../observability': { withInvokeAgentScope: async (_context, _message, callback) => callback() },
    });
    return { handleAnswer, inputs };
}

function context(patch = {}) {
    return {
        activity: {
            channelId: 'msteams',
            conversation: { id: 'dm-1', tenantId: 'tenant-1', conversationType: 'personal', isGroup: false },
            from: { aadObjectId: 'caller-1', id: 'channel-caller-1' },
            recipient: { id: 'bot-1' },
            ...patch,
        },
        sendActivity: async () => {},
    };
}

test('same caller and conversation retain a bounded follow-up history', async () => {
    const fixture = answerFixture();
    for (let i = 0; i < 7; i++) await fixture.handleAnswer(context(), `Question ${i}`);
    assert.deepEqual(fixture.inputs[1].map(i => i.content), ['Question 0', 'Grounded answer', 'Question 1']);
    assert.equal(fixture.inputs[6].length, 9);
    assert.equal(fixture.inputs[6][0].content, 'Question 2');
});

test('Q&A history never crosses tenant, channel, conversation, audience, caller or recipient', async () => {
    const variants = [
        { conversation: { id: 'dm-2', tenantId: 'tenant-1', conversationType: 'personal', isGroup: false } },
        { conversation: { id: 'dm-1', tenantId: 'tenant-2', conversationType: 'personal', isGroup: false } },
        { channelId: 'emulator' },
        { conversation: { id: 'dm-1', tenantId: 'tenant-1', conversationType: 'groupChat', isGroup: true } },
        { conversation: { id: 'dm-1', tenantId: 'tenant-1', conversationType: 'personal', isGroup: true } },
        { from: { aadObjectId: 'caller-2', id: 'channel-caller-1' } },
        { recipient: { id: 'bot-2' } },
        {
            id: 'root-1',
            conversation: { id: 'dm-1', tenantId: 'tenant-1', conversationType: 'channel', isGroup: true },
            channelData: { team: { id: 'team-1' }, channel: { id: 'channel-1' } },
        },
    ];
    for (const patch of variants) {
        const fixture = answerFixture();
        await fixture.handleAnswer(context(), 'Private DM details');
        await fixture.handleAnswer(context(patch), 'Provide more details');
        assert.deepEqual(fixture.inputs[1], [{ role: 'user', content: 'Provide more details' }]);
    }
});

test('channel replies retain only their own root thread and channel audience', async () => {
    const fixture = answerFixture();
    const channel = {
        conversation: { id: 'channel-conversation', tenantId: 'tenant-1', conversationType: 'channel', isGroup: true },
        channelData: { team: { id: 'team-1' }, channel: { id: 'channel-1' } },
    };
    await fixture.handleAnswer(context({ ...channel, id: 'root-1' }), 'Thread one');
    await fixture.handleAnswer(context({ ...channel, id: 'reply-1', replyToId: 'root-1' }), 'Follow up');
    assert.equal(fixture.inputs[1][0].content, 'Thread one');
    await fixture.handleAnswer(context({ ...channel, id: 'root-2' }), 'Other thread');
    assert.equal(fixture.inputs[2].length, 1);
    await fixture.handleAnswer(context({
        ...channel, replyToId: 'root-1',
        channelData: { team: { id: 'team-1' }, channel: { id: 'channel-2' } },
    }), 'Other audience');
    assert.equal(fixture.inputs[3].length, 1);
});

test('missing identities never reuse anonymous history, while identified channel callers can follow up', async () => {
    const variants = [
        { from: undefined }, { from: { id: ' ' } }, { channelId: '' },
        { conversation: { tenantId: 'tenant-1' } },
        { conversation: { id: 'dm-1', conversationType: 'personal' } },
        { conversation: undefined },
    ];
    for (const patch of variants) {
        const fixture = answerFixture();
        await fixture.handleAnswer(context(patch), 'Not retained');
        await fixture.handleAnswer(context(patch), 'Another caller');
        assert.equal(fixture.inputs[1].length, 1);
    }
    const fixture = answerFixture();
    const fallback = context({ from: { id: 'channel-only-caller' } });
    await fixture.handleAnswer(fallback, 'Retained');
    await fixture.handleAnswer(fallback, 'Follow up');
    assert.equal(fixture.inputs[1].length, 3);
});

function jiraFixture(mode = 'live', returnedKey = 'TEAM-123') {
    const requests = [];
    const cfg = {
        mode, projectKey: 'TEAM', baseUrl: 'https://jira.example.test',
        email: 'offline@example.test', apiToken: 'offline-placeholder', boardId: 1,
    };
    const module = load('src\\services\\jira.ts', {
        '../config': { getJiraConfig: () => cfg },
        '../util/httpLogger': { attachHttpLogging: () => {} },
        axios: {
            create: () => ({
                get: async (url, options) => {
                    requests.push({ url, options });
                    if (url.endsWith('/comment')) {
                        return { data: { comments: [{ id: '1', author: { displayName: 'Alex' }, body: 'Project update' }] } };
                    }
                    return { data: { id: '123', key: returnedKey, fields: { summary: 'Team task' } } };
                },
            }),
        },
    });
    return { ...module, requests, cfg };
}

test('shared live Jira reads deny canonical foreign keys and malformed aliases before HTTP', async () => {
    const fixture = jiraFixture();
    for (const client of [fixture.getJiraClient(), new fixture.LiveJiraClient(fixture.cfg)]) {
        for (const key of ['PRIVATE-123', 'private-123', 'Task-123', '123', 'TEAM-123/../PRIVATE-123', '']) {
            await assert.rejects(client.getIssue(key), /restricted to the configured Jira project/);
            await assert.rejects(client.getComments(key), /restricted to the configured Jira project/);
        }
    }
    assert.equal(fixture.requests.length, 0);
});

test('same-project reads normalize canonical keys and preserve comment limit/order', async () => {
    const fixture = jiraFixture();
    const client = fixture.getJiraClient();
    assert.equal((await client.getIssue(' team-123 ')).key, 'TEAM-123');
    assert.equal((await client.getComments('team-123', 2))[0].body, 'Project update');
    assert.equal(fixture.requests.length, 3);
    assert.equal(fixture.requests[0].url, '/rest/api/3/issue/TEAM-123');
    assert.deepEqual(fixture.requests[2].options.params, { orderBy: '-created', maxResults: 2 });
});

test('foreign response keys are rejected before any single-issue data is returned', async () => {
    const fixture = jiraFixture('live', 'PRIVATE-123');
    await assert.rejects(fixture.getJiraClient().getIssue('TEAM-123'), /restricted to the configured Jira project/);
    assert.equal(fixture.requests.length, 1);
});

test('moved same-project aliases cannot expose comments from a restricted project', async () => {
    const fixture = jiraFixture('live', 'PRIVATE-123');
    await assert.rejects(fixture.getJiraClient().getComments('TEAM-123'), /restricted to the configured Jira project/);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests.some(request => request.url.endsWith('/comment')), false);
});

test('mock boundary authorizes actual SCRUM seed, not leftover live project config, and preserves ceremonies', async () => {
    const fixture = jiraFixture('mock');
    const client = fixture.getJiraClient();
    assert.equal((await client.getIssue('scrum-1')).key, 'SCRUM-1');
    assert.deepEqual(await client.getComments('SCRUM-1'), []);
    for (const key of ['PRIVATE-123', 'TEAM-1']) {
        await assert.rejects(client.getIssue(key), /restricted/);
        await assert.rejects(client.getComments(key), /restricted/);
    }
    const sprint = await client.getActiveSprint();
    assert.ok((await client.searchSprintIssues(sprint.id)).length > 0);
    await client.addComment('SCRUM-1', 'Automatic ceremony update');
    assert.equal((await client.getComments('SCRUM-1'))[0].body, 'Automatic ceremony update');
    assert.equal(fixture.requests.length, 0);
});

test('Q&A tools deny foreign keys without granting access through friendly labels', async () => {
    const fixture = jiraFixture();
    const tools = load('src\\services\\jira-tool.ts', {
        '@openai/agents': { tool: definition => definition },
        './jira': { getJiraClient: fixture.getJiraClient },
        '../observability': { withExecuteToolScope: async (_name, _input, callback) => callback() },
    });
    assert.match((await tools.getIssueTool.execute({ issueKey: 'PRIVATE-123' })).error, /restricted/);
    assert.match((await tools.getIssueCommentsTool.execute({ issueKey: 'PRIVATE-123', limit: 5 })).error, /restricted/);
    assert.equal(fixture.requests.length, 0);
});
