// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * The plan (planReview card) the agent last proposed in each email thread, so a later
 * "Save it" reply can save exactly that plan. Persisted to `.email-plans.json` so it
 * survives agent restarts. Entries are per thread + user and expire after 14 days.
 */

import { FileStorage } from './file-storage';
import type { CardPayload } from './cards';

type PlanReview = Extract<CardPayload, { type: 'planReview' }>;

interface PendingPlan {
    userAADId: string;
    review: PlanReview;
    proposedAt: number;
}

const TTL_MS = 14 * 24 * 60 * 60_000;
const storage = new FileStorage('.email-plans.json');

export async function putPendingPlan(threadKey: string, userAADId: string, review: PlanReview): Promise<void> {
    const entry: PendingPlan = { userAADId: userAADId.toLowerCase(), review, proposedAt: Date.now() };
    await storage.write({ [threadKey]: entry });
}

/** The pending plan for this thread, only if it was proposed to the same user and hasn't expired. */
export async function getPendingPlan(threadKey: string, userAADId: string): Promise<PlanReview | undefined> {
    const entry = (await storage.read([threadKey]))[threadKey] as PendingPlan | undefined;
    if (!entry || entry.userAADId !== userAADId.toLowerCase()) return undefined;
    if (Date.now() - entry.proposedAt > TTL_MS) {
        await storage.delete([threadKey]);
        return undefined;
    }
    return entry.review;
}

export async function clearPendingPlan(threadKey: string): Promise<void> {
    await storage.delete([threadKey]);
}
