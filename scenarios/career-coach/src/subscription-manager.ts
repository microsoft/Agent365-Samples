// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Microsoft Graph change-notification subscription manager for the LearningPortalStatus list.
 *
 * Flow:
 *   1. On agent startup, `ensureSubscription()` is called.
 *      - If a subscription file exists AND the notificationUrl still matches AND the
 *        expiration is > 5 min away → PATCH to extend it.
 *      - Otherwise → DELETE the stale one (if any), then CREATE a fresh one.
 *   2. A background timer runs every 30 min and calls `renewSubscription()` so the sub
 *      never expires while the process is running.
 *   3. On graceful shutdown we DON'T delete the sub (Graph will time it out naturally in
 *      ~60 min if the agent stays down).
 *
 * Requires PORTAL_WEBHOOK_URL to be set in .env — this must be a publicly reachable HTTPS
 * URL (dev tunnel works). Graph will POST validation + notifications to it.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    createSubscription,
    deleteSubscription,
    getListIdByName,
    getSiteId,
    renewSubscription,
    listSubscriptions,
    type GraphSubscription,
} from './graph-service';
import { SP_CONFIG } from './career-coach-types';

const STATE_FILE = path.resolve(process.cwd(), '.sp-subscription.json');
const EXPIRATION_MINUTES = 60;
const RENEW_INTERVAL_MS = 30 * 60_000;

interface PersistedSub {
    subscriptionId: string;
    resource: string;
    notificationUrl: string;
    expirationDateTime: string;
}

function readState(): PersistedSub | null {
    try {
        if (!fs.existsSync(STATE_FILE)) return null;
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as PersistedSub;
    } catch (err) {
        console.warn('[sub-mgr] Failed to read state file:', (err as any)?.message ?? err);
        return null;
    }
}

function writeState(sub: PersistedSub): void {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(sub, null, 2), 'utf-8');
    } catch (err) {
        console.warn('[sub-mgr] Failed to write state file:', (err as any)?.message ?? err);
    }
}

let renewTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Ensures a Graph subscription exists for LearningPortalStatus targeting our notification URL.
 * Safe to call more than once (idempotent).
 */
export async function ensureSubscription(): Promise<GraphSubscription | null> {
    const notificationUrl = (process.env.PORTAL_WEBHOOK_URL || '').trim();
    const clientState = (process.env.PORTAL_EVENT_SECRET || '').trim();
    if (!notificationUrl) {
        console.warn('[sub-mgr] PORTAL_WEBHOOK_URL is empty in .env — skipping subscription. The manual POST path still works for testing.');
        return null;
    }
    if (!clientState) {
        console.warn('[sub-mgr] PORTAL_EVENT_SECRET is empty in .env — refusing to create a subscription without a clientState guard.');
        return null;
    }
    if (!notificationUrl.startsWith('https://')) {
        console.warn(`[sub-mgr] PORTAL_WEBHOOK_URL must be https (got: ${notificationUrl}). Graph rejects http.`);
        return null;
    }

    // Resolve site + list ids.
    const siteId = await getSiteId();
    const listName = SP_CONFIG.lists.learningPortalStatus;
    const listId = await getListIdByName(siteId, listName);
    if (!listId) {
        console.warn(`[sub-mgr] LearningPortalStatus list not found on the site (name="${listName}"). Run "npm run setup:sharepoint" first.`);
        return null;
    }
    const resource = `sites/${siteId}/lists/${listId}`;

    // 1) Try to renew an existing sub that matches this notificationUrl + resource.
    const persisted = readState();
    if (persisted && persisted.notificationUrl === notificationUrl && persisted.resource === resource) {
        try {
            const renewed = await renewSubscription(persisted.subscriptionId, EXPIRATION_MINUTES);
            writeState({
                subscriptionId: renewed.id,
                resource: renewed.resource,
                notificationUrl: renewed.notificationUrl,
                expirationDateTime: renewed.expirationDateTime,
            });
            console.log(`[sub-mgr] Renewed existing subscription (id=${renewed.id}), expires ${renewed.expirationDateTime}`);
            startRenewTimer();
            return renewed;
        } catch (err: any) {
            const code = err?.statusCode ?? err?.code ?? '';
            console.warn(`[sub-mgr] Renew failed (${code}). Will create a fresh subscription. Detail: ${err?.message ?? err}`);
            // Fall through to create-fresh path.
        }
    }

    // 2) Clean up any stale subs pointing at old tunnel URLs for the same resource (avoid orphans).
    // Scope deletions to subscriptions created by THIS sample via clientState.
    try {
        const all = await listSubscriptions();
        for (const s of all) {
            if (s.resource === resource && s.clientState === clientState) {
                console.log(`[sub-mgr] Deleting stale subscription id=${s.id} (was pointing at ${s.notificationUrl})`);
                await deleteSubscription(s.id).catch((e) => console.warn('  delete failed:', (e as any)?.message ?? e));
            }
        }
    } catch (err) {
        console.warn('[sub-mgr] Failed to enumerate existing subscriptions (continuing):', (err as any)?.message ?? err);
    }

    // 3) Create fresh. Graph will POST a validation handshake to notificationUrl and expects
    //    the response body to equal the ?validationToken=… query param, within ~10s.
    console.log(`[sub-mgr] Creating Graph subscription:`);
    console.log(`  resource:         ${resource}`);
    console.log(`  notificationUrl:  ${notificationUrl}`);
    console.log(`  expirationMin:    ${EXPIRATION_MINUTES}`);
    try {
        const fresh = await createSubscription({
            resource,
            notificationUrl,
            clientState,
            expirationMinutes: EXPIRATION_MINUTES,
            changeType: 'updated',
        });
        writeState({
            subscriptionId: fresh.id,
            resource: fresh.resource,
            notificationUrl: fresh.notificationUrl,
            expirationDateTime: fresh.expirationDateTime,
        });
        console.log(`[sub-mgr] ✓ Subscription created (id=${fresh.id}), expires ${fresh.expirationDateTime}`);
        startRenewTimer();
        return fresh;
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        console.error(`[sub-mgr] ✗ Failed to create subscription: ${msg}`);
        console.error('[sub-mgr]   Hint: make sure PORTAL_WEBHOOK_URL is reachable from the internet and the /api/portal-event route is running (Graph validates it during CREATE).');
        return null;
    }
}

function startRenewTimer(): void {
    if (renewTimer) return;
    renewTimer = setInterval(async () => {
        const persisted = readState();
        if (!persisted) return;
        try {
            const renewed = await renewSubscription(persisted.subscriptionId, EXPIRATION_MINUTES);
            writeState({
                subscriptionId: renewed.id,
                resource: renewed.resource,
                notificationUrl: renewed.notificationUrl,
                expirationDateTime: renewed.expirationDateTime,
            });
            console.log(`[sub-mgr] Auto-renewed subscription — new expiry ${renewed.expirationDateTime}`);
        } catch (err) {
            console.warn('[sub-mgr] Auto-renew failed (will retry on next tick):', (err as any)?.message ?? err);
        }
    }, RENEW_INTERVAL_MS);
}

export function stopRenewTimer(): void {
    if (renewTimer) {
        clearInterval(renewTimer);
        renewTimer = null;
    }
}
