// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Proactive DMs for learning-portal updates.
 *
 * `selectUsersToNotify` chooses which LearningPortalStatus rows should become a DM. Every Graph
 * notification re-reads the whole sliding window, so without a checkpoint any activity in the list
 * would re-send other employees' cards. `handled` maps a user to the LastUpdated time (ms) of the
 * newest row already turned into a DM; a row is selected only if it is newer than that.
 *
 * `PortalQueue` makes the work durable. The webhook acknowledges Graph with 202 straight away, so the
 * work is recorded on disk BEFORE that acknowledgement and retried with bounded backoff until every
 * selected user has been handled, independent of whether another list update ever arrives. The
 * per-user checkpoint is the deduplication key (user + row LastUpdated), so a retry never re-sends a
 * DM that already went out. A failure that can't clear up by retrying (the user has no private chat
 * yet) is not retried.
 *
 * What to scan is decided by a persisted PROCESSING WATERMARK — the start time of the last fully
 * successful pass — not by when a notification happened to arrive. SharePoint-list notifications can
 * be delayed by hours (documented latency of up to 6 h), so a window relative to arrival would miss a
 * completion whose notification shows up late, and an empty result would then clear the work. Each
 * pass scans from `watermark - overlap` (the overlap absorbs clock skew; the per-user checkpoint stops
 * it re-sending), bounded by `maxLookback` so a very old watermark can't trigger an unbounded scan.
 */

import * as fs from 'fs';

export interface PortalChange {
    fields: Record<string, any>;
    updatedAt: number;
}

export function selectUsersToNotify(
    rows: Array<{ id: string; fields: Record<string, any> }>,
    cutoffMs: number,
    handled: Map<string, number>,
): Map<string, PortalChange> {
    const selected = new Map<string, PortalChange>();
    for (const row of rows) {
        const f = row.fields || {};
        const updatedAt = f.LastUpdated ? Date.parse(String(f.LastUpdated)) : NaN;
        if (!Number.isFinite(updatedAt) || updatedAt < cutoffMs) continue;
        const aad = String(f.UserAADId || '').trim();
        if (!aad) continue;
        const handledAt = handled.get(aad.toLowerCase());
        if (handledAt !== undefined && updatedAt <= handledAt) continue;
        // Keep the newest row per user (avoid a double DM when a user has several recent changes).
        const existing = selected.get(aad);
        if (!existing || existing.updatedAt < updatedAt) selected.set(aad, { fields: f, updatedAt });
    }
    return selected;
}

export interface DeliveryResult { ok: boolean; reason?: string; retryable?: boolean }

export interface PortalQueueOptions {
    filePath: string;
    /** Reads the LearningPortalStatus rows updated at or after `cutoffMs`. Throws on a (retryable) read failure. */
    scan: (cutoffMs: number) => Promise<Array<{ id: string; fields: Record<string, any> }>>;
    /** Sends one user's DM. */
    deliver: (aad: string, fields: Record<string, any>) => Promise<DeliveryResult>;
    now?: () => number;
    /** Delay before retry number `attempt` (1-based). */
    backoffMs?: (attempt: number) => number;
    /** Overlap re-scanned before the watermark (default 10 min). */
    windowMs?: number;
    /** Furthest back a pass will ever scan, however old the watermark is (default 24 h). */
    maxLookbackMs?: number;
    maxAttempts?: number;
    maxAgeMs?: number;
    schedule?: (fn: () => void, ms: number) => { unref?: () => void };
}

interface Pending {
    /** When the oldest unfinished notification arrived. Only used to start the very first watermark. */
    since: number;
    attempts: number;
    nextAttemptAt: number;
    /** Bumped by every enqueue so work that arrives mid-run isn't lost when the run finishes. */
    generation: number;
}

