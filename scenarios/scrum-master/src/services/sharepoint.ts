// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * SharePoint Lists + Document Library CRUD via Microsoft Graph.
 *
 * The setup script (`scripts/setup-sharepoint.ts`) provisions six lists and one
 * document library on the configured site; this module is the runtime API used
 * by every handler that reads or writes durable state.
 *
 * All items are stored using SharePoint's "list item fields" bag. We keep the
 * schema flat (Title + a small handful of text/date columns) so migration to
 * Dataverse in v2 is a trivial re-map.
 */

import { getGraphClient } from './graph';
import { getSharePointConfig } from '../config';

export const LIST_NAMES = {
    teamMembers: 'TeamMembers',
    teamsConfig: 'TeamsConfig',
    standupSessions: 'StandupSessions',
    standupResponses: 'StandupResponses',
    blockers: 'Blockers',
    sprintRisks: 'SprintRisks',
    helperRoster: 'HelperRoster',
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
    const siteId = await getSiteId();
    const graph = getGraphClient();
    const res = await graph
        .api(`/sites/${siteId}/lists/${listName(key)}/items?$expand=fields&$filter=fields/Title eq '${escapeODataString(title)}'`)
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
    const siteId = await getSiteId();
    const graph = getGraphClient();
    const res = await graph
        .api(`/sites/${siteId}/lists/${listName(key)}/items?$expand=fields&$filter=fields/${fieldName} eq '${escapeODataString(value)}'`)
        .header('Prefer', 'HonorNonIndexedQueriesWarningMayFailRandomly')
        .get();
    return (res.value ?? []).map((v: any) => ({ id: v.id, fields: v.fields }));
}

export async function listItems<T extends object>(
    key: ListKey,
): Promise<ListItem<T>[]> {
    const siteId = await getSiteId();
    const graph = getGraphClient();
    const res = await graph
        .api(`/sites/${siteId}/lists/${listName(key)}/items?$expand=fields&$top=200`)
        .get();
    return (res.value ?? []).map((v: any) => ({ id: v.id, fields: v.fields }));
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
    columns: Array<{ name: string; type: 'text' | 'note' | 'dateTime' | 'number' | 'boolean' }>;
}> = {
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

function escapeODataString(s: string): string {
    // Two-step: (1) escape single-quote for the OData string literal ('' == literal ')
    // then (2) URL-encode the result so URL parsers don't treat `#`, `?`, `&`, `+`, etc.
    // inside our filter value as URL syntax. Our IDs use `#` as a separator (e.g.
    // `<sprintId>#<yyyy-mm-dd>`), which without encoding gets treated as a URL fragment
    // and truncates the filter — silently returning zero rows.
    return encodeURIComponent(s.replace(/'/g, "''"));
}
