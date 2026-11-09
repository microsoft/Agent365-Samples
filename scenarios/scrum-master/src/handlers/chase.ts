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
import { randomUUID } from 'crypto';
import { Activity, ConversationReference } from '@microsoft/agents-activity';
import { TurnContext } from '@microsoft/agents-hosting';

import { getJiraClient } from '../services/jira';
import { listTeamMembers, TeamMember, getMemberByAadId } from '../services/team-roster';
import { sendProactive } from '../services/proactive';
import { findByField, updateItem, claimItemState } from '../services/sharepoint';
import { getScheduleConfig, getJiraMode } from '../config';
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
import { getScrumMaster, requireScrumMaster } from '../services/authorization';

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

interface MeetingProposal {
    blockerId: string;
    issueKey: string;
    approverAadId: string;
    expiresAt: number;
    slots: Set<string>;
}

const meetingProposals = new Map<string, MeetingProposal>();

function pruneMeetingProposals(): void {
    for (const [id, proposal] of meetingProposals) {
        if (proposal.expiresAt <= Date.now()) meetingProposals.delete(id);
    }
}

function getMeetingProposal(proposalId: string, callerId: string): MeetingProposal | undefined {
    pruneMeetingProposals();
    const proposal = meetingProposals.get(proposalId);
    return proposal?.approverAadId.toLowerCase() === callerId.toLowerCase() ? proposal : undefined;
}

async function findBlocker(blockerId: string, issueKey: string) {
    const rows = await findByField<BlockerFields>('blockers', 'Title', issueKey);
    return rows.find(row => row.id === blockerId && row.fields.Title === issueKey);
}

// --- entry point called from summarizeStandup ---------------------------

export async function chaseAfterStandup(session: StandupSession): Promise<void> {
    const openBlockers = await findByField<BlockerFields>('blockers', 'StandupId', session.standupId);
    const openOnly = openBlockers.filter(b => b.fields.State === 'open');
    if (openOnly.length === 0) {
        console.log(`[chase] ${session.standupId}: no open blockers.`);
        return;
    }

    const members = await listTeamMembers();
    const memberByAadId = new Map(members.map(m => [m.AadObjectId, m]));
    const sm = members.find(m => m.Role === 'SM');
    const jira = getJiraClient();
    const delivered = session.chaseNotifications ??= new Set<string>();

    for (const row of openOnly) {
        const b = row.fields;
        const issueKey = b.Title;
        const owner = memberByAadId.get(b.OwnerAadId);
        const reporter = memberByAadId.get(b.ReporterAadId);

        // Ping the owner (unless it's the same person who reported — no self-ping).
        if (owner?.conversationReference && b.OwnerAadId !== b.ReporterAadId && !delivered.has(`owner:${row.id}`)) {
            const result = await sendProactive(owner.conversationReference, async ctx => {
                await ctx.sendActivity(
                    `👋 Heads up — **${issueKey}** was flagged as blocked in today's standup:\n\n` +
                    `> ${b.BlockerText || '_(no detail provided)_'}\n\n` +
                    `Reply here with what you need to unblock, or the Scrum Master will schedule a sync.`,
                );
            });
            if (!result.ok) throw new Error(`Blocker owner notification failed: ${result.error ?? row.id}`);
            delivered.add(`owner:${row.id}`);
        }

        // DM the SM the blocker card.
        if (!sm?.conversationReference) {
            throw new Error('No SM conversation reference; blocker escalation remains pending.');
        }
        if (delivered.has(`sm:${row.id}`)) continue;
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

        const result = await sendProactive(sm.conversationReference, async ctx => {
            await ctx.sendActivity({ type: 'message', attachments: [card] } as Partial<Activity> as Activity);
        });
        if (!result.ok) throw new Error(`Blocker escalation delivery failed: ${result.error ?? row.id}`);
        delivered.add(`sm:${row.id}`);
    }
    console.log(`[chase] ${session.standupId}: escalated ${openOnly.length} blocker(s) to SM.`);
}

// --- Adaptive Card submit handlers ---------------------------------------