interface PersistedState { pending: Pending | null; handled: Record<string, number>; watermark?: number | null }

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export class PortalQueue {
    private pending: Pending | null = null;
    private handled = new Map<string, number>();
    /** Start time (ms) of the last fully successful pass; every row older than this has been handled. */
    private watermark: number | null = null;
    private running: Promise<void> | null = null;
    private timer: { unref?: () => void } | null = null;
    private readonly now: () => number;
    private readonly backoffMs: (attempt: number) => number;
    private readonly windowMs: number;
    private readonly maxLookbackMs: number;
    private readonly maxAttempts: number;
    private readonly maxAgeMs: number;
    private readonly schedule: (fn: () => void, ms: number) => { unref?: () => void };

    constructor(private readonly opts: PortalQueueOptions) {
        this.now = opts.now ?? (() => Date.now());
        this.backoffMs = opts.backoffMs ?? ((attempt) => Math.min(30_000 * 2 ** (attempt - 1), 10 * MINUTE));
        this.windowMs = opts.windowMs ?? 10 * MINUTE;
        this.maxLookbackMs = opts.maxLookbackMs ?? 24 * HOUR;
        this.maxAttempts = opts.maxAttempts ?? 8;
        this.maxAgeMs = opts.maxAgeMs ?? 60 * MINUTE;
        this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
        this.load();
    }

    private load(): void {
        try {
            if (!fs.existsSync(this.opts.filePath)) return;
            const parsed = JSON.parse(fs.readFileSync(this.opts.filePath, 'utf-8')) as Partial<PersistedState>;
            this.pending = parsed.pending ?? null;
            this.handled = new Map(Object.entries(parsed.handled ?? {}));
            this.watermark = typeof parsed.watermark === 'number' ? parsed.watermark : null;
        } catch (err) {
            console.warn('[portal-queue] Could not read saved state, starting empty:', (err as any)?.message ?? err);
        }
    }

    private save(): void {
        try {
            const state: PersistedState = { pending: this.pending, handled: Object.fromEntries(this.handled), watermark: this.watermark };
            fs.writeFileSync(this.opts.filePath, JSON.stringify(state), 'utf-8');
        } catch (err) {
            console.warn('[portal-queue] Could not save state:', (err as any)?.message ?? err);
        }
    }

    /** Records that a notification arrived. Call this BEFORE acknowledging it. */
    enqueue(): void {
        const now = this.now();
        this.pending = this.pending
            ? { ...this.pending, nextAttemptAt: now, generation: this.pending.generation + 1 }
            : { since: now, attempts: 0, nextAttemptAt: now, generation: 1 };
        this.save();
    }

    hasPending(): boolean {
        return this.pending !== null;
    }

    /** Processes pending work (single-flight). Safe to call at any time, including at startup. */
    kick(): Promise<void> {
        if (this.running) return this.running;
        this.running = this.drain().finally(() => { this.running = null; });
        return this.running;
    }

    private async drain(): Promise<void> {
        while (this.pending && this.pending.nextAttemptAt <= this.now()) {
            const startedGeneration = this.pending.generation;
            const succeeded = await this.runOnce();
            if (!this.pending) return;
            if (succeeded) {
                if (this.pending.generation === startedGeneration) {
                    this.pending = null;
                    this.save();
                    return;
                }
                continue; // something arrived while this ran: go again right away
            }
            if (!this.retryLater()) return;
        }
        this.arm();
    }

    private scanCutoff(startedAt: number): number {
        // Start from the last fully successful pass (or, the very first time, when the first notification
        // arrived), re-scan a short overlap for clock skew, and never look further back than maxLookback.
        const base = this.watermark ?? this.pending?.since ?? startedAt;
        return Math.max(base - this.windowMs, startedAt - this.maxLookbackMs);
    }

    private async runOnce(): Promise<boolean> {
        const startedAt = this.now();
        const cutoff = this.scanCutoff(startedAt);
        let rows: Array<{ id: string; fields: Record<string, any> }>;
        try {
            rows = await this.opts.scan(cutoff);
        } catch (err) {
            console.error('[portal-queue] Reading portal rows failed:', (err as any)?.message ?? err);
            return false;
        }
        const selected = selectUsersToNotify(rows, cutoff, this.handled);
        if (selected.size === 0) {
            console.log('[Proactive] No new portal changes since the last successful scan — nothing to DM.');
        } else {
            console.log(`[Proactive] Firing proactive DM for ${selected.size} user(s).`);
        }
        let allDone = true;
        for (const [aad, change] of selected) {
            let result: DeliveryResult;
            try {
                result = await this.opts.deliver(aad, change.fields);
            } catch (err) {
                result = { ok: false, reason: (err as any)?.message ?? String(err), retryable: true };
            }
            if (result.ok) {
                // The checkpoint advances only after the DM was actually handled.
                this.handled.set(aad.toLowerCase(), change.updatedAt);
                this.save();
            } else if (result.retryable !== false) {
                console.warn(`[Proactive]   -> ${aad}: ${result.reason ?? 'delivery failed'} (will retry)`);
                allDone = false;
            } else {
                console.warn(`[Proactive]   -> ${aad}: ${result.reason ?? 'not deliverable'}`);
            }
        }
        // Only a fully successful pass moves the watermark: a failed one is re-scanned from the same point,
        // and so is a pass that gave up, by whichever notification arrives next.
        if (allDone) this.watermark = startedAt;
        this.prune(cutoff);
        return allDone;
    }

    /** Schedules the next attempt. Returns false (and drops the work) when it has been retried long enough. */
    private retryLater(): boolean {
        const pending = this.pending!;
        pending.attempts += 1;
        const tooOld = this.now() - pending.since > this.maxAgeMs;
        if (pending.attempts >= this.maxAttempts || tooOld) {
            console.error(`[portal-queue] Giving up on portal notifications after ${pending.attempts} attempt(s) — the next list update will start a new scan.`);
            this.pending = null;
            this.save();
            return false;
        }
        const delay = this.backoffMs(pending.attempts);
        pending.nextAttemptAt = this.now() + delay;
        this.save();
        console.log(`[portal-queue] Retrying portal notifications in ${Math.round(delay / 1000)}s (attempt ${pending.attempts + 1}).`);
        this.arm();
        return false;
    }

    private arm(): void {
        if (this.timer || !this.pending) return;
        const delay = Math.max(0, this.pending.nextAttemptAt - this.now());
        this.timer = this.schedule(() => { this.timer = null; void this.kick(); }, delay);
        this.timer.unref?.();
    }

    private prune(cutoff: number): void {
        // A checkpoint only matters while a row of that age can still be selected by a scan.
        for (const [key, at] of this.handled) if (at < cutoff) this.handled.delete(key);
        this.save();
    }
}
