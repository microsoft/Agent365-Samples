// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const path = require('node:path');
const { OpenAI } = require('openai');
const sdk = require('@openai/agents');

sdk.setTracingDisabled(true);
sdk.setOpenAIAPI('chat_completions');

let answer;
const requests = [];
const offlineClient = new OpenAI({
    apiKey: 'offline-test-key',
    baseURL: 'https://offline.invalid/v1',
    fetch: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return new Response(JSON.stringify({
            id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'gpt-4o',
            choices: [{
                index: 0, message: { role: 'assistant', content: JSON.stringify(answer) },
                finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
});
sdk.setDefaultOpenAIClient(offlineClient);

function loadCalendar() {
    const filename = path.resolve(__dirname, '../src/services/calendar.ts');
    const original = Module._load;
    delete require.cache[filename];
    Module._load = function (request, parent, isMain) {
        if (parent?.filename === filename) {
            if (request === '@microsoft/agents-a365-tooling-extensions-openai') {
                return { McpToolRegistrationService: class {
                    async addToolServersToAgent() {}
                } };
            }
            if (request === '../openai-config') return { getModelName: () => 'gpt-4o' };
        }
        return original.call(this, request, parent, isMain);
    };
    try { return require(filename); }
    finally { Module._load = original; }
}

test('direct Zod resolves to a patched release', () => {
    const [major, minor, patch] = require('zod/package.json').version.split('.').map(Number);
    assert.ok(major > 4 || (major === 4 && (minor > 6 || (minor === 6 && patch >= 6))));
});

test('real Agents SDK constructs and executes the Jira Zod 4 tools offline', async () => {
    const previous = process.env.JIRA_MODE;
    process.env.JIRA_MODE = 'mock';
    try {
        const { getIssueTool, listSprintIssuesTool, getIssueCommentsTool } = require('../src/services/jira-tool.ts');
        assert.equal(getIssueTool.parameters.properties.issueKey.type, 'string');
        assert.deepEqual(listSprintIssuesTool.parameters.required, []);
        assert.equal(getIssueCommentsTool.parameters.properties.limit.default, 5);
        const issue = await getIssueTool.invoke(new sdk.RunContext(), JSON.stringify({ issueKey: 'Task-1' }));
        assert.equal(issue.key, 'Task-1');
        assert.equal(issue.status, 'In Progress');
        const comments = await getIssueCommentsTool.invoke(new sdk.RunContext(), JSON.stringify({ issueKey: 'Task-1' }));
        assert.equal(comments.issueKey, 'Task-1');
        assert.ok(Array.isArray(comments.comments));
    } finally {
        if (previous === undefined) delete process.env.JIRA_MODE;
        else process.env.JIRA_MODE = previous;
    }
});

test('real SDK runner parses the calendar slot Zod 4 output without fallback', async () => {
    requests.length = 0;
    answer = { slots: [{
        startIso: '2026-11-02T09:00:00Z', endIso: '2026-11-02T09:30:00Z', label: 'Offline slot',
    }] };
    const { findUnblockSlots } = loadCalendar();
    const slots = await findUnblockSlots({}, [], 30, 'UTC');
    assert.deepEqual(slots, answer.slots);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].response_format.type, 'json_schema');
    assert.equal(requests[0].response_format.json_schema.schema.properties.slots.type, 'array');
});

test('real SDK runner parses calendar event output with optional metadata', async () => {
    requests.length = 0;
    answer = {
        id: 'offline-event', webLink: 'https://outlook.invalid/event',
        onlineMeetingUrl: null, attendeeCount: 1,
    };
    const { createUnblockMeeting } = loadCalendar();
    const event = await createUnblockMeeting({}, {
        subject: 'Offline test', body: 'Test', startIso: '2026-11-02T09:00:00Z',
        endIso: '2026-11-02T09:30:00Z', attendees: [{ email: 'test@example.com' }], timezone: 'UTC',
    });
    assert.deepEqual(event, answer);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].response_format.json_schema.schema.properties.id.type, 'string');
});

test('Azure OpenAI configuration accepts the aligned client types without credentials or network calls', () => {
    const keys = ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT'];
    const previous = keys.map(key => process.env[key]);
    process.env.AZURE_OPENAI_API_KEY = 'offline-test-key';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://offline.invalid';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'offline-deployment';
    try {
        assert.doesNotThrow(() => require('../src/openai-config.ts').configureOpenAIClient());
    } finally {
        keys.forEach((key, index) => {
            if (previous[index] === undefined) delete process.env[key];
            else process.env[key] = previous[index];
        });
        sdk.setDefaultOpenAIClient(offlineClient);
    }
});
