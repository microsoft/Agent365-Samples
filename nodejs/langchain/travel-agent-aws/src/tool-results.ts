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

export function extractCreatedItems(tools: ToolInvocation[]): CreatedDriveItem[] {
  const seen = new Set<string>();
  const out: CreatedDriveItem[] = [];
  for (const t of tools) {
    if (t.status !== 'success' || !CREATE_TOOLS.some((base) => toolNameIs(t.name, base))) continue;
    const found = driveItemPayload(t);
    if (!found) {
      out.push({ tool: t.name, error: 'the tool result did not include the new file id' });
      continue;
    }
    if (seen.has(found.itemId)) continue;
    seen.add(found.itemId);
    const sharedWith = pick(found.payload, 'sharedWith');
    out.push({
      tool: t.name,
      itemId: found.itemId,
      driveId: pick(pick(found.driveItem, 'parentReference'), 'driveId'),
      name: pick(found.driveItem, 'name'),
      webUrl: pick(found.driveItem, 'webUrl'),
      sharedWith: typeof sharedWith === 'string' ? sharedWith : undefined,
    });
  }
  return out;
}
