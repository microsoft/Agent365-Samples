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

function loadCalendar(overrides = {}) {
    const filename = path.resolve(__dirname, '../src/services/calendar.ts');
    const original = Module._load;
    delete require.cache[filename];
    Module._load = function (request, parent, isMain) {
        if (parent?.filename === filename) {
            if (request === '@openai/agents' && overrides.run) return { ...sdk, run: overrides.run };
            if (request === '@microsoft/agents-a365-tooling-extensions-openai') {
                return { McpToolRegistrationService: class {
                    async addToolServersToAgent() {
                        if (overrides.registrationError) throw overrides.registrationError;
                    }
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

test('calendar preserves empty availability instead of fabricating bookable slots', async () => {
    answer = { slots: [] };
    const { findUnblockSlots } = loadCalendar();
    assert.deepEqual(await findUnblockSlots({}, [{ email: 'busy@example.test' }], 30, 'UTC'), []);
});

test('calendar lookup and malformed output failures propagate without synthetic fallback', async () => {
    const failure = new Error('Calendar unavailable');
    for (const overrides of [
        { run: async () => { throw failure; } },
        { registrationError: failure },
    ]) {
        const { findUnblockSlots } = loadCalendar(overrides);
        await assert.rejects(findUnblockSlots({}, [], 30, 'UTC'), error => error === failure);
    }
    for (const finalOutput of [undefined, {}, { slots: 'invalid' }, { slots: [{ startIso: 'missing fields' }] }]) {
        const { findUnblockSlots } = loadCalendar({ run: async () => ({ finalOutput }) });
        await assert.rejects(findUnblockSlots({}, [], 30, 'UTC'), /invalid|expected/i);
    }
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

        test('hosting loads patched MSAL and preserves client-credentials acquisition', async () => {
            const { createRequire } = require('node:module');
            const hostingRequire = createRequire(require.resolve('@microsoft/agents-hosting'));
            const msal = hostingRequire('@azure/msal-node');
            const [major, minor] = hostingRequire('@azure/msal-node/package.json').version.split('.').map(Number);
            assert.ok(major > 7 || (major === 7 && minor >= 1));
            const original = msal.ConfidentialClientApplication.prototype.acquireTokenByClientCredential;
            const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
            const requests = [];
            msal.ConfidentialClientApplication.prototype.acquireTokenByClientCredential = async function (request) {
                requests.push(request);
                return { accessToken: token };
            };
            try {
                const { MsalTokenProvider } = require('@microsoft/agents-hosting');
                const provider = new MsalTokenProvider({
                    clientId: '66666666-6666-4666-8666-666666666666',
                    tenantId: '11111111-1111-4111-8111-111111111111',
                    clientSecret: 'offline-test-secret', authorityEndpoint: 'https://login.microsoftonline.com',
                });
                assert.equal(await provider.getAccessToken('https://graph.microsoft.com'), token);
                assert.deepEqual(requests[0].scopes, ['https://graph.microsoft.com/.default']);
            } finally {
                msal.ConfidentialClientApplication.prototype.acquireTokenByClientCredential = original;
            }
        });

        test('patched hosting MSAL retains workload OBO behavior', async () => {
            const { createRequire } = require('node:module');
            const hostingRequire = createRequire(require.resolve('@microsoft/agents-hosting'));
            const msal = hostingRequire('@azure/msal-node');
            const original = msal.ConfidentialClientApplication.prototype.acquireTokenOnBehalfOf;
            const requests = [];
            msal.ConfidentialClientApplication.prototype.acquireTokenOnBehalfOf = async function (request) {
                requests.push(request);
                return { accessToken: 'offline-workload-token' };
            };
            try {
                const { MsalTokenProvider } = require('@microsoft/agents-hosting');
                const provider = new MsalTokenProvider({
                    clientId: '77777777-7777-4777-8777-777777777777',
                    tenantId: '11111111-1111-4111-8111-111111111111',
                    clientSecret: 'offline-test-secret', authorityEndpoint: 'https://login.microsoftonline.com',
                });
                assert.equal(await provider.acquireTokenOnBehalfOf(['https://graph.microsoft.com/.default'], 'offline-user-assertion'), 'offline-workload-token');
                assert.equal(requests[0].oboAssertion, 'offline-user-assertion');
                assert.deepEqual(requests[0].scopes, ['https://graph.microsoft.com/.default']);
            } finally {
                msal.ConfidentialClientApplication.prototype.acquireTokenOnBehalfOf = original;
            }
        });
