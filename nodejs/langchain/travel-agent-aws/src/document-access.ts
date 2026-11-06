// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Requester-scoped authorization for the Word document tools. Every document lives in, or is
// reached through, the AGENT's account, so possession of a URL or id is not permission: the model
// may read or comment only on (a) documents the agent created for this caller, or (b) the document
// named by an authenticated Word comment notification on this turn. Agents (and their MCP tools)
// are cached per caller, so the per-turn scope travels in AsyncLocalStorage, not in a closure.
// It also records, at the tool boundary, every file created during one invocation, so a turn that
// fails after a successful create can still share and report it (see client.ts runTurn).
import { AsyncLocalStorage } from 'node:async_hooks';
import { BoundedTtlMap } from './identity.js';
import { CreatedDriveItem, commentsFromResult, documentIdsFromResult, toolNameIs } from './tool-results.js';

export interface DocScope {
  // From the authenticated WpxComment notification turn only. The notification's own documentId is
  // a Word id, not the Graph drive item id the Word tools use, so the document is named by its URL.
  documentUrl?: string;
  commentIds?: string[];
  // Used only when the notification carries no comment id: the notified comment's text and the
  // agent names it @mentions, to find that one comment in a read of the notified document.
  commentText?: string;
  mentionNames?: string[];
}

export interface TurnDocAccess {
  callerKeys: string[];
  allowedUrls: Set<string>;
  // Lowercased 'driveId|itemId', or a bare itemId when the drive is unknown.
  allowedDocs: Set<string>;
  notifiedCommentIds: Set<string>;
  isNotification: boolean;
  // Notification turns only: the notified document's normalized URL, and the exact
  // 'driveId|itemId' pairs a read of that URL returned (the only targets ReplyToComment may use),
  // also kept with their original case for pinning the reply's arguments.
  notifiedUrl?: string;
  notifiedDocs: Set<string>;
  notifiedTargets: Array<{ driveId: string; documentId: string }>;
  // Normalized notified comment text (no-comment-id notifications only).
  notifiedCommentText?: string;
  mentionNames: string[];
  // Files created during this invocation, recorded as each create tool succeeds.
  created: CreatedDriveItem[];
}

export interface OwnedDoc {
  itemId: string;
  driveId?: string;
  webUrl?: string;
}

export const DOC_ACCESS_DENIED =
  'Access denied - you can only read or comment on documents I created for you, or the document from this Word comment.';

const OWNED_DOCS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_OWNED_DOCS_PER_CALLER = 50;

// Documents created for a caller, keyed by every stable caller key (tenant + agent instance + AAD
// object id / verified UPN). In memory only: a cold start or another concurrent Lambda environment
// does not see it, the same as the other identity maps.
export const ownedDocsByCaller = new BoundedTtlMap<OwnedDoc[]>(OWNED_DOCS_TTL_MS, 1000);

const docAccessStore = new AsyncLocalStorage<TurnDocAccess>();

export class PartialInvocationError extends Error {
  readonly cause: unknown;
  readonly createdItems: CreatedDriveItem[];

  constructor(cause: unknown, createdItems: CreatedDriveItem[]) {
    super('The agent invocation failed before it finished.');
    this.name = 'PartialInvocationError';
    this.cause = cause;
    this.createdItems = createdItems;
  }
}

const lower = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

