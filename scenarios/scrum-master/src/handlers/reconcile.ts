// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * MVP 2 — Reconcile.
 *
 * After the standup summary posts, walk the collected responses and reconcile the
 * Jira board with what people reported.
 *
 * Design:
 *  - Rules-based classifier maps free-text updates to one of the four states
 *    { To Do, In Progress, In Review, Done }. Explainable in a demo ("saw the
 *    word 'done' so I moved it") and cheap — no extra LLM tokens per issue.
 *  - Only *safe forward transitions* on the whitelist
 *    `To Do → In Progress → In Review → Done` are auto-applied.
 *  - Backwards moves, skips, or unknown targets are batched into an Adaptive
 *    Card and DM'd to the Scrum Master for one-click approval.
 */

import { DateTime } from 'luxon';
import { Activity, ConversationReference } from '@microsoft/agents-activity';
import { TurnContext } from '@microsoft/agents-hosting';

import { getJiraClient, JiraIssue, JiraTransition } from '../services/jira';
import { listTeamMembers, TeamMember } from '../services/team-roster';
import { sendProactive } from '../services/proactive';
import {
    buildTransitionConfirmCard,
    ProposedTransition,
} from '../cards/transition-confirm.card';
import { StandupSession } from '../services/session-store';

// --- state classifier ----------------------------------------------------

type TargetStatus = 'To Do' | 'In Progress' | 'In Review' | 'Done' | 'unchanged';

const RANK: Record<Exclude<TargetStatus, 'unchanged'>, number> = {
    'To Do': 0,
    'In Progress': 1,
    'In Review': 2,
    'Done': 3,
};

/**
 * Rules ordered by strength — first match wins.
 * Patterns are intentionally loose (word-boundary case-insensitive) so real
 * standup phrasing hits them consistently.
 */
const RULES: Array<{ target: Exclude<TargetStatus, 'unchanged'>; patterns: RegExp[] }> = [
    {
        target: 'Done',
        patterns: [
            /\b(done|completed|finished|merged|shipped|deployed|closed)\b/i,
            /\bready to close\b/i,
        ],
    },
    {
        target: 'In Review',
        patterns: [
            /\bin review\b/i,
            /\b(code[- ]?review|pr\s*(is\s*)?up|pull request|reviewing)\b/i,
            /\bwaiting (for|on) review\b/i,
        ],
    },
    {
        target: 'In Progress',
        patterns: [
            /\b(started|starting|began|beginning|kicked\s*off|working on|in progress|picked up)\b/i,
            /\b(am|i'?m|now)\s+(implementing|building|coding|writing)\b/i,
        ],
    },
];

export function classifyUpdateText(text: string, hasBlocker: boolean): TargetStatus {
    // Blocker flag freezes any inferred movement — status should reflect reality,
    // not the update text alone.
    if (hasBlocker) return 'unchanged';
    const t = (text ?? '').trim();
    if (!t) return 'unchanged';
    for (const rule of RULES) {
        if (rule.patterns.some(p => p.test(t))) return rule.target;
    }
    return 'unchanged';
}

/** Is the transition `from → to` a single forward step on our whitelist? */
export function isSafeForwardTransition(from: string, to: string): boolean {
    const f = RANK[from as keyof typeof RANK];
    const target = RANK[to as keyof typeof RANK];
    if (f == null || target == null) return false;
    return target === f + 1;
}

/** Pick the Jira transition whose `toStatus` matches our target label. */
function findTransition(transitions: JiraTransition[], toLabel: string): JiraTransition | null {
    const match = transitions.find(t => t.toStatus.toLowerCase() === toLabel.toLowerCase());
    return match ?? null;
}

// --- runReconciliation ---------------------------------------------------

interface ReconcileOutcome {
    autoApplied: Array<{ issueKey: string; from: string; to: string }>;
    needsConfirm: ProposedTransition[];
    errors: Array<{ issueKey: string; message: string }>;
}

export async function runReconciliation(session: StandupSession): Promise<ReconcileOutcome> {
    const jira = getJiraClient();
    const outcome: ReconcileOutcome = { autoApplied: [], needsConfirm: [], errors: [] };

    for (const [aadId, response] of session.responses.entries()) {
        void aadId;
        for (const item of response.items) {
            const issue = (session.itemsByAssignee.get(response.userAadId) ?? [])
                .find(i => i.key === item.issueKey);
            if (!issue) continue;

            const target = classifyUpdateText(item.update, item.hasBlocker);
            if (target === 'unchanged' || target === issue.status) continue;

            try {
                const transitions = await jira.getTransitions(issue.key);
                const trans = findTransition(transitions, target);
                if (!trans) {
                    outcome.needsConfirm.push({
                        issueKey: issue.key, url: issue.url, summary: issue.summary,
                        statusFrom: issue.status, statusTo: target,
                        transitionId: 'unknown',
                        reason: `Jira does not offer a "${target}" transition from "${issue.status}"`,
                    });
                    continue;
                }

                if (isSafeForwardTransition(issue.status, target)) {
                    await jira.transitionIssue(issue.key, trans.id, `Auto-updated by Scrum Master (standup ${session.standupId}).`);
                    outcome.autoApplied.push({ issueKey: issue.key, from: issue.status, to: target });
                } else {
                    outcome.needsConfirm.push({
                        issueKey: issue.key, url: issue.url, summary: issue.summary,
                        statusFrom: issue.status, statusTo: target,
                        transitionId: trans.id,
                        reason: pickReason(issue.status, target),
                    });
                }
            } catch (e) {
                outcome.errors.push({ issueKey: issue.key, message: (e as Error).message });
            }
        }
    }

    return outcome;
}

function pickReason(from: string, to: string): string {
    const f = RANK[from as keyof typeof RANK];
    const t = RANK[to as keyof typeof RANK];
    if (f == null || t == null) return 'ambiguous mapping';
    if (t < f) return 'backwards move';
    if (t > f + 1) return 'skips a step';
    return 'needs confirmation';
}

/**
 * Called from summarizeStandup: runs reconciliation and, if any items need SM
 * approval, DMs the Scrum Master the transition-confirm card.
 * Best-effort — reconciliation is non-fatal to the standup summary flow.
 */
export async function reconcileAfterStandup(session: StandupSession): Promise<ReconcileOutcome> {
    const outcome = await runReconciliation(session);

    console.log(`[reconcile] ${session.standupId}: auto-applied=${outcome.autoApplied.length}, needs-confirm=${outcome.needsConfirm.length}, errors=${outcome.errors.length}`);

    if (outcome.needsConfirm.length === 0) return outcome;

    const members = await listTeamMembers();
    const sm = members.find(m => m.Role === 'SM');
    if (!sm?.conversationReference) {
        console.warn('[reconcile] No Scrum Master conversation ref — skipping confirm card.');
        return outcome;
    }

    const card = buildTransitionConfirmCard({
        standupId: session.standupId,
        sprintName: session.sprintName,
        autoAppliedCount: outcome.autoApplied.length,
        transitions: outcome.needsConfirm,
    });

    await sendProactive(sm.conversationReference, async ctx => {
        await ctx.sendActivity({ type: 'message', attachments: [card] } as Partial<Activity> as Activity);
    });

    return outcome;
}

// --- reconcile.apply / reconcile.skipAll handlers ------------------------

export async function handleReconcileSubmit(context: TurnContext): Promise<void> {
    const value = context.activity.value as Record<string, unknown> | undefined;
    const action = String(value?.action ?? '');
    const standupId = String(value?.standupId ?? '');
    if (action === 'reconcile.skipAll') {
        await context.sendActivity('Skipped — no board changes applied.');
        return;
    }
    if (action !== 'reconcile.apply') return;

    let transitions: ProposedTransition[] = [];
    try { transitions = JSON.parse(String(value?.transitions ?? '[]')); }
    catch { transitions = []; }

    const approvedKeys = new Set<string>();
    for (const t of transitions) {
        const approvedRaw = String(value?.[`approve_${t.issueKey}`] ?? 'false');
        if (approvedRaw === 'true') approvedKeys.add(t.issueKey);
    }
    if (approvedKeys.size === 0) {
        await context.sendActivity('No transitions were approved — nothing to apply.');
        return;
    }

    // Ack immediately so the Teams card invoke completes inside its ~15s window.
    // Then do the actual Jira writes in the background and post the outcome via a
    // proactive follow-up message.
    await context.sendActivity(`Applying ${approvedKeys.size} approved change${approvedKeys.size === 1 ? '' : 's'}…`);

    const ref = context.activity.getConversationReference();
    setImmediate(() => {
        applyApprovedTransitionsAsync(ref, transitions, approvedKeys, standupId).catch(err =>
            console.error('[reconcile] background apply failed:', (err as Error).message),
        );
    });
}

async function applyApprovedTransitionsAsync(
    ref: ConversationReference,
    transitions: ProposedTransition[],
    approvedKeys: Set<string>,
    standupId: string,
): Promise<void> {
    const jira = getJiraClient();
    const applied: string[] = [];
    const failed: string[] = [];
    for (const t of transitions) {
        if (!approvedKeys.has(t.issueKey)) continue;
        try {
            await jira.transitionIssue(
                t.issueKey,
                t.transitionId,
                `Approved by Scrum Master via Adaptive Card (standup ${standupId}).`,
            );
            applied.push(t.issueKey);
        } catch (e) {
            failed.push(`${t.issueKey}: ${(e as Error).message}`);
        }
    }

    const parts: string[] = [];
    if (applied.length) parts.push(`✅ Applied: ${applied.join(', ')}`);
    if (failed.length) parts.push(`⚠️ Failed: ${failed.join('; ')}`);
    const stamp = DateTime.now().toFormat('h:mm a');
    const summary = `Board updates at ${stamp} — ${parts.join(' · ')}`;

    await sendProactive(ref, async ctx => { await ctx.sendActivity(summary); });
}

// Small helper so tests can reach the classifier surface without importing the
// whole reconcile module machinery.
export const _internal = { classifyUpdateText, isSafeForwardTransition };

// (avoid unused-import warning under strict TS)
export type _KeepTypes = TeamMember | JiraIssue;
