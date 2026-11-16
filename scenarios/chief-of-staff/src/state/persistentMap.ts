// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// PersistentMap<V>
// ───────────────────────────────────────────────────────────────────────────
// A `Map<string, V>` subclass that transparently persists to a JSON file on
// disk. Every mutation (`set` / `delete` / `clear`) schedules a debounced
// write; the file is hydrated synchronously at construction time. Optional
// TTL predicate lets a store drop stale records on load without forcing
// callers to write cleanup code.
//
// Design choices:
//   - Synchronous hydration. The file is small (KBs) and boot happens once.
//     Keeping hydration sync means every consumer store keeps its current
//     synchronous API — no ripple through the codebase.
//   - Fire-and-forget writes with a 200 ms debounce. A single-threaded burst
//     of 10 mutations coalesces into one write. Safe because Node is
//     single-threaded — no lost updates within the debounce window.
//   - Atomic write via temp-file + rename. Prevents a torn JSON file if the
//     process is killed mid-write.
//   - Process exit flushes all instances synchronously so a graceful stop
//     (Ctrl+C, SIGTERM from App Service) doesn't lose queued mutations.
//
// Env knobs:
//   STATE_BACKEND=file   (default)  — persist to disk
//   STATE_BACKEND=null              — disable persistence entirely
//   STATE_DIR=./.cos-state (default) — root directory for JSON files
//
// For Azure App Service (single-instance): set STATE_DIR=/home/data/cos-state
// — `/home/data` is the app-scoped persistent volume. See DESIGN.md §6.

import * as fs from 'fs';
import * as path from 'path';

const DEBOUNCE_MS = 200;
const STATE_DIR = (process.env.STATE_DIR?.trim() || './.cos-state').replace(
  /\/+$/,
  ''
);
const PERSISTENCE_DISABLED = process.env.STATE_BACKEND?.trim().toLowerCase() === 'null';

// Ensure root dir exists on first import. Cheap, idempotent.
if (!PERSISTENCE_DISABLED) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch (err) {
    console.warn(
      `[persistentMap] mkdirSync failed for STATE_DIR="${STATE_DIR}" — persistence will silently no-op:`,
      (err as Error).message
    );
  }
}

/** All live instances, so we can flush every one on process exit. */
const allInstances = new Set<PersistentMap<unknown>>();
let shutdownWired = false;

function wireShutdownOnce(): void {
  if (shutdownWired) return;
  shutdownWired = true;

  // `exit` fires synchronously for any process termination that Node can
  // still see (natural exit, process.exit, uncaught exception). Perfect
  // hook for a synchronous flush.
  process.on('exit', () => {
    for (const m of allInstances) m.flushSync();
  });

  // SIGINT (Ctrl+C, nodemon restart) and SIGTERM (App Service shutdown)
  // don't fire `exit` automatically — we need to translate them.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      for (const m of allInstances) m.flushSync();
      // Exit with 0 so nodemon doesn't consider it a crash.
      process.exit(0);
    });
  }
}

export interface PersistentMapOptions<V> {
  /** Filename inside STATE_DIR, e.g. "pending-captures.json". */
  file: string;
  /**
   * Optional predicate applied to every record during hydration. Return
   * `true` to keep the record, `false` to drop it. Used for TTL pruning
   * (e.g. drop `complete` captures older than N days).
   */
  keepOnHydrate?: (v: V) => boolean;
  /**
   * Optional hook to strip fields from a value BEFORE it's persisted. Used
   * by pendingCaptureStore to drop `transcriptContent` after status flips
   * to `complete` — the fat field has done its job and shouldn't bloat the
   * on-disk file.
   *
   * NOTE: this returns a NEW object; the in-memory record is untouched.
   */
  serializeTransform?: (v: V) => V;
}

export class PersistentMap<V> extends Map<string, V> {
  private readonly filePath: string;
  private readonly serializeTransform?: (v: V) => V;
  private writeTimer: NodeJS.Timeout | undefined;
  private lastFlushError: string | undefined;

