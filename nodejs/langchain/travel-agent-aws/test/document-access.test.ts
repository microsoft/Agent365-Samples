// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamicStructuredTool } from '@langchain/core/tools';
import {
  DOC_ACCESS_DENIED,
  PartialInvocationError,
  authorizeDocTool,
  createTurnDocAccess,
  normalizeDocUrl,
  ownedDocsByCaller,
  runWithDocAccess,
} from '../src/document-access.ts';
import { selectModelMcpTools } from '../src/mcp-tool-policy.ts';

const ITEM_URL = 'https://contoso-my.sharepoint.com/personal/agent_contoso_com/Documents/Trip%20Plan.docx';

function fakeMcpTool(name: string, payload: unknown, calls: unknown[] = []) {
  return new DynamicStructuredTool({
    name,
    description: name,
    schema: { type: 'object', properties: {}, additionalProperties: true } as any,
    responseFormat: 'content_and_artifact',
    func: async (args: any) => {
      calls.push(args);
      return [[
        { type: 'text', text: JSON.stringify(payload) },
        { type: 'text', text: 'CorrelationId: N/A, TimeStamp: 2026-10-21_12:00:00' },
      ], []] as any;
    },
  } as any);
}

function modelTools(itemId = 'item-1', driveId = 'drive-1') {
  const created = { driveItem: { Id: itemId, WebUrl: ITEM_URL, Name: 'Trip Plan.docx', ParentReference: { DriveId: driveId } }, sharedWith: '' };
  const readCalls: unknown[] = [];
  const { modelTools: tools } = selectModelMcpTools([
    fakeMcpTool('CreateDocument', created),
    fakeMcpTool('createSmallTextFileInMyOnedrive', { id: `${itemId}-txt`, webUrl: `${ITEM_URL}.txt` }),
    fakeMcpTool('GetDocumentContent', { fileName: 'x.docx', driveId: 'drive-n', documentId: 'doc-n', content: '...' }, readCalls),
    fakeMcpTool('ReplyToComment', { ok: true }),
    fakeMcpTool('AddComment', { ok: true }),
  ]);
  const byName = Object.fromEntries(tools.map((t: any) => [t.name, t]));
  return { byName, readCalls };
}

test('normalizeDocUrl ignores case, query, hash and trailing slash; rejects non-https', () => {
  assert.equal(
    normalizeDocUrl('https://CONTOSO-my.sharepoint.com/personal/agent_contoso_com/Documents/Trip%20Plan.docx/?web=1#x'),
    'https://contoso-my.sharepoint.com/personal/agent_contoso_com/documents/trip plan.docx',
  );
  assert.equal(normalizeDocUrl('http://contoso-my.sharepoint.com/a.docx'), undefined);
  assert.equal(normalizeDocUrl('not a url'), undefined);
  assert.equal(normalizeDocUrl(42), undefined);
});

test('Office viewer URLs keep the sourcedoc id, and are unusable without one', () => {
  const a = normalizeDocUrl('https://c.sharepoint.com/sites/s/_layouts/15/Doc.aspx?sourcedoc=%7BAAA%7D&action=edit');
  const b = normalizeDocUrl('https://c.sharepoint.com/sites/s/_layouts/15/Doc.aspx?sourcedoc={BBB}');
  assert.equal(a, 'https://c.sharepoint.com/sites/s/_layouts/15/doc.aspx?sourcedoc=aaa');
  assert.notEqual(a, b);
  assert.equal(normalizeDocUrl('https://c.sharepoint.com/sites/s/_layouts/15/Doc.aspx?file=x.docx'), undefined);
});

test('without a turn scope every document tool is denied (fail closed)', async () => {
  assert.deepEqual(authorizeDocTool('GetDocumentContent', { url: ITEM_URL }).allowed, false);
  const { byName } = modelTools();
  await assert.rejects(byName.GetDocumentContent.invoke({ url: ITEM_URL }), { message: DOC_ACCESS_DENIED });
});

test('a created document is owned by its caller only; other callers are denied its URL', async () => {
  const { byName, readCalls } = modelTools('owned-1', 'drive-a');
  const first = createTurnDocAccess(['caller-a1']);
  await runWithDocAccess(first, () => byName.CreateDocument.invoke({ fileName: 'Trip Plan.docx', contentInHtml: 'x' }));
  assert.equal(first.created.length, 1);
  assert.equal(first.created[0].itemId, 'owned-1');
  assert.deepEqual(ownedDocsByCaller.get('caller-a1'), [{ itemId: 'owned-1', driveId: 'drive-a', webUrl: ITEM_URL }]);

  // Next turn, same caller: owned URL is allowed after normalization (case + query string).
  const later = createTurnDocAccess(['caller-a1']);
  await runWithDocAccess(later, () => byName.GetDocumentContent.invoke({ url: `${ITEM_URL.toUpperCase().replace('HTTPS', 'https')}?web=1` }));
  assert.equal(readCalls.length, 1);
  // Comment tools on the owned document are allowed on an ordinary turn.
  await runWithDocAccess(later, () => byName.AddComment.invoke({ driveId: 'DRIVE-A', documentId: 'owned-1', newComment: 'hi' }));

  // Another caller pasting the same URL is denied, and the MCP tool is never called.
  const other = createTurnDocAccess(['caller-b1']);
  await assert.rejects(
    runWithDocAccess(other, () => byName.GetDocumentContent.invoke({ url: ITEM_URL })),
    (err: any) => err instanceof PartialInvocationError && err.cause.message === DOC_ACCESS_DENIED,
  );
  await assert.rejects(runWithDocAccess(other, () => byName.AddComment.invoke({ driveId: 'drive-a', documentId: 'owned-1', newComment: 'x' })));
  assert.equal(readCalls.length, 1);
});

