// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Code-enforced MCP tool policy. Every document the agent creates lives in the AGENT's OneDrive,
// which is shared by everyone who talks to this agent instance — so the model must not be able to
// list, search, read, move, delete or share files there (one user could otherwise reach another
// user's documents, or a prompt injected via document text could re-share them). The model only
// gets the tools below; sharing is done by code for the verified requester (client.ts), and the
// Word read/comment tools only reach documents this caller may use (document-access.ts).
import { DynamicStructuredTool } from '@langchain/core/tools';
import { CREATE_TOOLS, CreatedDriveItem, createdItemFromResult, toolNameIs } from './tool-results.js';
import { DOC_ACCESS_DENIED, authorizeDocTool, pinNotifiedReplyTarget, recordCreated, recordDocumentRead } from './document-access.js';
import { logError } from './log.js';

// Base tool names (from MCP-Platform mcp_WordServer and mcp_OneDriveRemoteServer) the model may call.
export const MODEL_MCP_TOOL_ALLOWLIST = [
  'CreateDocument',                  // shareWith is stripped — see withoutShareWith()
  'GetDocumentContent',              // guarded by withDocumentGuard() — caller's own or notified document
  'ReplyToComment',                  // guarded
  'AddComment',                      // guarded
  'createSmallTextFileInMyOnedrive',
];

// Never exposed to the model; grantEditAccess() calls it directly with an item id created this turn.
export const SHARE_TOOL = 'shareFileOrFolderInMyOnedrive';

// Fixed failure codes only: MCP/Graph error text (messages, ids, URLs) stays in the server log.
export type GrantFailure = 'unidentified-item' | 'share-tool-unavailable' | 'share-failed';

export interface GrantResult {
  ok: boolean;
  error?: GrantFailure;
}

// Grants via the OneDrive MCP tool (email/UPN recipients only — it has no object-id or
// link-scope parameter). The model never sees this tool; only items created this turn reach it.
// Never falls back to an organization-wide or anonymous link.
export async function grantEditAccess(tools: any[], item: CreatedDriveItem, email: string): Promise<GrantResult> {
  if (!item.itemId) return { ok: false, error: 'unidentified-item' };
  const share = tools.find((t) => toolNameIs(t?.name, SHARE_TOOL));
  if (!share) return { ok: false, error: 'share-tool-unavailable' };
  try {
    await share.invoke({
      fileOrFolderId: item.itemId,
      recipientEmails: [email],
      roles: ['write'],
      sendInvitation: process.env.SHARE_SEND_INVITATION !== 'false',
      message: 'Here is the document I created for you.',
    });
    return { ok: true };
  } catch (e) {
    logError('[Share] grant failed:', e);
    return { ok: false, error: 'share-failed' };
  }
}

const CREATE_DOCUMENT_DESCRIPTION =
  "Create a new Word document in the agent's OneDrive. Provide a desired file name (may be empty) and " +
  'HTML or plain text content for the document body. Make sure all tags and URLs in the content are valid. ' +
  'Sharing is handled automatically by the system after the document is created.';

function stripProperty(schema: any, prop: string): any {
  if (!schema || typeof schema !== 'object' || !schema.properties) return schema;
  const { [prop]: _removed, ...properties } = schema.properties;
  const required = Array.isArray(schema.required) ? schema.required.filter((r: string) => r !== prop) : schema.required;
  return { ...schema, properties, ...(required ? { required } : {}) };
}

type ToolFunc = (args: Record<string, unknown>, runManager?: any, config?: any) => Promise<unknown>;

// Same name, schema, response format and metadata as the MCP tool; only the call is wrapped.
function wrapTool(inner: any, func: ToolFunc, overrides: { description?: string; schema?: any } = {}): any {
  return new DynamicStructuredTool({
    name: inner.name,
    description: overrides.description ?? inner.description,
    schema: overrides.schema ?? inner.schema,
    responseFormat: inner.responseFormat ?? 'content_and_artifact',
    metadata: inner.metadata,
    defaultConfig: inner.defaultConfig,
    func,
  } as any);
}

// CreateDocument without its shareWith parameter: the model can't name recipients, and any
// shareWith it still sends is dropped before the MCP call.
export function withoutShareWith(tool: any): any {
  return wrapTool(
    tool,
    async (args, runManager, config) => {
      const { shareWith: _ignored, ...rest } = args ?? {};
      return tool.func(rest, runManager, config);
    },
    { description: CREATE_DOCUMENT_DESCRIPTION, schema: stripProperty(tool.schema, 'shareWith') },
  );
}

// Records the created file the moment the MCP create call succeeds (a failed call throws), so it
// is shared and reported even if a later step of the same invocation fails.
export function withCreateRecording(tool: any): any {
  return wrapTool(tool, async (args, runManager, config) => {
    const result = await tool.func(args, runManager, config);
    recordCreated(createdItemFromResult(tool.name, result));
    return result;
  });
}

// GetDocumentContent / ReplyToComment / AddComment only on documents this caller may use
// (document-access.ts). A denial throws, which LangGraph's ToolNode turns into an error
// ToolMessage, so a denied ReplyToComment never counts as posted.
export function withDocumentGuard(tool: any): any {
  return wrapTool(tool, async (rawArgs, runManager, config) => {
    const args = toolNameIs(tool.name, 'ReplyToComment') ? pinNotifiedReplyTarget(rawArgs) : rawArgs;
    const decision = authorizeDocTool(tool.name, args);
    console.log(`[DocAccess] ${tool.name}: ${decision.allowed ? 'allowed' : 'denied'} (${decision.reason})`);
    if (!decision.allowed) throw new Error(DOC_ACCESS_DENIED);
    const result = await tool.func(args, runManager, config);
    if (toolNameIs(tool.name, 'GetDocumentContent')) {
      const unrecorded = recordDocumentRead(result, args?.url);
      if (unrecorded) console.warn(`[DocAccess] GetDocumentContent read unlocks no reply (${unrecorded})`);
    }
    return result;
  });
}

const DOCUMENT_TOOLS = ['GetDocumentContent', 'ReplyToComment', 'AddComment'];

export interface ModelToolSelection {
  modelTools: any[];
  withheld: string[];
}

export function selectModelMcpTools(mcpTools: any[]): ModelToolSelection {
  const modelTools: any[] = [];
  const withheld: string[] = [];
  for (const t of mcpTools) {
    const name: string = t?.name ?? '';
    if (!MODEL_MCP_TOOL_ALLOWLIST.some((base) => toolNameIs(name, base))) {
      withheld.push(name || '?');
      continue;
    }
    if (toolNameIs(name, 'CreateDocument')) {
      modelTools.push(withCreateRecording(withoutShareWith(t)));
    } else if (CREATE_TOOLS.some((base) => toolNameIs(name, base))) {
      modelTools.push(withCreateRecording(t));
    } else if (DOCUMENT_TOOLS.some((base) => toolNameIs(name, base))) {
      modelTools.push(withDocumentGuard(t));
    } else {
      modelTools.push(t);
    }
  }
  return { modelTools, withheld };
}
