// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * MVP 3 — Chase (blocker follow-through).
 *
 * Runs after the standup summary posts. For each open Blocker row created by
 * this standup:
 *   1. DM the blocker owner asking for what they need to unblock.
 *   2. DM the Scrum Master a blocker-escalation card with per-blocker actions.
 *
 * Card actions handled here:
 *   - `blocker.proposeSlots` → find 3 candidate 30-min slots via Graph
 *                              `/me/findMeetingTimes`, DM SM the slot picker.
 *   - `meeting.book`         → create the Outlook event; mark blocker `booked`.
 *   - `blocker.dismiss`      → mark blocker `resolved` (no further action).
 *   - `meeting.cancel`       → keep blocker open; no side effects.
 */

import { DateTime } from 'luxon';
import { Activity, ConversationReference } from '@microsoft/agents-activity';
import { TurnContext } from '@microsoft/agents-hosting';

import { getJiraClient } from '../services/jira';
import { listTeamMembers, TeamMember, getMemberByAadId } from '../services/team-roster';
import { sendProactive } from '../services/proactive';
import { findByField, findByTitle, updateItem } from '../services/sharepoint';
import { getScheduleConfig } from '../config';
import {
    buildBlockerEscalationCard,
} from '../cards/blocker-escalation.card';
import { buildMeetingProposeCard } from '../cards/meeting-propose.card';
import {
    Attendee,
    CalendarContext,
    createUnblockMeeting,
    findUnblockSlots,
} from '../services/calendar';
import { findHelperForBlocker, HelperMatch } from '../services/helperMatcher';
import { StandupSession } from '../services/session-store';
import { agentApplication } from '../agent';

// The static authHandlerName on the AgentApplication. Hardcoded here (not imported)
// to avoid a load-time circular reference chase.ts → agent.ts → chase.ts.
const AUTH_HANDLER = 'agentic';

interface BlockerFields {
    Title: string;
    StandupId: string;
    ReporterAadId: string;
    OwnerAadId: string;
    BlockerText: string;
    State: string;
    MeetingEventId?: string;
}

// --- entry point called from summarizeStandup ---------------------------

export async function chaseAfterStandup(session: StandupSession): Promise<void> {
    const openBlockers = await findByField<BlockerFields>('blockers', 'StandupId', session.standupId)
        .catch(() => []);
    const openOnly = openBlockers.filter(b => b.fields.State === 'open');
    if (openOnly.length === 0) {
        console.log(`[chase] ${session.standupId}: no open blockers.`);
        return;
    }

    const members = await listTeamMembers();
    const memberByAadId = new Map(members.map(m => [m.AadObjectId, m]));
    const sm = members.find(m => m.Role === 'SM');
    const jira = getJiraClient();

    for (const row of openOnly) {
        const b = row.fields;
        const issueKey = b.Title;
        const owner = memberByAadId.get(b.OwnerAadId);
        const reporter = memberByAadId.get(b.ReporterAadId);

        // Ping the owner (unless it's the same person who reported — no self-ping).
        if (owner?.conversationReference && b.OwnerAadId !== b.ReporterAadId) {
            await sendProactive(owner.conversationReference, async ctx => {
                await ctx.sendActivity(
                    `👋 Heads up — **${issueKey}** was flagged as blocked in today's standup:\n\n` +
                    `> ${b.BlockerText || '_(no detail provided)_'}\n\n` +
                    `Reply here with what you need to unblock, or the Scrum Master will schedule a sync.`,
                );
            });
        }

        // DM the SM the blocker card.
        if (!sm?.conversationReference) {
            console.warn('[chase] No SM conversation ref — skipping blocker card DM.');
            continue;
        }
        let issueSummary = issueKey;
        let issueStatus = 'Unknown';
        let issueUrl = '';
        try {
            const jiraIssue = await jira.getIssue(issueKey);
            issueSummary = jiraIssue.summary;
            issueStatus = jiraIssue.status;
            issueUrl = jiraIssue.url;
        } catch (e) {
            console.warn(`[chase] Could not fetch ${issueKey} for blocker card:`, (e as Error).message);
        }

        const card = buildBlockerEscalationCard({
            blockerId: row.id,
            issueKey,
            summary: issueSummary,
            url: issueUrl,
            status: issueStatus,
            sprintName: session.sprintName,
            ownerDisplayName: owner?.Title ?? b.OwnerAadId,
            reporterDisplayName: reporter?.Title ?? b.ReporterAadId,
            blockerText: b.BlockerText,
        });

        await sendProactive(sm.conversationReference, async ctx => {
            await ctx.sendActivity({ type: 'message', attachments: [card] } as Partial<Activity> as Activity);
        });
    }
    console.log(`[chase] ${session.standupId}: escalated ${openOnly.length} blocker(s) to SM.`);
}

// --- Adaptive Card submit handlers ---------------------------------------

