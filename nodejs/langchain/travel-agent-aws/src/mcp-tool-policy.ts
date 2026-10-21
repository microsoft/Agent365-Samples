// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Code-enforced MCP tool policy. Every document the agent creates lives in the AGENT's OneDrive,
// which is shared by everyone who talks to this agent instance — so the model must not be able to
// list, search, read, move, delete or share files there (one user could otherwise reach another
// user's documents, or a prompt injected via document text could re-share them). The model only
// gets the tools below; sharing is done by code for the verified requester (client.ts).
import { DynamicStructuredTool } from '@langchain/core/tools';
import { toolNameIs } from './tool-results.js';

// Base tool names (from MCP-Platform mcp_WordServer and mcp_OneDriveRemoteServer) the model may call.
export const MODEL_MCP_TOOL_ALLOWLIST = [
  'CreateDocument',                  // shareWith is stripped — see withoutShareWith()
  'GetDocumentContent',              // by URL — needed to answer Word comments
  'ReplyToComment',
  'AddComment',
  'createSmallTextFileInMyOnedrive',
];

// Never exposed to the model; grantEditAccess() calls it directly with an item id created this turn.
export const SHARE_TOOL = 'shareFileOrFolderInMyOnedrive';

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

// CreateDocument without its shareWith parameter: the model can't name recipients, and any
// shareWith it still sends is dropped before the MCP call.
export function withoutShareWith(tool: any): any {
  const inner = tool;
  return new DynamicStructuredTool({
    name: inner.name,
    description: CREATE_DOCUMENT_DESCRIPTION,
    schema: stripProperty(inner.schema, 'shareWith'),
    responseFormat: inner.responseFormat ?? 'content_and_artifact',
    metadata: inner.metadata,
    func: async (args: Record<string, unknown>, runManager?: any, config?: any) => {
      const { shareWith: _ignored, ...rest } = args ?? {};
      return inner.func(rest, runManager, config);
    },
  } as any);
}

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
    modelTools.push(toolNameIs(name, 'CreateDocument') ? withoutShareWith(t) : t);
  }
  return { modelTools, withheld };
}
