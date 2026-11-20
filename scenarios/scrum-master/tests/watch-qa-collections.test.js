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

function issue(key, parentKey) {
    return { id: key, key, fields: { summary: `${key} content`,
        issuetype: { name: parentKey ? 'Sub-task' : 'Story', subtask: !!parentKey },
        ...(parentKey ? { parent: { key: parentKey } } : {}) } };
}

function epicBackedStory(key, epicKey) {
    const raw = issue(key);
    raw.fields.parent = { key: epicKey };
    return raw;
}

function fixture(mode = 'live') {
    const requests = [];
    const cfg = { mode, projectKey: 'TEAM', baseUrl: 'https://jira.example.test', email: 'offline', apiToken: 'placeholder', boardId: 1 };
    const jira = load('src\\services\\jira.ts', {
        '../config': { getJiraConfig: () => cfg },
        '../util/httpLogger': { attachHttpLogging: () => {} },
        axios: {
            create: () => ({
                get: async (url, options) => {
                    requests.push({ url, options });
                    if (url.endsWith('/sprint')) return { data: { values: [{ id: 42, name: 'Shared board sprint' }] } };
                    const page = options.params.startAt === 0
                        ? [issue('PRIVATE-123'), epicBackedStory('TEAM-1', 'PROGRAM-1'), issue('TEAM-8', 'PRIVATE-123')]
                        : [issue('PRIVATE-456'), issue('TEAM-2'), issue('TEAM-1'), issue('invalid')];
                    return { data: { issues: page, total: 7 } };
                },
                post: async (url, body) => {
                    requests.push({ url, body });
                    if (!body.nextPageToken) {
                        return { data: {
                            issues: [issue('PRIVATE-5', 'TEAM-1'), issue('TEAM-3', 'TEAM-1'), issue('TEAM-6', 'PRIVATE-123')],
                            nextPageToken: 'page-2',
                        } };
                    }
                    return { data: {
                        issues: [issue('TEAM-4', 'TEAM-2'), issue('TEAM-3', 'TEAM-1'), issue('TEAM-7', 'TEAM-99')],
                        isLast: true,
                    } };
                },
            }),
        },
    });
    return { ...jira, cfg, requests };
}

test('multi-project sprint reads constrain requests and filter every returned page before exposing issues', async () => {
    const f = fixture();
    const issues = await f.getJiraClient().searchSprintIssues(42);
    assert.deepEqual(issues.map(i => i.key), ['TEAM-1', 'TEAM-2']);
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.requests.map(r => r.options.params.startAt), [0, 3]);
    assert.ok(f.requests.every(r => r.options.params.jql === 'project = "TEAM"'));
    assert.equal(issues[0].parentKey, null);
    assert.equal(issues[0].issueType, 'Story');
    assert.doesNotMatch(JSON.stringify(issues), /PRIVATE|PROGRAM|TEAM-8|invalid/);
});

test('subtask reads constrain project and parents, filter foreign or unexpected parent results, and retain pagination', async () => {
    const f = fixture();
    const issues = await f.getJiraClient().getSprintSubtasks(42, [' team-1 ', 'TEAM-2']);
    assert.deepEqual(issues.map(i => i.key), ['TEAM-3', 'TEAM-4']);
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests.every(r => r.body.jql === 'project = "TEAM" AND parent in ("TEAM-1", "TEAM-2")'));
    assert.equal(f.requests[1].body.nextPageToken, 'page-2');
    assert.doesNotMatch(JSON.stringify(issues), /PRIVATE|TEAM-6|TEAM-7|TEAM-99/);
});

test('foreign or injected subtask parents are denied before any shared-credential request', async () => {
    const f = fixture();
    const client = new f.LiveJiraClient(f.cfg);
    for (const parent of ['PRIVATE-123', 'TEAM-1") OR project = "PRIVATE', 'Task-1']) {
        await assert.rejects(client.getSprintSubtasks(42, ['TEAM-1', parent]), /restricted/);
    }
    assert.deepEqual(await client.getSprintSubtasks(42, []), []);
    assert.equal(f.requests.length, 0);
});

test('jira_list_sprint_issues never exposes foreign board content or launders it into Task labels', async () => {
    const f = fixture();
    const tools = load('src\\services\\jira-tool.ts', {
        '@openai/agents': { tool: definition => definition },
        './jira': { getJiraClient: f.getJiraClient },
        '../observability': { withExecuteToolScope: async (_name, _input, callback) => callback() },
    });
    const result = await tools.listSprintIssuesTool.execute();
    assert.deepEqual(result.issues.map(i => i.key), ['Task-1', 'Task-2']);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|PROGRAM|Task-123|Task-456|Task-8/);
});

test('mock collection boundary retains SCRUM seed and denies foreign parent keys despite live project setting', async () => {
    const f = fixture('mock');
    const client = f.getJiraClient();
    const sprint = await client.getActiveSprint();
    assert.ok((await client.searchSprintIssues(sprint.id)).every(i => i.key.startsWith('SCRUM-')));
    assert.deepEqual(await client.getSprintSubtasks(sprint.id, ['SCRUM-1']), []);
    await assert.rejects(client.getSprintSubtasks(sprint.id, ['TEAM-1']), /restricted/);
    await assert.rejects(client.getSprintSubtasks(sprint.id, ['PRIVATE-123']), /restricted/);
    assert.equal(f.requests.length, 0);
});
