// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Reads this turn's LangGraph ToolMessages so the code (not the model's prose) decides whether a
// tool ran, and which OneDrive items were created. Pure functions — unit tested in test/.

// One tool execution the model performed during a turn.
export interface ToolInvocation {
  name: string;
  status: 'success' | 'error';
  // Text blocks joined with '\n' — for display/diagnostics only, never parsed as one JSON value.
  content: string;
  // Each MCP text block separately. MCP-Platform appends a 'CorrelationId: …' block to every
  // successful result, so the JSON payload is one block among several.
  textBlocks: string[];
  // structuredContent from the content block or the mcp_structured_content artifact, when present.
  structured: unknown[];
  toolCallId?: string;
  args?: Record<string, unknown>;
}

// A file the model created in the agent's OneDrive during THIS turn. itemId is undefined when the
// create tool succeeded but its result could not be read — the caller must report that, not drop it.
export interface CreatedDriveItem {
  tool: string;
  itemId?: string;
  driveId?: string;
  name?: string;
  webUrl?: string;
  // What Word CreateDocument reported for its optional shareWith ('' when skipped, 'Failed' on error).
  sharedWith?: string;
  error?: string;
}

// MCP tool names may be bare (mcp-adapters default) or carry a server prefix.
export function toolNameIs(name: string | undefined, base: string): boolean {
  return new RegExp(`^(?:[\\w-]+__)?${base}$`, 'i').test(name ?? '');
}

function isToolMessage(m: any): boolean {
  return (typeof m?.getType === 'function' && m.getType() === 'tool') ||
    m?.type === 'tool' ||
    m?.constructor?.name === 'ToolMessage';
}

function textBlocksOf(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : undefined))
      .filter((t): t is string => t !== undefined);
  }
  if (content && typeof content === 'object' && typeof (content as any).text === 'string') {
    return [(content as any).text];
  }
  return content == null ? [] : [JSON.stringify(content)];
}

function structuredOf(m: any): unknown[] {
  const out: unknown[] = [];
  const blocks = Array.isArray(m?.content) ? m.content : [m?.content];
  for (const b of blocks) {
    if (b && typeof b === 'object' && b.structuredContent) out.push(b.structuredContent);
  }
  for (const a of Array.isArray(m?.artifact) ? m.artifact : []) {
    if (a?.type === 'mcp_structured_content' && a.data) out.push(a.data);
  }
  return out;
}

// Pass only the messages produced after this turn's input — never earlier turns from memory.
export function extractToolInvocations(messages: any[]): ToolInvocation[] {
  const argsById = new Map<string, Record<string, unknown>>();
  for (const m of messages ?? []) {
    for (const tc of m?.tool_calls ?? []) {
      if (tc?.id) argsById.set(tc.id, tc.args ?? {});
    }
  }
  const out: ToolInvocation[] = [];
  for (const m of messages ?? []) {
    if (!isToolMessage(m)) continue;
    const textBlocks = textBlocksOf(m.content);
    out.push({
      name: m.name ?? 'unknown',
      status: m.status === 'error' ? 'error' : 'success',
      content: textBlocks.join('\n'),
      textBlocks,
      structured: structuredOf(m),
      toolCallId: m.tool_call_id,
      args: m.tool_call_id ? argsById.get(m.tool_call_id) : undefined,
    });
  }
  return out;
}

// System.Text.Json may emit PascalCase keys (Id, WebUrl, ParentReference.DriveId).
function pick(obj: any, key: string): any {
  if (!obj || typeof obj !== 'object') return undefined;
  const k = Object.keys(obj).find((x) => x.toLowerCase() === key.toLowerCase());
  return k === undefined ? undefined : obj[k];
}

export const CREATE_TOOLS = ['CreateDocument', 'createSmallTextFileInMyOnedrive'];

function driveItemPayload(t: ToolInvocation): { payload: any; driveItem: any; itemId: string } | undefined {
  const candidates: unknown[] = [...t.structured];
  for (const text of t.textBlocks) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      candidates.push(JSON.parse(trimmed));
    } catch {
      // Not a JSON block (e.g. the 'CorrelationId: …' metadata block).
    }
  }
  for (const payload of candidates) {
    const driveItem = pick(payload, 'driveItem') ?? payload;
    const itemId = pick(driveItem, 'id');
    if (typeof itemId === 'string' && itemId) return { payload, driveItem, itemId };
  }
  return undefined;
}

