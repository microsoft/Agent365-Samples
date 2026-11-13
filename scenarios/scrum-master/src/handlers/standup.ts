// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Standup handler — Phase 1 implementation.
 *
 * End-to-end async standup:
 *   triggerStandup()
 *     └─ pulls active sprint + issues from Jira
 *     └─ groups by assignee, resolves to team members
 *     └─ persists StandupSessions row + StandupResponses expectations
 *     └─ proactively DMs each reachable member a request card
 *
 *   handleStandupSubmit(context)
 *     └─ validates & parses card payload
 *     └─ acks recording before deferring persistence and blocker writes
 *     └─ sends the "submitted" card proactively after recording succeeds
 *     └─ if all responded, immediately summarizes
 *
 *   summarizeStandup(session)
 *     └─ builds Card 2 and posts to the configured Teams channel
 *     └─ updates session state; Reconcile / Chase (Phase 2) fire off this event
 */

import { TurnContext } from '@microsoft/agents-hosting';
import { Activity } from '@microsoft/agents-activity';
import { DateTime } from 'luxon';

import {
    createItem,
    claimStandupSession,
    claimStandupResponse,
    findByField,
    findByTitle,
    updateItem,
} from '../services/sharepoint';
import { getJiraClient, JiraIssue } from '../services/jira';
import {
    listTeamMembers,
    TeamMember,
    isReachable,
    upsertConversationReference,
} from '../services/team-roster';
import {
    StandupSession,
    StandupItemResponse,
    StandupResponse,
    makeStandupId,
    todayKey,
    getSession,
    upsertSession,
    completeSession,
    getCompletedSession,
    claimSessionFinalization,
    reserveSessionSubmission,
    waitForSessionSubmissions,
    waitForResponderSubmission,
    allExpectedResponded,
} from '../services/session-store';
import { getJiraMode, getScheduleConfig } from '../config';
import { sendProactive } from '../services/proactive';
import {
    buildStandupRequestCard,
    buildStandupSubmittedCard,
} from '../cards/standup-request.card';
import {
    buildStandupSummaryCard,
    StandupSummaryBlocker,
    StandupSummaryMissed,
    StandupSummaryPerson,
    StandupSummaryUpdateItem,
} from '../cards/standup-summary.card';

// --- SharePoint field shapes for the lists we touch here -----------------

interface StandupSessionFields {
    Title: string; SprintId: string; StartedUtc: string; CutoffUtc: string;
    State: 'open' | 'summarized' | 'archived'; ExpectedResponders: string;
    InitiatedByAadId: string;
}
interface StandupResponseFields {
    Title: string; StandupId: string; UserAadId: string;
    SubmittedUtc: string; Items: string;
}
interface BlockerFields {
    Title: string; StandupId: string; ReporterAadId: string; OwnerAadId: string;
    BlockerText: string; State: string; MeetingEventId?: string;
}
interface TeamsConfigFields {
    Title: string; TeamId: string; ChannelId: string; ConversationRef: string;
    ConfiguredByAadId: string; ConfiguredAtUtc: string;
}

// --- triggerStandup ------------------------------------------------------

interface StandupTriggerOptions {
    initiatedByAadId?: string;
    turnContext?: TurnContext;
    source: 'command' | 'cron' | 'http';
    retryStandupId?: string;
}
interface StandupTriggerResult {
    standupId: string; sentTo: number; skipped: number; note?: string;
}

let pendingTrigger: Promise<StandupTriggerResult> | undefined;
const mockTurnContexts = new Map<string, TurnContext>();

async function deliverStandup(
    standupId: string,
    reference: NonNullable<TeamMember['conversationReference']>,
    logic: (context: TurnContext) => Promise<void>,
): Promise<{ ok: boolean; error?: string }> {
    const context = getJiraMode() === 'mock' ? mockTurnContexts.get(standupId) : undefined;
    if (context && reference.conversation?.id === context.activity.conversation?.id) {
        try {
            await logic(context);
            return { ok: true };
        } catch (error) {
            const message = (error as Error).message;
            console.warn(`[standup] Local delivery failed: ${message}`);
            return { ok: false, error: message };
        }
    }
    if (getJiraMode() === 'mock') {
        return { ok: false, error: 'Mock standup delivery requires a matching local turn context.' };
    }
    return sendProactive(reference, logic);
}

