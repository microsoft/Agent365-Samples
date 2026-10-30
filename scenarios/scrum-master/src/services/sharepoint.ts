// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * SharePoint Lists + Document Library CRUD via Microsoft Graph.
 *
 * The setup script (`scripts/setup-sharepoint.ts`) provisions the configured lists and one
 * document library on the configured site; this module is the runtime API used
 * by every handler that reads or writes durable state.
 *
 * All items are stored using SharePoint's "list item fields" bag. We keep the
 * schema flat (Title + a small handful of text/date columns) so migration to
 * Dataverse in v2 is a trivial re-map.
 */

import { getGraphClient } from './graph';
import { getSharePointConfig, getJiraMode } from '../config';

export const LIST_NAMES = {
    teamMembers: 'TeamMembers',
    teamsConfig: 'TeamsConfig',
    standupSessions: 'StandupSessions',
    standupResponses: 'StandupResponses',
    blockers: 'Blockers',
    sprintRisks: 'SprintRisks',
    helperRoster: 'HelperRoster',
    sprintReportsDelivery: 'SprintReportsDelivery',
} as const;
export type ListKey = keyof typeof LIST_NAMES;

export const DOC_LIBRARY_NAME = 'SprintReports';

// --- Site resolution -----------------------------------------------------

let cachedSiteId: string | null = null;
export async function getSiteId(): Promise<string> {
    if (cachedSiteId) return cachedSiteId;
    const { siteUrl } = getSharePointConfig();
    const parsed = new URL(siteUrl);
    const hostname = parsed.hostname;
    const serverRelPath = parsed.pathname.replace(/\/$/, '');
    const graph = getGraphClient();
    const res = await graph
        .api(`/sites/${hostname}:${serverRelPath}`)
        .get();
    cachedSiteId = res.id as string;
    return cachedSiteId;
}

function listName(key: ListKey): string {
    const { listsPrefix } = getSharePointConfig();
    return `${listsPrefix}${LIST_NAMES[key]}`;
}

// --- List CRUD -----------------------------------------------------------

export interface ListItem<T extends object = Record<string, unknown>> {
    id: string;                       // SharePoint list item id
    fields: T & { Title?: string };
    createdDateTime?: string;
    lastModifiedDateTime?: string;
}

const mockLists = new Map<ListKey, Map<string, ListItem<any>>>();
let mockSequence = 0;
function mockList(key: ListKey): Map<string, ListItem<any>> {
    let rows = mockLists.get(key);
    if (!rows) { rows = new Map(); mockLists.set(key, rows); }
    return rows;
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }

export async function upsertItem<T extends object>(
    key: ListKey,
    fields: T & { Title: string },
): Promise<ListItem<T>> {
    const existing = await findByTitle<T>(key, fields.Title);
    if (existing) {
        return updateItem<T>(key, existing.id, fields);
    }
    return createItem<T>(key, fields);
}

export async function createItem<T extends object>(
    key: ListKey,
    fields: T & { Title: string },
): Promise<ListItem<T>> {
    if (getJiraMode() === 'mock') {
        const rows = mockList(key);
        if (key === 'sprintReportsDelivery' &&
            [...rows.values()].some(r => r.fields.DeliveryKey === (fields as any).DeliveryKey)) {
            throw Object.assign(new Error('Duplicate delivery key'), { statusCode: 409 });
        }
        const row = { id: String(++mockSequence), fields: copy(fields) };
        rows.set(row.id, row);
        return copy(row);
    }
    const siteId = await getSiteId();
    const graph = getGraphClient();
    const res = await graph
        .api(`/sites/${siteId}/lists/${listName(key)}/items`)
        .post({ fields });
    return { id: res.id, fields: res.fields };
}

export async function updateItem<T extends object>(
    key: ListKey,
    itemId: string,
    fields: Partial<T> & { Title?: string },
): Promise<ListItem<T>> {
    if (getJiraMode() === 'mock') {
        const row = mockList(key).get(itemId);
        if (!row) throw new Error(`Missing mock ${key} item ${itemId}`);
        Object.assign(row.fields, copy(fields));
        return copy(row);
    }
    const siteId = await getSiteId();
    const graph = getGraphClient();
    await graph
        .api(`/sites/${siteId}/lists/${listName(key)}/items/${itemId}/fields`)
        .update(fields);
    const refreshed = await graph
        .api(`/sites/${siteId}/lists/${listName(key)}/items/${itemId}?$expand=fields`)
        .get();
    return { id: refreshed.id, fields: refreshed.fields };
}