const UNIDENTIFIED = 'the tool result did not include the new file id';

function createdItemOf(t: ToolInvocation): CreatedDriveItem {
  const found = driveItemPayload(t);
  if (!found) return { tool: t.name, error: UNIDENTIFIED };
  const sharedWith = pick(found.payload, 'sharedWith');
  const driveId = pick(pick(found.driveItem, 'parentReference'), 'driveId');
  const name = pick(found.driveItem, 'name');
  const webUrl = pick(found.driveItem, 'webUrl');
  return {
    tool: t.name,
    itemId: found.itemId,
    driveId: typeof driveId === 'string' ? driveId : undefined,
    name: typeof name === 'string' ? name : undefined,
    webUrl: typeof webUrl === 'string' ? webUrl : undefined,
    sharedWith: typeof sharedWith === 'string' ? sharedWith : undefined,
  };
}

export function extractCreatedItems(tools: ToolInvocation[]): CreatedDriveItem[] {
  const seen = new Set<string>();
  const out: CreatedDriveItem[] = [];
  for (const t of tools) {
    if (t.status !== 'success' || !CREATE_TOOLS.some((base) => toolNameIs(t.name, base))) continue;
    const item = createdItemOf(t);
    if (item.itemId) {
      if (seen.has(item.itemId)) continue;
      seen.add(item.itemId);
    }
    out.push(item);
  }
  return out;
}

// A successful MCP tool call returns either a string or a [content, artifact] tuple
// (responseFormat 'content_and_artifact'); this reads it like the matching ToolMessage.
function invocationFromResult(toolName: string, rawResult: unknown): ToolInvocation {
  const isTuple = Array.isArray(rawResult) && rawResult.length === 2 && Array.isArray(rawResult[1]);
  const content = isTuple ? (rawResult as unknown[])[0] : rawResult;
  const artifact = isTuple ? (rawResult as unknown[])[1] : undefined;
  const textBlocks = textBlocksOf(content);
  return {
    name: toolName,
    status: 'success',
    content: textBlocks.join('\n'),
    textBlocks,
    structured: structuredOf({ content, artifact }),
  };
}

// The created item from a create tool's raw (successful) result, read at the tool boundary.
export function createdItemFromResult(toolName: string, rawResult: unknown): CreatedDriveItem {
  return createdItemOf(invocationFromResult(toolName, rawResult));
}

// driveId/documentId from a successful GetDocumentContent result
// (MCP-Platform payload: { fileName, size, driveId, documentId, content, comments, ... }).
export function documentIdsFromResult(rawResult: unknown): { driveId: string; documentId: string } | undefined {
  const t = invocationFromResult('GetDocumentContent', rawResult);
  const candidates: unknown[] = [...t.structured];
  for (const text of t.textBlocks) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      candidates.push(JSON.parse(trimmed));
    } catch {
      // Not a JSON block.
    }
  }
  for (const payload of candidates) {
    const driveId = pick(payload, 'driveId');
    const documentId = pick(payload, 'documentId');
    if (typeof driveId === 'string' && driveId && typeof documentId === 'string' && documentId) {
      return { driveId, documentId };
    }
  }
  return undefined;
}

// Items recorded at the create-tool boundary are authoritative; items read back from this turn's
// ToolMessages only fill gaps. Deduped by itemId.
export function mergeCreatedItems(recorded: CreatedDriveItem[], extracted: CreatedDriveItem[]): CreatedDriveItem[] {
  const seen = new Set<string>();
  const out: CreatedDriveItem[] = [];
  for (const item of [...recorded, ...extracted]) {
    if (item.itemId) {
      if (seen.has(item.itemId)) continue;
      seen.add(item.itemId);
    }
    out.push(item);
  }
  // An unidentified create seen in the ToolMessages is the same call the recorder already reported.
  if (recorded.length) {
    const extraUnidentified = new Set(extracted.filter((i) => !i.itemId));
    return out.filter((i) => !extraUnidentified.has(i));
  }
  return out;
}
