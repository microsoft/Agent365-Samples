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
 *     └─ persists StandupResponses row + optional Blockers rows
 *     └─ acks the user with a "submitted" card
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
    findByField,
    findByTitle,
    updateItem,
} from '../services/sharepoint';
import { getJiraClient, JiraIssue } from '../services/jira';
import {
    listTeamMembers,
    TeamMember,
    isReachable,
} from '../services/team-roster';
import {
    StandupSession,
    StandupItemResponse,
    StandupResponse,
    makeStandupId,
    todayKey,
    getSession,
    upsertSession,
    removeSession,
    allExpectedResponded,
} from '../services/session-store';
import { getScheduleConfig } from '../config';
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

export async function triggerStandup(opts: {
    initiatedByAadId?: string;
    turnContext?: TurnContext;
    source: 'command' | 'cron' | 'http';
}): Promise<{ standupId: string; sentTo: number; skipped: number; note?: string }> {
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
    if (existingMem) {
        const msg = `Standup ${standupId} is already in progress (${existingMem.responses.size}/${existingMem.expectedResponders.size} responded).`;
        console.log(`[standup] ${msg}`);
        if (opts.turnContext) await opts.turnContext.sendActivity(msg);
        return { standupId, sentTo: existingMem.sentTo.size, skipped: 0, note: msg };
    }

    // Load roster and issues in parallel.
    const [members, issues] = await Promise.all([
        listTeamMembers(),
        jira.searchSprintIssues(sprint.id),
    ]);

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

    // Persist the session row (idempotent per Title key).
    await createItem<StandupSessionFields>('standupSessions', {
        Title: standupId,
        SprintId: String(sprint.id),
        StartedUtc: nowUtc.toISOString(),
        CutoffUtc: cutoffUtc.toISOString(),
        State: 'open',
        ExpectedResponders: JSON.stringify(Array.from(expectedResponders)),
        InitiatedByAadId: opts.initiatedByAadId ?? '',
    }).catch(err => {
        // If the row already exists (race between cron and command) the createItem
        // will 4xx — treat as non-fatal because we already checked in-memory above.
        console.warn(`[standup] StandupSessions insert warning: ${(err as Error).message}`);
    });

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

    // Schedule the cutoff timer only if the cutoff falls today (dev cron loop only).
    const msUntilCutoff = cutoffUtc.getTime() - nowUtc.getTime();
    if (msUntilCutoff > 0 && msUntilCutoff < 86_400_000) {
        session.cutoffTimer = setTimeout(async () => {
            const s = getSession(standupId);
            if (s && s.state === 'open') {
                console.log(`[standup] Cutoff fired for ${standupId}`);
                await summarizeStandup(s).catch(err =>
                    console.error('[standup] cutoff summarize failed:', (err as Error).message),
                );
            }
        }, msUntilCutoff);
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
        const result = await sendProactive(member.conversationReference!, async ctx => {
            await ctx.sendActivity({ type: 'message', attachments: [card] } as Partial<Activity> as Activity);
        });
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

export async function handleStandupSubmit(context: TurnContext): Promise<void> {
    const value = context.activity.value as Record<string, unknown> | undefined;
    const standupId = String(value?.standupId ?? '');
    const claimedAssigneeAadId = String(value?.assigneeAadId ?? '');
    const actualAadId = context.activity.from?.aadObjectId ?? '';

    if (!standupId) {
        await context.sendActivity('Standup submit missing `standupId` — please try again.');
        return;
    }

    // Security: reject cards where a user tries to submit on someone else's behalf.
    // DEMO_MODE=true relaxes this so one tester can submit on behalf of multiple
    // "persona" rows in TeamMembers whose AAD IDs point at the tester's inbox —
    // useful for validating 3-person fan-out without three real Teams accounts.
    const demoMode = String(process.env.DEMO_MODE ?? '').toLowerCase() === 'true';
    if (claimedAssigneeAadId && actualAadId && claimedAssigneeAadId !== actualAadId) {
        if (demoMode) {
            console.warn(`[standup] DEMO_MODE — accepting cross-identity submit: claimed=${claimedAssigneeAadId} actual=${actualAadId}`);
        } else {
            console.warn(`[standup] identity mismatch on submit: claimed=${claimedAssigneeAadId} actual=${actualAadId}`);
            await context.sendActivity('Your response does not match your identity — I did not record it.');
            return;
        }
    }

    const session = getSession(standupId);
    if (!session) {
        await context.sendActivity(
            `Standup ${standupId} has already been summarized or is unknown — I've noted your update for later.`,
        );
        // Still persist it so nothing is lost.
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
    // In DEMO_MODE, always key the response by the claimed assignee so each persona's
    // submit produces a distinct entry in session.responses (instead of collapsing to
    // a single entry keyed by the tester's real AAD).
    const responderKey = demoMode && claimedAssigneeAadId
        ? claimedAssigneeAadId
        : (actualAadId || claimedAssigneeAadId);
    const response: StandupResponse = {
        userAadId: responderKey,
        submittedUtc: nowUtc.toISOString(),
        items,
    };

    // Persist the response row.
    await createItem<StandupResponseFields>('standupResponses', {
        Title: `${standupId}#${response.userAadId}`,
        StandupId: standupId,
        UserAadId: response.userAadId,
        SubmittedUtc: response.submittedUtc,
        Items: JSON.stringify(items),
    }).catch(err => {
        console.warn(`[standup] StandupResponses insert warning: ${(err as Error).message}`);
    });

    // Persist / update Blocker rows for any hasBlocker=true items.
    for (const item of items) {
        if (!item.hasBlocker) continue;
        const blockerTitle = item.issueKey;
        const existing = await findByTitle<BlockerFields>('blockers', blockerTitle).catch(() => null);
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

    // Push the raw update + blocker text back to Jira as a comment on each issue.
    // Fire-and-forget: a Jira 4xx / network failure must not block the standup submit
    // (the SharePoint state is already durable at this point).
    const responderDisplayName =
        context.activity.from?.name?.trim() || response.userAadId;
    const commentDateLocal = formatLocal(nowUtc, getScheduleConfig().timezone);
    setImmediate(async () => {
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

    if (session) {
        session.responses.set(response.userAadId, response);
    }

    // Ack the user.
    const submittedAtLocal = formatLocal(nowUtc, getScheduleConfig().timezone);
    await context.sendActivity({
        type: 'message',
        attachments: [buildStandupSubmittedCard({
            sprintName: session?.sprintName ?? '',
            submittedAtLocal,
            items,
        })],
    } as Partial<Activity> as Activity);

    // Fire-and-forget the downstream summarize/reconcile/chase chain.
    //
    // Rationale: Teams gives ~15s for our card-submit invoke response. The chain
    // does Jira REST + SharePoint writes + multiple proactive card sends — easily
    // exceeds the timeout, which surfaces as a spurious "Something went wrong"
    // toast in Teams. Returning immediately means the ack card completes the
    // invoke inside the deadline; the summarizer runs in the background and can
    // safely take as long as it needs.
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

    // Load roster once for display names.
    const members = await listTeamMembers();
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
    const configRows = await findByField<TeamsConfigFields>('teamsConfig', 'Title', 'primary').catch(() => []);
    const targetConvRef = configRows[0]?.fields?.ConversationRef;
    if (!targetConvRef) {
        console.warn('[standup] No TeamsConfig.primary channel set — falling back to DM the SM.');
        if (smMember?.conversationReference) {
            await sendProactive(smMember.conversationReference, async ctx => {
                await ctx.sendActivity({ type: 'message', attachments: [card] } as Partial<Activity> as Activity);
                if (boardMsg) await ctx.sendActivity(boardMsg);
            });
        } else {
            console.error('[standup] No SM conversation reference either — cannot deliver summary.');
        }
    } else {
        try {
            const ref = JSON.parse(targetConvRef);
            await sendProactive(ref, async ctx => {
                await ctx.sendActivity({ type: 'message', attachments: [card] } as Partial<Activity> as Activity);
                if (boardMsg) await ctx.sendActivity(boardMsg);
            });
        } catch (e) {
            console.error('[standup] Bad ConversationRef in TeamsConfig:', (e as Error).message);
        }
    }

    // Mark session summarized.
    session.state = 'summarized';
    if (session.cutoffTimer) { clearTimeout(session.cutoffTimer); session.cutoffTimer = undefined; }

    // Update StandupSessions row.
    const row = await findByTitle<StandupSessionFields>('standupSessions', session.standupId).catch(() => null);
    if (row) await updateItem<StandupSessionFields>('standupSessions', row.id, { State: 'summarized' });

    // Chase runs AFTER summary post (blocker DMs to SM / owner pings can wait).
    try {
        const { chaseAfterStandup } = await import('./chase');
        await chaseAfterStandup(session);
    } catch (e) {
        console.error('[standup] chase failed (non-fatal):', (e as Error).message);
    }

    // Evict the in-memory session (durable record already in SharePoint).
    removeSession(session.standupId);
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
