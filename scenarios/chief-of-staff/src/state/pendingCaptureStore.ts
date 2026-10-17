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

/** One extracted action item / decision, with its write progress. */
export interface CaptureItem {
  itemId: string;
  kind: 'task' | 'decision';
  title: string;
  description?: string;
  dueDateTime?: string | null;
  ownerAad: string;
  ownerName: string;
  taskId?: string;
  descriptionSaved?: boolean;
  cardSent?: boolean;
  cardSkipped?: string;
}

export interface SimpleMeetingNote {
  title?: string;
  content?: string;
}

export interface PendingCapture {
  eventId: string; // calendar event id — primary dedupe key
  meetingId: string; // Graph onlineMeeting id
  /** Teams join URL — shared by every occurrence of a recurring meeting. */
  joinWebUrl?: string;
  subject: string;
  organizerAad?: string;
  ownerUpn: string; // whose Graph path to query — normally LEADER_UPN
  chatId?: string;
  /** Scheduled start of THIS occurrence (epoch ms). Used to match transcripts
   *  to the right occurrence of a recurring meeting. */
  startTime?: number;
  endTime: number; // epoch ms
  durationMinutes: number;
  waitBudgetMinutes: number; // computed at creation
  createdAt: number; // epoch ms
  giveUpAfter: number; // epoch ms

  // Progress
  status: CaptureStatus;
  attempts: number;
  nextCheckAt: number; // epoch ms
  /** Downstream (runCapture) failures for a READY capture. */
  processingFailures?: number;

  /** Set when the capture was retired because the invitation was withdrawn
   *  (CoS/leader removed, declined, cancelled). Discovery reopens it if the
   *  event qualifies again; exhausted retries never set this. */
  revokedAt?: number;

  // Fetched artifacts
  transcriptId?: string;
  transcriptFetchedAt?: number;
  /** Correlation ids of the selected transcript — used to accept only the
   *  Copilot insights that belong to this same occurrence. */
  transcriptCallId?: string;
  transcriptCorrelationId?: string;
  /** Extraction checkpoint: the items the model extracted on the first
   *  processing attempt, with per-item write progress. Retries resume from
   *  here instead of re-extracting (so re-worded items can't duplicate). */
  extractedItems?: CaptureItem[];
  summaryPosted?: boolean;
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

export function getCapture(eventId: string): PendingCapture | undefined {
  return store.get(eventId);
}

/** True when another capture already consumed this transcript — prevents a
 *  later occurrence of a recurring meeting from re-processing it. */
export function isTranscriptClaimed(transcriptId: string, exceptEventId: string): boolean {
  for (const c of store.values()) {
    if (c.eventId !== exceptEventId && c.transcriptId === transcriptId) return true;
  }
  return false;
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

/** Return all captures whose next-check time has arrived: pending captures
 *  to advance, plus READY captures whose processing still needs to run
 *  (e.g. after a restart or a downstream failure). */
export function findCapturesDueForCheck(now: number = Date.now()): PendingCapture[] {
  const due: PendingCapture[] = [];
  for (const c of store.values()) {
    if (c.status !== 'pending' && c.status !== 'ready') continue;
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

/** Artifacts are collected; processing has not succeeded yet. The fat fields
 *  stay (in memory and on disk) so a restart or retry can reprocess. */
export function markCaptureReady(eventId: string): void {
  const c = store.get(eventId);
  if (!c) return;
  c.status = 'ready';
  c.nextCheckAt = Date.now();
  store.set(eventId, c);
}

const MAX_PROCESSING_FAILURES = Number(process.env.CAPTURE_MAX_PROCESSING_FAILURES ?? '3');

/** runCapture failed: keep the capture READY and retry later, or give up
 *  after MAX_PROCESSING_FAILURES so a poison payload can't loop forever. */
export function markCaptureProcessingFailed(eventId: string): 'retry' | 'gave-up' {
  const c = store.get(eventId);
  if (!c) return 'gave-up';
  c.processingFailures = (c.processingFailures ?? 0) + 1;
  if (c.processingFailures >= MAX_PROCESSING_FAILURES) {
    store.set(eventId, c);
    markCaptureGaveUp(eventId);
    return 'gave-up';
  }
  c.status = 'ready';
  c.nextCheckAt = Date.now() + pickNextRetryDelayMinutes(c.processingFailures, 30) * 60 * 1000;
  store.set(eventId, c);
  return 'retry';
}

/**
 * The calendar event behind an existing capture moved. Refresh its timing and
 * deadlines; reopen a gave-up record whose new window hasn't passed yet.
 * Completed captures are left untouched (dedupe of processed occurrences).
 */
export function rescheduleCapture(
  eventId: string,
  timing: { startTime?: number; endTime: number; durationMinutes: number; waitBudgetMinutes: number; giveUpAfter: number }
): 'updated' | 'reopened' | 'unchanged' {
  const c = store.get(eventId);
  if (!c || c.status === 'complete') return 'unchanged';
  const moved = c.endTime !== timing.endTime || (timing.startTime !== undefined && c.startTime !== timing.startTime);
  if (!moved) return 'unchanged';
  Object.assign(c, timing);
  let result: 'updated' | 'reopened' = 'updated';
  if (c.status === 'gave-up' && timing.giveUpAfter > Date.now()) {
    c.status = 'pending';
    c.attempts = 0;
    c.processingFailures = 0;
    c.transcriptId = undefined;
    c.transcriptFetchedAt = undefined;
    c.insightsFetched = false;
    result = 'reopened';
  }
  if (c.status === 'pending') c.nextCheckAt = Date.now();
  store.set(eventId, c);
  return result;
}

/**
 * The invitation was withdrawn: retire the capture but remember why, so a
 * later re-invitation can reopen it (unlike exhausted retries).
 */
export function markCaptureRevoked(eventId: string): void {
  const c = store.get(eventId);
  if (!c) return;
  markCaptureGaveUp(eventId);
  c.revokedAt = Date.now();
  store.set(eventId, c);
}

/**
 * Fresh discovery confirms a revoked capture qualifies again: reopen it with
 * clean artifact and retry state. No-op for captures that weren't revoked.
 */
export function reopenRevokedCapture(
  eventId: string,
  timing: { startTime?: number; endTime: number; durationMinutes: number; waitBudgetMinutes: number; giveUpAfter: number }
): boolean {
  const c = store.get(eventId);
  if (!c || c.status !== 'gave-up' || !c.revokedAt) return false;
  Object.assign(c, timing);
  c.status = 'pending';
  c.revokedAt = undefined;
  c.attempts = 0;
  c.processingFailures = 0;
  c.nextCheckAt = Date.now();
  c.transcriptId = undefined;
  c.transcriptFetchedAt = undefined;
  c.transcriptCallId = undefined;
  c.transcriptCorrelationId = undefined;
  c.transcriptContent = undefined;
  c.insightsFetched = false;
  c.insightsActionItems = undefined;
  c.insightsMeetingNotes = undefined;
  c.extractedItems = undefined;
  c.summaryPosted = undefined;
  store.set(eventId, c);
  return true;
}

export function markCaptureComplete(eventId: string): void {
  const c = store.get(eventId);
  if (!c) return;
  c.status = 'complete';
  c.extractedItems = undefined;
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
