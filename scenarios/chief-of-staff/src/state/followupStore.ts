// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// In-process store of pending / in-flight follow-ups. Tracks what the agent
// asked, whether the owner replied, and whether we've already escalated to
// the leader — so the followup cron can decide who to escalate on next tick.
//
// Persistence: backed by PersistentMap. In-flight (`pending`, `escalated`)
// records are always kept; terminal (`responded`, `resolved`) records are
// pruned on next hydration once they're older than the cooldown window
// used by hasBlockingFollowupForTask (default 3 days). Ensures a restart
// doesn't drop an active escalation, and doesn't lose a "responded within
// cooldown" record either.

import { randomUUID } from 'crypto';
import { PersistentMap } from './persistentMap';

export type FollowupResponseKind = 'ontrack' | 'extend' | 'blocked';
export type FollowupStatus = 'pending' | 'responded' | 'escalated' | 'resolved';

export interface PendingFollowup {
  followupId: string;
  taskId: string;
  taskTitle: string;
  ownerAad: string;
  ownerName: string;
  dueDate?: string; // ISO
  sentAt: number; // epoch ms
  status: FollowupStatus;
  responseKind?: FollowupResponseKind;
  respondedAt?: number;
  escalatedAt?: number;
  meetingScheduledAt?: number;
  extendedTo?: string; // ISO — new due date if extension approved
  /** Due date proposed to the leader for approval. Authoritative for approval. */
  extensionRequestedTo?: string;
  extensionStatus?: 'pending' | 'approved' | 'rejected' | 'cancelled';
  /** Owner request (extension / blocker) that still has to reach the leader.
   *  Written BEFORE the send and cleared only after delivery, so a failed
   *  send is retried by the scheduler instead of being lost. */
  pendingLeaderDelivery?: PendingLeaderDelivery;
}

export interface PendingLeaderDelivery {
  kind: 'extension' | 'blocker';
  suggestedNewDueDate?: string; // extension
  blockerSummary?: string; // blocker
  queuedAt: number;
  attempts: number;
  lastError?: string;
}

// How long to keep terminal (responded / resolved) followups on disk. The
// cooldown checks in cos/followup.ts look back FOLLOWUP_COOLDOWN_HOURS
// (default 4) and MEETING_SCHEDULED_COOLDOWN_HOURS (24). We keep records
// well past both so cooldowns survive a restart. Default 72h = 3 days.
const RETENTION_HOURS = Number(process.env.FOLLOWUP_STATE_RETENTION_HOURS ?? '72');
const RETENTION_MS = RETENTION_HOURS * 60 * 60 * 1000;

const store = new PersistentMap<PendingFollowup>({
  file: 'followups.json',
  keepOnHydrate: (f) => {
    if (!f) return false;
    // Always keep in-flight followups so escalation survives restart.
    if (f.status === 'pending' || f.status === 'escalated') return true;
    // Keep extension requests that still await the leader's decision.
    if (f.extensionStatus === 'pending') return true;
    // Keep owner requests that haven't reached the leader yet.
    if (f.pendingLeaderDelivery) return true;
    // Keep terminal followups within the retention window for cooldowns.
    const anchor = f.respondedAt ?? f.sentAt ?? 0;
    return Date.now() - anchor < RETENTION_MS;
  },
});

export function createFollowup(
  input: Omit<PendingFollowup, 'followupId' | 'sentAt' | 'status'>
): PendingFollowup {
  const followupId = randomUUID();
  const record: PendingFollowup = {
    ...input,
    followupId,
    sentAt: Date.now(),
    status: 'pending',
  };
  store.set(followupId, record);
  return record;
}

export function getFollowup(followupId: string): PendingFollowup | undefined {
  return store.get(followupId);
}

/** Remove a record whose card was never delivered, so it cannot suppress the
 *  next reminder or qualify for a "no reply" escalation. */
export function deleteFollowup(followupId: string): void {
  store.delete(followupId);
}

/** Open follow-up for a specific owner AND task. Used when a card carries a
 *  taskId but no followupId, so we never resolve an unrelated follow-up. */
export function findOpenFollowupForOwnerTask(
  ownerAad: string | undefined,
  taskId: string
): PendingFollowup | undefined {
  if (!ownerAad || !taskId) return undefined;
  const key = ownerAad.toLowerCase();
  let latest: PendingFollowup | undefined;
  for (const f of store.values()) {
    if (f.taskId !== taskId || f.ownerAad.toLowerCase() !== key) continue;
    if (f.status !== 'pending' && f.status !== 'escalated') continue;
    if (!latest || f.sentAt > latest.sentAt) latest = f;
  }
  return latest;
}

/** Record that an extension to `dueIso` was proposed to the leader. */
export function recordExtensionRequest(followupId: string, dueIso: string): void {
  const f = store.get(followupId);
  if (!f) return;
  f.extensionRequestedTo = dueIso;
  f.extensionStatus = 'pending';
  store.set(followupId, f);
}

/** Extension requests still awaiting the leader's approve / reject. */
export function findPendingExtensionRequests(): PendingFollowup[] {
  return Array.from(store.values())
    .filter((f) => f.extensionStatus === 'pending')
    .sort((a, b) => (b.respondedAt ?? b.sentAt) - (a.respondedAt ?? a.sentAt));
}

