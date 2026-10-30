// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * MVP 3 — Helper matching for unblock meetings.
 *
 * When a blocker is reported in standup we want the unblock meeting to include
 * NOT just the blocked assignee + SM, but ALSO a subject-matter helper from the
 * broader org. Helpers are configured out-of-band in the SharePoint
 * `SMA_HelperRoster` list (see `scripts/seed-helper-roster.ts`).
 *
 * Matching is deterministic and keyword-based: the blocker text is scanned for
 * substring hits against each roster row's `Keywords` column. On the first hit
 * we return the matching helper. If nothing matches, `findHelperForBlocker`
 * returns `null` and the caller schedules the meeting with just the SM +
 * reporter + owner (previous behaviour).
 *
 * Rationale for keyword-only (no LLM fallback):
 *   - Predictable: the SM can review the roster and know exactly which words
 *     will route to which helper.
 *   - Zero latency, zero LLM cost.
 *   - No risk of misclassification landing the wrong person in the meeting.
 *
 * If a fuzzier match is desired later, add a new topic row to the roster with
 * broader keywords rather than reintroducing an LLM step.
 */

import { listItems } from './sharepoint';

export interface HelperRosterFields {
    Title: string;              // Topic name — e.g. "IT / Access / Data platform"
    Keywords: string;           // Comma-separated
    HelperEmail: string;
    HelperDisplayName: string;
    IsActive?: boolean;
}

export interface HelperMatch {
    topic: string;
    email: string;
    displayName: string;
    matchedBy: 'keyword';
    reason: string;
}

// Roster is stable at runtime — cache for 60s so per-blocker matching is fast.
let rosterCache: HelperRosterFields[] | null = null;
let rosterCacheExpiresUtc = 0;

async function loadRoster(): Promise<HelperRosterFields[]> {
    const now = Date.now();
    if (rosterCache && now < rosterCacheExpiresUtc) return rosterCache;
    let rows: HelperRosterFields[] = [];
    try {
        const items = await listItems<HelperRosterFields>('helperRoster');
        rows = items
            .map(r => r.fields)
            .filter(r => r.IsActive !== false && !!r.HelperEmail);
    } catch (e) {
        console.warn('[helperMatcher] Could not load HelperRoster:', (e as Error).message);
    }
    rosterCache = rows;
    rosterCacheExpiresUtc = now + 60_000;
    return rows;
}

/**
 * Try to identify a subject-matter helper for the given blocker text by keyword.
 * Returns `null` when no keyword hit — the caller should then schedule the
 * unblock meeting with only the SM + reporter + owner.
 */
export async function findHelperForBlocker(blockerText: string): Promise<HelperMatch | null> {
    if (!blockerText || blockerText.trim().length < 3) return null;
    const roster = await loadRoster();
    if (roster.length === 0) return null;

    const lower = blockerText.toLowerCase();
    for (const row of roster) {
        const kws = (row.Keywords ?? '')
            .split(',')
            .map(k => k.trim().toLowerCase())
            .filter(k => k.length >= 3);
        for (const kw of kws) {
            if (lower.includes(kw)) {
                return {
                    topic: row.Title,
                    email: row.HelperEmail,
                    displayName: row.HelperDisplayName || row.HelperEmail,
                    matchedBy: 'keyword',
                    reason: `Matched keyword "${kw}".`,
                };
            }
        }
    }
    return null;
}

// Test-only surface — lets unit tests bypass the cache without touching Graph.
export const _internal = {
    resetRosterCache(): void {
        rosterCache = null;
        rosterCacheExpiresUtc = 0;
    },
};