export function triggerStandup(opts: StandupTriggerOptions): Promise<StandupTriggerResult> {
    if (getJiraMode() === 'mock' && !opts.turnContext) {
        const note = 'Mock standup skipped: scheduled/HTTP triggers require a local turn context. Use /standup in Agents Playground.';
        console.log(`[standup] ${note}`);
        return Promise.resolve({ standupId: '', sentTo: 0, skipped: 0, note });
    }
    // Reserve the entire async initialization, before roster and persistence awaits.
    if (pendingTrigger) return pendingTrigger;
    pendingTrigger = startStandup(opts).finally(() => { pendingTrigger = undefined; });
    return pendingTrigger;
}

async function startStandup(opts: StandupTriggerOptions): Promise<StandupTriggerResult> {
    if (opts.retryStandupId) {
        const session = getSession(opts.retryStandupId);
        let note: string;
        if (!session) {
            note = `Standup ${opts.retryStandupId} is not retained in this process. No new run was started; inspect persisted records before manual recovery.`;
        } else if (session.state === 'summarized') {
            await finishStandupChase(session);
            note = session.chaseState === 'complete'
                ? `Blocker follow-up completed for ${session.standupId} without repeating its summary.`
                : `Blocker follow-up for ${session.standupId} is still pending. Retry /standup retry ${session.standupId}.`;
        } else if (session.state === 'open' &&
            (allExpectedResponded(session) || Date.now() >= Date.parse(session.cutoffUtc))) {
            await summarizeStandup(session);
            note = `Retried retained standup ${session.standupId} without starting a new daily run.`;
        } else {
            note = `Standup ${session.standupId} is still collecting responses or being summarized; no additional work was started.`;
        }
        console.log(`[standup] ${note}`);
        if (opts.turnContext) await opts.turnContext.sendActivity(note);
        return { standupId: opts.retryStandupId, sentTo: session?.sentTo.size ?? 0, skipped: 0, note };
    }
    const src = opts.source;
    const jira = getJiraClient();
    const schedule = getScheduleConfig();

    console.log(`[standup] triggerStandup (source=${src})`);

    const sprint = await jira.getActiveSprint();
    if (!sprint) {
        const msg = 'No active sprint found — nothing to standup on.';
        console.log(`[standup] ${msg}`);
        if (opts.turnContext) await opts.turnContext.sendActivity(msg);
        return { standupId: '', sentTo: 0, skipped: 0, note: msg };
    }

    const standupId = makeStandupId(sprint.id);

    // Idempotency: if a session already exists today (from cron OR the /standup command),
    // don't re-fan-out. Callers get a friendly note.
    const existingMem = getSession(standupId);
    const completed = getCompletedSession(standupId);
    if (existingMem?.state === 'summarized') {
        await finishStandupChase(existingMem);
        const note = existingMem.chaseState === 'complete'
            ? 'Blocker follow-up completed without repeating the standup summary.'
            : 'Summary already delivered; blocker follow-up is pending. Retry /standup to retry only blocker follow-up.';
        if (opts.turnContext) await opts.turnContext.sendActivity(note);
        return { standupId, sentTo: existingMem.sentTo.size, skipped: 0, note };
    }
    if (existingMem?.state === 'open' &&
        (allExpectedResponded(existingMem) || Date.now() >= DateTime.fromISO(existingMem.cutoffUtc).toMillis())) {
        await summarizeStandup(existingMem);
        return { standupId, sentTo: existingMem.sentTo.size, skipped: 0, note: 'Existing standup summary delivered without repeating fan-out.' };
    }
    const persisted = !existingMem && !completed
        ? await findByTitle<StandupSessionFields>('standupSessions', standupId)
        : null;
    if (existingMem || completed || persisted) {
        const msg = existingMem
            ? `Standup ${standupId} is already ${existingMem.state === 'open' ? 'in progress' : 'being summarized'} (${existingMem.responses.size}/${existingMem.expectedResponders.size} responded).`
            : `Standup ${standupId} has already been started or completed today.`;
        console.log(`[standup] ${msg}`);
        if (opts.turnContext) await opts.turnContext.sendActivity(msg);
        return { standupId, sentTo: existingMem?.sentTo.size ?? completed?.sentTo ?? 0, skipped: 0, note: msg };
    }

    if (getJiraMode() === 'mock' && opts.turnContext) {
        await upsertConversationReference(opts.turnContext);
    }

    // Load roster and issues in parallel.
    const [members, sprintIssues] = await Promise.all([
        listTeamMembers(),
        jira.searchSprintIssues(sprint.id),
    ]);
    const subtasks = await jira.getSprintSubtasks(sprint.id, sprintIssues.filter(i => !i.parentKey).map(i => i.key));
    const issues = Array.from(new Map([...sprintIssues, ...subtasks].map(i => [i.key, i])).values());

    // Group Jira issues by team-member AAD id (via JiraAccountId join).
    const itemsByAssignee = new Map<string, JiraIssue[]>();
    const jiraAccountToMember = new Map<string, TeamMember>();
    members.forEach(m => { if (m.JiraAccountId) jiraAccountToMember.set(m.JiraAccountId, m); });

    for (const issue of issues) {
        const acct = issue.assignee?.accountId;
        if (!acct) continue;
        const member = jiraAccountToMember.get(acct);
        if (!member) {
            console.warn(`[standup] Jira assignee ${acct} (${issue.assignee?.displayName}) is not in TeamMembers — skipping ${issue.key}`);
            continue;
        }
        const bucket = itemsByAssignee.get(member.AadObjectId) ?? [];
        bucket.push(issue);
        itemsByAssignee.set(member.AadObjectId, bucket);
    }

    const expectedResponders = new Set(itemsByAssignee.keys());
    const reachable: TeamMember[] = [];
    const unreachable = new Set<string>();
    for (const aadId of expectedResponders) {
        const m = members.find(x => x.AadObjectId === aadId)!;
        if (isReachable(m)) reachable.push(m);
        else unreachable.add(aadId);
    }

    const nowUtc = new Date();
    const cutoffUtc = new Date(nowUtc.getTime() + schedule.cutoffHours * 3600_000);

    // The unique daily RunKey insert is the cross-worker claim before fan-out.
    const claimed = await claimStandupSession<StandupSessionFields>({
        Title: standupId,
        SprintId: String(sprint.id),
        StartedUtc: nowUtc.toISOString(),
        CutoffUtc: cutoffUtc.toISOString(),
        State: 'open',
        ExpectedResponders: JSON.stringify(Array.from(expectedResponders)),
        InitiatedByAadId: opts.initiatedByAadId ?? '',
    });
    if (!claimed) {
        const note = `Standup ${standupId} has already been started or completed today.`;
        if (opts.turnContext) await opts.turnContext.sendActivity(note);
        return { standupId, sentTo: 0, skipped: 0, note };
    }

    // Build session in memory.
    const session: StandupSession = {
        standupId,
        sprintId: sprint.id,
        sprintName: sprint.name,
        startedUtc: nowUtc.toISOString(),
        cutoffUtc: cutoffUtc.toISOString(),
        state: 'open',
        initiatedByAadId: opts.initiatedByAadId ?? null,
        itemsByAssignee,
        expectedResponders,
        sentTo: new Set(),
        unreachable,
        responses: new Map(),
    };
    upsertSession(session);
    if (getJiraMode() === 'mock' && opts.turnContext) mockTurnContexts.set(standupId, opts.turnContext);

    // Keep multi-day cutoffs within Node's supported timer range.
    const msUntilCutoff = cutoffUtc.getTime() - nowUtc.getTime();
    if (msUntilCutoff > 0 && msUntilCutoff <= 2_147_483_647) {
        scheduleStandupCutoff(session, msUntilCutoff);
    }

    // Fan out request cards.
    const cutoffLocal = formatLocal(cutoffUtc, schedule.timezone);
    let sent = 0;
    for (const member of reachable) {
        const items = itemsByAssignee.get(member.AadObjectId) ?? [];
        const card = buildStandupRequestCard({
            standupId,
            sprintName: sprint.name,
            cutoffLocal,
            assigneeAadId: member.AadObjectId,
            items,
        });
        const deliver = async (ctx: TurnContext) => {
            await ctx.sendActivity({ type: 'message', attachments: [card] } as Partial<Activity> as Activity);
        };
        const result = await deliverStandup(standupId, member.conversationReference!, deliver);
        if (result.ok) {
            session.sentTo.add(member.AadObjectId);
            sent++;
        }
    }

    if (opts.turnContext) {
        await opts.turnContext.sendActivity(
            `Started standup for **${sprint.name}** — DM'd ${sent}/${expectedResponders.size} squad member(s). ` +
            `I'll post the summary here${unreachable.size > 0 ? ` (${unreachable.size} member(s) were unreachable — no conversation reference stored yet)` : ''} ` +
            `once everyone's replied or by **${cutoffLocal}**.`,
        );
    }

    return { standupId, sentTo: sent, skipped: unreachable.size };
}

