// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { extractCreatedItems, extractToolInvocations } from '../src/tool-results.ts';
import { SHARE_TOOL, selectModelMcpTools } from '../src/mcp-tool-policy.ts';

const createDocCall = (content: ToolMessage['content'], artifact?: unknown) => [
  new AIMessage({ content: '', tool_calls: [{ id: 'call-1', name: 'CreateDocument', args: { fileName: 'Trip.docx' } }] }),
  new ToolMessage({ tool_call_id: 'call-1', name: 'CreateDocument', content, artifact }),
];

test('CreateDocument two-block MCP result (payload + CorrelationId block) yields the created item', () => {
  const messages = createDocCall([
    { type: 'text', text: '{"driveItem":{"Id":"x","WebUrl":"u","Name":"Trip.docx","ParentReference":{"DriveId":"d"}},"sharedWith":""}' },
    { type: 'text', text: 'CorrelationId: N/A, TimeStamp: 2026-10-21_12:00:00' },
  ]);
  const tools = extractToolInvocations(messages);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].textBlocks.length, 2);
  assert.deepEqual(tools[0].args, { fileName: 'Trip.docx' });
  assert.deepEqual(extractCreatedItems(tools), [
    { tool: 'CreateDocument', itemId: 'x', driveId: 'd', name: 'Trip.docx', webUrl: 'u', sharedWith: '' },
  ]);
});

test('single-block string result and structuredContent artifact are both understood', () => {
  const asString = extractCreatedItems(extractToolInvocations(createDocCall('{"id":"s1","webUrl":"w"}')));
  assert.equal(asString[0].itemId, 's1');
  const asArtifact = extractCreatedItems(extractToolInvocations(createDocCall(
    [{ type: 'text', text: 'Created.' }, { type: 'text', text: 'CorrelationId: N/A' }],
    [{ type: 'mcp_structured_content', data: { driveItem: { id: 'a1' } } }],
  )));
  assert.equal(asArtifact[0].itemId, 'a1');
});

test('a successful create without a usable id is reported as unidentified, not dropped', () => {
  const items = extractCreatedItems(extractToolInvocations(createDocCall([
    { type: 'text', text: 'Document created.' },
    { type: 'text', text: 'CorrelationId: N/A' },
  ])));
  assert.equal(items.length, 1);
  assert.equal(items[0].itemId, undefined);
  assert.ok(items[0].error);
});

test('failed create tools produce no created items', () => {
  const messages = [
    new AIMessage({ content: '', tool_calls: [{ id: 'c', name: 'CreateDocument', args: {} }] }),
    new ToolMessage({ tool_call_id: 'c', name: 'CreateDocument', status: 'error', content: 'boom' }),
  ];
  assert.deepEqual(extractCreatedItems(extractToolInvocations(messages)), []);
});

function fakeMcpTool(name: string, calls: unknown[]) {
  return new DynamicStructuredTool({
    name,
    description: `${name} (share with any email)`,
    schema: { type: 'object', properties: { fileName: { type: 'string' }, shareWith: { type: 'string' } }, required: ['fileName', 'shareWith'] } as any,
    responseFormat: 'content_and_artifact',
    func: async (args: any) => {
      calls.push(args);
      return [[{ type: 'text', text: '{"driveItem":{"id":"x"}}' }], []] as any;
    },
  } as any);
}

test('model gets only allow-listed MCP tools; OneDrive list/read/delete/share are withheld', () => {
  const names = [
    'CreateDocument', 'GetDocumentContent', 'ReplyToComment', 'AddComment', 'createSmallTextFileInMyOnedrive',
    'getFolderChildrenInMyOnedrive', 'findFileOrFolderInMyDrive', 'readSmallTextFileFromMyOnedrive',
    'deleteFileOrFolderInMyOnedrive', SHARE_TOOL, 'moveSmallFileInMyOnedrive', 'renameFileOrFolderInMyOnedrive',
  ];
  const { modelTools, withheld } = selectModelMcpTools(names.map((n) => fakeMcpTool(n, [])));
  assert.deepEqual(modelTools.map((t: any) => t.name).sort(), names.slice(0, 5).sort());
  assert.ok(withheld.includes(SHARE_TOOL));
  assert.ok(withheld.includes('deleteFileOrFolderInMyOnedrive'));
});

test('CreateDocument exposed to the model has no shareWith and drops one if sent anyway', async () => {
  const calls: any[] = [];
  const { modelTools } = selectModelMcpTools([fakeMcpTool('CreateDocument', calls)]);
  const tool: any = modelTools[0];
  assert.equal(tool.schema.properties.shareWith, undefined);
  assert.deepEqual(tool.schema.required, ['fileName']);
  assert.doesNotMatch(tool.description, /email/i);
  const msg = await tool.invoke({ type: 'tool_call', id: 't1', name: 'CreateDocument', args: { fileName: 'a', shareWith: 'b@contoso.com' } });
  assert.deepEqual(calls, [{ fileName: 'a' }]);
  assert.equal(msg.tool_call_id, 't1');
});