export async function handleBlockerSubmit(context: TurnContext): Promise<void> {
    const value = context.activity.value as Record<string, unknown> | undefined;
    const action = String(value?.action ?? '');

    if (action === 'blocker.dismiss') {
        const blockerId = String(value?.blockerId ?? '');
        await updateBlockerState(blockerId, 'resolved');
        await context.sendActivity('Dismissed — marked as resolved.');
        return;
    }

    if (action === 'blocker.proposeSlots') {
        // Ack immediately so the card-submit invoke response beats Teams' ~15s timeout;
        // the Graph findMeetingTimes call + slot-picker card send run in background.
        await context.sendActivity('Looking up open slots…');
        const ref = context.activity.getConversationReference();
        const smAadId = context.activity.from?.aadObjectId ?? '';
        setImmediate(() => {
            proposeSlotsAsync(ref, value, smAadId).catch(err =>
                console.error('[chase] background proposeSlots failed:', (err as Error).message),
            );
        });
        return;
    }
}

export async function handleMeetingSubmit(context: TurnContext): Promise<void> {
    const value = context.activity.value as Record<string, unknown> | undefined;
    const action = String(value?.action ?? '');

    if (action === 'meeting.cancel') {
        await context.sendActivity('Meeting not booked — blocker still open.');
        return;
    }
    if (action !== 'meeting.book') return;

    const slotRaw = String(value?.slot ?? '');
    const [startIso, endIso] = slotRaw.split('|');
    if (!startIso || !endIso) {
        await context.sendActivity('No slot selected — aborting.');
        return;
    }

    // Ack immediately so Teams doesn't fire "Something went wrong" while we do the
    // Graph POST /events call; background task then reports back with the outcome.
    await context.sendActivity('Booking the meeting…');
    const ref = context.activity.getConversationReference();
    const smAadId = context.activity.from?.aadObjectId ?? '';
    setImmediate(() => {
        bookMeetingAsync(ref, value, smAadId).catch(err =>
            console.error('[chase] background book failed:', (err as Error).message),
        );
    });
}

async function bookMeetingAsync(
    ref: ConversationReference,
    value: Record<string, unknown> | undefined,
    smAadId: string,
): Promise<void> {
    const issueKey = String(value?.issueKey ?? '');
    const slotRaw = String(value?.slot ?? '');
    const [startIso, endIso] = slotRaw.split('|');

    const rows = await findByField<BlockerFields>('blockers', 'Title', issueKey);
    const b = rows[0]?.fields;
    if (!b) {
        await sendProactive(ref, async ctx => {
            await ctx.sendActivity(`Could not find blocker for ${issueKey} — aborting.`);
        });
        return;
    }
    const owner = await getMemberByAadId(b.OwnerAadId);
    const reporter = await getMemberByAadId(b.ReporterAadId);
    const sm = smAadId ? await getMemberByAadId(smAadId) : null;

    // Attendees: include the SM as an explicit attendee too, since the event is now
    // organised by the agent itself (mcp_CalendarTools → agent's mailbox). Dedup by
    // email inside createUnblockMeeting.
    const attendees: Attendee[] = [];
    if (owner?.Email) attendees.push({ email: owner.Email, displayName: owner.Title });
    if (reporter?.Email) attendees.push({ email: reporter.Email, displayName: reporter.Title });
    if (sm?.Email) attendees.push({ email: sm.Email, displayName: sm.Title });

    // Subject-matter helper — look up someone in the org who can actually help
    // resolve the blocker (e.g. an IT admin for a "PowerBI service account" ask).
    // Falls back to `null` when nothing matches, in which case we book the meeting
    // with just owner + reporter + SM (previous behaviour).
    const helper = await findHelperForBlocker(b.BlockerText).catch(err => {
        console.warn('[chase] helper match failed:', (err as Error).message);
        return null as HelperMatch | null;
    });
    if (helper) {
        attendees.push({ email: helper.email, displayName: helper.displayName });
        console.log(
            `[chase] Helper for ${issueKey}: ${helper.displayName} <${helper.email}> — ` +
            `topic="${helper.topic}" via ${helper.matchedBy} (${helper.reason})`,
        );
    }

    // Do the calendar work + follow-up message inside one proactive turn so the
    // MCP registration has a live TurnContext to authenticate against.
    await sendProactive(ref, async ctx => {
        const cc: CalendarContext = {
            turnContext: ctx,
            authorization: agentApplication.authorization,
            authHandlerName: AUTH_HANDLER,
        };
        try {
            const created = await createUnblockMeeting(cc, {
                subject: `Unblock ${issueKey}`,
                body: `Auto-booked by Scrum Master.<br/><br/>` +
                    `<b>Blocker:</b> ${b.BlockerText || '(no detail)'}`,
                startIso,
                endIso,
                attendees,
                timezone: getScheduleConfig().timezone,
            });
            await updateBlockerState(rows[0].id, 'booked', created.id);
            const stamp = DateTime.fromISO(startIso).setZone(getScheduleConfig().timezone).toFormat('ccc d LLL h:mm a');
            const parts: string[] = [];
            parts.push(`📅 Booked — **${issueKey}** unblock sync at **${stamp}**.`);
            parts.push(`[Open in Outlook](${created.webLink})`);
            if (created.onlineMeetingUrl) parts.push(`· [Join in Teams](${created.onlineMeetingUrl})`);
            if (created.attendeeCount != null) {
                parts.push(`· ${created.attendeeCount} attendee${created.attendeeCount === 1 ? '' : 's'} invited.`);
            }
            if (helper) {
                parts.push(
                    `\n\n_Included **${helper.displayName}** as subject-matter helper _` +
                    `_(topic: ${helper.topic})._`,
                );
            }
            await ctx.sendActivity(parts.join(' '));
        } catch (e) {
            console.error('[chase] createUnblockMeeting failed:', (e as Error).message);
            await ctx.sendActivity(
                `Sorry — couldn't book the meeting: ${(e as Error).message}. The blocker is still open.`,
            );
        }
    });
}