// --- handleStandupSubmit -------------------------------------------------

function scheduleStandupCutoff(session: StandupSession, delayMs: number, retries = 0): void {
    session.cutoffTimer = setTimeout(async () => {
        session.cutoffTimer = undefined;
        if (getSession(session.standupId) !== session || session.state === 'summarized') return;
        if (session.state === 'summarizing') {
            scheduleStandupCutoff(session, 60_000, retries);
            return;
        }
        try {
            console.log(`[standup] Cutoff fired for ${session.standupId}`);
            await summarizeStandup(session);
        } catch (error) {
            console.error('[standup] cutoff summarize failed:', (error as Error).message);
            if (session.state === 'open' && retries < 3) {
                scheduleStandupCutoff(session, 60_000, retries + 1);
            } else {
                console.error(`[standup] Automatic summary retries exhausted. Retry /standup retry ${session.standupId}; the session is retained.`);
            }
        }
    }, delayMs);
}

async function acknowledgeStandupSubmission(
    context: TurnContext, session: StandupSession, response: StandupResponse,
): Promise<void> {
    await context.sendActivity({
        type: 'message',
        attachments: [buildStandupSubmittedCard({
            sprintName: session.sprintName,
            submittedAtLocal: formatLocal(new Date(response.submittedUtc), getScheduleConfig().timezone),
            items: response.items,
        })],
    } as Partial<Activity> as Activity);
}

