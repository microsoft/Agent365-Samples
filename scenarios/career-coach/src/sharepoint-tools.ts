// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * SharePoint access as OpenAI-Agents function tools, backed by an agentic-auth Graph
 * client. Replaces the previous `mcp_SharePointRemoteServer` MCP dependency so we no
 * longer need `a365 develop get-token` — the A365 platform hands us a fresh Graph token
 * on every run.
 *
 * The LLM's system prompt (see client.ts) calls these tools by name — the names are
 * intentionally identical to the old MCP tools so the prompt did not need to change:
 *   getSiteByPath, listLists, listListItems, createListItem, updateListItem.
 *
 * Tools use `strict: false` + a JSON-schema `parameters` object (no `zod` needed, which
 * avoids the transitive-dep conflict we saw during install).
 */

import { tool, type FunctionTool } from '@openai/agents';
import type { TurnContext, Authorization } from '@microsoft/agents-hosting';
import { Client as MsGraphClient } from '@microsoft/microsoft-graph-client';
import { getAgenticGraphClient } from './graph-service';
import { getColumnMap, toInternalFields, toDisplayFields } from './sharepoint-column-map';

/**
 * The per-run context passed to `run(agent, input, { context })`. Every tool below
 * reads the `turnContext` + `authorization` from here to build a Graph client. This
 * lets us reuse the same Agent instance across turns while still using per-turn auth.
 */
export interface RunCtx {
    turnContext: TurnContext;
    authorization: Authorization;
}

// The `tool()` helper's strict generics don't play well with untyped JSON schema — every
// property has to be a literal type. This helper swallows that noise by casting through
// `any` so we can write vanilla JSON schemas and keep the file readable.
function makeTool(spec: {
    name: string;
    description: string;
    parameters: object;
    execute: (args: any, ctx: any) => Promise<any>;
}): FunctionTool<any, any, any> {
    return tool({ ...spec, strict: false } as any) as FunctionTool<any, any, any>;
}

function graphFrom(rawCtx: any): MsGraphClient {
    // The SDK passes the RunContext<TContext> which has .context = MyCtx.
    const ctx: RunCtx | undefined = rawCtx?.context ?? rawCtx;
    if (!ctx?.turnContext || !ctx?.authorization) {
        throw new Error('SharePoint tool called without a RunCtx { turnContext, authorization }.');
    }
    return getAgenticGraphClient(ctx.turnContext, ctx.authorization);
}

/**
 * The LLM occasionally hallucinates a shortened siteId (e.g. just the hostname
 * "contoso" or "contoso.sharepoint.com") instead of the full
 * `{hostname},{siteGuid},{webGuid}` composite that Graph requires. To make the
 * agent resilient, we remember every siteId successfully returned by getSiteByPath
 * and reuse it when a downstream call passes anything without a comma. Also keyed
 * by hostname for extra safety.
 */
const siteIdCache = new Map<string, string>();
function rememberSite(fullSiteId: string): void {
    if (!fullSiteId || !fullSiteId.includes(',')) return;
    siteIdCache.set(fullSiteId, fullSiteId);
    const hostname = fullSiteId.split(',')[0];
    if (hostname) siteIdCache.set(hostname, fullSiteId);
}
function resolveSiteId(candidate: unknown): string {
    const raw = String(candidate ?? '').trim();
    if (!raw) return raw;

    // If we've never resolved a site, we can't correct anything — pass through.
    if (siteIdCache.size === 0) return raw;

    // Exact match against a known-good composite id — perfect.
    if (raw.includes(',') && siteIdCache.has(raw)) return raw;

    // Composite candidate: check the hostname prefix. If the hostname is one we know,
    // but the GUID triplet doesn't match ANY cached full id, the LLM hallucinated the
    // GUIDs (they look plausible but are wrong). Substitute the correct composite for
    // that hostname.
    if (raw.includes(',')) {
        const hostname = raw.split(',')[0];
        const cachedByHost = siteIdCache.get(hostname);
        if (cachedByHost && cachedByHost !== raw) {
            console.warn(`[SharePointTools] LLM sent hallucinated siteId "${raw.slice(0, 80)}…"; auto-substituting known-good id for host "${hostname}".`);
            return cachedByHost;
        }
        // Composite for a host we don't recognize — pass through and let Graph decide.
        return raw;
    }

    // Hostname-only (or otherwise-comma-less) lookup.
    const cached = siteIdCache.get(raw);
    if (cached) {
        console.warn(`[SharePointTools] LLM sent truncated siteId "${raw}"; auto-substituting full id "${cached.slice(0, 60)}…".`);
        return cached;
    }

    // Last resort: return most-recent full id (only one site in this app).
    for (const v of siteIdCache.values()) {
        console.warn(`[SharePointTools] LLM sent unknown siteId "${raw}"; falling back to last resolved site.`);
        return v;
    }
    return raw;
}