/** Queue an owner request for delivery to the leader (before sending). */
export function queueLeaderDelivery(
  followupId: string,
  delivery: Omit<PendingLeaderDelivery, 'queuedAt' | 'attempts'>
): PendingFollowup | undefined {
  const f = store.get(followupId);
  if (!f) return undefined;
  f.pendingLeaderDelivery = { ...delivery, queuedAt: Date.now(), attempts: 0 };
  store.set(followupId, f);
  return f;
}

/** Record a delivery attempt. Success clears the queued request. */
export function recordLeaderDeliveryAttempt(followupId: string, ok: boolean, error?: string): void {
  const f = store.get(followupId);
  if (!f?.pendingLeaderDelivery) return;
  if (ok) {
    delete f.pendingLeaderDelivery;
  } else {
    f.pendingLeaderDelivery.attempts += 1;
    f.pendingLeaderDelivery.lastError = error?.slice(0, 300);
  }
  store.set(followupId, f);
}

/** Owner requests whose leader card has not been delivered yet. */
export function findPendingLeaderDeliveries(): PendingFollowup[] {
  return Array.from(store.values())
    .filter((f) => !!f.pendingLeaderDelivery && f.status !== 'resolved')
    .sort((a, b) => a.pendingLeaderDelivery!.queuedAt - b.pendingLeaderDelivery!.queuedAt);
}

export function setExtensionStatus(
  followupId: string,
  status: 'pending' | 'approved' | 'rejected'
): void {
  const f = store.get(followupId);
  if (!f) return;
  f.extensionStatus = status;
  store.set(followupId, f);
}

/** Find the most-recent pending follow-up for a given owner AAD. Used when a
 * user replies with plain text (keyword fallback) instead of clicking a card
 * button — we assume they mean their latest open one. */
export function findLatestOpenFollowupForOwner(
  ownerAad: string | undefined
): PendingFollowup | undefined {
  if (!ownerAad) return undefined;
  const key = ownerAad.toLowerCase();
  let latest: PendingFollowup | undefined;
  for (const f of store.values()) {
    if (f.ownerAad.toLowerCase() !== key) continue;
    if (f.status !== 'pending' && f.status !== 'escalated') continue;
    if (!latest || f.sentAt > latest.sentAt) latest = f;
  }
  return latest;
}

export function recordOwnerResponse(
  followupId: string,
  kind: FollowupResponseKind
): PendingFollowup | undefined {
  const f = store.get(followupId);
  if (!f) return undefined;
  f.status = 'responded';
  f.responseKind = kind;
  f.respondedAt = Date.now();
  store.set(followupId, f); // trigger persistence
  return f;
}

export function markEscalated(followupId: string): void {
  const f = store.get(followupId);
  if (!f) return;
  f.status = 'escalated';
  f.escalatedAt = Date.now();
  store.set(followupId, f);
}

export function markResolved(followupId: string, patch?: Partial<PendingFollowup>): void {
  const f = store.get(followupId);
  if (!f) return;
  f.status = 'resolved';
  if (patch) Object.assign(f, patch);
  store.set(followupId, f);
}

export function findStaleForEscalation(hoursSinceSent: number): PendingFollowup[] {
  const cutoff = Date.now() - hoursSinceSent * 60 * 60 * 1000;
  const stale: PendingFollowup[] = [];
  for (const f of store.values()) {
    if (f.status === 'pending' && f.sentAt < cutoff) stale.push(f);
  }
  return stale;
}

/** Find every open (pending or escalated) follow-up for a given Planner task.
 * Used when the task is marked complete so we can clear any outstanding
 * check-ins / escalations and prevent the escalation sweep from firing. */
export function findOpenFollowupsForTask(taskId: string): PendingFollowup[] {
  const out: PendingFollowup[] = [];
  for (const f of store.values()) {
    if (f.taskId !== taskId) continue;
    if (f.status === 'pending' || f.status === 'escalated') out.push(f);
  }
  return out;
}

/**
 * Close one follow-up and cancel any owner request attached to it (queued
 * leader delivery, pending extension decision). Used when the leader takes the
 * request off the table (e.g. reassign).
 */
export function cancelOwnerRequest(followupId: string): void {
  const f = store.get(followupId);
  if (!f) return;
  f.status = 'resolved';
  delete f.pendingLeaderDelivery;
  if (f.extensionStatus === 'pending') f.extensionStatus = 'cancelled';
  store.set(followupId, f);
}

/**
 * The task is complete: resolve every follow-up for it and cancel any owner
 * request still waiting for delivery or for the leader's decision, so neither
 * the retry pass nor a typed/old-card approval can revive it.
 * Returns the number of records changed.
 */
export function cancelOutstandingRequestsForTask(taskId: string): number {
  let changed = 0;
  for (const f of store.values()) {
    if (f.taskId !== taskId) continue;
    const outstanding =
      f.status === 'pending' ||
      f.status === 'escalated' ||
      f.status === 'responded' ||
      !!f.pendingLeaderDelivery ||
      f.extensionStatus === 'pending';
    if (!outstanding) continue;
    f.status = 'resolved';
    delete f.pendingLeaderDelivery;
    if (f.extensionStatus === 'pending') f.extensionStatus = 'cancelled';
    store.set(f.followupId, f);
    changed++;
  }
  return changed;
}

export function listAll(): PendingFollowup[] {
  return Array.from(store.values());
}