export async function findByTitle<T extends object>(
    key: ListKey,
    title: string,
): Promise<ListItem<T> | null> {
    if (getJiraMode() === 'mock') {
        return copy([...mockList(key).values()].find(r => r.fields.Title === title) ?? null);
    }
    const siteId = await getSiteId();
    const graph = getGraphClient();
    const filter = `fields/Title eq '${escapeODataString(title)}'`;
    const res = await graph
        .api(`/sites/${siteId}/lists/${listName(key)}/items?$expand=fields&$filter=${encodeURIComponent(filter)}`)
        .header('Prefer', 'HonorNonIndexedQueriesWarningMayFailRandomly')
        .get();
    const items = res.value ?? [];
    if (items.length === 0) return null;
    return { id: items[0].id, fields: items[0].fields };
}

export async function findByField<T extends object>(
    key: ListKey,
    fieldName: string,
    value: string,
): Promise<ListItem<T>[]> {
    if (getJiraMode() === 'mock') {
        return copy([...mockList(key).values()].filter(r => r.fields[fieldName] === value));
    }
    const siteId = await getSiteId();
    const graph = getGraphClient();
    const filter = `fields/${fieldName} eq '${escapeODataString(value)}'`;
    const res = await graph
        .api(`/sites/${siteId}/lists/${listName(key)}/items?$expand=fields&$filter=${encodeURIComponent(filter)}`)
        .header('Prefer', 'HonorNonIndexedQueriesWarningMayFailRandomly')
        .get();
    return (res.value ?? []).map((v: any) => ({ id: v.id, fields: v.fields }));
}

export async function listItems<T extends object>(
    key: ListKey,
): Promise<ListItem<T>[]> {
    if (getJiraMode() === 'mock') return copy([...mockList(key).values()]);
    const siteId = await getSiteId();
    const graph = getGraphClient();
    const res = await graph
        .api(`/sites/${siteId}/lists/${listName(key)}/items?$expand=fields&$top=200`)
        .get();
    return (res.value ?? []).map((v: any) => ({ id: v.id, fields: v.fields }));
}

/** Atomic state transition: a stale reader cannot acquire a second claim. */
export async function claimItemState(
    key: ListKey, itemId: string, expected: string, next: string,
): Promise<boolean> {
    if (getJiraMode() === 'mock') {
        const row = mockList(key).get(itemId);
        if (!row || row.fields.State !== expected) return false;
        row.fields.State = next;
        return true;
    }
    const graph = getGraphClient();
    const siteId = await getSiteId();
    const path = `/sites/${siteId}/lists/${listName(key)}/items/${itemId}`;
    const current = await graph.api(`${path}?$expand=fields`).get();
    if (current.fields?.State !== expected) return false;
    const etag = current.eTag ?? current['@odata.etag'];
    if (!etag) throw new Error('SharePoint did not return an ETag; refusing an unsafe claim.');
    try {
        await graph.api(`${path}/fields`).header('If-Match', etag).update({ State: next });
        return true;
    } catch (e) {
        if ((e as any).statusCode === 412 || (e as any).status === 412) return false;
        throw e;
    }
}

export async function claimSprintReport(sprintId: number): Promise<string | null> {
    const deliveryKey = `sprint-close:${sprintId}`;
    const existing = (await findByField<{ State: string }>(
        'sprintReportsDelivery', 'DeliveryKey', deliveryKey,
    ))[0];
    if (existing) {
        if (existing.fields.State !== 'failed') return null;
        return await claimItemState('sprintReportsDelivery', existing.id, 'failed', 'claimed') ? existing.id : null;
    }
    try {
        const created = await createItem('sprintReportsDelivery', {
            Title: deliveryKey, DeliveryKey: deliveryKey, State: 'claimed', ClaimedUtc: new Date().toISOString(),
        });
        return created.id;
    } catch (e) {
        // A competing worker may have won the unique-key insert. All other
        // storage errors must stop delivery rather than bypass the guard.
        if ((await findByField('sprintReportsDelivery', 'DeliveryKey', deliveryKey)).length) return null;
        throw e;
    }
}

// --- Doc library upload --------------------------------------------------

