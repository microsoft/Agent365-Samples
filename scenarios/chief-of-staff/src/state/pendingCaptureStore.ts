// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// In-process tracking of meeting captures that are in-flight — waiting for
// their transcript and/or AI insights to become available in Graph.
//
// A capture is created by the meeting watcher when it detects a qualifying
// meeting has ended. It stays here through a bounded retry loop until it's
// either READY to fire runCapture or we give up.
//
// Persistence: backed by PersistentMap so a restart doesn't cause every
// meeting in the watch window to be re-captured. On disk we keep a slim
// dedupe record for `complete` / `gave-up` entries (no transcript body);
// only in-flight `pending` / `ready` captures carry the fat fields.

import { PersistentMap } from './persistentMap';

export type CaptureStatus = 'pending' | 'ready' | 'complete' | 'gave-up';

export interface SimpleActionItem {
  title: string;
  ownerDisplayName?: string;
  ownerUpn?: string;
  dueDateTime?: string;
  description?: string;
}

export interface SimpleMeetingNote {
  title?: string;
  content?: string;
}

export interface PendingCapture {
  eventId: string; // calendar event id — primary dedupe key
  meetingId: string; // Graph onlineMeeting id
  subject: string;
  organizerAad?: string;
  ownerUpn: string; // whose Graph path to query — normally LEADER_UPN
  chatId?: string;
  endTime: number; // epoch ms
  durationMinutes: number;
  waitBudgetMinutes: number; // computed at creation
  createdAt: number; // epoch ms
  giveUpAfter: number; // epoch ms

  // Progress
  status: CaptureStatus;
  attempts: number;
  nextCheckAt: number; // epoch ms

  // Fetched artifacts
  transcriptId?: string;
  transcriptFetchedAt?: number;
  /**
   * The raw WebVTT transcript body, fetched via the standalone Graph worker.
   * Populated once transcriptId is known. Undefined = not yet fetched, or the
   * content endpoint failed (LLM should fall back to mcp_TeamsServer).
   *
   * NOT persisted for `complete` / `gave-up` records — see serializeTransform
   * below. Only in-flight captures carry this on disk.
   */
  transcriptContent?: string;
  insightsFetched: boolean;
  insightsActionItems?: SimpleActionItem[];
  insightsMeetingNotes?: SimpleMeetingNote[];
}

// TTL retention for finished captures. In-flight (pending/ready) records
// are always kept. Completed/gave-up records older than this are pruned
// on next hydration.
const RETENTION_DAYS = Number(process.env.CAPTURE_STATE_RETENTION_DAYS ?? '30');
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

// Keyed by eventId (calendar event id).
const store = new PersistentMap<PendingCapture>({
  file: 'pending-captures.json',
  keepOnHydrate: (c) => {
    if (!c) return false;
    // In-flight captures: always keep (the poller will drive them to
    // terminal state or give up).
    if (c.status === 'pending' || c.status === 'ready') return true;
    // Terminal states: keep only within retention window, based on the
    // meeting end time (or createdAt as fallback).
    const anchor = c.endTime ?? c.createdAt ?? 0;
    return Date.now() - anchor < RETENTION_MS;
  },
  serializeTransform: (c) => {
    // Slim disk footprint for terminal records — we already used the
    // transcript body and insights during runCapture; on disk we only
    // need enough info to dedupe on future discovery ticks.
    if (c.status !== 'complete' && c.status !== 'gave-up') return c;
    return {
      ...c,
      transcriptContent: undefined,
      insightsActionItems: undefined,
      insightsMeetingNotes: undefined,
    };
  },
});

export function hasCaptureForEvent(eventId: string): boolean {
  return store.has(eventId);
}

export function createPendingCapture(
  input: Omit<
    PendingCapture,
    | 'createdAt'
    | 'status'
    | 'attempts'
    | 'nextCheckAt'
    | 'insightsFetched'
  >
): PendingCapture {
  const now = Date.now();
  const record: PendingCapture = {
    ...input,
    createdAt: now,
    status: 'pending',
    attempts: 0,
    nextCheckAt: now, // check immediately on next tick
    insightsFetched: false,
  };
  store.set(record.eventId, record);
  return record;
}

/** Return all captures whose next-check time has arrived. */
export function findCapturesDueForCheck(now: number = Date.now()): PendingCapture[] {
  const due: PendingCapture[] = [];
  for (const c of store.values()) {
    if (c.status !== 'pending') continue;
    if (c.nextCheckAt <= now) due.push(c);
  }
  return due;
}

export function updateCapture(
  eventId: string,
  patch: Partial<PendingCapture>
): PendingCapture | undefined {
  const c = store.get(eventId);
  if (!c) return undefined;
  Object.assign(c, patch);
  store.set(eventId, c); // triggers debounced write
  return c;
}

export function markCaptureComplete(eventId: string): void {
  const c = store.get(eventId);
  if (!c) return;
  c.status = 'complete';
  // Strip fat fields — the transcript has already been fed to the LLM.
  // Keeping them in memory serves no purpose and the serializeTransform
  // drops them on disk anyway; freeing the in-memory copy is a bonus.
  c.transcriptContent = undefined;
  c.insightsActionItems = undefined;
  c.insightsMeetingNotes = undefined;
  store.set(eventId, c);
}

export function markCaptureGaveUp(eventId: string): void {
  const c = store.get(eventId);
  if (!c) return;
  c.status = 'gave-up';
  c.transcriptContent = undefined;
  c.insightsActionItems = undefined;
  c.insightsMeetingNotes = undefined;
  store.set(eventId, c);
}

export function listAll(): PendingCapture[] {
  return Array.from(store.values());
}

// ─── Wait-budget math ─────────────────────────────────────────────────────
export interface WaitBudgetOptions {
  multiplier: number;
  minMinutes: number;
  maxMinutes: number;
}

export function computeWaitBudget(
  durationMinutes: number,
  opts: WaitBudgetOptions
): number {
  const raw = durationMinutes * opts.multiplier;
  return Math.max(opts.minMinutes, Math.min(opts.maxMinutes, raw));
}

/** Retry cadence in minutes, budgeted to the wait window. */
export function pickNextRetryDelayMinutes(
  attempts: number,
  waitBudgetMinutes: number
): number {
  const ladder = [1, 3, 7, 15, 30];
  const step = ladder[Math.min(attempts, ladder.length - 1)];
  return Math.min(step, Math.max(1, waitBudgetMinutes));
}