// --- helpers -------------------------------------------------------------

async function proposeSlotsAsync(
    ref: ConversationReference,
    value: Record<string, unknown> | undefined,
    smAadId: string,
): Promise<void> {
    const blockerId = String(value?.blockerId ?? '');
    const issueKey = String(value?.issueKey ?? '');
    const rows = await findByField<BlockerFields>('blockers', 'Title', issueKey);
    const b = rows[0]?.fields;
    if (!b) {
        await sendProactive(ref, async ctx => {
            await ctx.sendActivity(`Could not find blocker for ${issueKey}.`);
        });
        return;
    }

    const owner = await getMemberByAadId(b.OwnerAadId);
    const reporter = await getMemberByAadId(b.ReporterAadId);
    const sm = smAadId ? await getMemberByAadId(smAadId) : null;

    // Build attendee list (deduped later inside findUnblockSlots for display too).
    const attendees: Attendee[] = [];
    if (owner?.Email) attendees.push({ email: owner.Email, displayName: owner.Title });
    if (reporter?.Email) attendees.push({ email: reporter.Email, displayName: reporter.Title });
    if (sm?.Email) attendees.push({ email: sm.Email, displayName: sm.Title });

    // Subject-matter helper — see bookMeetingAsync for the rationale. When a match
    // exists we surface the helper on the slot-picker card too, so the SM has a
    // chance to sanity-check who the agent has decided to invite.
    const helper = await findHelperForBlocker(b.BlockerText).catch(err => {
        console.warn('[chase] helper match failed:', (err as Error).message);
        return null as HelperMatch | null;
    });
    if (helper) {
        attendees.push({ email: helper.email, displayName: helper.displayName });
        console.log(
            `[chase] Helper for ${issueKey}: ${helper.displayName} <${helper.email}> — ` +
            `topic="${helper.topic}" via ${helper.matchedBy}`,
        );
    }

    const durationMinutes = 30;
    // Do the calendar lookup + card send inside one proactive turn for MCP auth.
    await sendProactive(ref, async ctx => {
        const cc: CalendarContext = {
            turnContext: ctx,
            authorization: agentApplication.authorization,
            authHandlerName: AUTH_HANDLER,
        };
        const slots = await findUnblockSlots(cc, attendees, durationMinutes, getScheduleConfig().timezone);

        const attendeeNames = [
            owner?.Title ?? b.OwnerAadId,
            reporter?.Title ?? b.ReporterAadId,
            sm?.Title ?? 'Scrum Master',
        ];
        if (helper) attendeeNames.push(helper.displayName);

        const card = buildMeetingProposeCard({
            blockerId,
            issueKey,
            attendeeNames,
            durationMinutes,
            slots,
        });
        await ctx.sendActivity({ type: 'message', attachments: [card] } as Partial<Activity> as Activity);
    });
}

async function updateBlockerState(blockerId: string, state: string, meetingEventId?: string): Promise<void> {
    if (!blockerId) return;
    const row = await findByTitle<BlockerFields>('blockers', blockerId).catch(() => null);
    // blockerId is the SharePoint item id (numeric); findByTitle matches on Title (issueKey).
    // We need to update by item id directly.
    const patch: Partial<BlockerFields> = { State: state };
    if (meetingEventId) patch.MeetingEventId = meetingEventId;
    try {
        await updateItem<BlockerFields>('blockers', blockerId, patch);
    } catch (e) {
        // Fall back: if blockerId was actually a Title (issueKey), look up and update.
        if (row) await updateItem<BlockerFields>('blockers', row.id, patch);
        else throw e;
    }
}

// suppress unused-var warnings under strict TS
export type _KeepTypes = TeamMember;
