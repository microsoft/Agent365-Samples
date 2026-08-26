// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Deletes every item from a SharePoint list. Used to clear duplicate rows before
 * re-seeding a reference list. Uses the MSAL device-code cache (same as
 * setup:sharepoint / seed:reference).
 *
 * Usage:
 *   npm run clear:list -- CompetencyFramework_v2
 *   npm run clear:list -- LearningCatalog_v2
 *   npm run clear:list -- UserState
 */

import { configDotenv } from 'dotenv';
configDotenv();

import 'isomorphic-fetch';
import { getGraphClient, getSiteId } from '../graph-service';

async function main(): Promise<void> {
    const target = (process.argv[2] || '').trim();
    if (!target) {
        console.error('Usage: npm run clear:list -- <listDisplayName>');
        process.exit(2);
    }

    console.log(`[clear] Employee Career Coach — clear list "${target}"`);
    const siteId = await getSiteId();
    const graph = getGraphClient();

    // Resolve list id by display name.
    const escaped = target.replace(/'/g, "''");
    const lookup = await graph.api(`/sites/${siteId}/lists?$filter=displayName eq '${escaped}'`).get();
    const listId: string | undefined = lookup?.value?.[0]?.id;
    if (!listId) {
        console.error(`[clear] List "${target}" not found on the site.`);
        process.exit(3);
    }
    console.log(`[clear] siteId=${siteId} listId=${listId}`);

    // Enumerate all item ids.
    const ids: string[] = [];
    let url: string | undefined = `/sites/${siteId}/lists/${listId}/items?$select=id&$top=200`;
    while (url) {
        const page: any = await graph.api(url).get();
        for (const it of page?.value ?? []) if (it?.id) ids.push(String(it.id));
        url = page?.['@odata.nextLink'] ? String(page['@odata.nextLink']).replace('https://graph.microsoft.com/v1.0', '') : undefined;
    }
    console.log(`[clear] Found ${ids.length} items to delete.`);
    if (ids.length === 0) { console.log('[clear] Nothing to do.'); return; }

    let ok = 0, fail = 0;
    for (const id of ids) {
        try {
            await graph.api(`/sites/${siteId}/lists/${listId}/items/${id}`).delete();
            ok++;
            if (ok % 10 === 0) process.stdout.write(`.`);
        } catch (err: any) {
            fail++;
            console.warn(`\n[clear]   ! delete id=${id} failed: ${err?.message ?? err}`);
        }
    }
    console.log(`\n[clear] ✅ Done: ${ok} deleted, ${fail} failed.`);
}

main().catch((err) => {
    console.error('[clear] ❌ FAILED:', (err as any)?.message ?? err);
    process.exit(1);
});
