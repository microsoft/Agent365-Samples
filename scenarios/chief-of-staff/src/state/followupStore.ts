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

export function listAll(): PendingFollowup[] {
  return Array.from(store.values());
}
