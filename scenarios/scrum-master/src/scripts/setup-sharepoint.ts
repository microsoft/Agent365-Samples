// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * One-time SharePoint provisioning script.
 *
 * Signs in the developer via device-code, creates all six SMA_* lists with the
 * schemas declared in `services/sharepoint.ts`, and creates the SprintReports
 * document library. Idempotent — running it twice is a no-op.
 *
 * Usage: `npm run setup:sharepoint`
 */

import { configDotenv } from 'dotenv';
configDotenv();

import 'isomorphic-fetch';
import {
    acquireTokenViaDeviceCode,
    getGraphClient,
} from '../services/graph';
import {
    DOC_LIBRARY_NAME,
    LIST_NAMES,
    LIST_SCHEMAS,
    ListKey,
    getSiteId,
} from '../services/sharepoint';
import { getSharePointConfig } from '../config';

const COLUMN_TYPE_MAP: Record<string, object> = {
    text: { text: {} },
    note: { text: { allowMultipleLines: true, appendChangesToExistingText: false, linesForEditing: 6 } },
    dateTime: { dateTime: { format: 'dateTime' } },
    number: { number: { decimalPlaces: 'automatic' } },
    boolean: { boolean: {} },
};

async function main() {
    console.log('[setup] Starting SharePoint provisioning...');

    // Interactive sign-in — this populates the MSAL cache used by every runtime call.
    await acquireTokenViaDeviceCode();
    console.log('[setup] Sign-in complete. Token cache persisted.');

    const { siteUrl, listsPrefix } = getSharePointConfig();
    console.log(`[setup] Target site: ${siteUrl}`);
    const siteId = await getSiteId();
    console.log(`[setup] Resolved siteId=${siteId}`);
    const graph = getGraphClient();

    // Provision lists
    for (const key of Object.keys(LIST_NAMES) as ListKey[]) {
        const displayName = `${listsPrefix}${LIST_NAMES[key]}`;
        const schema = LIST_SCHEMAS[key];

        const existing = await graph
            .api(`/sites/${siteId}/lists?$filter=displayName eq '${displayName.replace(/'/g, "''")}'`)
            .get()
            .catch(() => ({ value: [] }));

        if ((existing.value ?? []).length > 0) {
            console.log(`[setup] List ${displayName} already exists — skipping.`);
            continue;
        }

        console.log(`[setup] Creating list ${displayName}...`);
        await graph.api(`/sites/${siteId}/lists`).post({
            displayName,
            list: { template: 'genericList' },
            columns: schema.columns.map(col => ({
                name: col.name,
                ...COLUMN_TYPE_MAP[col.type],
            })),
        });
        console.log(`[setup]   ...created.`);
    }

    // Provision doc library
    const libExisting = await graph
        .api(`/sites/${siteId}/lists?$filter=displayName eq '${DOC_LIBRARY_NAME}'`)
        .get()
        .catch(() => ({ value: [] }));
    if ((libExisting.value ?? []).length > 0) {
        console.log(`[setup] Doc library ${DOC_LIBRARY_NAME} already exists — skipping.`);
    } else {
        console.log(`[setup] Creating doc library ${DOC_LIBRARY_NAME}...`);
        await graph.api(`/sites/${siteId}/lists`).post({
            displayName: DOC_LIBRARY_NAME,
            list: { template: 'documentLibrary' },
        });
        console.log(`[setup]   ...created.`);
    }

    console.log('[setup] Done. You can now run `npm run seed` and then `npm run dev`.');
}

main().catch((err) => {
    console.error('[setup] Failed:', err?.message ?? err);
    process.exit(1);
});
