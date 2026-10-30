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
import { getAgenticGraphClient, getSiteId } from './graph-service';
import { getColumnMap, toInternalFields, toDisplayFields, canonicalizeFields } from './sharepoint-column-map';
import { SP_CONFIG, APP_MANAGED_USERSTATE_FIELDS, planStatusOf } from './career-coach-types';
import { readUserState, readPreviousPlans, dropMissingLifecycleColumns } from './career-coach-service';
import { withUserLock } from './user-lock';

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
    const execute = async (args: any, ctx: any) => {
        try {
            return await spec.execute(args, ctx);
        } catch (err: any) {
            // The Agents SDK hands tool errors back to the LLM silently; log them so failures are diagnosable.
            const status = err?.statusCode ?? err?.status ?? '';
            const code = err?.code ?? '';
            console.error(`[SharePointTools] ${spec.name} failed${status ? ` (status=${status})` : ''}${code ? ` [${code}]` : ''}: ${err?.message ?? err}`);
            throw err;
        }
    };
    return tool({ ...spec, execute, strict: false } as any) as FunctionTool<any, any, any>;
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

    // Case 2b: LLM dropped a version suffix (e.g. "UserState" for "UserState_V3") — accept a unique match.
    if (!isLikelyGuid(raw)) {
        const prefix = `${raw.toLowerCase()}_`;
        const matches = Array.from(bucket.byName.entries()).filter(([name]) => name.startsWith(prefix));
        if (matches.length === 1) {
            console.warn(`[SharePointTools] LLM sent list name "${raw}"; resolving to "${matches[0][0]}" (${matches[0][1]}).`);
            return matches[0][1];
        }
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

// -----------------------------------------------------------------------------
// Progress guard — a course only becomes Complete (and a skill only levels up) when the
// user passes its quiz, and only the deterministic quiz grader (handlers.ts) records that.
// The LLM may still write other UserState fields; these transitions are rejected.
// -----------------------------------------------------------------------------

const blockedByTurn = new WeakMap<object, Set<string>>();

/** Course ids the LLM tried to mark complete during this turn (cleared on read). */
export function takeBlockedCompletions(turnContext: TurnContext): string[] {
    const blocked = blockedByTurn.get(turnContext);
    blockedByTurn.delete(turnContext);
    return blocked ? [...blocked] : [];
}

function parseJsonArray(value: unknown): any[] {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
    }
    return [];
}

/** The list's display name (lower-cased). Falls back to Graph when the list cache is cold, so a raw GUID can't bypass the rules. */
async function listNameOf(graph: MsGraphClient, siteId: string, listId: string): Promise<string> {
    let name = listCacheBySite.get(siteId)?.byId.get(listId);
    if (!name) {
        try {
            const list: any = await graph.api(`/sites/${siteId}/lists/${listId}?$select=id,displayName`).get();
            if (list?.displayName) { name = String(list.displayName); rememberList(siteId, listId, name); }
        } catch { /* unknown list: handled as "not a Career Coach list" by the callers; Graph reports the real error on the actual call */ }
    }
    return (name ?? listId).toLowerCase();
}

/** True when listId is the UserState list. */
async function isUserStateList(graph: MsGraphClient, siteId: string, listId: string): Promise<boolean> {
    return (await listNameOf(graph, siteId, listId)) === SP_CONFIG.lists.userState.toLowerCase();
}

/** Lists that hold one employee's private data — the model only ever sees the caller's own rows. */
function personalListNames(): string[] {
    return [SP_CONFIG.lists.userState, SP_CONFIG.lists.learningPortalStatus, SP_CONFIG.lists.quizResponses].map((n) => n.toLowerCase());
}

/** Every list this sample owns. The model's data tools never touch any other list. */
function careerCoachListNames(): string[] {
    return [...personalListNames(), SP_CONFIG.lists.competencyFramework.toLowerCase(), SP_CONFIG.lists.learningCatalog.toLowerCase()];
}

// The data tools (list / create / update) only ever operate on the configured Career Coach site.
let configuredSite: Promise<string> | null = null;
function configuredSiteId(graph: MsGraphClient): Promise<string> {
    if (!configuredSite) {
        configuredSite = getSiteId(graph).catch((err) => { configuredSite = null; throw err; });
    }
    return configuredSite;
}

/** Resolves the site for a data tool: always the configured site. A composite id for any other site is rejected. */
async function dataSiteId(graph: MsGraphClient, candidate: unknown): Promise<string> {
    const allowed = await configuredSiteId(graph);
    const raw = resolveSiteId(candidate);
    if (raw.includes(',') && raw !== allowed) {
        throw new Error(`BLOCKED — nothing was done. These tools only work on the configured Career Coach site (${SP_CONFIG.siteUrl}).`);
    }
    return allowed;
}

