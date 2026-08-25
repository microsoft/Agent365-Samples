// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Team roster service.
 *
 * Wraps the SharePoint `TeamMembers` list and adds a small in-process cache
 * for `ConversationReference` values so proactive DMs during a standup don't
 * incur one SharePoint round-trip per member.
 *
 * A `ConversationReference` is the small JSON blob the Agents SDK needs in
 * order to send a proactive message to a user we've talked to before. We
 * capture and persist it every time a user interacts with the agent.
 */

import { TurnContext } from '@microsoft/agents-hosting';
import { ConversationReference } from '@microsoft/agents-activity';
import {
    createItem,
    findByField,
    listItems,
    ListItem,
    updateItem,
} from './sharepoint';

export interface TeamMemberFields {
    Title: string;                  // display name
    Email: string;
    AadObjectId: string;
    JiraAccountId: string;
    TimeZone: string;
    Role: 'Dev' | 'SM' | 'PM' | string;
    ConversationRef?: string;       // JSON-stringified ConversationReference
    LastSeenUtc?: string;
}

export interface TeamMember extends TeamMemberFields {
    itemId: string;
    conversationReference: Partial<ConversationReference> | null;
}

const cache = new Map<string, TeamMember>();   // AadObjectId -> member

function toDomain(item: ListItem<TeamMemberFields>): TeamMember {
    const f = item.fields;
    let convRef: Partial<ConversationReference> | null = null;
    if (f.ConversationRef) {
        try { convRef = JSON.parse(f.ConversationRef); } catch { convRef = null; }
    }
    return {
        itemId: item.id,
        Title: f.Title,
        Email: f.Email,
        AadObjectId: f.AadObjectId,
        JiraAccountId: f.JiraAccountId,
        TimeZone: f.TimeZone,
        Role: f.Role,
        ConversationRef: f.ConversationRef,
        LastSeenUtc: f.LastSeenUtc,
        conversationReference: convRef,
    };
}

export async function listTeamMembers(): Promise<TeamMember[]> {
    const items = await listItems<TeamMemberFields>('teamMembers');
    const members = items.map(toDomain);
    members.forEach(m => cache.set(m.AadObjectId, m));
    return members;
}

export async function getMemberByAadId(aadObjectId: string): Promise<TeamMember | null> {
    if (cache.has(aadObjectId)) return cache.get(aadObjectId)!;
    const items = await findByField<TeamMemberFields>('teamMembers', 'AadObjectId', aadObjectId);
    if (items.length === 0) return null;
    const member = toDomain(items[0]);
    cache.set(aadObjectId, member);
    return member;
}

export async function getMemberByJiraAccountId(jiraAccountId: string): Promise<TeamMember | null> {
    for (const m of cache.values()) if (m.JiraAccountId === jiraAccountId) return m;
    const items = await findByField<TeamMemberFields>('teamMembers', 'JiraAccountId', jiraAccountId);
    if (items.length === 0) return null;
    const member = toDomain(items[0]);
    cache.set(member.AadObjectId, member);
    return member;
}

/**
 * Called from every incoming activity to (a) create the TeamMembers row if it
 * doesn't exist yet, and (b) refresh the stored ConversationReference + LastSeen
 * so proactive messaging always uses the latest routing info.
 */
export async function upsertConversationReference(context: TurnContext): Promise<void> {
    const from = context.activity?.from;
    const aadId = from?.aadObjectId;
    if (!aadId) return; // no AAD id => nothing we can key on

    const convRef = context.activity.getConversationReference();
    const convRefJson = JSON.stringify(convRef);
    const nowIso = new Date().toISOString();

    const existing = await findByField<TeamMemberFields>('teamMembers', 'AadObjectId', aadId);
    if (existing.length > 0) {
        const patched = await updateItem<TeamMemberFields>('teamMembers', existing[0].id, {
            ConversationRef: convRefJson,
            LastSeenUtc: nowIso,
        });
        cache.set(aadId, toDomain(patched));
        return;
    }

    // Auto-provision a row for anyone the agent hasn't seen before. Jira mapping stays
    // empty — the SM (or the seed script) fills that in later.
    const created = await createItem<TeamMemberFields>('teamMembers', {
        Title: from?.name ?? aadId,
        Email: '',
        AadObjectId: aadId,
        JiraAccountId: '',
        TimeZone: '',
        Role: 'Dev',
        ConversationRef: convRefJson,
        LastSeenUtc: nowIso,
    });
    cache.set(aadId, toDomain(created));
    console.log(`[TeamRoster] Auto-provisioned new member row for ${from?.name ?? aadId}`);
}

/**
 * Reachable = we have a stored conversation reference we can DM through.
 * Unreachable members go into a distinct "Missed (never installed)" bucket
 * in the standup summary so the SM knows who still needs onboarding.
 */
export function isReachable(member: TeamMember): boolean {
    return !!member.conversationReference;
}
