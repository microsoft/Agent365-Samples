// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * One-time SharePoint provisioning script for the Employee Career Coach.
 *
 * Signs the developer in via device-code, then creates all five lists (idempotent):
 *   1. `CompetencyFramework_v2` (reference; seeded from CSV via `npm run seed:reference`)
 *   2. `LearningCatalog_v2`     (reference; seeded from CSV via `npm run seed:reference`)
 *   3. `UserState`             (per-user plan, incl. Phase-B columns)
 *   4. `LearningPortalStatus`  (Feature 1: mimic'd portal source)
 *   5. `QuizResponses`         (Feature 2: full audit log of quiz attempts)
 *
 * It also adds the Phase-B columns (`ManagerName`, `ManagerEmail`, `LastSyncDate`,
 * `Milestone80Fired`, `Completion100Fired`) to `UserState` for the legacy case where
 * that list pre-existed without them.
 *
 * Idempotent — running it twice is a no-op (skips existing lists / columns).
 *
 * Usage: `npm run setup:sharepoint`
 */

import { configDotenv } from 'dotenv';
configDotenv();

import 'isomorphic-fetch';
import { acquireTokenViaDeviceCode, getGraphClient, getSiteId } from '../graph-service';
import { SP_CONFIG } from '../career-coach-types';

interface ColumnSpec {
    name: string;
    spec: Record<string, unknown>;
}

interface ListSpec {
    displayName: string;
    columns: ColumnSpec[];
}

// Column-type shortcuts (mirror the Graph columnDefinition schema).
const text = (): Record<string, unknown> => ({ text: {} });
const multilineText = (): Record<string, unknown> => ({
    text: { allowMultipleLines: true, appendChangesToExistingText: false, linesForEditing: 6, textType: 'plain' },
});
const dateTime = (): Record<string, unknown> => ({ dateTime: { format: 'dateTime', displayAs: 'default' } });
const number = (min: number, max?: number): Record<string, unknown> => ({
    number: { minimum: min, decimalPlaces: 'none', ...(typeof max === 'number' ? { maximum: max } : {}) },
});
const boolean = (): Record<string, unknown> => ({ boolean: {} });
const choice = (choices: string[]): Record<string, unknown> => ({
    choice: { choices, displayAs: 'dropDownMenu', allowTextEntry: false },
});

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

// Reference list: role → skill mapping (read-only at runtime; seeded from CSV).
const COMPETENCY_FRAMEWORK: ListSpec = {
    displayName: SP_CONFIG.lists.competencyFramework,
    columns: [
        { name: 'RoleId', spec: text() },
        { name: 'RoleTitle', spec: text() },
        { name: 'RoleLevel', spec: text() },
        { name: 'CompetencyId', spec: text() },
        { name: 'CompetencyName', spec: text() },
        { name: 'RequiredLevel', spec: number(0, 4) },
        { name: 'LevelDescription', spec: multilineText() },
        { name: 'Category', spec: text() },
    ],
};

// Reference list: courses mapped to skills (read-only at runtime; seeded from CSV).
const LEARNING_CATALOG: ListSpec = {
    displayName: SP_CONFIG.lists.learningCatalog,
    columns: [
        { name: 'CourseId', spec: text() },
        { name: 'Provider', spec: text() },
        { name: 'Format', spec: text() },
        { name: 'SkillIds', spec: text() },
        { name: 'FromLevel', spec: number(0, 4) },
        { name: 'ToLevel', spec: number(0, 4) },
        { name: 'URL', spec: text() },
        { name: 'Description', spec: multilineText() },
        { name: 'ResourceType', spec: text() },
    ],
};

// The living per-user plan (read/write). JSON columns are stored as multi-line text.
const USER_STATE: ListSpec = {
    displayName: SP_CONFIG.lists.userState,
    columns: [
        { name: 'UserAADId', spec: text() },
        { name: 'CurrentRole', spec: text() },
        { name: 'CurrentLevel', spec: text() },
        { name: 'TargetRole', spec: text() },
        { name: 'TargetRoleId', spec: text() },
        { name: 'TotalExperience', spec: text() },
        { name: 'OverallProgress', spec: number(0, 100) },
        { name: 'Goals', spec: multilineText() },
        { name: 'Skills', spec: multilineText() },
        { name: 'LearningProgress', spec: multilineText() },
        { name: 'ManagerAsks', spec: multilineText() },
        { name: 'PlanCreatedDate', spec: text() },
        { name: 'LastCheckIn', spec: text() },
        { name: 'ManagerName', spec: text() },
        { name: 'ManagerEmail', spec: text() },
        { name: 'LastSyncDate', spec: dateTime() },
        { name: 'Milestone80Fired', spec: boolean() },
        { name: 'Completion100Fired', spec: boolean() },
    ],
};

const LEARNING_PORTAL_STATUS: ListSpec = {
    displayName: SP_CONFIG.lists.learningPortalStatus,
    columns: [
        { name: 'UserAADId', spec: text() },
        { name: 'CourseId', spec: text() },
        { name: 'Status', spec: choice(['Not Started', 'In Progress', 'Complete']) },
        { name: 'PercentComplete', spec: number(0, 100) },
        { name: 'TimeSpentMinutes', spec: number(0) },
        { name: 'CompletedDate', spec: dateTime() },
        { name: 'LastUpdated', spec: dateTime() },
    ],
};

const QUIZ_RESPONSES: ListSpec = {
    displayName: SP_CONFIG.lists.quizResponses,
    columns: [
        { name: 'UserAADId', spec: text() },
        { name: 'CourseId', spec: text() },
        { name: 'SkillId', spec: text() },
        { name: 'AttemptDate', spec: dateTime() },
        { name: 'Score', spec: number(0, 5) },
        { name: 'Passed', spec: boolean() },
        { name: 'QuestionsJSON', spec: multilineText() },
    ],
};

const USER_STATE_NEW_COLUMNS: ColumnSpec[] = [
    { name: 'ManagerName', spec: text() },
    { name: 'ManagerEmail', spec: text() },
    { name: 'LastSyncDate', spec: dateTime() },
    { name: 'Milestone80Fired', spec: boolean() },
    { name: 'Completion100Fired', spec: boolean() },
];

// -----------------------------------------------------------------------------
// Provisioning logic
// -----------------------------------------------------------------------------

async function findListId(graph: ReturnType<typeof getGraphClient>, siteId: string, displayName: string): Promise<string | null> {
    const escaped = displayName.replace(/'/g, "''");
    const res = await graph
        .api(`/sites/${siteId}/lists?$filter=displayName eq '${escaped}'`)
        .get()
        .catch(() => ({ value: [] as any[] }));
    const items = (res?.value ?? []) as Array<{ id: string; displayName: string }>;
    return items[0]?.id ?? null;
}

async function createList(graph: ReturnType<typeof getGraphClient>, siteId: string, list: ListSpec): Promise<void> {
    const existing = await findListId(graph, siteId, list.displayName);
    if (existing) {
        console.log(`[setup] List "${list.displayName}" already exists (id=${existing}) — skipping.`);
        return;
    }
    console.log(`[setup] Creating list "${list.displayName}"…`);
    await graph.api(`/sites/${siteId}/lists`).post({
        displayName: list.displayName,
        list: { template: 'genericList' },
        columns: list.columns.map((c) => ({ name: c.name, ...c.spec })),
    });
    console.log(`[setup]   ✓ Created with ${list.columns.length} columns.`);
}

async function ensureColumn(
    graph: ReturnType<typeof getGraphClient>,
    siteId: string,
    listId: string,
    col: ColumnSpec,
): Promise<void> {
    // Check if the column already exists on the list.
    const existing = await graph
        .api(`/sites/${siteId}/lists/${listId}/columns?$select=id,name`)
        .get()
        .catch(() => ({ value: [] as any[] }));
    const names: string[] = ((existing?.value ?? []) as Array<{ name: string }>).map((c) => c.name);
    if (names.includes(col.name)) {
        console.log(`[setup]   • Column "${col.name}" already exists — skipping.`);
        return;
    }
    console.log(`[setup]   • Adding column "${col.name}"…`);
    await graph.api(`/sites/${siteId}/lists/${listId}/columns`).post({ name: col.name, ...col.spec });
}

async function main(): Promise<void> {
    console.log('[setup] Employee Career Coach — SharePoint provisioner');

    // 1. Interactive sign-in (populates the MSAL file cache for runtime).
    await acquireTokenViaDeviceCode();
    console.log('[setup] Sign-in complete. Token cache persisted to .mstoken-cache.json.\n');

    // 2. Resolve site.
    const siteId = await getSiteId();
    console.log(`[setup] Target site: ${SP_CONFIG.siteUrl}`);
    console.log(`[setup] Resolved siteId=${siteId}\n`);
    const graph = getGraphClient();

    // 3. Create the lists (idempotent — existing lists are skipped).
    //    Reference + UserState first so a brand-new tenant has the full schema; then the
    //    two Phase-B lists. On a tenant where the base lists already exist, these are no-ops.
    await createList(graph, siteId, COMPETENCY_FRAMEWORK);
    await createList(graph, siteId, LEARNING_CATALOG);
    await createList(graph, siteId, USER_STATE);
    await createList(graph, siteId, LEARNING_PORTAL_STATUS);
    await createList(graph, siteId, QUIZ_RESPONSES);

    // 4. Add new columns to UserState.
    //    Covers the legacy case where UserState pre-existed without the Phase-B columns.
    //    (For a freshly-created UserState above, these are already present and skipped.)
    const userStateListName = SP_CONFIG.lists.userState;
    const userStateListId = await findListId(graph, siteId, userStateListName);
    if (!userStateListId) {
        console.warn(
            `[setup] WARNING: UserState list "${userStateListName}" not found — skipping column additions. ` +
            `Verify SP_LIST_USER_STATE in .env matches your SharePoint list display name.`,
        );
    } else {
        console.log(`\n[setup] Adding new columns to "${userStateListName}" (id=${userStateListId})…`);
        for (const col of USER_STATE_NEW_COLUMNS) {
            await ensureColumn(graph, siteId, userStateListId, col);
        }
    }

    console.log('\n[setup] ✅ Done. All Phase A SharePoint schema is in place.');
}

main().catch((err) => {
    const msg = (err as any)?.message ?? String(err);
    const body = (err as any)?.body ?? '';
    console.error('\n[setup] ❌ FAILED:', msg);
    if (body) console.error('[setup]    body:', typeof body === 'string' ? body : JSON.stringify(body));
    process.exit(1);
});
