// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Persistent AAD-Object-ID -> proactive conversationId map.
 *
 * The A365 SDK's `Proactive` subsystem stores its own `Conversation` records (with the JWT
 * claims + service URL needed for `adapter.continueConversation`) keyed by an SDK-generated
 * conversationId. But we don't know that ID at webhook time — the LearningPortalStatus row
 * only carries the user's AAD Object ID.
 *
 * So we keep a small side-table on disk: aadObjectId -> conversationId. Populated whenever
 * a user talks to the agent, read by the proactive webhook endpoint.
 *
 * Not encrypted, not intended for prod — same posture as `.mstoken-cache.json`.
 */

import * as fs from 'fs';
import * as path from 'path';

const CACHE_FILE = path.resolve(process.cwd(), '.proactive-refs.json');

let cache: Record<string, string> | null = null;

function load(): Record<string, string> {
    if (cache) return cache;
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
            cache = JSON.parse(raw) as Record<string, string>;
        } else {
            cache = {};
        }
    } catch (err) {
        console.warn('[proactive-refs] Failed to read cache, starting empty:', (err as any)?.message ?? err);
        cache = {};
    }
    return cache;
}

function persist(): void {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache ?? {}, null, 2), 'utf-8');
    } catch (err) {
        console.warn('[proactive-refs] Failed to persist cache:', (err as any)?.message ?? err);
    }
}

export function setRef(aadObjectId: string, conversationId: string): void {
    if (!aadObjectId || !conversationId) return;
       const c = load();
       const key = aadObjectId.toLowerCase();
       if (c[key] === conversationId) return; // no-op
       c[key] = conversationId;
       persist();
       console.log(`[proactive-refs] Stored conversationId for aadObjectId=${aadObjectId}`);
}

export function getRef(aadObjectId: string): string | undefined {
    return load()[aadObjectId.toLowerCase()];
}

export function listRefs(): Record<string, string> {
    return { ...load() };
}
