// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const { test, after, afterEach } = require('node:test');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate startup from the developer's credentials and dotenv file.
for (const key of Object.keys(process.env)) {
  if (/^(CONNECTIONS|CONNECTIONSMAP|AGENTAPPLICATION|agentic_|AUTH_HANDLER_NAME|USE_AGENTIC_AUTH|WEBSITE_SITE_NAME|CLIENTID|CLIENTSECRET|TENANTID)/i.test(key)) {
    delete process.env[key];
  }
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-hosting-'));
const envFile = path.join(directory, '.env');
fs.writeFileSync(envFile, '');
process.env.AGENT_ENV_FILE = envFile;
process.env.ENABLE_OBSERVABILITY = 'false';
process.env.NODE_ENV = 'development';
process.env.PORT = '0';

const { startServer } = require('../dist/index');
const { MyAgent } = require('../dist/hosting');
const sdk = require('@microsoft/agents-hosting');
const { Activity } = require('@microsoft/agents-activity');

after(() => fs.rmSync(directory, { recursive: true, force: true }));
afterEach(() => {
  process.env.NODE_ENV = 'development';
  delete process.env.WEBSITE_SITE_NAME;
});

async function listen(t, app) {
  const server = startServer(app);
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await once(server, 'listening');
  return `http://localhost:${server.address().port}`;
}

function message() {
  return {
    type: 'message', text: 'hello', channelId: 'test',
    deliveryMode: 'expectReplies',
    from: { id: 'test-user', name: 'Test' },
    recipient: { id: 'test-agent' },
    conversation: { id: 'test-conversation' },
  };
}

test('anonymous SDK message routing invokes the agent without reading authorization', async t => {
  const calls = [];
  const app = new MyAgent({
    async invokeAgentWithScope(text, auth, handler) {
      calls.push({ text, auth, handler });
      return 'Hello from the agent';
    },
  });
  assert.throws(() => app.authorization, /unavailable/);
  const url = await listen(t, app);
  const response = await fetch(`${url}/api/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message()),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.activities.some(activity => activity.text === 'Hello from the agent'));
  assert.deepEqual(calls, [{ text: 'hello', auth: undefined, handler: null }]);
});

test('invalid activity and adapter initialization rejection do not terminate HTTP service', async t => {
  const app = new MyAgent({});
  const url = await listen(t, app);
  const post = body => fetch(`${url}/api/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const invalid = await post({});
  assert.equal(invalid.status, 500);
  assert.deepEqual(await invalid.json(), { error: 'Unable to process the message request.' });
  t.mock.method(app.cloudAdapter, 'process', async () => { throw new Error('private connector failure'); });
  const failed = await post(message());
  assert.equal(failed.status, 500);
  assert.doesNotMatch(await failed.text(), /private connector failure/);
  const health = await fetch(`${url}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'healthy');
});

test('adapter rejection after response headers does not attempt another response', async t => {
  const app = new MyAgent({});
  t.mock.method(app.cloudAdapter, 'process', async (_req, res) => {
    res.status(202).send('already sent');
    throw new Error('late adapter failure');
  });
  const url = await listen(t, app);
  const response = await fetch(`${url}/api/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message()),
  });
  assert.equal(response.status, 202);
  assert.equal(await response.text(), 'already sent');
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
});

test('malformed JSON never logs or returns the request body', async t => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(JSON.stringify(args)));
  const url = await listen(t, new MyAgent({}));
  const response = await fetch(`${url}/api/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: '{"secret":"private-request-sentinel",',
  });
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private-request-sentinel/);
  assert.ok(logged.some(line => line.includes('INVALID_JSON')));
  assert.ok(logged.every(line => !line.includes('private-request-sentinel')));
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
});

test('production, App Service and non-development startup reject missing client IDs', () => {
  const app = new MyAgent({});
  for (const mode of ['production', 'app-service', 'unset']) {
    process.env.NODE_ENV = mode === 'production' ? 'production' : mode === 'unset' ? '' : 'development';
    if (mode === 'app-service') process.env.WEBSITE_SITE_NAME = 'test-site';
    else delete process.env.WEBSITE_SITE_NAME;
    assert.throws(() => startServer(app), /authentication client ID|ClientId required in production/);
  }
});

test('configuration-loading errors propagate outside explicit local development', async t => {
  const app = new MyAgent({});
  const authModule = require(path.join(path.dirname(require.resolve('@microsoft/agents-hosting')),
    'auth', 'authConfiguration.js'));
  t.mock.method(authModule, 'loadAuthConfigFromEnv', () => { throw new Error('invalid authentication configuration'); });
  process.env.NODE_ENV = 'production';
  assert.throws(() => startServer(app), /invalid authentication configuration/);
  process.env.NODE_ENV = 'development';
  process.env.WEBSITE_SITE_NAME = 'test-site';
  assert.throws(() => startServer(app), /invalid authentication configuration/);
  delete process.env.WEBSITE_SITE_NAME;
  const url = await listen(t, app);
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
});

test('configured production startup retains JWT protection and public readiness', async t => {
  const app = new MyAgent({});
  const authModule = require(path.join(path.dirname(require.resolve('@microsoft/agents-hosting')),
    'auth', 'authConfiguration.js'));
  t.mock.method(authModule, 'loadAuthConfigFromEnv', () => ({
    clientId: '11111111-1111-4111-8111-111111111111',
  }));
  process.env.NODE_ENV = 'production';
  const url = await listen(t, app);
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  const response = await fetch(`${url}/api/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message()),
  });
  assert.equal(response.status, 401);
});

test('anonymous email and Word notification paths invoke the agent without authorization', async t => {
  const calls = [];
  const app = new MyAgent({
    async invokeAgentWithScope(_text, auth, handler) {
      calls.push({ auth, handler });
      return 'notification response';
    },
  });
  const context = new sdk.TurnContext(app.cloudAdapter, Activity.fromObject(message()));
  t.mock.method(context, 'sendActivity', async () => ({ id: 'sent' }));
  await app.handleEmailNotification(context, { emailNotification: { id: 'email-1' } }, null);
  await app.handleWpxCommentNotification(context, {
    wpxCommentNotification: { documentId: 'document-1', initiatingCommentId: 'comment-1' },
  }, null);
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ({ auth: undefined, handler: null })));
});
