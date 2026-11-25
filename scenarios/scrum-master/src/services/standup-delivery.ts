// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from 'zod';
import { claimItemState, createItem, findByTitle, updateItem } from './sharepoint';

const issueSchema = z.object({
    id: z.string(), key: z.string(), summary: z.string(), status: z.string(),
    statusCategory: z.string(),
    assignee: z.object({
        accountId: z.string(), displayName: z.string(), emailAddress: z.string().optional(),
    }).nullable(),
    storyPoints: z.number().nullable(), url: z.string(), sprintId: z.number().nullable(),
    dueDate: z.string().nullable(), parentKey: z.string().nullable(), issueType: z.string(),
});

export const standupSnapshotSchema = z.object({
    sprintName: z.string(),
    itemsByAssignee: z.array(z.tuple([z.string(), z.array(issueSchema)])),
    unreachable: z.array(z.string()),
});

export const standupResponsesSchema = z.array(z.object({
    issueKey: z.string(), update: z.string(), hasBlocker: z.boolean(),
    blockerText: z.string().optional(),
}));

interface DeliveryFields {
    Title: string;
    DeliveryKey: string;
    StandupId: string;
    UserAadId: string;
    State: string;
    DeliveredUtc?: string;
}

/** A claimed/uncertain send is never replayed without operator verification. */
export async function deliverStandupRequest(
    standupId: string,
    userAadId: string,
    send: (started: () => void, rejected: () => void) => Promise<{ ok: boolean; error?: string }>,
): Promise<void> {
    const key = `${standupId}#${userAadId}`;
    let row = await findByTitle<DeliveryFields>('standupDeliveries', key);
    if (!row) {
        try {
            row = await createItem<DeliveryFields>('standupDeliveries', {
                Title: key, DeliveryKey: key, StandupId: standupId, UserAadId: userAadId, State: 'pending',
            });
        } catch (error) {
            row = await findByTitle<DeliveryFields>('standupDeliveries', key);
            if (!row) throw error;
        }
    }
    if (row.fields.State === 'sent') return;
    if (row.fields.State !== 'pending' ||
        !await claimItemState('standupDeliveries', row.id, 'pending', 'claimed')) {
        throw new Error(`Standup ${standupId} delivery to ${userAadId} is claimed or uncertain. Inspect Teams and SMA_StandupDeliveries before recovery.`);
    }
    let sendStarted = false;
    let confirmedRejection = false;
    let failure: string;
    try {
        const result = await send(() => { sendStarted = true; }, () => { confirmedRejection = true; });
        if (result.ok) {
            // If persistence fails after acceptance, leave the durable claim intact.
            await updateItem<DeliveryFields>('standupDeliveries', row.id, {
                State: 'sent', DeliveredUtc: new Date().toISOString(),
            });
            return;
        }
        failure = result.error ?? 'send failed';
    } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
    }
    const uncertain = sendStarted && !confirmedRejection;
    await updateItem<DeliveryFields>('standupDeliveries', row.id, { State: uncertain ? 'uncertain' : 'pending' });
    throw new Error(`Standup ${standupId} delivery to ${userAadId} ${uncertain ? 'is uncertain; inspect Teams before recovery' : 'failed; retry will resume this member'}: ${failure}`);
}
