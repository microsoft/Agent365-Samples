// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Disk-backed implementation of the A365 hosting SDK's `Storage` interface.
 *
 * The default `MemoryStorage` loses everything on every process restart, which
 * kills the Proactive subsystem in dev: after nodemon restarts, the SDK can no
 * longer find the stored conversation for a given conversationId, and
 * `proactive.continueConversation(...)` throws `-120742 Conversation not found`.
 *
 * This implementation keeps the same in-memory Map for fast reads/writes and
 * asynchronously persists the whole map to a JSON file on every write / delete.
 * Reads on startup rehydrate from the file. It's not designed for production
 * (no sharding, no concurrency control) but is perfect for local dev.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Storage, StoreItem } from '@microsoft/agents-hosting';

export class FileStorage implements Storage {
    private readonly filePath: string;
    private store: Map<string, any> = new Map();
    private loaded = false;
    private saveTimer: NodeJS.Timeout | null = null;

    constructor(fileName: string = '.proactive-storage.json') {
        this.filePath = path.resolve(process.cwd(), fileName);
    }

    private ensureLoaded(): void {
        if (this.loaded) return;
        this.loaded = true;
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf-8');
                const obj = JSON.parse(raw);
                if (obj && typeof obj === 'object') {
                    this.store = new Map(Object.entries(obj));
                    console.log(`[FileStorage] Loaded ${this.store.size} entries from ${this.filePath}`);
                }
            }
        } catch (err) {
            console.warn(`[FileStorage] Failed to load ${this.filePath}: ${(err as any)?.message ?? err}`);
        }
    }

    /**
     * Persist to disk. Debounced so a burst of writes only produces one flush.
     */
    private scheduleSave(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            try {
                const obj: Record<string, any> = {};
                for (const [k, v] of this.store.entries()) obj[k] = v;
                fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), 'utf-8');
            } catch (err) {
                console.warn(`[FileStorage] Save failed: ${(err as any)?.message ?? err}`);
            }
        }, 100);
    }

    async read(keys: string[]): Promise<StoreItem> {
        this.ensureLoaded();
        const out: StoreItem = {};
        for (const k of keys ?? []) {
            if (this.store.has(k)) {
                out[k] = this.store.get(k);
            }
        }
        return out;
    }

    async write(changes: StoreItem): Promise<void> {
        this.ensureLoaded();
        let dirty = false;
        for (const [k, v] of Object.entries(changes ?? {})) {
            this.store.set(k, v);
            dirty = true;
        }
        if (dirty) this.scheduleSave();
    }

    async delete(keys: string[]): Promise<void> {
        this.ensureLoaded();
        let dirty = false;
        for (const k of keys ?? []) {
            if (this.store.delete(k)) dirty = true;
        }
        if (dirty) this.scheduleSave();
    }
}
