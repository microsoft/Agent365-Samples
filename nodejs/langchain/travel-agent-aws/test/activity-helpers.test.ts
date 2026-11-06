// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entityShape, isAgentsChannel, spanAgentId, turnCorrelationId, wordCommentFrom, wordCommentIds } from '../src/activity-helpers.ts';
import { stableCallerKeys } from '../src/identity.ts';

const wpx = { type: 'WpxComment', documentId: 'doc', subjectCommentId: 'c1' };

test('an ordinary Teams @mention is not a Word comment', () => {
  const teams = { channelId: 'msteams', entities: [{ type: 'mention', mentioned: { id: 'bot' } }, wpx] };
  assert.equal(wordCommentFrom(teams), undefined);
});

test('an agents-channel activity with a WpxComment entity is a Word comment', () => {
  const agents = { channelId: 'agents', entities: [{ type: 'mention' }, wpx] };
  assert.deepEqual(wordCommentFrom(agents), wpx);
  assert.equal(wordCommentFrom({ channelId: 'agents', entities: [{ type: 'mention' }] }), undefined);
});

test('isAgentsChannel matches the agents channel only', () => {
  assert.equal(isAgentsChannel({ channelId: 'Agents' }), true);
  assert.equal(isAgentsChannel({ channelId: 'msteams' }), false);
  assert.equal(isAgentsChannel(undefined), false);
});

test('turnCorrelationId uses the activity id, or a fresh UUID', () => {
  assert.equal(turnCorrelationId({ id: 'act-1' }), 'act-1');
  assert.match(turnCorrelationId({}), /^[0-9a-f-]{36}$/);
});

test('span agent id prefers the recipient instance and never uses the blueprint id', () => {
  assert.equal(spanAgentId('inst-1', 'bp-1', {}), 'inst-1');
  assert.equal(spanAgentId(undefined, 'bp-1', { AGENT365_OBS_AGENT_ID: 'inst-2', agent365Observability__agentId: 'x' }), 'inst-2');
  assert.equal(spanAgentId(undefined, 'bp-1', { agent365Observability__agentId: 'inst-3' }), 'inst-3');
  assert.equal(spanAgentId(undefined, 'BP-1', { agent365Observability__agentId: 'bp-1' }), '');
  assert.equal(spanAgentId(undefined, '', {}), '');
});

function ctx(activity: any): any {
  return { activity };
}

test('caller keys need a stable id and are scoped by tenant and agent instance', () => {
  const base = { channelId: 'msteams', conversation: { tenantId: 't1' }, recipient: { agenticAppId: 'app1', agenticUserId: 'u1' } };
  assert.deepEqual(stableCallerKeys(ctx({ ...base, from: { id: '29:mri', name: 'Alex' } })), []);
  const a = stableCallerKeys(ctx({ ...base, from: { id: '29:mri', aadObjectId: 'OID' } }));
  const otherTenant = stableCallerKeys(ctx({ ...base, conversation: { tenantId: 't2' }, from: { aadObjectId: 'oid' } }));
  const otherAgent = stableCallerKeys(ctx({ ...base, recipient: { agenticAppId: 'app2' }, from: { aadObjectId: 'oid' } }));
  assert.equal(a.length, 1);
  assert.notDeepEqual(a, otherTenant);
  assert.notDeepEqual(a, otherAgent);
});

test('wordCommentIds targets the thread and keeps the @mentioned reply', () => {
  assert.deepEqual(wordCommentIds({ initiatingCommentId: 'T1', subjectCommentId: 'R1' }), { threadId: 'T1', subjectId: 'R1' });
  assert.deepEqual(wordCommentIds({ subjectCommentId: 'C1' }), { threadId: 'C1', subjectId: 'C1' });
  assert.deepEqual(wordCommentIds({ parentCommentId: 'T2', commentId: 'R2' }), { threadId: 'T2', subjectId: 'R2' });
  assert.deepEqual(wordCommentIds({ commentId: 'C3' }), { threadId: 'C3', subjectId: 'C3' });
});

test('wordCommentIds reads ids from the OData path', () => {
  assert.deepEqual(
    wordCommentIds({ odataId: "/drives/d1/items/i1/document/comments('T4')/replies('R4')" }),
    { threadId: 'T4', subjectId: 'R4' });
  assert.deepEqual(
    wordCommentIds({ odataId: '/drives/d1/items/i1/document/comments/T5%2B1/replies/R5' }),
    { threadId: 'T5+1', subjectId: 'R5' });
  assert.deepEqual(wordCommentIds({ '@odata.id': '/drives/d/items/i/document/comments(T6)' }), { threadId: 'T6', subjectId: 'T6' });
  assert.deepEqual(wordCommentIds({ type: 'WpxComment', documentId: 'doc' }), { threadId: undefined, subjectId: undefined });
  assert.deepEqual(wordCommentIds(undefined), { threadId: undefined, subjectId: undefined });
});

test('entityShape lists field names only', () => {
  assert.equal(entityShape({ type: 'WpxComment', documentId: 'secret-id', b: 1 }), 'b,documentId,type');
  assert.equal(entityShape(undefined), 'undefined');
});