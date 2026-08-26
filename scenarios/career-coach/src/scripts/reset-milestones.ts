// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Flip Milestone80Fired and/or Completion100Fired back to false so the corresponding
 * cascade card can re-fire on the next progress sync. Useful when a Feature 4 email
 * delivery failed and you want to retry it, or when demo'ing the milestone card twice.
 *
 * Usage:
 *   npm run reset:milestones -- <UserAADId>              # reset both flags
 *   npm run reset:milestones -- <UserAADId> milestone80  # reset only 80% guard
 *   npm run reset:milestones -- <UserAADId> completion100 # reset only 100% guard
 */

import { configDotenv } from 'dotenv';
configDotenv();

import 'isomorphic-fetch';
import { getGraphClient } from '../graph-service';
import { readUserState, upsertUserState } from '../career-coach-service';

async function main(): Promise<void> {
    const userAADId = (process.argv[2] || '').trim();
    const which = (process.argv[3] || '').toLowerCase();
    if (!userAADId) {
        console.error('Usage: npm run reset:milestones -- <UserAADId> [milestone80|completion100]');
        process.exit(2);
    }
    const graph = getGraphClient();
    const rec = await readUserState(graph, userAADId);
    if (!rec) {
        console.error(`[reset:milestones] No UserState row found for ${userAADId}`);
        process.exit(3);
    }
    const before = { m80: rec.state.Milestone80Fired, c100: rec.state.Completion100Fired };
    const nextState = {
        ...rec.state,
        Milestone80Fired: which && which !== 'milestone80' ? rec.state.Milestone80Fired : false,
        Completion100Fired: which && which !== 'completion100' ? rec.state.Completion100Fired : false,
    };
    await upsertUserState(graph, nextState, rec);
    console.log('[reset:milestones] Before:', before);
    console.log('[reset:milestones] After :', { m80: nextState.Milestone80Fired, c100: nextState.Completion100Fired });
    console.log('[reset:milestones] ✅ Done. Say "check my progress" in Teams to re-fire.');
}

main().catch((err) => {
    console.error('[reset:milestones] ❌ FAILED:', (err as any)?.message ?? err);
    process.exit(1);
});