test('a caller without a stable identity can use a created document only within the same turn', async () => {
  const { byName } = modelTools('anon-1', 'drive-x');
  const access = createTurnDocAccess([]);
  await runWithDocAccess(access, async () => {
    await byName.CreateDocument.invoke({ fileName: 'a', contentInHtml: 'b' });
    await byName.GetDocumentContent.invoke({ url: ITEM_URL });
  });
  await assert.rejects(runWithDocAccess(createTurnDocAccess([]), () => byName.GetDocumentContent.invoke({ url: ITEM_URL })));
});

test('a Word comment notification allows only its document and comment', async () => {
  const { byName } = modelTools();
  const notifiedUrl = 'https://contoso.sharepoint.com/sites/team/Shared%20Documents/Plan.docx';
  const scope = { documentUrl: notifiedUrl, documentId: 'DOC-N', commentIds: ['c-1', 'c-2'] };
  const access = createTurnDocAccess(['caller-n1'], scope);
  await runWithDocAccess(access, () => byName.GetDocumentContent.invoke({ url: notifiedUrl }));
  await assert.rejects(
    runWithDocAccess(access, () => byName.GetDocumentContent.invoke({ url: 'https://contoso.sharepoint.com/sites/team/Shared%20Documents/Other.docx' })),
  );
  await runWithDocAccess(access, () => byName.ReplyToComment.invoke({ commentId: 'c-2', driveId: 'drive-n', documentId: 'doc-n', newComment: 'ok' }));
  await runWithDocAccess(access, () => byName.ReplyToComment.invoke({ commentId: 'c-1', driveId: 'DRIVE-N', documentId: 'DOC-N', newComment: 'ok' }));
  assert.equal(authorizeDocToolIn(access, 'ReplyToComment', { commentId: 'c-9', driveId: 'drive-n', documentId: 'doc-n' }).reason, 'comment-not-notified');
  assert.equal(authorizeDocToolIn(access, 'AddComment', { driveId: 'drive-n', documentId: 'doc-n' }).reason, 'add-comment-on-notification');
});

test('a notification turn cannot reach the commenter\'s other documents', async () => {
  const { byName, readCalls } = modelTools('owned-n', 'drive-o');
  await runWithDocAccess(createTurnDocAccess(['caller-n2']), () => byName.CreateDocument.invoke({ fileName: 'a', contentInHtml: 'b' }));
  const notifiedUrl = 'https://contoso.sharepoint.com/sites/team/Shared%20Documents/Plan.docx';
  const access = createTurnDocAccess(['caller-n2'], { documentUrl: notifiedUrl, documentId: 'doc-n', commentIds: ['c-1'] });

  // Owned documents are not readable or commentable on a notification turn.
  assert.deepEqual(authorizeDocToolIn(access, 'GetDocumentContent', { url: ITEM_URL }), { allowed: false, reason: 'document-not-allowed' });
  await assert.rejects(runWithDocAccess(access, () => byName.GetDocumentContent.invoke({ url: ITEM_URL })));
  assert.equal(readCalls.length, 0);
  assert.equal(authorizeDocToolIn(access, 'ReplyToComment', { commentId: 'ZZZ', driveId: 'drive-o', documentId: 'owned-n' }).allowed, false);
  assert.equal(authorizeDocToolIn(access, 'ReplyToComment', { commentId: 'c-1', driveId: 'drive-o', documentId: 'owned-n' }).allowed, false);
  assert.equal(authorizeDocToolIn(access, 'AddComment', { driveId: 'drive-o', documentId: 'owned-n' }).reason, 'add-comment-on-notification');
});

