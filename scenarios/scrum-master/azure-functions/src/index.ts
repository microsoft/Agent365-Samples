// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Registers Azure Functions v4 (programming model) triggers for the Scrum
 * Master Assistant. Both timers do the same thing: POST to an internal HTTP
 * endpoint on the running agent so that the agent (which owns all state,
 * tokens, and Adaptive Card knowledge) does the work.
 *
 * Env vars:
 *   AGENT_CALLBACK_URL     — base URL of the agent (e.g. dev tunnel)
 *   INTERNAL_TRIGGER_TOKEN — shared secret guarding the internal endpoints
 */

import { app, InvocationContext, Timer } from '@azure/functions';
import axios from 'axios';

function agentUrl(path: string): string {
    const base = (process.env.AGENT_CALLBACK_URL ?? '').replace(/\/$/, '');
    if (!base) throw new Error('AGENT_CALLBACK_URL is not set.');
    return `${base}${path}`;
}

function headers(): Record<string, string> {
    const token = process.env.INTERNAL_TRIGGER_TOKEN ?? '';
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (token) h['x-internal-token'] = token;
    return h;
}

// 09:00 Asia/Kolkata Mon–Fri = 03:30 UTC Mon–Fri.
// NCRONTAB is 6-field including seconds.
app.timer('StandupTimer', {
    schedule: '0 30 3 * * 1-5',
    handler: async (myTimer: Timer, context: InvocationContext) => {
        context.log('[StandupTimer] tick', { pastDue: myTimer.isPastDue });
        try {
            const res = await axios.post(agentUrl('/api/internal/standup-trigger'), {}, {
                headers: headers(), timeout: 60_000,
            });
            context.log('[StandupTimer] agent responded:', res.status, res.data);
        } catch (e) {
            context.error('[StandupTimer] call failed:', (e as Error).message);
            throw e; // let Functions retry per host.json rules
        }
    },
});

// 00:30 Asia/Kolkata daily = 19:00 UTC daily.
app.timer('NightlyTimer', {
    schedule: '0 0 19 * * *',
    handler: async (myTimer: Timer, context: InvocationContext) => {
        context.log('[NightlyTimer] tick', { pastDue: myTimer.isPastDue });
        try {
            const res = await axios.post(agentUrl('/api/internal/nightly-check'), {}, {
                headers: headers(), timeout: 120_000,
            });
            context.log('[NightlyTimer] agent responded:', res.status, res.data);
        } catch (e) {
            context.error('[NightlyTimer] call failed:', (e as Error).message);
            throw e;
        }
    },
});