export async function uploadReportMarkdown(
    filename: string,
    markdown: string,
): Promise<{ webUrl: string; id: string }> {
    const siteId = await getSiteId();
    const graph = getGraphClient();
    const driveResp = await graph.api(`/sites/${siteId}/drives`).get();
    const drive = (driveResp.value ?? []).find((d: any) => d.name === DOC_LIBRARY_NAME);
    if (!drive) {
        throw new Error(`Doc library ${DOC_LIBRARY_NAME} not found. Run npm run setup:sharepoint.`);
    }
    const buffer = Buffer.from(markdown, 'utf-8');
    const uploaded = await graph
        .api(`/drives/${drive.id}/root:/${encodeURIComponent(filename)}:/content`)
        .put(buffer);
    return { webUrl: uploaded.webUrl, id: uploaded.id };
}

// --- Provisioning helpers (used by setup script) -------------------------

/**
 * Column schemas for each list. Field types map to Microsoft Graph list-column definitions.
 * Keeping schemas here (not in the setup script) so runtime code has one source of truth
 * for what fields exist.
 */
export const LIST_SCHEMAS: Record<ListKey, {
    columns: Array<{ name: string; type: 'text' | 'note' | 'dateTime' | 'number' | 'boolean'; unique?: boolean }>;
}> = {
    sprintReportsDelivery: {
        columns: [
            { name: 'DeliveryKey', type: 'text', unique: true },
            { name: 'State', type: 'text' },
            { name: 'ClaimedUtc', type: 'dateTime' },
            { name: 'DeliveredUtc', type: 'dateTime' },
        ],
    },
    teamMembers: {
        columns: [
            { name: 'Email', type: 'text' },
            { name: 'AadObjectId', type: 'text' },
            { name: 'JiraAccountId', type: 'text' },
            { name: 'TimeZone', type: 'text' },
            { name: 'Role', type: 'text' },
            { name: 'ConversationRef', type: 'note' },
            { name: 'LastSeenUtc', type: 'dateTime' },
        ],
    },
    teamsConfig: {
        columns: [
            { name: 'TeamId', type: 'text' },
            { name: 'ChannelId', type: 'text' },
            { name: 'ConversationRef', type: 'note' },
            { name: 'ConfiguredByAadId', type: 'text' },
            { name: 'ConfiguredAtUtc', type: 'dateTime' },
        ],
    },
    standupSessions: {
        columns: [
            { name: 'SprintId', type: 'text' },
            { name: 'StartedUtc', type: 'dateTime' },
            { name: 'CutoffUtc', type: 'dateTime' },
            { name: 'State', type: 'text' },
            { name: 'ExpectedResponders', type: 'note' },
            { name: 'InitiatedByAadId', type: 'text' },
        ],
    },
    standupResponses: {
        columns: [
            { name: 'StandupId', type: 'text' },
            { name: 'UserAadId', type: 'text' },
            { name: 'SubmittedUtc', type: 'dateTime' },
            { name: 'Items', type: 'note' },
        ],
    },
    blockers: {
        columns: [
            { name: 'StandupId', type: 'text' },
            { name: 'ReporterAadId', type: 'text' },
            { name: 'OwnerAadId', type: 'text' },
            { name: 'BlockerText', type: 'note' },
            { name: 'State', type: 'text' },
            { name: 'MeetingEventId', type: 'text' },
        ],
    },
    sprintRisks: {
        columns: [
            { name: 'SprintId', type: 'text' },
            { name: 'DetectedUtc', type: 'dateTime' },
            { name: 'Reason', type: 'note' },
            { name: 'PointsToDoPct', type: 'number' },
            { name: 'Payload', type: 'note' },
        ],
    },
    helperRoster: {
        columns: [
            // Title is the topic name (e.g. "IT / Access / Data platform").
            { name: 'Keywords', type: 'note' },
            { name: 'HelperEmail', type: 'text' },
            { name: 'HelperDisplayName', type: 'text' },
            { name: 'IsActive', type: 'boolean' },
        ],
    },
};

// --- helpers ------------------------------------------------------------

// OData string literal escaping only — double single-quotes for the '' == literal ' rule.
// Callers must URL-encode the full $filter query value (not just this string) so URL
// syntax chars like `#`, `?`, `&`, `+` inside the literal survive transport, while spaces
// stay real spaces inside the OData literal (URL-encoding the value alone would send
// `%20` and match nothing).
function escapeODataString(s: string): string {
    return s.replace(/'/g, "''");
}
