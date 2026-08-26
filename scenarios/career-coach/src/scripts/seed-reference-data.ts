// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Seeds the two read-only SharePoint reference lists from the CSVs under
 * `SharePoint Data/`:
 *   - CompetencyFramework_v2 <- CompetencyFramework_v2.csv
 *   - LearningCatalog_v2     <- LearningCatalog_v2.csv
 *
 * Idempotent: skips a list if it already has items. To re-seed, first delete the
 * items via the SharePoint UI (or extend this script with a --force flag).
 *
 * Uses the same MSAL device-code cache as `setup:sharepoint`, so no separate
 * sign-in is needed.
 *
 * Usage: `npm run seed:reference`
 */

import { configDotenv } from 'dotenv';
configDotenv();

import 'isomorphic-fetch';
import * as fs from 'fs';
import * as path from 'path';
import { getGraphClient, getSiteId } from '../graph-service';
import { SP_CONFIG } from '../career-coach-types';
import { getColumnMap, toInternalFields } from '../sharepoint-column-map';

const CSV_DIR = resolveCsvDir();

// Resolve where the seed CSVs live. Order of precedence:
//   1. SP_SEED_CSV_DIR env var (explicit override)
//   2. project-local `SharePoint Data/` (self-contained, ships with the repo)
//   3. legacy `../SharePoint Data/` (one folder up)
function resolveCsvDir(): string {
    if (process.env.SP_SEED_CSV_DIR) return path.resolve(process.env.SP_SEED_CSV_DIR);
    const candidates = [
        path.resolve(process.cwd(), 'SharePoint Data'),
        path.resolve(process.cwd(), '..', 'SharePoint Data'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return candidates[0];
}

interface SeedSpec {
    listDisplayName: string;
    csvFileName: string;
    // Column names that should be parsed as numbers (SharePoint Number columns).
    numericFields: string[];
}

const SEEDS: SeedSpec[] = [
    {
        listDisplayName: SP_CONFIG.lists.competencyFramework,
        csvFileName: 'CompetencyFramework_v2.csv',
        numericFields: ['RequiredLevel'],
    },
    {
        listDisplayName: SP_CONFIG.lists.learningCatalog,
        csvFileName: 'LearningCatalog_v2.csv',
        numericFields: ['FromLevel', 'ToLevel'],
    },
];

// Minimal RFC-4180-ish CSV parser (handles quoted fields with commas + embedded quotes).
function parseCsv(text: string): { header: string[]; rows: string[][] } {
    const rows: string[][] = [];
    let cur = '';
    let row: string[] = [];
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
            else if (ch === '"') inQuotes = false;
            else cur += ch;
        } else {
            if (ch === '"') inQuotes = true;
            else if (ch === ',') { row.push(cur); cur = ''; }
            else if (ch === '\r') { /* skip */ }
            else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
            else cur += ch;
        }
    }
    // Handle trailing line without newline
    if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
    const header = rows.shift() ?? [];
    return { header, rows: rows.filter((r) => r.some((c) => c.trim().length > 0)) };
}

function toFields(header: string[], row: string[], numericFields: Set<string>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < header.length; i++) {
        const key = header[i];
        let val: string | number = row[i] ?? '';
        if (numericFields.has(key)) {
            const n = Number(val);
            out[key] = Number.isFinite(n) ? n : 0;
        } else {
            out[key] = val;
        }
    }
    return out;
}

async function findListId(graph: any, siteId: string, displayName: string): Promise<string | null> {
    const escaped = displayName.replace(/'/g, "''");
    const res = await graph.api(`/sites/${siteId}/lists?$filter=displayName eq '${escaped}'`).get();
    return res?.value?.[0]?.id ?? null;
}

async function existingItemCount(graph: any, siteId: string, listId: string): Promise<number> {
    // $count on list items is unreliable — just page through and count.
    let total = 0;
    let url: string | undefined = `/sites/${siteId}/lists/${listId}/items?$select=id&$top=200`;
    while (url) {
        const page: any = await graph.api(url).get();
        total += (page?.value?.length ?? 0);
        url = page?.['@odata.nextLink'] ? String(page['@odata.nextLink']).replace('https://graph.microsoft.com/v1.0', '') : undefined;
    }
    return total;
}

async function seed(): Promise<void> {
    console.log('[seed] Employee Career Coach — reference-list seeder\n');
    const siteId = await getSiteId();
    console.log(`[seed] Site: ${SP_CONFIG.siteUrl}`);
    console.log(`[seed] siteId=${siteId}\n`);
    const graph = getGraphClient();

    for (const spec of SEEDS) {
        console.log(`\n[seed] Processing ${spec.listDisplayName} <- ${spec.csvFileName}`);
        const listId = await findListId(graph, siteId, spec.listDisplayName);
        if (!listId) {
            console.warn(`[seed]   ! List not found — run "npm run setup:sharepoint" first.`);
            continue;
        }

        // Idempotency: skip if any items already exist.
        const existing = await existingItemCount(graph, siteId, listId);
        if (existing > 0) {
            console.log(`[seed]   List already has ${existing} items — skipping (delete them in SharePoint UI to re-seed).`);
            continue;
        }

        const csvPath = path.join(CSV_DIR, spec.csvFileName);
        if (!fs.existsSync(csvPath)) {
            console.warn(`[seed]   ! CSV not found at ${csvPath} — skipping.`);
            continue;
        }
        const csvText = fs.readFileSync(csvPath, 'utf-8');
        const { header, rows } = parseCsv(csvText);
        console.log(`[seed]   Parsed ${rows.length} rows (${header.length} columns): ${header.join(', ')}`);

        const numericSet = new Set(spec.numericFields);
        // Resolve display-name -> internal-name mapping ONCE per list.
        const colMap = await getColumnMap(graph, siteId, listId);
        console.log(`[seed]   Column mapping (display -> internal):`);
        for (const [d, i] of Object.entries(colMap.displayToInternal)) {
            if (d === i) continue; // system columns
            console.log(`[seed]     ${d} -> ${i}`);
        }
        let ok = 0, fail = 0;
        for (const row of rows) {
            const displayFields = toFields(header, row, numericSet);
            const fields = toInternalFields(displayFields, colMap);
            try {
                await graph.api(`/sites/${siteId}/lists/${listId}/items`).post({ fields });
                ok++;
                if (ok % 5 === 0) process.stdout.write(`.`);
            } catch (err: any) {
                fail++;
                console.warn(`\n[seed]     ! Row ${ok + fail} failed: ${err?.message ?? err}`);
                if (fail <= 2) {
                    // Verbose diagnostics for the first couple of failures so we can see WHY.
                    console.warn(`[seed]       body sent: ${JSON.stringify(fields)}`);
                    console.warn(`[seed]       Graph statusCode: ${err?.statusCode}`);
                    console.warn(`[seed]       Graph body: ${err?.body ?? JSON.stringify(err?.rawResponse ?? {})}`);
                }
            }
        }
        console.log(`\n[seed]   Done: ${ok} created, ${fail} failed.`);
    }

    console.log('\n[seed] ✅ Reference data import complete.');
}

seed().catch((err) => {
    console.error('\n[seed] ❌ FAILED:', (err as any)?.message ?? err);
    process.exit(1);
});
