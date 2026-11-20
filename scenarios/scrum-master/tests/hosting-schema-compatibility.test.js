// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const activity = require('@microsoft/agents-activity');

test('activity and hosting resolve the same patched Zod without a vulnerable nested copy', () => {
    const root = require('zod');
    for (const name of ['@microsoft/agents-activity', '@microsoft/agents-hosting']) {
        const sdk = createRequire(require.resolve(name));
        assert.equal(sdk('zod'), root);
        const [major, minor, patch] = sdk('zod/package.json').version.split('.').map(Number);
        assert.ok(major > 4 || (major === 4 && (minor > 6 || (minor === 6 && patch >= 6))));
    }
});

test('real activity schemas preserve message, card and entity validation with patched Zod', () => {
    const message = {
        type: 'message', text: '/standup', channelId: 'msteams',
        from: { id: 'human', aadObjectId: '55555555-5555-4555-8555-555555555555' },
        recipient: { id: 'agent', agenticAppId: '22222222-2222-4222-8222-222222222222' },
        conversation: { id: 'conversation', conversationType: 'personal' },
        timestamp: '2026-11-02T06:00:00Z',
        entities: [{ type: 'mention', text: 'agent', mentioned: { id: 'agent' } }],
        attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { type: 'AdaptiveCard' } }],
        value: { action: 'standup.submit', standupId: 's1', 'update_TEAM-1': 'In review' },
    };
    const parsed = activity.activityZodSchema.parse(message);
    assert.equal(parsed.text, message.text);
    assert.equal(parsed.value.action, 'standup.submit');
    assert.equal(parsed.entities[0].mentioned.id, 'agent');
    assert.ok(parsed.timestamp instanceof Date);
    assert.equal(activity.Activity.fromObject(message).value.standupId, 's1');
    for (const invalid of [{}, { ...message, type: '' }, { ...message, text: 10 }, { ...message, attachments: 'invalid' }]) {
        assert.equal(activity.activityZodSchema.safeParse(invalid).success, false);
    }
});

test('legacy single-argument semantic entity records still validate their values', () => {
    const base = { type: 'message', semanticAction: { id: 'action', state: 'start', entities: { task: { type: 'Task', key: 'TEAM-1' } } } };
    const parsed = activity.activityZodSchema.parse(base);
    assert.equal(parsed.semanticAction.entities.task.key, 'TEAM-1');
    for (const entity of [null, 1, {}, { type: 1 }]) {
        const invalid = { ...base, semanticAction: { ...base.semanticAction, entities: { task: entity } } };
        assert.equal(activity.activityZodSchema.safeParse(invalid).success, false);
    }
});

test('hosting adaptive-card parsers retain validation, unknown submit fields, and feedback records', () => {
    const entry = require.resolve('@microsoft/agents-hosting');
    const parsers = require(path.join(path.dirname(entry), 'app', 'adaptiveCards', 'activityValueParsers.js'));
    const submit = { action: 'standup.submit', standupId: 's1', 'update_TEAM-1': 'Done' };
    assert.deepEqual(parsers.parseValueAction(submit), submit);
    assert.throws(() => parsers.parseValueAction({ action: 1 }));
    const action = { type: 'Action.Execute', verb: 'save', data: { task: 'TEAM-1', nested: { ok: true } } };
    assert.deepEqual(activity.adaptiveCardInvokeActionZodSchema.parse(action), action);
    assert.equal(activity.adaptiveCardInvokeActionZodSchema.safeParse({ ...action, data: [] }).success, false);
    assert.deepEqual(parsers.parseValueActionFeedbackLoopData({
        actionValue: { reaction: 'like', feedback: { quality: 'good', score: 1 } },
    }), { actionValue: { reaction: 'like', feedback: { quality: 'good', score: 1 } } });
    assert.throws(() => parsers.parseValueActionFeedbackLoopData({ actionValue: { reaction: 'unknown', feedback: 'test' } }));
});