  constructor(opts: PersistentMapOptions<V>) {
    super();
    if (!opts.file || opts.file.includes('/') || opts.file.includes('\\')) {
      throw new Error(
        `[persistentMap] "file" must be a plain filename, got "${opts.file}"`
      );
    }
    this.filePath = path.join(STATE_DIR, opts.file);
    this.serializeTransform = opts.serializeTransform;

    if (!PERSISTENCE_DISABLED) {
      this.hydrate(opts.keepOnHydrate);
      allInstances.add(this as PersistentMap<unknown>);
      wireShutdownOnce();
    } else {
      console.log(
        `[persistentMap] STATE_BACKEND=null — "${opts.file}" runs in-memory only`
      );
    }
  }

  // ─── Hydration ────────────────────────────────────────────────────────
  private hydrate(keep?: (v: V) => boolean): void {
    if (!fs.existsSync(this.filePath)) {
      console.log(`[persistentMap] no prior state at ${this.filePath} — starting fresh`);
      return;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      console.warn(
        `[persistentMap] readFileSync failed for ${this.filePath} — starting fresh:`,
        (err as Error).message
      );
      return;
    }
    if (!raw.trim()) {
      console.log(`[persistentMap] ${this.filePath} is empty — starting fresh`);
      return;
    }
    let parsed: Record<string, V>;
    try {
      parsed = JSON.parse(raw) as Record<string, V>;
    } catch (err) {
      console.warn(
        `[persistentMap] JSON parse failed for ${this.filePath} — starting fresh (file kept as .corrupt):`,
        (err as Error).message
      );
      try {
        fs.renameSync(this.filePath, `${this.filePath}.corrupt`);
      } catch {
        /* best-effort */
      }
      return;
    }
    let kept = 0;
    let pruned = 0;
    for (const [k, v] of Object.entries(parsed)) {
      if (keep && !keep(v)) {
        pruned++;
        continue;
      }
      super.set(k, v);
      kept++;
    }
    console.log(
      `[persistentMap] hydrated ${this.filePath}: kept=${kept} pruned=${pruned}`
    );
    // If we pruned anything, rewrite the file so it doesn't carry stale
    // entries into the next process (they'd just get re-hydrated + pruned
    // again forever).
    if (pruned > 0) this.scheduleWrite();
  }

  // ─── Persistence (debounced) ──────────────────────────────────────────
  private scheduleWrite(): void {
    if (PERSISTENCE_DISABLED) return;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => this.flushSync(), DEBOUNCE_MS);
    // Don't block process exit on this timer.
    if (typeof this.writeTimer.unref === 'function') this.writeTimer.unref();
  }

  /**
   * Write the current in-memory contents to disk NOW, synchronously.
   * Called on process exit and by the debounce timer.
   * Idempotent — safe to call from multiple hooks.
   */
  flushSync(): void {
    if (PERSISTENCE_DISABLED) return;
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    const snapshot: Record<string, V> = {};
    for (const [k, v] of super.entries()) {
      snapshot[k] = this.serializeTransform ? this.serializeTransform(v) : v;
    }
    const tmp = `${this.filePath}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(snapshot));
      fs.renameSync(tmp, this.filePath);
      this.lastFlushError = undefined;
    } catch (err) {
      const msg = (err as Error).message;
      // Suppress spam: only log if the error is new.
      if (this.lastFlushError !== msg) {
        console.warn(`[persistentMap] flush failed for ${this.filePath}:`, msg);
        this.lastFlushError = msg;
      }
      // Best-effort cleanup of the temp file.
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  // ─── Map overrides — every mutation schedules a write ─────────────────
  set(key: string, value: V): this {
    super.set(key, value);
    this.scheduleWrite();
    return this;
  }

  delete(key: string): boolean {
    const existed = super.delete(key);
    if (existed) this.scheduleWrite();
    return existed;
  }

  clear(): void {
    if (super.size === 0) return;
    super.clear();
    this.scheduleWrite();
  }

  // ─── Diagnostics ──────────────────────────────────────────────────────
  /** Absolute path of the backing file. Useful for logging / debugging. */
  getFilePath(): string {
    return this.filePath;
  }
}

/**
 * Public status hook for the startup banner. Returns a one-liner describing
 * the persistence mode + directory.
 */
export function describePersistence(): string {
  if (PERSISTENCE_DISABLED) {
    return 'STATE_BACKEND=null — state is in-memory only (lost on restart)';
  }
  return `STATE_BACKEND=file — persisting to ${path.resolve(STATE_DIR)} (survives restart)`;
}