export async function handleStandupSubmit(context: TurnContext): Promise<void> {
    const value = context.activity.value as Record<string, unknown> | undefined;
    const standupId = String(value?.standupId ?? '');
    const claimedAssigneeAadId = String(value?.assigneeAadId ?? '');
    const actualAadId = context.activity.from?.aadObjectId
        || (getJiraMode() === 'mock' ? context.activity.from?.id : '') || '';

    if (!standupId) {
        await context.sendActivity('Standup submit missing `standupId` — please try again.');
        return;
    }

    if (!actualAadId || (claimedAssigneeAadId && claimedAssigneeAadId !== actualAadId)) {
        console.warn('[standup] Rejected missing or mismatched responder identity.');
        await context.sendActivity('Your response does not match your identity — I did not record it.');
        return;
    }

    const session = getSession(standupId);
    if ((session && session.state !== 'open') || getCompletedSession(standupId)) {
        await context.sendActivity(`Standup ${standupId} is already being summarized — no further updates were recorded.`);
        return;
    }
    if (!session) {
        console.warn('[standup] Rejected an unknown standup session.');
        await context.sendActivity('This standup is unknown or no longer active. No updates were recorded.');
        return;
    }
    if (!session.expectedResponders.has(actualAadId)) {
        console.warn('[standup] Rejected a caller outside the standup responder set.');
        await context.sendActivity('You are not an expected responder for this standup. No updates were recorded.');
        return;
    }
    const assignedKeys = new Set((session.itemsByAssignee.get(actualAadId) ?? []).map(issue => issue.key));
    if (Object.keys(value ?? {}).some(key => {
        const match = key.match(/^(?:update_|blockerText_|blocker_)(.+)$/);
        return match && !assignedKeys.has(match[1]);
    })) {
        console.warn('[standup] Rejected an issue outside the responder assignment.');
        await context.sendActivity('Your response contains an issue not assigned to you in this standup. No updates were recorded.');
        return;
    }

    // Parse per-issue inputs.
    const items: StandupItemResponse[] = [];
    const issueKeys = new Set<string>();
    for (const key of Object.keys(value ?? {})) {
        const m = key.match(/^update_(.+)$/);
        if (m) issueKeys.add(m[1]);
    }
    for (const issueKey of issueKeys) {
        const update = String(value?.[`update_${issueKey}`] ?? '').trim();
        const hasBlocker = String(value?.[`blocker_${issueKey}`] ?? 'false') === 'true';
        const blockerText = String(value?.[`blockerText_${issueKey}`] ?? '').trim();
        if (!update) continue;
        items.push({ issueKey, update, hasBlocker, blockerText: hasBlocker ? blockerText : undefined });
    }

    if (items.length === 0) {
        await context.sendActivity('I did not find any updates in your response — please fill at least one item.');
        return;
    }

    const nowUtc = new Date();
    const response: StandupResponse = {
        userAadId: actualAadId,
        submittedUtc: nowUtc.toISOString(),
        items,
    };

    const accepted = session.responses.get(actualAadId);
    if (accepted) {
        await acknowledgeStandupSubmission(context, session, accepted);
        return;
    }
    const reference = context.activity.getConversationReference();
    const reply = async (logic: (ctx: TurnContext) => Promise<void>): Promise<void> => {
        if (getJiraMode() === 'mock') {
            await logic(context);
            return;
        }
        const result = await deliverStandup(standupId, reference, logic);
        if (!result.ok) throw new Error(`Standup submission notification failed: ${result.error}`);
    };
    const releaseSubmission = reserveSessionSubmission(session, actualAadId);
    try {
        await context.sendActivity('Recording your standup response…');
    } catch (error) {
        releaseSubmission?.();
        throw error;
    }
    const responderDisplayName = context.activity.from?.name?.trim() || response.userAadId;
    setImmediate(() => {
        const work = async () => {
            if (releaseSubmission) {
                await recordStandupSubmission(session, response, assignedKeys, responderDisplayName, reply, releaseSubmission);
            } else {
                await waitForResponderSubmission(session, actualAadId);
                const recorded = session.responses.get(actualAadId);
                if (!recorded) throw new Error('The pending response was not recorded. Please retry the card.');
                await reply(ctx => acknowledgeStandupSubmission(ctx, session, recorded));
            }
        };
        work().catch(async error => {
            console.error('[standup] Background submission failed:', (error as Error).message);
            const message = session.responses.has(actualAadId)
                ? 'Your response was recorded, but follow-up failed. Please notify the Scrum Master to check blocker records and Jira comments.'
                : 'Your response could not be confirmed as recorded. Please retry the card.';
            try {
                await reply(async ctx => { await ctx.sendActivity(message); });
            } catch (notificationError) {
                console.error('[standup] Submission failure notification failed:', (notificationError as Error).message);
            }
        });
    });
}

