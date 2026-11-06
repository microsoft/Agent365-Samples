// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TurnContext } from '@microsoft/agents-hosting';
import { getJiraMode } from '../config';
import { listTeamMembers, TeamMember } from './team-roster';

export function getCallerId(context: TurnContext): string {
    return context.activity.from?.aadObjectId?.trim()
        || (getJiraMode() === 'mock' && process.env.NODE_ENV === 'development'
            ? context.activity.from?.id?.trim() : '') || '';
}

export async function getScrumMaster(callerId: string): Promise<TeamMember | undefined> {
    if (!callerId) return undefined;
    return (await listTeamMembers()).find(member =>
        member.Role === 'SM' && member.AadObjectId.toLowerCase() === callerId.toLowerCase());
}

export async function requireScrumMaster(context: TurnContext): Promise<TeamMember | undefined> {
    const member = await getScrumMaster(getCallerId(context));
    if (!member) {
        console.warn('[authorization] Rejected an action requiring the configured Scrum Master.');
        await context.sendActivity('Only the configured Scrum Master can perform this action. No changes were made.');
    }
    return member;
}