// Lowercase origin + decoded path, without query, hash or trailing slash. Office web viewer URLs
// (/_layouts/15/Doc.aspx?sourcedoc={guid}) keep the sourcedoc id, since the path alone names no file.
export function normalizeDocUrl(u: unknown): string | undefined {
  if (typeof u !== 'string' || !u.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(u.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  path = path.toLowerCase().replace(/\/+$/, '');
  if (path.includes('/_layouts/')) {
    const sourceDoc = lower(url.searchParams.get('sourcedoc')).replace(/[{}]/g, '');
    if (!sourceDoc) return undefined;
    return `${url.origin.toLowerCase()}${path}?sourcedoc=${sourceDoc}`;
  }
  return `${url.origin.toLowerCase()}${path}`;
}

function docKey(driveId: unknown, itemId: unknown): string | undefined {
  const item = lower(itemId);
  if (!item) return undefined;
  const drive = lower(driveId);
  return drive ? `${drive}|${item}` : item;
}

// Comparable form of a comment: no markup, no @mention of the agent, letters and digits only.
export function normalizeCommentText(text: unknown, mentionNames: string[] = []): string {
  let s = typeof text === 'string' ? text : '';
  s = s.replace(/<at>[\s\S]*?<\/at>/gi, ' ').replace(/<[^>]+>/g, ' ');
  for (const name of mentionNames) {
    const n = name.trim();
    if (n) s = s.replace(new RegExp(`@?${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi'), ' ');
  }
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function createTurnDocAccess(callerKeys: string[], scope?: DocScope): TurnDocAccess {
  const access: TurnDocAccess = {
    callerKeys: [...callerKeys],
    allowedUrls: new Set(),
    allowedDocs: new Set(),
    notifiedCommentIds: new Set(),
    isNotification: !!scope,
    notifiedDocs: new Set(),
    notifiedTargets: [],
    mentionNames: (scope?.mentionNames ?? []).filter((n) => typeof n === 'string' && n.trim()),
    created: [],
  };
  const url = normalizeDocUrl(scope?.documentUrl);
  if (url) {
    access.allowedUrls.add(url);
    access.notifiedUrl = url;
  }
  for (const id of scope?.commentIds ?? []) {
    if (id) access.notifiedCommentIds.add(id);
  }
  if (access.notifiedCommentIds.size === 0) {
    const text = normalizeCommentText(scope?.commentText, access.mentionNames);
    if (text) access.notifiedCommentText = text;
  }
  return access;
}

export function currentDocAccess(): TurnDocAccess | undefined {
  return docAccessStore.getStore();
}

// Runs one agent invocation with a fresh per-invocation record. On failure, the files created
// before the failure travel with the error so the caller can still share and report them.
export async function runWithDocAccess<T>(access: TurnDocAccess, fn: () => Promise<T>): Promise<T> {
  try {
    return await docAccessStore.run(access, fn);
  } catch (err) {
    throw new PartialInvocationError(err, [...access.created]);
  }
}

function ownedDocs(callerKeys: string[]): OwnedDoc[] {
  return callerKeys.flatMap((k) => ownedDocsByCaller.get(k) ?? []);
}

function ownsUrl(access: TurnDocAccess, url: string): boolean {
  return ownedDocs(access.callerKeys).some((d) => normalizeDocUrl(d.webUrl) === url);
}

function ownsDoc(access: TurnDocAccess, driveId: unknown, documentId: unknown): boolean {
  const item = lower(documentId);
  const drive = lower(driveId);
  if (!item) return false;
  return ownedDocs(access.callerKeys).some((d) =>
    lower(d.itemId) === item && (!d.driveId || !drive || lower(d.driveId) === drive));
}

function docAllowedThisTurn(access: TurnDocAccess, driveId: unknown, documentId: unknown): boolean {
  const item = lower(documentId);
  if (!item) return false;
  const full = docKey(driveId, documentId);
  return (!!full && access.allowedDocs.has(full)) || access.allowedDocs.has(item);
}

export interface DocDecision {
  allowed: boolean;
  // Fixed reason codes only — never URLs, ids or names.
  reason: string;
}

// A Word comment notification turn is driven by text other collaborators can write (the comment and
// the document body), so it is limited to the notified document: the caller's other documents are
// not readable, AddComment is refused, and ReplyToComment must name a notified comment on the exact
// drive/item pair a read of the notified URL returned. Owned documents never widen that scope.
export function authorizeDocTool(toolName: string, args: Record<string, unknown> | undefined): DocDecision {
  const access = currentDocAccess();
  if (!access) return { allowed: false, reason: 'no-turn-scope' };
  const a = args ?? {};
  if (toolNameIs(toolName, 'GetDocumentContent')) {
    const url = normalizeDocUrl(a.url);
    if (!url) return { allowed: false, reason: 'invalid-url' };
    if (access.allowedUrls.has(url)) return { allowed: true, reason: 'turn-document' };
    if (!access.isNotification && ownsUrl(access, url)) return { allowed: true, reason: 'owned-document' };
    return { allowed: false, reason: 'document-not-allowed' };
  }
  const isReply = toolNameIs(toolName, 'ReplyToComment');
  const isAdd = toolNameIs(toolName, 'AddComment');
  if (!isReply && !isAdd) return { allowed: false, reason: 'unguarded-tool' };
  if (access.isNotification) {
    if (isAdd) return { allowed: false, reason: 'add-comment-on-notification' };
    if (access.notifiedDocs.size === 0) return { allowed: false, reason: 'notified-document-not-read' };
    const key = lower(a.driveId) ? docKey(a.driveId, a.documentId) : undefined;
    if (!key || !access.notifiedDocs.has(key)) return { allowed: false, reason: 'document-not-allowed' };
    if (!access.notifiedCommentIds.has(String(a.commentId ?? ''))) {
      return { allowed: false, reason: 'comment-not-notified' };
    }
    return { allowed: true, reason: 'turn-document' };
  }
  const owned = ownsDoc(access, a.driveId, a.documentId);
  if (!owned && !docAllowedThisTurn(access, a.driveId, a.documentId)) {
    return { allowed: false, reason: 'document-not-allowed' };
  }
  return { allowed: true, reason: owned ? 'owned-document' : 'turn-document' };
}

// On a notification turn, ReplyToComment can only target the document a read of the notified URL
// returned, so when there is exactly one such document its drive/item ids replace whatever the
// model passed (for example the notification's Word document id, which Graph does not accept).
export function pinNotifiedReplyTarget(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const access = currentDocAccess();
  if (!access?.isNotification || access.notifiedTargets.length !== 1) return args;
  const [target] = access.notifiedTargets;
  return { ...(args ?? {}), driveId: target.driveId, documentId: target.documentId };
}

// After an allowed GetDocumentContent: its driveId/documentId may be commented on for THIS turn.
// On a notification turn, only a read of the notified URL counts. Returns a fixed reason code when
// the read unlocks nothing, for logging.
export function recordDocumentRead(rawResult: unknown, readUrl?: unknown): string | undefined {
  const access = currentDocAccess();
  if (!access) return 'no-turn-scope';
  const ids = documentIdsFromResult(rawResult);
  const key = ids ? docKey(ids.driveId, ids.documentId) : undefined;
  if (!ids || !key) return 'no-ids-in-result';
  if (!access.isNotification) {
    access.allowedDocs.add(key);
    return undefined;
  }
  if (!access.notifiedUrl || normalizeDocUrl(readUrl) !== access.notifiedUrl) return 'not-the-notified-url';
  if (!access.notifiedDocs.has(key)) {
    access.notifiedDocs.add(key);
    access.notifiedTargets.push({ driveId: ids.driveId, documentId: ids.documentId });
  }
  // No comment id in the notification: the comment it names is the one comment in this document
  // whose text matches exactly. Anything other than a single match leaves replies refused.
  if (access.notifiedCommentIds.size === 0 && access.notifiedCommentText) {
    const matches = commentsFromResult(rawResult)
      .filter((c) => normalizeCommentText(c.text, access.mentionNames) === access.notifiedCommentText);
    if (matches.length === 1) access.notifiedCommentIds.add(matches[0].id);
    else return matches.length ? 'comment-text-ambiguous' : 'comment-text-not-found';
  }
  return undefined;
}

// Records a file a create tool just made: in this invocation's list, in the caller's owned
// documents, and in this turn's allowed sets.
export function recordCreated(item: CreatedDriveItem): void {
  const access = currentDocAccess();
  if (!access) return;
  if (item.itemId && access.created.some((c) => c.itemId === item.itemId)) return;
  access.created.push(item);
  if (!item.itemId) return;
  const url = normalizeDocUrl(item.webUrl);
  if (url) access.allowedUrls.add(url);
  const key = docKey(item.driveId, item.itemId);
  if (key) access.allowedDocs.add(key);
  const owned: OwnedDoc = { itemId: item.itemId, driveId: item.driveId, webUrl: item.webUrl };
  for (const callerKey of access.callerKeys) {
    const previous = (ownedDocsByCaller.get(callerKey) ?? []).filter((d) => d.itemId !== item.itemId);
    ownedDocsByCaller.set(callerKey, [owned, ...previous].slice(0, MAX_OWNED_DOCS_PER_CALLER));
  }
}