async function recordStandupSubmission(
    session: StandupSession,
    response: StandupResponse,
    assignedKeys: Set<string>,
    responderDisplayName: string,
    reply: (logic: (ctx: TurnContext) => Promise<void>) => Promise<void>,
    releaseSubmission: () => void,
): Promise<void> {
    const { standupId } = session;
    const actualAadId = response.userAadId;
    const items = response.items;
    let acceptedResponse = response;
    let created = false;
    try {
        const result = await claimStandupResponse<StandupResponseFields>({
            Title: `${standupId}#${response.userAadId}`,
            StandupId: standupId,
            UserAadId: response.userAadId,
            SubmittedUtc: response.submittedUtc,
            Items: JSON.stringify(items),
        });
        created = result.created;
        if (!created) {
            const fields = result.item.fields;
            const storedItems: unknown = JSON.parse(fields.Items);
            if (fields.StandupId !== standupId || fields.UserAadId !== actualAadId ||
                !Number.isFinite(Date.parse(fields.SubmittedUtc)) || !Array.isArray(storedItems) ||
                !storedItems.every((item: unknown): item is StandupItemResponse =>
                    typeof item === 'object' && item !== null &&
                    'issueKey' in item && typeof item.issueKey === 'string' && assignedKeys.has(item.issueKey) &&
                    'update' in item && typeof item.update === 'string' &&
                    'hasBlocker' in item && typeof item.hasBlocker === 'boolean' &&
                    (!('blockerText' in item) || item.blockerText === undefined || typeof item.blockerText === 'string'))) {
                throw new Error('Stored standup response does not match the authorized responder assignment.');
            }
            acceptedResponse = { userAadId: actualAadId, submittedUtc: fields.SubmittedUtc, items: storedItems };
        }
        session.responses.set(actualAadId, acceptedResponse);

        // Persist / update Blocker rows for any hasBlocker=true items.
        for (const item of created ? items : []) {
            if (!item.hasBlocker) continue;
            const blockerTitle = item.issueKey;
            const existing = await findByTitle<BlockerFields>('blockers', blockerTitle);
            const fields = {
                Title: blockerTitle,
                StandupId: standupId,
                ReporterAadId: response.userAadId,
                OwnerAadId: response.userAadId,      // owner = reporter unless we learn otherwise
                BlockerText: item.blockerText ?? '',
                State: 'open',
            };
            if (existing) await updateItem<BlockerFields>('blockers', existing.id, fields);
            else await createItem<BlockerFields>('blockers', fields);
        }
    } catch (error) {
        console.error('[standup] Response recording failed:', (error as Error).message);
        throw error;
    } finally {
        releaseSubmission();
    }

    // Push the raw update + blocker text back to Jira as a comment on each issue.
    // Fire-and-forget: a Jira 4xx / network failure must not block the standup submit
    // (the SharePoint state is already durable at this point).
    const commentDateLocal = formatLocal(new Date(response.submittedUtc), getScheduleConfig().timezone);
    if (created) setImmediate(async () => {
        const jira = getJiraClient();
        for (const item of items) {
            const lines = [
                `Standup update — ${commentDateLocal} — ${responderDisplayName}`,
                '',
                item.update,
            ];
            if (item.hasBlocker && item.blockerText) {
                lines.push('', `\u{1F6A7} Blocker: ${item.blockerText}`);
            }
            try {
                await jira.addComment(item.issueKey, lines.join('\n'));
                console.log(`[standup] Posted Jira comment on ${item.issueKey} (blocker=${item.hasBlocker})`);
            } catch (e) {
                console.warn(`[standup] Jira comment failed for ${item.issueKey}: ${(e as Error).message}`);
            }
        }
    });

    await reply(ctx => acknowledgeStandupSubmission(ctx, session, acceptedResponse));

    // Fire-and-forget the downstream summarize/reconcile/chase chain.
    //
    // The invoke already returned its recording acknowledgement; finalization
    // waits for reserved submissions, including their blocker writes.
    if (session && allExpectedResponded(session)) {
        console.log(`[standup] All expected responded for ${standupId} — kicking off summarize in background.`);
        setImmediate(() => {
            summarizeStandup(session).catch(err =>
                console.error('[standup] background summarize failed:', (err as Error).message),
            );
        });
    }
}

