// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Local (in-process) cron scheduler for dev.
 *
 * When LOCAL_CRON=true (default in dev), spins up two node-cron jobs:
 *   - STANDUP_CRON  → calls the same triggerStandup() the HTTP endpoint uses
 *   - NIGHTLY_CRON  → runs warn + report checks
 *
 * The Azure Function projects under `azure-functions/` do the same thing when
 * the agent is deployed. Both are safe to fire simultaneously — session IDs
 * are idempotent (see session-store.makeStandupId).
 */

import * as cron from 'node-cron';

import { getScheduleConfig } from '../config';
import { triggerStandup } from '../handlers/standup';
import { runWarnCheck } from '../handlers/warn';
import { runSprintCloseReport } from '../handlers/report';

let started = false;

export function startLocalScheduler(): void {
    if (started) return;
    const cfg = getScheduleConfig();
    if (!cfg.localCron) {
        console.log('[cron] LOCAL_CRON=false — in-process scheduler NOT started.');
        return;
    }

    console.log(`[cron] Starting local scheduler in tz=${cfg.timezone}`);
    console.log(`[cron]   Standup: ${cfg.standupCron}`);
    console.log(`[cron]   Nightly: ${cfg.nightlyCron}`);

    cron.schedule(cfg.standupCron, async () => {
        console.log('[cron] Standup tick');
        try {
            await triggerStandup({ source: 'cron' });
        } catch (e) {
            console.error('[cron] Standup failed:', (e as Error).message);
        }
    }, { timezone: cfg.timezone });

    cron.schedule(cfg.nightlyCron, async () => {
        console.log('[cron] Nightly tick — warn + report');
        try { await runWarnCheck(); }
        catch (e) { console.error('[cron] warn failed:', (e as Error).message); }
        try { await runSprintCloseReport(); }
        catch (e) { console.error('[cron] report failed:', (e as Error).message); }
    }, { timezone: cfg.timezone });

    started = true;
}