/** Strips the app-managed columns (goal lifecycle + manager identity) from an LLM write to UserState. */
function withoutAppManagedFields(fields: Record<string, unknown>): Record<string, unknown> {
    const out = { ...fields };
    for (const name of APP_MANAGED_USERSTATE_FIELDS) {
        if (name in out) {
            console.warn(`[GoalLifecycle] Ignored LLM write to app-managed column "${name}".`);
            delete out[name];
        }
    }
    return out;
}

function currentUserId(rawCtx: any): string {
    const ctx: RunCtx | undefined = rawCtx?.context ?? rawCtx;
    return String(ctx?.turnContext?.activity?.from?.aadObjectId ?? '');
}

/** The authenticated caller's object id; personal data is never read or written without one. */
function requireCallerId(rawCtx: any): string {
    const id = currentUserId(rawCtx);
    if (!id) {
        throw new Error('BLOCKED — nothing was done: this turn has no authenticated user, so personal career data can\'t be read or written.');
    }
    return id;
}

function sameId(a: unknown, b: unknown): boolean {
    return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

/** Returns the courses / skills this write would advance without a passed quiz. */
function findUnearnedProgress(
    next: Record<string, unknown>,
    stored: Record<string, unknown> | null,
): { courses: Array<{ courseId: string; title: string }>; skills: string[] } {
    const courses: Array<{ courseId: string; title: string }> = [];
    if ('LearningProgress' in next) {
        const prev = parseJsonArray(stored?.LearningProgress);
        for (const lp of parseJsonArray(next.LearningProgress)) {
            const courseId = String(lp?.courseId ?? '');
            if (!courseId || courses.some((c) => c.courseId === courseId)) continue;
            const alreadyValidated = prev.some((p) => p?.courseId === courseId &&
                String(p?.status ?? '').toLowerCase() === 'complete' && p?.quizResult?.passed === true);
            if (alreadyValidated) continue;
            const claimsComplete = String(lp?.status ?? '').toLowerCase() === 'complete';
            const claimsPassed = lp?.quizResult?.passed === true;
            if (claimsComplete || claimsPassed) courses.push({ courseId, title: String(lp?.courseTitle ?? courseId) });
        }
    }
    const skills: string[] = [];
    if ('Skills' in next && stored) {
        const prev = parseJsonArray(stored.Skills);
        for (const s of parseJsonArray(next.Skills)) {
            const before = prev.find((p) => p?.competencyId === s?.competencyId);
            if (before && Number(s?.currentLevel) > Number(before?.currentLevel)) {
                skills.push(String(s?.competencyName ?? s?.competencyId));
            }
        }
    }
    return { courses, skills };
}

/**
 * Throws (and records the courses for this turn) when an LLM write to UserState would mark
 * a course Complete, record a passed quiz, or raise a skill level. `stored` is the row as it is
 * now (null for a create, which is compared against an empty plan). The thrown message is
 * returned to the model as the tool result.
 */
function guardUserStateWrite(
    rawCtx: any,
    displayFields: Record<string, unknown>,
    stored: Record<string, unknown> | null,
): void {
    if (!('LearningProgress' in displayFields) && !('Skills' in displayFields)) return;

    const { courses, skills } = findUnearnedProgress(displayFields, stored);
    if (courses.length === 0 && skills.length === 0) return;

    const turnContext: TurnContext | undefined = (rawCtx?.context ?? rawCtx)?.turnContext;
    if (turnContext && courses.length) {
        const set = blockedByTurn.get(turnContext) ?? new Set<string>();
        for (const c of courses) set.add(c.courseId);
        blockedByTurn.set(turnContext, set);
    }
    const parts: string[] = [];
    if (courses.length) parts.push(`marking ${courses.map((c) => `"${c.title}" (${c.courseId})`).join(', ')} as Complete`);
    if (skills.length) parts.push(`raising the level of ${skills.join(', ')}`);
    console.warn(`[ProgressGuard] Blocked UserState write: ${parts.join('; ')}.`);
    const example = courses[0]?.courseId ?? '<courseId>';
    throw new Error(
        `BLOCKED — nothing was written. Progress only changes when the user passes a course quiz, and only the quiz grader records that. ` +
        `Not allowed: ${parts.join('; ')}. Do NOT retry this update and do NOT tell the user these courses are complete. ` +
        `To validate a course, emit ONE quiz card (type "quiz") with its courseId (e.g. "${example}"); the system generates and grades it.`,
    );
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
            listId: { type: 'string', description: 'The Graph listId GUID (from listLists) OR the exact list display name from the system prompt (e.g. the configured UserState list). Display names auto-resolve.' },
            filterField: { type: 'string', description: 'Optional. Field name to filter on (e.g. "UserAADId").' },
            filterValue: { type: 'string', description: 'Optional. String value to match. Case-insensitive.' },
        },
        required: ['siteId', 'listId'],
        additionalProperties: false,
    },
    execute: async (args: any, ctx: any) => {
        const graph = graphFrom(ctx);
        const siteId = await dataSiteId(graph, args.siteId);
        const listId = resolveListId(siteId, args.listId);
        const listName = await listNameOf(graph, siteId, listId);
        if (!careerCoachListNames().includes(listName)) {
            throw new Error(`BLOCKED — nothing was read. "${args.listId}" is not one of the Career Coach lists (${careerCoachListNames().join(', ')}).`);
        }
        // Personal lists: the model only ever sees the caller's own rows, whatever filter it asks for.
        const personal = personalListNames().includes(listName);
        const callerId = personal ? requireCallerId(ctx) : '';
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
        let filtered = personal ? rows.filter((r) => sameId(r.fields?.UserAADId, callerId)) : rows;
        if (args.filterField && typeof args.filterValue !== 'undefined') {
            const key = String(args.filterField);
            const needle = String(args.filterValue).toLowerCase();
            filtered = filtered.filter((r) => String(r.fields?.[key] ?? '').toLowerCase() === needle);
        }
        // Only the active goal is visible; finished goals are history (see listPreviousGoals).
        if (listName === SP_CONFIG.lists.userState.toLowerCase()) filtered = filtered.filter((r) => planStatusOf(r.fields) === 'Active');
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
        const siteId = await dataSiteId(graph, args.siteId);
        const listId = resolveListId(siteId, args.listId);
        // Chat writes are limited to UserState. Reference data, portal completions and quiz audit rows
        // are written only by provisioning, the learning portal and the deterministic quiz grader.
        if (!await isUserStateList(graph, siteId, listId)) {
            throw new Error(`BLOCKED — nothing was written. Writes from chat are limited to the "${SP_CONFIG.lists.userState}" list; every other list is written by the app itself.`);
        }
        const callerId = requireCallerId(ctx);
        const colMap = await getColumnMap(graph, siteId, listId);
        // Canonical (display) names first, so no guard below can be bypassed with an internal-name alias.
        let displayFields = canonicalizeFields(normalizeFields(args.fields), colMap);
        // A new plan always belongs to the authenticated caller; a different owner is refused.
        if (displayFields.UserAADId !== undefined && String(displayFields.UserAADId).trim() !== '' && !sameId(displayFields.UserAADId, callerId)) {
            throw new Error('BLOCKED — nothing was written. A plan can only be created for the user you are talking to.');
        }
        displayFields = { ...displayFields, UserAADId: callerId };

        return withUserLock(callerId, async () => {
            // One active goal per user: a new row is only allowed when there's no active goal.
            const active = await readUserState(graph, callerId, siteId);
            if (active) {
                throw new Error(
                    `BLOCKED — nothing was written. This user already has an active goal (itemId "${active.itemId}", ` +
                    `TargetRole "${active.state.TargetRole}"). Update that row with updateListItem instead of creating a new one.`,
                );
            }
            displayFields = dropMissingLifecycleColumns({ ...withoutAppManagedFields(displayFields), PlanStatus: 'Active' }, colMap);
            guardUserStateWrite(ctx, displayFields, null);
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
        });
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
        const siteId = await dataSiteId(graph, args.siteId);
        const listId = resolveListId(siteId, args.listId);
        if (!await isUserStateList(graph, siteId, listId)) {
            throw new Error(`BLOCKED — nothing was written. Writes from chat are limited to the "${SP_CONFIG.lists.userState}" list; every other list is written by the app itself.`);
        }
        const callerId = requireCallerId(ctx);
        const itemId = String(args.itemId ?? '').trim();
        if (!/^\d+$/.test(itemId)) {
            throw new Error('BLOCKED — nothing was written. itemId must be the numeric id of a row returned by listListItems.');
        }
        const colMap = await getColumnMap(graph, siteId, listId);
        // Canonical (display) names first, so no guard below can be bypassed with an internal-name alias.
        let displayFields = canonicalizeFields(normalizeFields(args.fields), colMap);

        return withUserLock(callerId, async () => {
            // Fail closed: a row that can't be read, or that belongs to someone else, is never written.
            let stored: Record<string, any>;
            try {
                const item = await graph.api(`/sites/${siteId}/lists/${listId}/items/${itemId}?$expand=fields`).get();
                stored = toDisplayFields(item?.fields ?? {}, colMap);
            } catch (err: any) {
                throw new Error(`BLOCKED — nothing was written. Item "${itemId}" could not be read (${err?.statusCode ?? err?.code ?? 'error'}), so ownership can't be verified. Re-read the active goal with listListItems and retry.`);
            }
            if (!sameId(stored.UserAADId, callerId)) {
                throw new Error(`BLOCKED — nothing was written. Item "${itemId}" is not the current user's plan.`);
            }
            // Ownership never changes.
            if (displayFields.UserAADId !== undefined && !sameId(displayFields.UserAADId, callerId)) {
                throw new Error('BLOCKED — nothing was written. The owner of a plan cannot be changed.');
            }
            delete displayFields.UserAADId;
            displayFields = withoutAppManagedFields(displayFields);

            const status = planStatusOf(stored);
            if (status !== 'Active') {
                throw new Error(
                    `BLOCKED — nothing was written. Item "${itemId}" is a ${status.toLowerCase()} goal and is read-only history. ` +
                    `Only the user's active goal (from listListItems) can be updated.`,
                );
            }
            // Switching the active goal to another role must not wipe its progress.
            const newRole = String(displayFields.TargetRole ?? '').trim().toLowerCase();
            const oldRole = String(stored.TargetRole ?? '').trim().toLowerCase();
            const hasProgress = Number(stored.OverallProgress ?? 0) > 0 ||
                parseJsonArray(stored.LearningProgress).some((lp) => String(lp?.status ?? 'Recommended') !== 'Recommended' || !!lp?.quizResult);
            if (newRole && oldRole && newRole !== oldRole && hasProgress) {
                throw new Error(
                    `BLOCKED — nothing was written. The active "${stored.TargetRole}" goal has progress and can't be overwritten with a new role. ` +
                    `Ask the user to click 💾 Save my plan on the plan card — the app keeps the unfinished goal as history and starts the new one.`,
                );
            }
            guardUserStateWrite(ctx, displayFields, stored);
            const internalFields = toInternalFields(displayFields, colMap);
            try {
                const updated = await graph.api(`/sites/${siteId}/lists/${listId}/items/${itemId}/fields`).update(internalFields);
                return JSON.stringify({ id: itemId, fields: toDisplayFields(updated ?? internalFields, colMap) });
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
        });
    },
});

