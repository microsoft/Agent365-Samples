// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Seed the SharePoint SMA_HelperRoster list used by the blocker chase flow.
 *
 * Idempotent:
 *   1. Provisions the SMA_HelperRoster list if it doesn't already exist.
 *      (Standalone from setup-sharepoint.ts so you can add helpers at any time
 *      without re-running the full site provisioning.)
 *   2. Upserts three rows keyed on `Title` (topic name). Re-running this script
 *      overwrites the keywords / email / display name of each seed row in place.
 *
 * Usage: `npm run seed:helpers`
 */

import { configDotenv } from 'dotenv';
configDotenv();

import 'isomorphic-fetch';
import {
    LIST_NAMES,
    LIST_SCHEMAS,
    getSiteId,
    upsertItem,
} from '../services/sharepoint';
import { getGraphClient, acquireTokenSilentForGraph, acquireTokenViaDeviceCode } from '../services/graph';
import { getSharePointConfig } from '../config';
import { HelperRosterFields } from '../services/helperMatcher';

const COLUMN_TYPE_MAP: Record<string, object> = {
    text: { text: {} },
    note: { text: { allowMultipleLines: true, appendChangesToExistingText: false, linesForEditing: 6 } },
    dateTime: { dateTime: { format: 'dateTime' } },
    number: { number: { decimalPlaces: 'automatic' } },
    boolean: { boolean: {} },
};

// Sample helper roster used by the blocker-chase flow. Replace the placeholder
// emails with real users from your tenant before running against a live SharePoint
// site.
const SEEDS: HelperRosterFields[] = [
    {
        Title: 'IT / Access / Data platform',
        Keywords: 'powerbi, dataset, service account, dashboard, access, vpn, laptop, hardware, database, api, provisioning, license',
        HelperEmail: 'ivy@contoso.com',
        HelperDisplayName: 'Ivy (IT / Data platform)',
        IsActive: true,
    },
    {
        Title: 'Security / Compliance',
        Keywords: 'security, credentials, secret, token, threat model, pen test, audit, compliance, vulnerability, cve, review',
        HelperEmail: 'sam@contoso.com',
        HelperDisplayName: 'Sam (Security)',
        IsActive: true,
    },
    {
        Title: 'Design / UX / Product',
        Keywords: 'figma, mockup, wireframe, ux, design review, prototype, usability, user testing, spec, copy, content, layout',
        HelperEmail: 'dana@contoso.com',
        HelperDisplayName: 'Dana (Design / UX)',
        IsActive: true,
    },
];

async function ensureListExists(): Promise<void> {
    const { listsPrefix } = getSharePointConfig();
    const displayName = `${listsPrefix}${LIST_NAMES.helperRoster}`;
    const schema = LIST_SCHEMAS.helperRoster;
    const siteId = await getSiteId();
    const graph = getGraphClient();

    const existing = await graph
        .api(`/sites/${siteId}/lists?$filter=displayName eq '${displayName.replace(/'/g, "''")}'`)
        .get()
        .catch(() => ({ value: [] }));

    if ((existing.value ?? []).length > 0) {
        console.log(`[seed-helpers] List ${displayName} already exists — reusing.`);
        return;
    }

    console.log(`[seed-helpers] Creating list ${displayName}...`);
    await graph.api(`/sites/${siteId}/lists`).post({
        displayName,
        list: { template: 'genericList' },
        columns: schema.columns.map(col => ({
            name: col.name,
            ...COLUMN_TYPE_MAP[col.type],
        })),
    });
    console.log('[seed-helpers]   ...created.');
}

async function main() {
    console.log('[seed-helpers] Starting helper roster seed.');

    // Prefer silent auth against the MSAL cache; fall back to device code
    // interactively only if the cache is empty or the refresh token has expired.
    try {
        await acquireTokenSilentForGraph();
        console.log('[seed-helpers] Reusing cached Microsoft sign-in.');
    } catch {
        console.log('[seed-helpers] Cache miss — running device-code flow.');
        await acquireTokenViaDeviceCode();
    }

    await ensureListExists();

    for (const row of SEEDS) {
        console.log(`[seed-helpers] Upsert: "${row.Title}" -> ${row.HelperEmail}`);
        await upsertItem<HelperRosterFields>('helperRoster', row);
    }

    console.log(`[seed-helpers] Done — ${SEEDS.length} row(s) seeded.`);
}

main().catch(err => {
    console.error('[seed-helpers] Failed:', err?.message ?? err);
    process.exit(1);
});
