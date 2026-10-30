// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Authorization, TurnContext } from '@microsoft/agents-hosting';
import { getWorkIqConnection } from './workiq';
import { withToolScope } from './observability';
import { errorSummary, log } from './util/logger';

interface OperationContext {
  authorization: Authorization;
  authHandlerName: string;
  context: TurnContext;
}

export type BoundOperation =
  | { kind: 'message'; chatId: string; text: string }
  | { kind: 'event'; organizer: string; attendees: string[]; start: string; end: string; subject: string; body: string; transactionId: string };

interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  anyOf?: Schema[];
  oneOf?: Schema[];
}
export interface OperationTool {
  name: string;
  inputSchema: Schema;
}

const key = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();
const eventNames = new Set(['createevent', 'createcalendarevent', 'bookmeeting']);
const messageNames = new Set(['sendmessage', 'sendchatmessage', 'sendmessagetochat', 'postchatmessage', 'postmessage']);

/**
 * Bind catalog fields to trusted application values. No generated arguments,
 * arbitrary recipients, endpoints, or nested commands are accepted. Unknown
 * required fields make the operation incompatible rather than being guessed.
 */
export function bindOperation(tool: OperationTool, op: BoundOperation): Record<string, unknown> {
  if (op.kind === 'message') {
    if (!op.chatId.trim() || !op.text.trim()) throw new Error('A target chat and message are required');
  } else if (!op.organizer.trim() || op.attendees.length === 0 ||
      !Number.isFinite(Date.parse(op.start)) || !Number.isFinite(Date.parse(op.end)) ||
      Date.parse(op.end) <= Date.parse(op.start)) {
    throw new Error('A valid organizer, attendee list, and event interval are required');
  }
  const bare = key(tool.name).replace(/^(mcpcalendartools|mcpteamsserver)/, '');
  if (!(op.kind === 'event' ? eventNames : messageNames).has(bare)) {
    throw new Error('Tool is not an approved create-event or chat-post operation');
  }
  const supplied = new Set<string>();
  const object = (schema: Schema, parent = ''): Record<string, unknown> => {
    if (!schema.properties) throw new Error(`Unsupported object schema for ${parent || 'operation'}`);
    const result: Record<string, unknown> = {};
    for (const [field, rawSchema] of Object.entries(schema.properties)) {
      const selectedSchema = rawSchema.anyOf?.find((s) => s.type !== 'null') ??
        rawSchema.oneOf?.find((s) => s.type !== 'null') ?? rawSchema;
      const schema = { ...selectedSchema, type: Array.isArray(selectedSchema.type) ? selectedSchema.type.find((t) => t !== 'null') : selectedSchema.type };
      const n = key(field);
      let value: unknown;
      if (['requestbody', 'event', 'message', 'body'].includes(n) && schema.type === 'object') {
        value = object(schema, n);
      } else if (op.kind === 'message') {
        if (['chatid', 'chatthreadid', 'threadid'].includes(n)) { value = op.chatId; supplied.add('chat'); }
        else if (['text', 'content', 'message', 'messagebody', 'body'].includes(n)) { value = op.text; supplied.add('text'); }
        else if (n === 'contenttype') value = 'text';
      } else {
        if (['subject', 'title'].includes(n)) { value = op.subject; supplied.add('subject'); }
        else if (['body', 'content', 'description'].includes(n)) value = op.body;
        else if (['organizer', 'organizerupn', 'user', 'userid', 'userprincipalname'].includes(n)) {
          if (schema.type === 'string') { value = op.organizer; supplied.add('organizer'); }
        } else if (['start', 'startdatetime', 'starttime', 'end', 'enddatetime', 'endtime'].includes(n)) {
          const start = n.startsWith('start');
          const instant = start ? op.start : op.end;
          value = schema.type === 'object' ? object(schema, start ? 'start' : 'end') : instant;
          supplied.add(start ? 'start' : 'end');
        } else if (n === 'datetime' && (parent === 'start' || parent === 'end')) {
          value = parent === 'start' ? op.start : op.end;
        } else if (['timezone', 'starttimezone', 'endtimezone'].includes(n)) value = 'UTC';
        else if (['attendees', 'requiredattendees'].includes(n)) {
          if (schema.type !== 'array') throw new Error('Attendees must have an explicit array schema');
          value = op.attendees.map((address) => {
            if (schema.items?.type === 'string') return address;
            if (schema.items?.type !== 'object' || !schema.items.properties) throw new Error('Unsupported attendee schema');
            const fields: Record<string, unknown> = {};
            for (const [k, s] of Object.entries(schema.items.properties)) {
              const f = key(k);
              if (['address', 'email', 'emailaddress'].includes(f) && s.type === 'string') fields[k] = address;
              else if (f === 'emailaddress' && s.type === 'object') fields[k] = { address };
              else if (f === 'type') fields[k] = 'required';
              else if (schema.items.required?.includes(k)) throw new Error(`Unsupported attendee field ${k}`);
            }
            if (!Object.keys(fields).some((k) => ['address', 'email', 'emailaddress'].includes(key(k)))) {
              throw new Error('Attendee schema has no address field');
            }
            return fields;
          });
          supplied.add('attendees');
        } else if (n === 'transactionid') value = op.transactionId;
        else if (n === 'contenttype') value = 'text';
      }
      if (value !== undefined) {
        if (schema.enum && !schema.enum.includes(value)) throw new Error(`Unsupported enum for ${field}`);
        if (schema.type === 'string' && typeof value !== 'string') throw new Error(`Unsupported field type for ${field}`);
        result[field] = value;
      }
    }
    for (const required of schema.required ?? []) {
      if (!(required in result)) throw new Error(`Unsupported required field ${required}`);
    }
    return result;
  };
  const args = object(tool.inputSchema);
  const required = op.kind === 'message' ? ['chat', 'text'] : ['organizer', 'subject', 'start', 'end', 'attendees'];
  if (required.some((r) => !supplied.has(r))) throw new Error('Tool schema cannot bind every approved operation field');
  return args;
}

