// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Simulates the "learning portal" telemetry by inserting rows into the
 * LearningPortalStatus SharePoint list. Each row triggers a Graph change
 * notification which the running dev server catches at /api/portal-event
 * and turns into a proactive DM (Feature 1).
 *
 * Usage:
 *   npm run mark:complete -- <CourseId> [CourseId ...]
 *
 * Example (mark all 3 AI Engineering Fundamentals courses complete for the test user):
 *   npm run mark:complete -- CS007560 CS002198 CS003021
 *
 * If no CourseIds are provided, defaults to the three AI Engineering Fundamentals
 * courses used in the demo script.
 *
 * Set the target user's AAD object id via TEST_USER_AAD_ID before running:
 *   $env:TEST_USER_AAD_ID = "<guid>"; npm run mark:complete
 *
 * Uses the same MSAL device-code cache as setup:sharepoint / seed:reference.
 */

import { configDotenv } from 'dotenv';
configDotenv();

import 'isomorphic-fetch';
import { getGraphClient, getSiteId, getListIdByName } from '../graph-service';
import { SP_CONFIG } from '../career-coach-types';
import { getColumnMap, toInternalFields } from '../sharepoint-column-map';

const DEFAULT_COURSE_IDS = ['CS007560', 'CS002198', 'CS003021'];
const USER_AAD_ID = process.env.TEST_USER_AAD_ID || '00000000-0000-0000-0000-000000000000';
const USER_DISPLAY_NAME = process.env.TEST_USER_NAME || 'Test User';

// Minutes spent on each course when we synthesize a completion. Values chosen so
// the total sums to something plausible (~4 hours per course).
const TIME_SPENT_MINUTES = 240;

async function findCatalogTitle(graph: any, siteId: string, courseId: string): Promise<string | null> {
    const listId = await getListIdByName(siteId, SP_CONFIG.lists.learningCatalog);
    if (!listId) return null;
    // Filter server-side by CourseId when possible; fall back to client-side scan otherwise.
    const res: any = await graph.api(`/sites/${siteId}/lists/${listId}/items?$expand=fields&$top=200`).get();
    for (const item of (res?.value ?? [])) {
        const fields = item?.fields ?? {};
        if (String(fields.CourseId ?? '').trim() === courseId) {
            return String(fields.Title ?? '');
        }
    }
    return null;
}

async function main(): Promise<void> {
    const courseIds = process.argv.slice(2).filter((a) => a.trim().length > 0);
    const targets = courseIds.length > 0 ? courseIds : DEFAULT_COURSE_IDS;

    console.log('[mark-complete] Employee Career Coach — LearningPortalStatus writer');
    console.log(`[mark-complete] User:    ${USER_DISPLAY_NAME} (${USER_AAD_ID})`);
    console.log(`[mark-complete] Courses: ${targets.join(', ')}`);

    const siteId = await getSiteId();
    console.log(`[mark-complete] Site:    ${SP_CONFIG.siteUrl}`);
    const graph = getGraphClient();
    const listId = await getListIdByName(siteId, SP_CONFIG.lists.learningPortalStatus);
    if (!listId) {
        throw new Error(`List "${SP_CONFIG.lists.learningPortalStatus}" not found.`);
    }
    console.log(`[mark-complete] List:    ${SP_CONFIG.lists.learningPortalStatus} (${listId})\n`);

    const colMap = await getColumnMap(graph, siteId, listId);

    // ISO 8601 for date/dateTime columns.
    const now = new Date();
    const isoDate = now.toISOString().slice(0, 10);       // 2026-07-21
    const isoDateTime = now.toISOString();                // 2026-07-21T10:30:00.123Z

    let ok = 0, fail = 0;
    for (const courseId of targets) {
        const catalogTitle = await findCatalogTitle(graph, siteId, courseId);
        const title = catalogTitle ?? `Completion for ${courseId}`;
        const displayFields: Record<string, unknown> = {
            Title: title,
            UserAADId: USER_AAD_ID,
            CourseId: courseId,
            Status: 'Complete',
            PercentComplete: 100,
            TimeSpentMinutes: TIME_SPENT_MINUTES,
            CompletedDate: isoDateTime,
            LastUpdated: isoDateTime,
        };
        const internal = toInternalFields(displayFields, colMap);
        try {
            const created = await graph.api(`/sites/${siteId}/lists/${listId}/items`).post({ fields: internal });
            ok++;
            console.log(`[mark-complete] ✅ ${courseId} — "${title}" (itemId=${created.id})`);
        } catch (err: any) {
            fail++;
            console.error(`[mark-complete] ❌ ${courseId} — ${err?.message ?? err}`);
            if (err?.body) console.error(`[mark-complete]    Graph body: ${typeof err.body === 'string' ? err.body : JSON.stringify(err.body)}`);
        }
    }

    console.log(`\n[mark-complete] Done: ${ok} inserted, ${fail} failed.`);
    if (ok > 0) {
        console.log('[mark-complete] The Graph change-notification subscription should fire within');
        console.log('[mark-complete] ~30 seconds → dev server POSTs a proactive DM to the user.');
    }
}

main().catch((err) => {
    console.error('\n[mark-complete] FAILED:', (err as any)?.message ?? err);
    process.exit(1);
});