export async function handleBlockerSubmit(context: TurnContext): Promise<void> {
    const value = context.activity.value as Record<string, unknown> | undefined;
    const action = String(value?.action ?? '');
    if (action !== 'blocker.dismiss' && action !== 'blocker.proposeSlots') return;
    const sm = await requireScrumMaster(context);
    if (!sm) return;
    const row = await findBlocker(String(value?.blockerId ?? ''), String(value?.issueKey ?? ''));
    if (!row || row.fields.State !== 'open' || row.fields.MeetingEventId) {
        console.warn('[chase] Rejected an unknown or inactive blocker action.');
        await context.sendActivity('This blocker is unavailable or no longer open. No changes were made.');
        return;
    }

    if (action === 'blocker.dismiss') {
        const claimed = await claimItemState('blockers', row.id, 'open', 'resolved');
        await context.sendActivity(claimed ? 'Dismissed — marked as resolved.' : 'The blocker changed; no changes were made.');
        return;
    }

    if (action === 'blocker.proposeSlots') {
        // Ack immediately so the card-submit invoke response beats Teams' ~15s timeout;
        // the Graph findMeetingTimes call + slot-picker card send run in background.
        await context.sendActivity('Looking up open slots…');
        const ref = context.activity.getConversationReference();
        const smAadId = sm.AadObjectId;
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
    if (action !== 'meeting.cancel' && action !== 'meeting.book') return;
    const sm = await requireScrumMaster(context);
    if (!sm) return;
    const proposalId = String(value?.proposalId ?? '');
    const proposal = getMeetingProposal(proposalId, sm.AadObjectId);
    if (!proposal) {
        console.warn('[chase] Rejected an unknown, expired, or unauthorized meeting proposal.');
        await context.sendActivity('This meeting proposal is unavailable. Request new slots; no meeting was booked.');
        return;
    }

    if (action === 'meeting.cancel') {
        meetingProposals.delete(proposalId);
        await context.sendActivity('Meeting not booked — blocker still open.');
        return;
    }
    if (action !== 'meeting.book') return;
    if (getJiraMode() === 'mock') {
        await context.sendActivity('Offline demo: no calendar invitation was created. Use JIRA_MODE=live to book meetings.');
        return;
    }

    const slotRaw = String(value?.slot ?? '');
    if (!proposal.slots.has(slotRaw)) {
        console.warn('[chase] Rejected a slot outside the server-side meeting proposal.');
        await context.sendActivity('Select one of the offered slots. No meeting was booked.');
        return;
    }
    meetingProposals.delete(proposalId);

    // Ack immediately so Teams doesn't fire "Something went wrong" while we do the
    // Graph POST /events call; background task then reports back with the outcome.
    await context.sendActivity('Booking the meeting…');
    const ref = context.activity.getConversationReference();
    setImmediate(() => {
        bookMeetingAsync(ref, proposal, slotRaw, sm.AadObjectId).catch(err =>
            console.error('[chase] background book failed:', (err as Error).message),
        );
    });
}

async function bookMeetingAsync(
    ref: ConversationReference,
    proposal: MeetingProposal,
    slotRaw: string,
    smAadId: string,
): Promise<void> {
    const sm = await getScrumMaster(smAadId);
    if (!sm) {
        console.warn('[chase] Meeting approver is no longer the configured Scrum Master.');
        await sendProactive(ref, async ctx => {
            await ctx.sendActivity('Meeting authorization is no longer valid. No meeting was booked.');
        });
        return;
    }
    const { issueKey, blockerId } = proposal;
    const [startIso, endIso] = slotRaw.split('|');
    if (!blockerId || !Number.isFinite(Date.parse(startIso)) ||
        !Number.isFinite(Date.parse(endIso)) || Date.parse(endIso) <= Date.parse(startIso)) return;

    const row = await findBlocker(blockerId, issueKey);
    const b = row?.fields;
    if (!b || !row) {
        await sendProactive(ref, async ctx => {
            await ctx.sendActivity(`Could not find blocker for ${issueKey} — aborting.`);
        });
        return;
    }
    if (b.State !== 'open' || b.MeetingEventId) {
        await sendProactive(ref, async ctx => {
            const eventId = b.MeetingEventId?.trim();
            const encodedId = eventId ? encodeURIComponent(eventId).replace(/[!'()*]/g,
                char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`) : '';
            const existing = encodedId
                ? ` [Open existing event in Outlook](https://outlook.office.com/calendar/item/${encodedId})`
                : '';
            await ctx.sendActivity(`Blocker ${issueKey} is already ${b.State}; no additional meeting was created.${existing}`);
        });
        return;
    }
    const owner = await getMemberByAadId(b.OwnerAadId);
    const reporter = await getMemberByAadId(b.ReporterAadId);

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

    if (!await claimItemState('blockers', row.id, 'open', 'booking')) return;
    let calendarAttempted = false;
    let meetingRecorded = false;
    // Do the calendar work + follow-up message inside one proactive turn so the
    // MCP registration has a live TurnContext to authenticate against.
    await sendProactive(ref, async ctx => {
        const cc: CalendarContext = {
            turnContext: ctx,
            authorization: agentApplication.authorization,
            authHandlerName: AUTH_HANDLER,
        };
        try {
            calendarAttempted = true;
            const created = await createUnblockMeeting(cc, {
                subject: `Unblock ${issueKey}`,
                body: `Auto-booked by Scrum Master.<br/><br/>` +
                    `<b>Blocker:</b> ${b.BlockerText || '(no detail)'}`,
                startIso,
                endIso,
                attendees,
                timezone: getScheduleConfig().timezone,
            });
            await updateBlockerState(row.id, 'booked', created.id);
            meetingRecorded = true;
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
            if (meetingRecorded) throw e; // A failed confirmation must not undo the booking.
            console.error('[chase] createUnblockMeeting failed:', (e as Error).message);
            const msg = (e as Error).message;
            if (msg.startsWith('CALENDAR_VERIFY_FAILED')) {
                await updateBlockerState(row.id, 'booked');
                await ctx.sendActivity(
                    `⚠️ Calendar tool returned a garbled response for **${issueKey}**. ` +
                    `The meeting was most likely created — please check Outlook to confirm. ` +
                    `Blocker marked as booked so future flows don't re-trigger.`,
                );
            } else {
                await ctx.sendActivity(
                    `Booking could not be confirmed: ${msg}. Check Outlook before retrying; the booking claim is retained to prevent duplicate invitations.`,
                );
            }
        }
    }).finally(async () => {
        if (!calendarAttempted) await claimItemState('blockers', row.id, 'booking', 'open');
    });
}

// --- helpers -------------------------------------------------------------

async function proposeSlotsAsync(
    ref: ConversationReference,
    value: Record<string, unknown> | undefined,
    smAadId: string,
): Promise<void> {
    const sm = await getScrumMaster(smAadId);
    if (!sm) {
        console.warn('[chase] Slot requester is no longer the configured Scrum Master.');
        await sendProactive(ref, async ctx => {
            await ctx.sendActivity('Meeting authorization is no longer valid. No slots were proposed.');
        });
        return;
    }
    if (getJiraMode() === 'mock') {
        await sendProactive(ref, async ctx => {
            await ctx.sendActivity('Offline demo: meeting-slot lookup is disabled; no Graph or Calendar request was made.');
        });
        return;
    }
    const blockerId = String(value?.blockerId ?? '');
    const issueKey = String(value?.issueKey ?? '');
    const row = await findBlocker(blockerId, issueKey);
    const b = row?.fields;
    if (!b || b.State !== 'open' || b.MeetingEventId) {
        await sendProactive(ref, async ctx => {
            await ctx.sendActivity(`Could not find blocker for ${issueKey}.`);
        });
        return;
    }

    const owner = await getMemberByAadId(b.OwnerAadId);
    const reporter = await getMemberByAadId(b.ReporterAadId);

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
        const allowedSlots = slots.filter(slot => Number.isFinite(Date.parse(slot.startIso)) &&
            Date.parse(slot.endIso) > Date.parse(slot.startIso));
        if (!allowedSlots.length) {
            await ctx.sendActivity('No valid meeting slots were found. No meeting was booked.');
            return;
        }

        const attendeeNames = [
            owner?.Title ?? b.OwnerAadId,
            reporter?.Title ?? b.ReporterAadId,
            sm?.Title ?? 'Scrum Master',
        ];
        if (helper) attendeeNames.push(helper.displayName);

        const proposalId = randomUUID();
        pruneMeetingProposals();
        meetingProposals.set(proposalId, {
            blockerId, issueKey, approverAadId: smAadId,
            expiresAt: Date.now() + 30 * 60_000,
            slots: new Set(allowedSlots.map(slot => `${slot.startIso}|${slot.endIso}`)),
        });
        const card = buildMeetingProposeCard({
            proposalId,
            issueKey,
            attendeeNames,
            durationMinutes,
            slots: allowedSlots,
        });
        try {
            await ctx.sendActivity({ type: 'message', attachments: [card] } as Partial<Activity> as Activity);
        } catch (error) {
            meetingProposals.delete(proposalId);
            throw error;
        }
    });
}

async function updateBlockerState(blockerId: string, state: string, meetingEventId?: string): Promise<void> {
    const patch: Partial<BlockerFields> = { State: state };
    if (meetingEventId) patch.MeetingEventId = meetingEventId;
    await updateItem<BlockerFields>('blockers', blockerId, patch);
}

// suppress unused-var warnings under strict TS
export type _KeepTypes = TeamMember;
