// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Flip Milestone80Fired and/or Completion100Fired back to false so the corresponding
 * cascade card can re-fire on the next progress sync. Useful when a Feature 4 email
 * delivery failed and you want to retry it, or when demo'ing the milestone card twice.
 *
 * Usage:
 *   npm run reset:milestones                              # both flags, user from TEST_USER_AAD_ID
 *   npm run reset:milestones -- <UserAADId>              # reset both flags
 *   npm run reset:milestones -- <UserAADId> milestone80  # reset only 80% guard
 *   npm run reset:milestones -- <UserAADId> completion100 # reset only 100% guard
 *
 * With no UserAADId, TEST_USER_AAD_ID from .env is used (a first argument of milestone80 or
 * completion100 is read as the flag, not the user).
 */

import { configDotenv } from 'dotenv';
configDotenv();

import 'isomorphic-fetch';
import { getGraphClient } from '../graph-service';
import { readUserState, readPreviousPlans, upsertUserState } from '../career-coach-service';

async function main(): Promise<void> {
    const args = process.argv.slice(2).map((a) => a.trim()).filter(Boolean);
    const isFlag = (a?: string) => a === 'milestone80' || a === 'completion100';
    const flagFirst = isFlag(args[0]?.toLowerCase());
    const userAADId = (flagFirst ? '' : args[0] || '') || (process.env.TEST_USER_AAD_ID || '').trim();
    const which = ((flagFirst ? args[0] : args[1]) || '').toLowerCase();
    if (!userAADId) {
        console.error('Usage: npm run reset:milestones -- [<UserAADId>] [milestone80|completion100]   (defaults to TEST_USER_AAD_ID)');
        process.exit(2);
    }
    const graph = getGraphClient();
    // Resetting the 100% guard reopens the latest Completed goal when there's no active one.
    let rec = await readUserState(graph, userAADId);
    if (!rec && which !== 'milestone80') {
        rec = (await readPreviousPlans(graph, userAADId)).find((p) => p.state.PlanStatus === 'Completed') ?? null;
        if (rec) console.log(`[reset:milestones] No active goal — reopening completed "${rec.state.TargetRole}" goal.`);
    }
    if (!rec) {
        console.error(`[reset:milestones] No UserState row found for ${userAADId}`);
        process.exit(3);
    }
    const resetCompletion = !which || which === 'completion100';
    const before = { m80: rec.state.Milestone80Fired, c100: rec.state.Completion100Fired, status: rec.state.PlanStatus };
    const nextState = {
        ...rec.state,
        Milestone80Fired: which && which !== 'milestone80' ? rec.state.Milestone80Fired : false,
        Completion100Fired: resetCompletion ? false : rec.state.Completion100Fired,
        PlanStatus: resetCompletion ? 'Active' as const : rec.state.PlanStatus,
        PlanCompletedDate: resetCompletion ? '' : rec.state.PlanCompletedDate,
    };
    await upsertUserState(graph, nextState, rec);
    console.log('[reset:milestones] Before:', before);
    console.log('[reset:milestones] After :', { m80: nextState.Milestone80Fired, c100: nextState.Completion100Fired, status: nextState.PlanStatus });
    console.log('[reset:milestones] ✅ Done. Say "check my progress" in Teams to re-fire.');
}

main().catch((err) => {
    console.error('[reset:milestones] ❌ FAILED:', (err as any)?.message ?? err);
    process.exit(1);
});