/**
 * The LLM hallucinates listIds even more often than siteIds — it forgets the real GUIDs
 * across turns and fabricates plausible-looking ones. Cache the site's list catalog so
 * we can accept EITHER a real listId GUID OR the list's display name (e.g. "UserState")
 * and auto-resolve. Warmed at startup by `warmSiteCache`.
 */
const listCacheBySite = new Map<string, { byId: Map<string, string>; byName: Map<string, string> }>();

function rememberList(siteId: string, listId: string, displayName: string): void {
    if (!siteId || !listId) return;
    let bucket = listCacheBySite.get(siteId);
    if (!bucket) {
        bucket = { byId: new Map(), byName: new Map() };
        listCacheBySite.set(siteId, bucket);
    }
    bucket.byId.set(listId, displayName);
    // Case-insensitive name lookup — LLM sometimes lowercases or mixes.
    bucket.byName.set(displayName.toLowerCase(), listId);
}

function isLikelyGuid(s: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function resolveListId(siteId: string, candidate: unknown): string {
    const raw = String(candidate ?? '').trim();
    if (!raw) return raw;
    const bucket = listCacheBySite.get(siteId);
    if (!bucket) return raw; // cache not warmed yet — pass through

    // Case 1: LLM sent a real listId GUID we know about — perfect.
    if (bucket.byId.has(raw)) return raw;

    // Case 2: LLM sent a display name we know about — translate.
    const byName = bucket.byName.get(raw.toLowerCase());
    if (byName) {
        console.warn(`[SharePointTools] LLM used display name "${raw}" as listId; auto-substituting real listId "${byName}".`);
        return byName;
    }

    // Case 3: LLM sent a plausible-looking GUID we've never seen — hallucination.
    // We can't recover automatically (no way to know which real list they meant), so
    // let it fall through to Graph which returns "list not found". The LLM will then
    // retry, likely with listLists first.
    if (isLikelyGuid(raw)) {
        console.warn(`[SharePointTools] LLM sent unknown listId GUID "${raw}"; passing through (Graph will 404). Known lists on this site: ${Array.from(bucket.byName.keys()).join(', ')}`);
    }
    return raw;
}

// Convert a caller-friendly `fields` object into either a flat object (Graph's actual
// wire format) or the legacy `[{Key, Value}]` array the old MCP prompt sometimes emits.
function normalizeFields(fields: unknown): Record<string, unknown> {
    if (Array.isArray(fields)) {
        const out: Record<string, unknown> = {};
        for (const entry of fields) {
            if (entry && typeof entry === 'object' && 'Key' in entry && 'Value' in entry) {
                out[String((entry as any).Key)] = (entry as any).Value;
            }
        }
        return out;
    }
    return (fields ?? {}) as Record<string, unknown>;
}

const getSiteByPathTool: FunctionTool<any, any, any> = makeTool({
    name: 'getSiteByPath',
    description:
        'Resolve a SharePoint site to its Graph siteId by hostname + server-relative path. ' +
        'Call this before any list operation. Example: hostname="contoso.sharepoint.com" serverRelativePath="sites/CareerCoach".',

    parameters: {
        type: 'object',
        properties: {
            hostname: { type: 'string', description: 'The SharePoint hostname (no scheme, no path).' },
            serverRelativePath: { type: 'string', description: 'Server-relative site path, e.g. "sites/CareerCoach" (no leading slash).' },
        },
        required: ['hostname', 'serverRelativePath'],
        additionalProperties: false,
    },
    execute: async (args: any, ctx: any) => {
        const graph = graphFrom(ctx);
        const cleanedPath = String(args.serverRelativePath ?? '').replace(/^\/+/, '');
        const site = await graph.api(`/sites/${args.hostname}:/${cleanedPath}`).get();
        rememberSite(site.id);
        return JSON.stringify({ id: site.id, displayName: site.displayName, webUrl: site.webUrl });
    },
});

const listListsTool: FunctionTool<any, any, any> = makeTool({
    name: 'listLists',
    description: 'Enumerate all SharePoint lists on the given site. Returns an array of {id, displayName, name}. Use to resolve a listId from a display name. siteId MUST be the full composite id returned by getSiteByPath (e.g. "host,siteGuid,webGuid") — never just the hostname.',

    parameters: {
        type: 'object',
        properties: {
            siteId: { type: 'string', description: 'The Graph siteId from getSiteByPath. Full composite "host,siteGuid,webGuid" — never truncate.' },
        },
        required: ['siteId'],
        additionalProperties: false,
    },
    execute: async (args: any, ctx: any) => {
        const graph = graphFrom(ctx);
        const siteId = resolveSiteId(args.siteId);
        const res = await graph.api(`/sites/${siteId}/lists?$select=id,displayName,name`).get();
        const items = (res?.value ?? []).map((l: any) => ({ id: l.id, displayName: l.displayName, name: l.name }));
        // Cache each list so downstream tools can auto-resolve display-name → listId.
        for (const l of items) {
            if (l?.id && l?.displayName) rememberList(siteId, l.id, l.displayName);
        }
        return JSON.stringify(items);
    },
});

const listListItemsTool: FunctionTool<any, any, any> = makeTool({
    name: 'listListItems',
    description:
        'Read all items from a SharePoint list. Each returned entry is { id, fields } where fields is an object of column-name -> value. ' +
        'Optionally pass filterField + filterValue to narrow to items whose fields[filterField] === filterValue (case-insensitive string comparison).',

    parameters: {
        type: 'object',
        properties: {
            siteId: { type: 'string' },
            listId: { type: 'string', description: 'The Graph listId GUID (from listLists) OR the list display name (e.g. "UserState", "LearningCatalog_v2"). Display names auto-resolve.' },
            filterField: { type: 'string', description: 'Optional. Field name to filter on (e.g. "UserAADId").' },
            filterValue: { type: 'string', description: 'Optional. String value to match. Case-insensitive.' },
        },
        required: ['siteId', 'listId'],
        additionalProperties: false,
    },
    execute: async (args: any, ctx: any) => {
        const graph = graphFrom(ctx);
        const siteId = resolveSiteId(args.siteId);
        const listId = resolveListId(siteId, args.listId);
        const colMap = await getColumnMap(graph, siteId, listId);
        const rows: Array<{ id: string; fields: any }> = [];
        let url: string | undefined = `/sites/${siteId}/lists/${listId}/items?$expand=fields&$top=200`;
        while (url) {
            const page: any = await graph.api(url).get();
            for (const item of page?.value ?? []) {
                const displayFields = toDisplayFields(item.fields ?? {}, colMap);
                rows.push({ id: item.id, fields: displayFields });
            }
            url = page?.['@odata.nextLink'] ? String(page['@odata.nextLink']).replace('https://graph.microsoft.com/v1.0', '') : undefined;
        }
        let filtered = rows;
        if (args.filterField && typeof args.filterValue !== 'undefined') {
            const key = String(args.filterField);
            const needle = String(args.filterValue).toLowerCase();
            filtered = rows.filter((r) => String(r.fields?.[key] ?? '').toLowerCase() === needle);
        }
        return JSON.stringify(filtered);
    },
});

const createListItemTool: FunctionTool<any, any, any> = makeTool({
    name: 'createListItem',
    description:
        'Create a new item in a SharePoint list. `fields` is an object of column-name -> value (JSON), e.g. {"UserAADId":"...","CourseId":"..."}. ' +
        'Returns the created item {id, fields}. NEVER call this for reads or for updates.',

    parameters: {
        type: 'object',
        properties: {
            siteId: { type: 'string' },
            listId: { type: 'string' },
            fields: {
                type: 'object',
                description: 'Flat object of column-name -> value. Multi-line text columns take a string value. Yes/No columns take true/false.',
                additionalProperties: true,
            },
        },
        required: ['siteId', 'listId', 'fields'],
        additionalProperties: false,
    },
    execute: async (args: any, ctx: any) => {
        const graph = graphFrom(ctx);
        const siteId = resolveSiteId(args.siteId);
        const listId = resolveListId(siteId, args.listId);
        const colMap = await getColumnMap(graph, siteId, listId);
        const displayFields = normalizeFields(args.fields);
        const internalFields = toInternalFields(displayFields, colMap);
        try {
            const created = await graph.api(`/sites/${siteId}/lists/${listId}/items`).post({ fields: internalFields });
            return JSON.stringify({ id: created.id, fields: toDisplayFields(created.fields ?? internalFields, colMap) });
        } catch (err: any) {
            const graphBody = err?.body ?? err?.response?.body;
            const detail = graphBody ? (typeof graphBody === 'string' ? graphBody : JSON.stringify(graphBody)) : '';
            const statusCode = err?.statusCode ?? err?.code;
            console.error(`[createListItem] Graph POST failed (status=${statusCode}). Error: ${err?.message}`);
            console.error(`[createListItem] Display fields sent by LLM:`, JSON.stringify(displayFields, null, 2));
            console.error(`[createListItem] Internal fields after column-map translation:`, JSON.stringify(internalFields, null, 2));
            console.error(`[createListItem] Known columns:`, Object.entries(colMap.kindByInternal).map(([k, v]) => `${k}(${v})`).join(', '));
            console.error(`[createListItem] Display->internal map:`, JSON.stringify(colMap.displayToInternal));
            if (detail) console.error(`[createListItem] Graph error body:`, detail);
            throw new Error(`createListItem failed: ${err?.message ?? 'unknown'} — Graph body: ${detail || '(none)'}`);
        }
    },
});

const updateListItemTool: FunctionTool<any, any, any> = makeTool({
    name: 'updateListItem',
    description:
        'Update an existing item in a SharePoint list. `fields` is an object of column-name -> value with ONLY the columns you want to change. ' +
        'Requires the correct itemId — always re-read the target row (via listListItems) immediately before calling this so the id is fresh.',

    parameters: {
        type: 'object',
        properties: {
            siteId: { type: 'string' },
            listId: { type: 'string' },
            itemId: { type: 'string' },
            fields: {
                type: 'object',
                description: 'Columns to change and their new values. Omit any column you do not want to modify.',
                additionalProperties: true,
            },
        },
        required: ['siteId', 'listId', 'itemId', 'fields'],
        additionalProperties: false,
    },
    execute: async (args: any, ctx: any) => {
        const graph = graphFrom(ctx);
        const siteId = resolveSiteId(args.siteId);
        const listId = resolveListId(siteId, args.listId);
        const colMap = await getColumnMap(graph, siteId, listId);
        const displayFields = normalizeFields(args.fields);
        const internalFields = toInternalFields(displayFields, colMap);
        try {
            const updated = await graph.api(`/sites/${siteId}/lists/${listId}/items/${args.itemId}/fields`).update(internalFields);
            return JSON.stringify({ id: args.itemId, fields: toDisplayFields(updated ?? internalFields, colMap) });
        } catch (err: any) {
            const graphBody = err?.body ?? err?.response?.body;
            const detail = graphBody ? (typeof graphBody === 'string' ? graphBody : JSON.stringify(graphBody)) : '';
            const statusCode = err?.statusCode ?? err?.code;
            console.error(`[updateListItem] Graph PATCH failed (status=${statusCode}). Error: ${err?.message}`);
            console.error(`[updateListItem] Display fields sent by LLM:`, JSON.stringify(displayFields, null, 2));
            console.error(`[updateListItem] Internal fields after column-map translation:`, JSON.stringify(internalFields, null, 2));
            if (detail) console.error(`[updateListItem] Graph error body:`, detail);
            throw new Error(`updateListItem failed: ${err?.message ?? 'unknown'} — Graph body: ${detail || '(none)'}`);
        }
    },
});

export function makeSharePointTools(): FunctionTool<any, any, any>[] {
    return [getSiteByPathTool, listListsTool, listListItemsTool, createListItemTool, updateListItemTool];
}

/**
 * Warm the siteId cache at server startup using the same MSAL device-code path used
 * by the setup scripts. This means proactive turns (like Feature 1's quiz card) work
 * even before any user has done an interactive turn — otherwise the LLM sometimes
 * hallucinates a siteId (fake GUIDs after the hostname prefix) and the first tool
 * call fails with "Requested site could not be found".
 *
 * Best-effort: if MSAL isn't cached or the site can't be resolved, we log and move
 * on — the interactive path still populates the cache on the first user turn.
 */
export async function warmSiteCache(): Promise<void> {
    try {
        const { getSiteId, getGraphClient } = await import('./graph-service');
        const siteId = await getSiteId();
        rememberSite(siteId);
        console.log(`[SharePointTools] Warmed siteId cache with "${siteId.slice(0, 80)}…"`);

        // Also fetch all lists on this site and cache them by both listId and displayName.
        // The LLM often hallucinates listIds across turns; keeping this cache lets us
        // auto-translate list display names to real listIds (and detect hallucinations).
        try {
            const graph = getGraphClient();
            const res: any = await graph.api(`/sites/${siteId}/lists?$select=id,displayName,name`).get();
            const lists = (res?.value ?? []) as Array<any>;
            for (const l of lists) {
                if (l?.id && l?.displayName) rememberList(siteId, l.id, l.displayName);
            }
            console.log(`[SharePointTools] Warmed list cache: ${lists.length} lists on site (${lists.map((l: any) => l.displayName).filter(Boolean).join(', ')})`);
        } catch (err) {
            console.warn(`[SharePointTools] Could not warm list cache: ${(err as any)?.message ?? err}`);
        }
    } catch (err) {
        console.warn(`[SharePointTools] Could not warm siteId cache: ${(err as any)?.message ?? err}`);
    }
}