// --- summarizeStandup ----------------------------------------------------

export async function summarizeStandup(session: StandupSession): Promise<void> {
    if (session.state !== 'open') return;

    // Resolve prerequisites before claiming; a transient roster failure remains retryable.
    const members = await listTeamMembers();
    if (!claimSessionFinalization(session)) return;
    try {
        await finalizeStandup(session, members);
    } finally {
        releaseSessionFinalization(session);
    }
}

function releaseSessionFinalization(session: StandupSession): void {
    if (session.state === 'summarizing') session.state = 'open';
}

async function finalizeStandup(session: StandupSession, members: TeamMember[]): Promise<void> {
    await waitForSessionSubmissions(session);
    const memberByAadId = new Map(members.map(m => [m.AadObjectId, m]));
    const smMember = members.find(m => m.Role === 'SM') ?? null;

    // Fix 1: run Reconcile BEFORE building the summary card so `statusFrom → statusTo`
    // in the card reflects what Jira actually looks like right now. We also patch
    // session.itemsByAssignee in place so any downstream reader sees the fresh state.
    let reconcileOutcome: { autoApplied: Array<{ issueKey: string; from: string; to: string }>; needsConfirm: Array<{ issueKey: string; statusFrom: string; statusTo: string }>; errors: Array<{ issueKey: string; message: string }> } = { autoApplied: [], needsConfirm: [], errors: [] };
    try {
        const { reconcileAfterStandup } = await import('./reconcile');
        reconcileOutcome = await reconcileAfterStandup(session);
        // Patch in-memory issue statuses to the new values so the card renders them correctly.
        for (const applied of reconcileOutcome.autoApplied) {
            for (const items of session.itemsByAssignee.values()) {
                const issue = items.find(i => i.key === applied.issueKey);
                if (issue) issue.status = applied.to;
            }
        }
    } catch (e) {
        console.error('[standup] reconcile failed (non-fatal):', (e as Error).message);
    }
    const autoAppliedByKey = new Map(reconcileOutcome.autoApplied.map(a => [a.issueKey, a]));

    // Build "updates by person" and "blockers" arrays for the card.
    const updatesByPerson: StandupSummaryPerson[] = [];
    const blockers: StandupSummaryBlocker[] = [];
    for (const [aadId, response] of session.responses.entries()) {
        const member = memberByAadId.get(aadId);
        const displayName = member?.Title ?? aadId;
        const perItem: StandupSummaryUpdateItem[] = [];
        for (const item of response.items) {
            const jiraIssue = (session.itemsByAssignee.get(aadId) ?? [])
                .find(i => i.key === item.issueKey);
            const applied = autoAppliedByKey.get(item.issueKey);
            perItem.push({
                issueKey: item.issueKey,
                url: jiraIssue?.url ?? '',
                title: cleanIssueTitle(jiraIssue?.summary ?? item.issueKey),
                statusFrom: applied?.from ?? (jiraIssue?.status ?? 'Unknown'),
                statusTo: applied?.to ?? null,
                update: item.update,
                blockerText: item.hasBlocker ? (item.blockerText ?? '') : undefined,
            });
            if (item.hasBlocker) {
                blockers.push({
                    issueKey: item.issueKey,
                    url: jiraIssue?.url ?? '',
                    ownerDisplayName: displayName,
                    blockerText: item.blockerText ?? '',
                });
            }
        }
        updatesByPerson.push({ displayName, items: perItem });
    }

    // Missed = expected − responded (with the "never installed" flag).
    const missed: StandupSummaryMissed[] = [];
    for (const aadId of session.expectedResponders) {
        if (session.responses.has(aadId)) continue;
        const member = memberByAadId.get(aadId);
        missed.push({
            displayName: member?.Title ?? aadId,
            neverInstalled: session.unreachable.has(aadId),
        });
    }

    const schedule = getScheduleConfig();
    const dateLocal = DateTime.now().setZone(schedule.timezone).toFormat('cccc, d LLLL');
    const card = buildStandupSummaryCard({
        sprintName: session.sprintName,
        dateLocal,
        respondedCount: session.responses.size,
        expectedCount: session.expectedResponders.size,
        updatesByPerson,
        missed,
        blockers,
        scrumMaster: smMember ? { aadId: smMember.AadObjectId, displayName: smMember.Title } : null,
    });

    // Fix 2: a small text follow-up so the auto-reconcile is visible to demo viewers.
    const boardMsg = reconcileOutcome.autoApplied.length > 0
        ? `🧾 **Board updated** — ${reconcileOutcome.autoApplied.map(a => `**${a.issueKey}** ${a.from} → ${a.to}`).join(', ')}.` +
        (reconcileOutcome.needsConfirm.length > 0
            ? ` I DM'd you separately for ${reconcileOutcome.needsConfirm.length} change(s) that need your call.`
            : '')
        : null;

    // Post to the configured channel (via TeamsConfig).
    const configRows = await findByField<TeamsConfigFields>('teamsConfig', 'Title', 'primary').catch(error => {
        console.warn('[standup] Channel configuration lookup failed; trying SM DM:', (error as Error).message);
        return [];
    });
    const targetConvRef = configRows[0]?.fields?.ConversationRef;
    let deliveredReference: TeamMember['conversationReference'] = null;
    const sendCard = async (ctx: TurnContext) => {
        await ctx.sendActivity({ type: 'message', attachments: [card] } as Partial<Activity> as Activity);
    };
    if (targetConvRef) {
        try {
            const ref = JSON.parse(targetConvRef);
            const result = await deliverStandup(session.standupId, ref, sendCard);
            if (result.ok) deliveredReference = ref;
            else console.warn('[standup] Channel summary delivery failed; trying SM DM:', result.error);
        } catch (e) {
            console.warn('[standup] Channel summary unavailable; trying SM DM:', (e as Error).message);
        }
    }
    if (!deliveredReference && smMember?.conversationReference) {
        const result = await deliverStandup(session.standupId, smMember.conversationReference, sendCard);
        if (result.ok) deliveredReference = smMember.conversationReference;
        else console.warn('[standup] SM summary delivery failed:', result.error);
    }
    if (!deliveredReference) {
        session.state = 'open';
        console.error('[standup] Summary was not delivered; retaining the open session for retry.');
        throw new Error('Standup summary was not delivered. Retry /standup after cutoff or once all responses are collected.');
    }
    if (boardMsg) {
        const result = await deliverStandup(session.standupId, deliveredReference, async ctx => {
            await ctx.sendActivity(boardMsg);
        });
        if (!result.ok) console.warn('[standup] Board-update follow-up failed; the summary itself was delivered:', result.error);
    }

    // Mark session summarized.
    session.state = 'summarized';
    if (session.cutoffTimer) { clearTimeout(session.cutoffTimer); session.cutoffTimer = undefined; }

    // Update StandupSessions row.
    try {
        const row = await findByTitle<StandupSessionFields>('standupSessions', session.standupId);
        if (!row) throw new Error('Standup session row was not found.');
        await updateItem<StandupSessionFields>('standupSessions', row.id, { State: 'summarized' });
    } catch (e) {
        console.error('[standup] Summary delivered, but completion persistence failed; check the StandupSessions row before restarting:', (e as Error).message);
    }

    await finishStandupChase(session);
}

