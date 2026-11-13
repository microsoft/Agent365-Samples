// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Seeds the two read-only SharePoint reference lists from the CSVs under
 * `SharePoint Data/`:
 *   - CompetencyFramework_v2 <- CompetencyFramework_v2.csv
 *   - LearningCatalog_v2     <- LearningCatalog_v2.csv
 *
 * Idempotent by row key (RoleId + CompetencyId, CourseId): a re-run adds only the rows that are
 * missing, so a seed that stopped part-way is completed by running it again. Rows already in the
 * list are never changed; to replace content, delete the items via the SharePoint UI first.
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
import { getColumnMap, toInternalFields, toDisplayFields, type ColumnMap } from '../sharepoint-column-map';

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
    // Columns that together identify a row, so a re-run adds only the rows that are missing.
    keyFields: string[];
}

const SEEDS: SeedSpec[] = [
    {
        listDisplayName: SP_CONFIG.lists.competencyFramework,
        csvFileName: 'CompetencyFramework_v2.csv',
        numericFields: ['RequiredLevel'],
        keyFields: ['RoleId', 'CompetencyId'],
    },
    {
        listDisplayName: SP_CONFIG.lists.learningCatalog,
        csvFileName: 'LearningCatalog_v2.csv',
        numericFields: ['FromLevel', 'ToLevel'],
        keyFields: ['CourseId'],
    },
];

const keyOf = (fields: Record<string, unknown>, keyFields: string[]): string =>
    keyFields.map((k) => String(fields[k] ?? '').trim().toLowerCase()).join('|');

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

/** Keys of the rows already in the list (by the spec's key columns), so a re-run only adds what is missing. */
async function existingKeys(graph: any, siteId: string, listId: string, colMap: ColumnMap, keyFields: string[]): Promise<Set<string>> {
    const keys = new Set<string>();
    let url: string | undefined = `/sites/${siteId}/lists/${listId}/items?$expand=fields&$top=200`;
    while (url) {
        const page: any = await graph.api(url).get();
        for (const item of page?.value ?? []) {
            keys.add(keyOf(toDisplayFields(item.fields ?? {}, colMap), keyFields));
        }
        url = page?.['@odata.nextLink'] ? String(page['@odata.nextLink']).replace('https://graph.microsoft.com/v1.0', '') : undefined;
    }
    return keys;
}

async function seed(): Promise<void> {
    console.log('[seed] Employee Career Coach — reference-list seeder\n');
    const siteId = await getSiteId();
    console.log(`[seed] Site: ${SP_CONFIG.siteUrl}`);
    console.log(`[seed] siteId=${siteId}\n`);
    const graph = getGraphClient();
    let anyFailed = false;

    for (const spec of SEEDS) {
        console.log(`\n[seed] Processing ${spec.listDisplayName} <- ${spec.csvFileName}`);
        const listId = await findListId(graph, siteId, spec.listDisplayName);
        if (!listId) {
            console.warn(`[seed]   ! List not found — run "npm run setup:sharepoint" first.`);
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

        // Idempotency by row key, not by "has any items": a run that stopped part-way is completed by
        // the next run instead of being mistaken for a finished seed.
        const present = await existingKeys(graph, siteId, listId, colMap, spec.keyFields);
        const missing = rows.filter((row) => !present.has(keyOf(toFields(header, row, numericSet), spec.keyFields)));
        if (missing.length === 0) {
            console.log(`[seed]   All ${rows.length} rows are already present — nothing to add.`);
            continue;
        }
        console.log(`[seed]   ${present.size} row(s) present; adding ${missing.length} missing of ${rows.length}.`);
        console.log(`[seed]   Column mapping (display -> internal):`);
        for (const [d, i] of Object.entries(colMap.displayToInternal)) {
            if (d === i) continue; // system columns
            console.log(`[seed]     ${d} -> ${i}`);
        }
        let ok = 0, fail = 0;
        for (const row of missing) {
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
        if (fail > 0) anyFailed = true;
    }

    if (anyFailed) {
        console.error('\n[seed] ❌ Some rows failed. Re-run "npm run seed:reference" — it adds only the rows that are still missing.');
        process.exitCode = 1;
        return;
    }
    console.log('\n[seed] ✅ Reference data import complete.');
}

seed().catch((err) => {
    console.error('\n[seed] ❌ FAILED:', (err as any)?.message ?? err);
    process.exit(1);
});