/** A transport response alone or a model reply is never proof of a write. */
export function confirmedResourceId(result: unknown, kind: BoundOperation['kind']): string {
  const read = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const obj = value as Record<string, unknown>;
    if (obj.isError === true || obj.ok === false || obj.success === false || obj.error) {
      throw new Error('WorkIQ operation returned a failure');
    }
    const id = obj[kind === 'event' ? 'eventId' : 'messageId'] ?? obj.id;
    if (typeof id === 'string' && id.trim()) return id;
    for (const k of ['structuredContent', 'result', 'data', kind]) {
      const found = read(obj[k]);
      if (found) return found;
    }
    if (Array.isArray(obj.content)) {
      for (const item of obj.content) {
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
          let parsed: unknown;
          try { parsed = JSON.parse(item.text); } catch { continue; }
          const found = read(parsed);
          if (found) return found;
        }
      }
    }
    return undefined;
  };
  const id = read(result);
  if (!id) throw new Error('WorkIQ did not return a created resource ID; delivery is not confirmed');
  return id;
}

/** Invoke exactly one catalog operation with code-bound arguments, without an LLM. */
export async function runWorkIqOperation(opts: OperationContext, op: BoundOperation): Promise<string> {
  const server = op.kind === 'event' ? 'mcp_CalendarTools' : 'mcp_TeamsServer';
  const connection = await getWorkIqConnection(server, opts.authorization, opts.authHandlerName, opts.context);
  const mcp = new McpClient({ name: 'ChiefOfStaff', version: '1.0.0' });
  try {
    await mcp.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers } }));
    const compatible: { name: string; args: Record<string, unknown> }[] = [];
    let cursor: string | undefined;
    do {
      const page = await mcp.listTools(cursor ? { cursor } : {});
      for (const tool of page.tools) {
        try {
          const args = bindOperation(tool, op);
          compatible.push({ name: tool.name, args });
        } catch {
          // Catalog schemas that cannot bind this operation are not callable.
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    if (compatible.length !== 1) {
      throw new Error(`Expected one compatible ${op.kind} operation in ${server}; found ${compatible.length}. No write was attempted.`);
    }
    const selected = compatible[0];
    return await withToolScope(opts.context, {
      toolName: selected.name, toolType: 'mcp', arguments: selected.args,
    }, { peopleOpts: opts, humanInitiated: op.kind === 'event' }, async () => {
      const response = await mcp.callTool({ name: selected.name, arguments: selected.args });
      return confirmedResourceId(response, op.kind);
    });
  } finally {
    try { await mcp.close(); } catch (error) {
      log.warn('workiq', 'MCP connection cleanup failed', errorSummary(error));
    }
  }
}
