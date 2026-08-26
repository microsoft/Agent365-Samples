// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * SharePoint column display-name <-> internal-name mapping.
 *
 * Lists imported via the SharePoint UI (CSV Quick-Import etc.) get generic internal
 * column names (`field_1`, `field_2`, ...) even though the display names are set
 * correctly (`RoleId`, `RoleTitle`, ...). Graph writes REQUIRE internal names, so we
 * translate both directions transparently.
 *
 * The mapping is cached per (siteId, listId).
 */

import { Client as MsGraphClient } from '@microsoft/microsoft-graph-client';

type ColumnKind = 'text' | 'number' | 'dateTime' | 'boolean' | 'choice' | 'hyperlink' | 'unknown';

interface ColumnMap {
    displayToInternal: Record<string, string>;
    internalToDisplay: Record<string, string>;
    /** Column kind keyed by internal name — used to auto-format hyperlink values, etc. */
    kindByInternal: Record<string, ColumnKind>;
}

const cache = new Map<string, ColumnMap>();

function key(siteId: string, listId: string): string {
    return `${siteId}::${listId}`;
}

function detectKind(col: any): ColumnKind {
    if (col?.text) return 'text';
    if (col?.number) return 'number';
    if (col?.dateTime) return 'dateTime';
    if (col?.boolean) return 'boolean';
    if (col?.choice) return 'choice';
    // Graph's response for hyperlink/picture columns often omits any type block
    // entirely. If a writable, non-hidden, non-lookup column has no recognized
    // shape AND its display/internal name suggests a link, treat as hyperlink.
    const name = String(col?.name ?? '').toLowerCase();
    const disp = String(col?.displayName ?? '').toLowerCase();
    const linky = name.includes('url') || name.includes('link') || disp.includes('url') || disp.includes('link');
    if (linky) return 'hyperlink';
    return 'unknown';
}

/**
 * Fetches (and caches) the display-name -> internal-name mapping for a SharePoint list.
 * Skips SharePoint's built-in system columns.
 */
export async function getColumnMap(graph: MsGraphClient, siteId: string, listId: string): Promise<ColumnMap> {
    const k = key(siteId, listId);
    const cached = cache.get(k);
    if (cached) return cached;

    const res = await graph.api(`/sites/${siteId}/lists/${listId}/columns`).get();
    const displayToInternal: Record<string, string> = {};
    const internalToDisplay: Record<string, string> = {};
    const kindByInternal: Record<string, ColumnKind> = {};

    // System columns we always ignore — they're SP-managed metadata (Compliance Asset id,
    // ColorTag, LinkTitle, Attachments, etc.) that leak into every list.
    const SYSTEM_INTERNAL = new Set([
        'LinkTitle', 'LinkTitle2', 'LinkTitleNoMenu', '_ColorTag', 'ComplianceAssetId',
        'ContentType', 'Attachments', 'Edit', 'DocIcon', '_ExtendedDescription', 'Modified',
        'Created', 'Author', 'Editor', 'ID', 'AppAuthor', 'AppEditor', 'FileLeafRef',
    ]);

    for (const c of (res?.value ?? []) as Array<any>) {
        if (!c?.name) continue;
        if (SYSTEM_INTERNAL.has(c.name)) continue;
        if (c.hidden) continue;
        const disp = c.displayName || c.name;
        // If the same display name maps to multiple internal names (e.g. the duplicate "Title" issue),
        // prefer the first non-linked one. In practice the first entry Graph returns is the writable one.
        if (!displayToInternal[disp]) displayToInternal[disp] = c.name;
        internalToDisplay[c.name] = disp;
        kindByInternal[c.name] = detectKind(c);
    }

    const map: ColumnMap = { displayToInternal, internalToDisplay, kindByInternal };
    cache.set(k, map);
    return map;
}

/**
 * Convert a fields object keyed by DISPLAY names into one keyed by INTERNAL names,
 * ready to POST to Graph. Unknown display names pass through unchanged so the caller
 * can see the Graph error message if they used a non-existent column. Hyperlink columns
 * get automatically wrapped as { Url, Description } if the caller supplied a plain string.
 *
 * Defensive coercions applied for LLM output:
 *  - null / undefined / empty-string values are DROPPED. SharePoint's imported columns
 *    are often flagged Required; sending "" causes generalException even when the LLM
 *    means "unknown".
 *  - Arrays / plain objects going to non-hyperlink columns are JSON.stringify'd so
 *    SharePoint's multi-line text columns accept them. The LLM sometimes forgets to
 *    stringify Goals/Skills/LearningProgress and sends raw arrays.
 *  - Numbers going to text columns are stringified (SharePoint rejects a JSON number
 *    for a text column with a generic exception).
 *  - Read-only / system-managed columns (_UIVersionString, ItemChildCount, compliance
 *    columns, _IsRecord, etc.) are dropped even if the LLM tries to write them.
 */
const READONLY_INTERNAL = new Set([
    '_UIVersionString', 'ItemChildCount', 'FolderChildCount',
    '_ComplianceFlags', '_ComplianceTag', '_ComplianceTagWrittenTime', '_ComplianceTagUserId',
    '_IsRecord',
]);

export function toInternalFields(fields: Record<string, unknown>, map: ColumnMap): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
        // Drop null / undefined / empty-string.
        if (v === null || typeof v === 'undefined') continue;
        if (typeof v === 'string' && v.length === 0) continue;

        const internal = map.displayToInternal[k] ?? k;

        // Skip read-only / system-managed columns even if the LLM tries to set them.
        if (READONLY_INTERNAL.has(internal)) continue;

        const kind = map.kindByInternal[internal];

        if (kind === 'hyperlink' && typeof v === 'string' && v.length > 0) {
            out[internal] = { Url: v, Description: v };
        } else if (kind === 'boolean' && typeof v === 'string') {
            // SP boolean columns accept true/false — map common string forms.
            const lower = v.toLowerCase();
            out[internal] = lower === 'true' || lower === 'yes' || lower === '1';
        } else if (kind === 'text' && typeof v === 'number') {
            // Text column receiving a number — coerce to string.
            out[internal] = String(v);
        } else if (typeof v === 'object' && kind !== 'hyperlink') {
            // Array or plain object going to a text (multi-line) column — stringify.
            // The LLM sometimes forgets to serialize Goals/Skills/LearningProgress
            // and we don't want the Graph POST to reject with "Invalid request".
            try {
                out[internal] = JSON.stringify(v);
            } catch {
                out[internal] = String(v);
            }
        } else {
            out[internal] = v;
        }
    }
    return out;
}

/**
 * Convert a fields object keyed by INTERNAL names into one keyed by DISPLAY names,
 * ready to hand back to the LLM. Only maps known columns; leaves the rest as-is.
 * Hyperlink columns get flattened back to a plain URL string so the LLM sees the URL.
 */
export function toDisplayFields(fields: Record<string, unknown>, map: ColumnMap): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields ?? {})) {
        const display = map.internalToDisplay[k];
        if (!display) continue;
        const kind = map.kindByInternal[k];
        if (kind === 'hyperlink' && v && typeof v === 'object') {
            const url = (v as any).Url ?? (v as any).url ?? '';
            out[display] = url || v;
        } else {
            out[display] = v;
        }
    }
    return out;
}
