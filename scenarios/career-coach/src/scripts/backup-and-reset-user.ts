// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Backs up a user's rows across the three write-lists (UserState, LearningPortalStatus,
 * QuizResponses) to a timestamped JSON file, then deletes them so the user gets a clean
 * slate for a re-demo or re-recording.
 *
 * Usage:
 *   npm run backup:user                                   # TEST_USER_AAD_ID / TEST_USER_NAME from .env
 *   npm run backup:user -- <UserAADId> [displayName]
 *
 * Example:
 *   npm run backup:user -- <UserAADId> "Test User"
 *
 * The backup file is written to  backups/user-<name>-<timestamp>.json
 * and includes every row plus the itemId so it could be replayed later if needed.
 * Rows are read, the backup file is written, and only then are the rows deleted; the script
 * exits non-zero if any deletion fails.
 *
 * Runs against MSAL device-code cache (same as setup:sharepoint / seed:reference).
 */

import { configDotenv } from 'dotenv';
configDotenv();

import 'isomorphic-fetch';
import * as fs from 'fs';
import * as path from 'path';
import { getGraphClient, getSiteId, getListIdByName } from '../graph-service';
import { SP_CONFIG } from '../career-coach-types';
import { getColumnMap, toDisplayFields } from '../sharepoint-column-map';

const BACKUP_DIR = path.resolve(process.cwd(), 'backups');

interface BackupBundle {
    backupTimestamp: string;
    siteId: string;
    userAADId: string;
    displayName: string;
    lists: {
        userState:            Array<{ itemId: string; fields: any }>;
        learningPortalStatus: Array<{ itemId: string; fields: any }>;
        quizResponses:        Array<{ itemId: string; fields: any }>;
    };
}

async function pagedItems(graph: any, siteId: string, listId: string): Promise<Array<{ id: string; fields: any }>> {
    const colMap = await getColumnMap(graph, siteId, listId);
    const rows: Array<{ id: string; fields: any }> = [];
    let url: string | undefined = `/sites/${siteId}/lists/${listId}/items?$expand=fields&$top=200`;
    while (url) {
        const page: any = await graph.api(url).get();
        for (const item of (page?.value ?? [])) {
            rows.push({ id: item.id, fields: toDisplayFields(item.fields ?? {}, colMap) });
        }
        url = page?.['@odata.nextLink'] ? String(page['@odata.nextLink']).replace('https://graph.microsoft.com/v1.0', '') : undefined;
    }
    return rows;
}

interface ListSnapshot {
    listName: string;
    listId: string | null;
    rows: Array<{ itemId: string; fields: any }>;
}

/** Reads the user's rows from one list. Nothing is deleted here. */
async function readUserRows(graph: any, siteId: string, listName: string, userAADId: string): Promise<ListSnapshot> {
    const listId = await getListIdByName(siteId, listName);
    if (!listId) {
        console.warn(`[backup] List "${listName}" not found — skipping.`);
        return { listName, listId: null, rows: [] };
    }
    const all = await pagedItems(graph, siteId, listId);
    const mine = all.filter((r) => String(r.fields?.UserAADId ?? '').toLowerCase() === userAADId.toLowerCase());
    console.log(`[backup] ${listName}: found ${mine.length} row(s) for user.`);
    return { listName, listId, rows: mine.map((r) => ({ itemId: r.id, fields: r.fields })) };
}

/** Deletes the snapshotted rows. Returns how many deletions failed. */
async function deleteRows(graph: any, siteId: string, snapshot: ListSnapshot): Promise<number> {
    if (!snapshot.listId) return 0;
    let ok = 0, fail = 0;
    for (const row of snapshot.rows) {
        try {
            await graph.api(`/sites/${siteId}/lists/${snapshot.listId}/items/${row.itemId}`).delete();
            ok++;
        } catch (err) {
            fail++;
            console.warn(`[backup]   ! failed to delete itemId=${row.itemId}: ${(err as any)?.message ?? err}`);
        }
    }
    console.log(`[backup] ${snapshot.listName}: deleted ${ok} row(s)${fail ? `, ${fail} failed` : ''}.`);
    return fail;
}

async function main(): Promise<void> {
    // Same default user as the other helper scripts: TEST_USER_AAD_ID / TEST_USER_NAME from .env.
    const userAADId  = (process.argv[2] || process.env.TEST_USER_AAD_ID || '').trim();
    const displayName = (process.argv[3] || process.env.TEST_USER_NAME || '').trim() || 'user';
    if (!userAADId) {
        console.error('Usage: npm run backup:user -- [<UserAADId> [displayName]]   (defaults to TEST_USER_AAD_ID / TEST_USER_NAME)');
        process.exit(2);
    }

    console.log(`[backup] Employee Career Coach — backup + clear for ${displayName} (${userAADId})`);
    const siteId = await getSiteId();
    const graph  = getGraphClient();
    console.log(`[backup] Site: ${SP_CONFIG.siteUrl}`);

    // 1) Read everything first — nothing is deleted until the backup file is safely on disk.
    const userState            = await readUserRows(graph, siteId, SP_CONFIG.lists.userState,            userAADId);
    const learningPortalStatus = await readUserRows(graph, siteId, SP_CONFIG.lists.learningPortalStatus, userAADId);
    const quizResponses        = await readUserRows(graph, siteId, SP_CONFIG.lists.quizResponses,        userAADId);

    const bundle: BackupBundle = {
        backupTimestamp: new Date().toISOString(),
        siteId,
        userAADId,
        displayName,
        lists: {
            userState:            userState.rows,
            learningPortalStatus: learningPortalStatus.rows,
            quizResponses:        quizResponses.rows,
        },
    };

    // 2) Write the backup. If this throws, nothing has been deleted.
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const safeName = displayName.replace(/[^a-zA-Z0-9-]/g, '_');
    const outFile = path.join(BACKUP_DIR, `user-${safeName}-${stamp}.json`);
    fs.writeFileSync(outFile, JSON.stringify(bundle, null, 2), 'utf-8');
    console.log(`\n[backup] Snapshot saved: ${outFile}`);

    // 3) Only now delete the rows.
    let failures = 0;
    for (const snapshot of [userState, learningPortalStatus, quizResponses]) {
        failures += await deleteRows(graph, siteId, snapshot);
    }

    const total = userState.rows.length + learningPortalStatus.rows.length + quizResponses.rows.length;
    if (failures > 0) {
        console.error(`[backup] ❌ ${failures} row(s) could not be deleted. The backup in ${outFile} is complete; re-run to clear what is left.`);
        process.exit(1);
    }
    console.log(`[backup] ✅ ${total} row(s) backed up + deleted across all three lists.`);
    console.log('[backup] Restart nodemon (or send a message in Teams) to warm the file-storage cache before your next test.');
}

main().catch((err) => {
    console.error('\n[backup] ❌ FAILED:', (err as any)?.message ?? err);
    process.exit(1);
});