test('a notification reply needs the exact drive returned by reading the notified document', async () => {
  const { byName } = modelTools();
  const notifiedUrl = 'https://contoso.sharepoint.com/sites/team/Shared%20Documents/Plan.docx';
  const access = createTurnDocAccess(['caller-n3'], { documentUrl: notifiedUrl, documentId: 'doc-n', commentIds: ['c-1'] });

  // The notified id alone (before any read, or with a missing/other drive) is not enough.
  assert.equal(authorizeDocToolIn(access, 'ReplyToComment', { commentId: 'c-1', driveId: 'drive-n', documentId: 'doc-n' }).allowed, false);
  assert.equal(authorizeDocToolIn(access, 'ReplyToComment', { commentId: 'c-1', documentId: 'doc-n' }).allowed, false);
  await runWithDocAccess(access, () => byName.GetDocumentContent.invoke({ url: notifiedUrl }));
  assert.equal(authorizeDocToolIn(access, 'ReplyToComment', { commentId: 'c-1', driveId: 'DX', documentId: 'doc-n' }).allowed, false);
  assert.equal(authorizeDocToolIn(access, 'ReplyToComment', { commentId: 'c-1', documentId: 'doc-n' }).allowed, false);
  assert.equal(authorizeDocToolIn(access, 'ReplyToComment', { commentId: 'c-1', driveId: 'drive-n', documentId: 'doc-n' }).allowed, true);
});

test('a read whose id differs from the notified document id unlocks nothing', async () => {
  const { byName } = modelTools();
  const notifiedUrl = 'https://contoso.sharepoint.com/sites/team/Shared%20Documents/Plan.docx';
  const access = createTurnDocAccess(['caller-n4'], { documentUrl: notifiedUrl, documentId: 'other-doc', commentIds: ['c-1'] });
  await runWithDocAccess(access, () => byName.GetDocumentContent.invoke({ url: notifiedUrl }));
  assert.equal(authorizeDocToolIn(access, 'ReplyToComment', { commentId: 'c-1', driveId: 'drive-n', documentId: 'doc-n' }).allowed, false);
});

test('ids from an allowed GetDocumentContent result unlock ReplyToComment in the same turn only', async () => {
  const { byName } = modelTools();
  const notifiedUrl = 'https://contoso.sharepoint.com/sites/team/Shared%20Documents/Plan.docx';
  const scope = { documentUrl: notifiedUrl, commentIds: ['c-1'] };
  const reply = { commentId: 'c-1', driveId: 'drive-n', documentId: 'doc-n', newComment: 'ok' };

  const turn1 = createTurnDocAccess(['caller-r1'], scope);
  assert.equal(authorizeDocToolIn(turn1, 'ReplyToComment', reply).allowed, false);
  await runWithDocAccess(turn1, async () => {
    await byName.GetDocumentContent.invoke({ url: notifiedUrl });
    await byName.ReplyToComment.invoke(reply);
  });

  const turn2 = createTurnDocAccess(['caller-r1'], scope);
  assert.equal(authorizeDocToolIn(turn2, 'ReplyToComment', reply).allowed, false);
});

test('a failure after a successful create carries only that invocation\'s created items', async () => {
  const { byName } = modelTools('partial-1', 'drive-p');
  const access = createTurnDocAccess(['caller-p1']);
  const err = await runWithDocAccess(access, async () => {
    await byName.CreateDocument.invoke({ fileName: 'a', contentInHtml: 'b' });
    await byName.createSmallTextFileInMyOnedrive.invoke({ filename: 'a.txt', content: 'b' });
    throw new Error('ThrottlingException: Bedrock said no to arn:aws:bedrock:...');
  }).then(() => undefined, (e) => e);
  assert.ok(err instanceof PartialInvocationError);
  assert.doesNotMatch(err.message, /Throttling|arn:/);
  assert.equal((err.cause as Error).message.startsWith('ThrottlingException'), true);
  assert.deepEqual(err.createdItems.map((i) => i.itemId), ['partial-1', 'partial-1-txt']);
  assert.deepEqual(ownedDocsByCaller.get('caller-p1')?.map((d) => d.itemId), ['partial-1-txt', 'partial-1']);

  // The next invocation starts with an empty record.
  const next = createTurnDocAccess(['caller-p1']);
  const failed = await runWithDocAccess(next, async () => { throw new Error('boom'); }).then(() => undefined, (e) => e);
  assert.ok(failed instanceof PartialInvocationError);
  assert.deepEqual(failed.createdItems, []);
});

test('a successful create without a parseable id is still recorded for reporting', async () => {
  const { modelTools: tools } = selectModelMcpTools([fakeMcpTool('CreateDocument', { message: 'Document created.' })]);
  const access = createTurnDocAccess(['caller-u1']);
  await runWithDocAccess(access, () => tools[0].invoke({ fileName: 'a', contentInHtml: 'b' }));
  assert.equal(access.created.length, 1);
  assert.equal(access.created[0].itemId, undefined);
  assert.ok(access.created[0].error);
  assert.equal(ownedDocsByCaller.get('caller-u1'), undefined);
});

function authorizeDocToolIn(access: ReturnType<typeof createTurnDocAccess>, name: string, args: Record<string, unknown>) {
  let decision: ReturnType<typeof authorizeDocTool> | undefined;
  // runWithDocAccess is async; the decision is computed synchronously inside the scope.
  void runWithDocAccess(access, async () => { decision = authorizeDocTool(name, args); });
  return decision!;
}