async function finishStandupChase(session: StandupSession): Promise<void> {
    if (session.chaseState === 'running' || session.chaseState === 'complete') return;
    session.chaseState = 'running';
    try {
        const { chaseAfterStandup } = await import('./chase');
        await chaseAfterStandup(session);
    } catch (e) {
        session.chaseState = 'failed';
        console.error(`[standup] Summary delivered, but blocker follow-up failed. Session retained; retry /standup retry ${session.standupId} to retry only blocker follow-up:`, (e as Error).message);
        return;
    }

    session.chaseState = 'complete';
    // Release heavy response data but retain today's duplicate-fan-out guard.
    completeSession(session);
    mockTurnContexts.delete(session.standupId);
}

// --- helpers -------------------------------------------------------------

function formatLocal(d: Date, tz: string): string {
    return DateTime.fromJSDate(d).setZone(tz).toFormat('h:mm a ZZZZ');
}

/**
 * Strip the "User Story: " / "Bug: " / "Task N: [Category]: " prefixes from a
 * Jira issue summary so the standup summary table shows a compact, human title.
 * Examples:
 *   "User Story: Employee listing page"         -> "Employee listing page"
 *   "Task 1: [Backend API]: Implement /login"   -> "Implement /login"
 *   "Bug: Employee list off-by-one on last…"    -> "Employee list off-by-one on last…"
 */
function cleanIssueTitle(summary: string): string {
    if (!summary) return '';
    // "Task N: [Category]: rest"
    const taskCat = summary.match(/^\s*Task\s+\d+\s*:\s*\[[^\]]+\]\s*:\s*(.+)$/i);
    if (taskCat) return taskCat[1].trim();
    // "User Story: rest" | "Bug: rest" | "Task: rest"
    const prefixed = summary.match(/^\s*(?:User Story|Story|Bug|Task)\s*:\s*(.+)$/i);
    if (prefixed) return prefixed[1].trim();
    return summary.trim();
}

// re-export for callers that already imported the stub
export { todayKey };
