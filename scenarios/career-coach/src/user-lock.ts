// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Per-user async mutex. Every UserState read-modify-write (save, sync, quiz grading, milestone and
 * completion persistence, and the LLM's own list writes) runs inside `withUserLock(userId, …)` so two
 * concurrent turns for the same user can't read the same plan and overwrite each other's changes.
 *
 * In-process only — it serialises turns inside this Node process, which matches the single-instance
 * deployment this sample targets. Running several instances needs a shared lock or conditional writes.
 * The lock is NOT re-entrant: never call `withUserLock` for the same user from inside `fn`.
 */

const tails = new Map<string, Promise<void>>();

export async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const key = userId.toLowerCase();
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    tails.set(key, tail);
    await previous;
    try {
        return await fn();
    } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
    }
}
