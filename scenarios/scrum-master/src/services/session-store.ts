// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * In-memory session store for in-flight standups.
 *
 * Active sessions are torn down after the consolidated summary posts, retaining
 * a small per-day completion record. SharePoint is the durable record; this cache
 * exists so response fan-in and cutoff timers don't need a round-trip per event.
 *
 * Session id convention: `<sprintId>#<yyyy-mm-dd>` — idempotent between the Azure
 * Function trigger and the local dev cron so both can fire the same tick safely.
 */

import { JiraIssue } from './jira';

export type StandupState = 'open' | 'summarizing' | 'summarized' | 'archived';

export interface StandupItemResponse {
    issueKey: string;
    update: string;
    hasBlocker: boolean;
    blockerText?: string;
}

export interface StandupResponse {
    userAadId: string;
    submittedUtc: string;
    items: StandupItemResponse[];
}

export interface StandupSession {
    standupId: string;
    sprintId: number;
    sprintName: string;
    startedUtc: string;
    cutoffUtc: string;
    state: StandupState;
    initiatedByAadId: string | null;
    /** Per-assignee item groups fetched from Jira at trigger time. */
    itemsByAssignee: Map<string /* aadObjectId */, JiraIssue[]>;
    /** AAD ids of everyone we expect to hear from. */
    expectedResponders: Set<string>;
    /** AAD ids we successfully DM'd (subset of expected). */
    sentTo: Set<string>;
    /** AAD ids that never had a reachable conversation ref. */
    unreachable: Set<string>;
    /** Submitted responses, keyed by AAD id. */
    responses: Map<string, StandupResponse>;
    /** Cutoff timer handle (only set when running under local cron). */
    cutoffTimer?: NodeJS.Timeout;
}

const sessions = new Map<string, StandupSession>();
const completed = new Map<string, { sentTo: number }>();
const pendingSubmissions = new WeakMap<StandupSession, Map<string, Promise<void>>>();

/** Reserve synchronously so cutoff finalization includes every accepted write. */
export function reserveSessionSubmission(session: StandupSession, responderId: string): (() => void) | undefined {
    if (session.state !== 'open') return undefined;
    const writes = pendingSubmissions.get(session) ?? new Map<string, Promise<void>>();
    if (writes.has(responderId) || session.responses.has(responderId)) return undefined;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    writes.set(responderId, pending);
    pendingSubmissions.set(session, writes);
    return () => {
        writes.delete(responderId);
        release();
    };
}

export async function waitForSessionSubmissions(session: StandupSession): Promise<void> {
    await Promise.all(pendingSubmissions.get(session)?.values() ?? []);
}

export async function waitForResponderSubmission(session: StandupSession, responderId: string): Promise<void> {
    await pendingSubmissions.get(session)?.get(responderId);
}

export function getCompletedSession(standupId: string): { sentTo: number } | undefined {
    return completed.get(standupId);
}

/** Claim synchronously after prerequisites so concurrent finalizers cannot both run. */
export function claimSessionFinalization(session: StandupSession): boolean {
    if (session.state !== 'open') return false;
    session.state = 'summarizing';
    return true;
}

export function completeSession(session: StandupSession): void {
    session.state = 'summarized';
    completed.set(session.standupId, { sentTo: session.sentTo.size });
    removeSession(session.standupId);
    const day = todayKey();
    for (const id of completed.keys()) {
        if (id.slice(id.lastIndexOf('#') + 1) < day) completed.delete(id);
    }
}

export function todayKey(now = new Date()): string {
    return now.toISOString().slice(0, 10);
}

export function makeStandupId(sprintId: number, day = todayKey()): string {
    return `${sprintId}#${day}`;
}

export function getSession(standupId: string): StandupSession | undefined {
    return sessions.get(standupId);
}

export function upsertSession(session: StandupSession): StandupSession {
    sessions.set(session.standupId, session);
    return session;
}

export function removeSession(standupId: string): void {
    const s = sessions.get(standupId);
    if (s?.cutoffTimer) clearTimeout(s.cutoffTimer);
    sessions.delete(standupId);
}

export function listOpenSessions(): StandupSession[] {
    return Array.from(sessions.values()).filter(s => s.state === 'open');
}

export function allExpectedResponded(session: StandupSession): boolean {
    return Array.from(session.expectedResponders).every(id => session.responses.has(id));
}