const listPreviousGoalsTool: FunctionTool<any, any, any> = makeTool({
    name: 'listPreviousGoals',
    description:
        "List the current user's previous (finished) career goals, most recent first: Completed goals and goals Replaced by a newer one. " +
        'Each entry has the full detail (skills with levels, courses with completion + quiz results, goal progress, manager asks), enough to build a progress summary or a 1:1 prep brief. ' +
        'Read-only. Use when the user asks about previous / past / completed goals or history, or when they ask for a 1:1 prep and have no active goal.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async (_args: any, ctx: any) => {
        const userId = currentUserId(ctx);
        if (!userId) return JSON.stringify([]);
        const plans = await readPreviousPlans(graphFrom(ctx), userId);
        return JSON.stringify(plans.map(({ state: s }, i) => ({
            goalNumber: i + 1,
            targetRole: s.TargetRole,
            status: s.PlanStatus,
            planCreatedDate: s.PlanCreatedDate,
            finishedDate: s.PlanCompletedDate ?? null,
            overallProgress: s.OverallProgress,
            managerAsks: s.ManagerAsks || null,
            goals: (s.Goals ?? []).map((g) => ({ name: g.competencyName, progressPct: g.progressPct, status: g.status })),
            skills: (s.Skills ?? []).map((k) => ({ name: k.competencyName, currentLevel: k.currentLevel, targetLevel: k.targetLevel, gap: k.gap })),
            courses: (s.LearningProgress ?? []).map((lp) => ({
                title: lp.courseTitle,
                status: lp.status,
                completedDate: lp.completedDate ?? null,
                timeSpentMinutes: lp.timeSpentMinutes ?? null,
                quizScore: lp.quizResult ? `${lp.quizResult.score}/5` : null,
            })),
        })));
    },
});

export function makeSharePointTools(): FunctionTool<any, any, any>[] {
    return [getSiteByPathTool, listListsTool, listListItemsTool, createListItemTool, updateListItemTool, listPreviousGoalsTool];
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
