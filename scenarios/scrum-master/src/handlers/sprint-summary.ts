// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Sprint Summary Report (mid-sprint, T-2 days).
 *
 * Differs from the existing MVP 7 sprint-close report:
 *   - Fires **2 days before sprint end**, not at close.
 *   - Operates at **task granularity** (Jira sub-tasks), not parent stories.
 *   - Uses **RAG / SLA** classification with per-task due-date rules.
 *   - Output format is a management-friendly Markdown table with an
 *     executive summary at the top.
 *
 * Trigger paths:
 *   - Manual / demo:  POST /api/internal/sprint-summary?force=true
 *   - Scheduled:      the nightly cron calls runSprintSummary() and it
 *                     only produces output on the day == sprintEnd - 2.
 */

import { DateTime } from 'luxon';

import { getJiraClient, JiraIssue, JiraSprint } from '../services/jira';
import { getScheduleConfig } from '../config';
import { findByField } from '../services/sharepoint';
import { listTeamMembers } from '../services/team-roster';
import { sendProactive } from '../services/proactive';

interface TeamsConfigFields {
    Title: string; TeamId: string; ChannelId: string; ConversationRef: string;
    ConfiguredByAadId: string; ConfiguredAtUtc: string;
}

// --- classification ------------------------------------------------------

type Rag = 'Red' | 'Amber' | 'Green';

interface ClassifiedTask {
    key: string;
    summary: string;
    parentKey: string | null;
    parentSummary: string;
    assignee: string;
    dueDate: string | null;    // yyyy-mm-dd
    status: string;
    daysFromEta: number | null; // negative = overdue, 0 = today, positive = future
    rag: Rag;
    slaBreached: boolean;
    url: string;
}

/** Amber if the ETA is within this many days (inclusive). */
const AMBER_WINDOW_DAYS = 2;

function classify(task: JiraIssue, parentSummary: string, todayIso: string): ClassifiedTask {
    const status = task.status;
    const isDone = status === 'Done';
    let daysFromEta: number | null = null;
    if (task.dueDate) {
        const due = DateTime.fromISO(task.dueDate);
        const today = DateTime.fromISO(todayIso);
        daysFromEta = Math.round(due.diff(today, 'days').days);
    }

    let rag: Rag;
    let slaBreached = false;
    if (isDone) {
        rag = 'Green';
    } else if (daysFromEta !== null && daysFromEta < 0) {
        rag = 'Red';
        slaBreached = true;
    } else if (daysFromEta !== null && daysFromEta <= AMBER_WINDOW_DAYS) {
        rag = 'Amber';
    } else {
        rag = 'Green';
    }

    return {
        key: task.key,
        summary: task.summary,
        parentKey: task.parentKey,
        parentSummary,
        assignee: task.assignee?.displayName ?? '(unassigned)',
        dueDate: task.dueDate,
        status,
        daysFromEta,
        rag,
        slaBreached,
        url: task.url,
    };
}

const RAG_EMOJI: Record<Rag, string> = { Red: '🟥', Amber: '🟧', Green: '🟩' };

function etaLabel(t: ClassifiedTask): string {
    if (!t.dueDate) return '(no ETA)';
    if (t.daysFromEta === null) return t.dueDate;
    if (t.daysFromEta < 0) return `${t.dueDate} (overdue ${Math.abs(t.daysFromEta)}d)`;
    if (t.daysFromEta === 0) return `${t.dueDate} (today)`;
    return `${t.dueDate} (+${t.daysFromEta}d)`;
}

function overallHealth(reds: number, ambers: number, pending: number): string {
    if (reds >= 3) return '🟥 **At Serious Risk**';
    if (reds > 0) return '🟥 **At Risk**';
    if (ambers >= Math.max(1, Math.floor(pending / 3))) return '🟧 **Watch**';
    return '🟩 **On Track**';
}

// --- markdown builder ----------------------------------------------------

export function buildSprintSummaryMarkdown(opts: {
    sprint: JiraSprint;
    parentStoriesByKey: Map<string, JiraIssue>;
    tasks: ClassifiedTask[];
    tz: string;
    generatedNowIso: string;
    daysRemaining: number;
}): string {
    const { sprint, parentStoriesByKey, tasks, tz, generatedNowIso, daysRemaining } = opts;
    const nowLocal = DateTime.fromISO(generatedNowIso).setZone(tz).toFormat('ccc d LLL yyyy, HH:mm ZZZZ');
    const startLocal = sprint.startDate ? DateTime.fromISO(sprint.startDate).setZone(tz).toFormat('ccc d LLL') : '—';
    const endLocal = sprint.endDate ? DateTime.fromISO(sprint.endDate).setZone(tz).toFormat('ccc d LLL yyyy') : '—';

    const totalUserStories = parentStoriesByKey.size;
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(t => t.status === 'Done').length;
    const pendingTasks = tasks.filter(t => t.status !== 'Done');
    const slaBreached = pendingTasks.filter(t => t.slaBreached).length;
    const reds = pendingTasks.filter(t => t.rag === 'Red');
    const ambers = pendingTasks.filter(t => t.rag === 'Amber');

    // Sort pending tasks by ETA ascending (missing ETA to the end).
    const sortedPending = [...pendingTasks].sort((a, b) => {
        if (a.dueDate && !b.dueDate) return -1;
        if (!a.dueDate && b.dueDate) return 1;
        if (!a.dueDate && !b.dueDate) return 0;
        return DateTime.fromISO(a.dueDate!).toMillis() - DateTime.fromISO(b.dueDate!).toMillis();
    });

    const lines: string[] = [];
    lines.push(`# 📋 Sprint Summary Report — ${sprint.name}`);
    lines.push('');
    lines.push(`**Generated:** ${nowLocal} — **T-${Math.max(0, daysRemaining)} days from sprint end**  `);
    lines.push(`**Sprint period:** ${startLocal} → ${endLocal}`);
    lines.push('');

    // ---- Executive summary ----
    lines.push('## 🎯 Executive Summary');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|---|---|');
    lines.push(`| Sprint duration | ${startLocal} → ${endLocal} |`);
    lines.push(`| Days remaining | **${daysRemaining}** |`);
    lines.push(`| Total user stories | ${totalUserStories} |`);
    lines.push(`| Total tasks | ${totalTasks} |`);
    lines.push(`| Completed tasks | ${completedTasks} |`);
    lines.push(`| Pending tasks | ${pendingTasks.length} |`);
    lines.push(`| SLA breached | ${slaBreached} |`);
    lines.push(`| **Overall health** | ${overallHealth(reds.length, ambers.length, pendingTasks.length)} |`);
    lines.push('');

    // ---- Critical overdue ----
    lines.push('### 🔴 Critical overdue tasks');
    if (reds.length === 0) {
        lines.push('_None — no tasks past their ETA._');
    } else {
        for (const t of reds) {
            lines.push(`- **${t.key}** — ${t.summary} · owner **${t.assignee}** · ETA ${etaLabel(t)} · status **${t.status}**`);
        }
    }
    lines.push('');

    // ---- Requiring attention ----
    lines.push('### ⚠️ Requiring immediate attention (next 2 days)');
    if (ambers.length === 0) {
        lines.push('_None._');
    } else {
        for (const t of ambers) {
            lines.push(`- **${t.key}** — ${t.summary} · owner **${t.assignee}** · ETA ${etaLabel(t)} · status **${t.status}**`);
        }
    }
    lines.push('');

    // ---- Risks ----
    lines.push('### 🔎 Risks to sprint completion');
    const risks: string[] = [];
    if (reds.length > 0) risks.push(`${reds.length} task(s) already past ETA — highest-impact items must be re-planned or escalated today.`);
    if (ambers.length >= 3) risks.push(`${ambers.length} tasks are within the amber window (≤ ${AMBER_WINDOW_DAYS} days to ETA) — pipeline could stall if any slip.`);
    const overloaded = pendingOwnerLoad(pendingTasks);
    for (const [name, n] of overloaded) if (n >= 4) risks.push(`${name} has ${n} pending tasks — potential over-allocation risk.`);
    if (risks.length === 0) risks.push('_No specific risks detected — sprint on track._');
    for (const r of risks) lines.push(`- ${r}`);
    lines.push('');

    // ---- Prioritised pending list ----
    lines.push('## 📊 Pending Tasks — prioritised by ETA (oldest first)');
    lines.push('');
    lines.push('| RAG | Task | User Story | Owner | ETA | Status | SLA |');
    lines.push('|---|---|---|---|---|---|---|');
    if (sortedPending.length === 0) {
        lines.push('| — | _No pending tasks._ | | | | | |');
    } else {
        for (const t of sortedPending) {
            const usLabel = t.parentKey ? `[${t.parentKey}] ${trim(t.parentSummary, 60)}` : '(no parent)';
            const sla = t.slaBreached ? '❌ Breached' : (t.rag === 'Amber' ? '⚠️ Near breach' : '✅ Within SLA');
            lines.push(`| ${RAG_EMOJI[t.rag]} | [${t.key}](${t.url}) — ${trim(t.summary, 60)} | ${usLabel} | ${t.assignee} | ${etaLabel(t)} | ${t.status} | ${sla} |`);
        }
    }
    lines.push('');

    // ---- Completed (separate section) ----
    const completed = tasks.filter(t => t.status === 'Done').sort((a, b) => a.key.localeCompare(b.key));
    lines.push(`## ✅ Completed tasks (${completed.length})`);
    if (completed.length === 0) {
        lines.push('_No tasks completed yet._');
    } else {
        lines.push('');
        lines.push('| Task | User Story | Owner | Completed by ETA |');
        lines.push('|---|---|---|---|');
        for (const t of completed) {
            const usLabel = t.parentKey ? `[${t.parentKey}] ${trim(t.parentSummary, 60)}` : '(no parent)';
            const onTime = t.dueDate ? '✅' : '—';
            lines.push(`| [${t.key}](${t.url}) — ${trim(t.summary, 60)} | ${usLabel} | ${t.assignee} | ${onTime} ${etaLabel(t)} |`);
        }
    }
    lines.push('');

    // ---- Footer ----
    lines.push('---');
    lines.push(`_Report auto-generated by Scrum Master. Rules: 🟥 ETA passed & pending / SLA breached · 🟧 ETA within ${AMBER_WINDOW_DAYS} days & pending · 🟩 Done or within ETA._`);

    return lines.join('\n');
}

function pendingOwnerLoad(pending: ClassifiedTask[]): Array<[string, number]> {
    const m = new Map<string, number>();
    for (const t of pending) m.set(t.assignee, (m.get(t.assignee) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
}

function trim(s: string, n: number): string {
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + '…';
}

// --- entry point ---------------------------------------------------------

export async function runSprintSummary(opts?: {
    force?: boolean;
    sprintId?: number;
}): Promise<{ uploaded: boolean; url?: string; note?: string; counts?: { total: number; pending: number; red: number; amber: number } }> {
    const jira = getJiraClient();
    const tz = getScheduleConfig().timezone;

    const sprint = opts?.sprintId ? await jira.getSprint(opts.sprintId) : await jira.getActiveSprint();
    if (!sprint) return { uploaded: false, note: 'No active sprint.' };
    if (!sprint.endDate) return { uploaded: false, note: `Sprint ${sprint.name} has no endDate.` };

    // Gate: fire only on end-2 unless forced.
    const now = DateTime.now().setZone(tz);
    const end = DateTime.fromISO(sprint.endDate).setZone(tz);
    const daysRemaining = Math.ceil(end.diff(now, 'days').days);
    if (!opts?.force && daysRemaining !== 2) {
        return { uploaded: false, note: `Not the T-2 day. daysRemaining=${daysRemaining}. Pass force=true for demo.` };
    }

    // Fetch parent stories + sub-tasks in parallel.
    const parents = await jira.searchSprintIssues(sprint.id);
    const parentKeys = parents.map(p => p.key);
    const subtasks = await jira.getSprintSubtasks(sprint.id, parentKeys);

    // Build lookup for parent summaries.
    const parentByKey = new Map<string, JiraIssue>();
    for (const p of parents) parentByKey.set(p.key, p);

    // Classify. If a sprint has zero sub-tasks (e.g. flat structure), classify
    // parents as tasks so the report is still useful.
    const rawTasks: JiraIssue[] = subtasks.length > 0 ? subtasks : parents;
    const todayIso = now.toISODate() ?? new Date().toISOString().slice(0, 10);
    const classified = rawTasks.map(t => classify(t, parentByKey.get(t.parentKey ?? '')?.summary ?? '', todayIso));

    const markdown = buildSprintSummaryMarkdown({
        sprint,
        parentStoriesByKey: parentByKey,
        tasks: classified,
        tz,
        generatedNowIso: now.toISO() ?? new Date().toISOString(),
        daysRemaining,
    });

    // Post the FULL report inline as a Teams message to the configured channel.
    // No SharePoint upload — the manager wants the summary readable directly in the group chat.
    const configRows = await findByField<TeamsConfigFields>('teamsConfig', 'Title', 'primary').catch(() => []);
    const channelRefRaw = configRows[0]?.fields?.ConversationRef;

    const pending = classified.filter(t => t.status !== 'Done');
    const reds = pending.filter(t => t.rag === 'Red');
    const ambers = pending.filter(t => t.rag === 'Amber');

    let delivered = false;
    if (channelRefRaw) {
        try {
            const ref = JSON.parse(channelRefRaw);
            await sendProactive(ref, async ctx => { await ctx.sendActivity(markdown); });
            delivered = true;
            console.log(`[sprint-summary] Posted to configured channel (${classified.length} tasks, ${reds.length} red / ${ambers.length} amber)`);
        } catch (e) {
            console.warn('[sprint-summary] Bad TeamsConfig ref — falling back to SM DM:', (e as Error).message);
        }
    }
    if (!delivered) {
        const members = await listTeamMembers();
        const sm = members.find(m => m.Role === 'SM');
        if (sm?.conversationReference) {
            await sendProactive(sm.conversationReference, async ctx => { await ctx.sendActivity(markdown); });
            delivered = true;
            console.log('[sprint-summary] Posted to SM DM (channel unavailable)');
        }
    }

    return {
        uploaded: delivered,
        counts: { total: classified.length, pending: pending.length, red: reds.length, amber: ambers.length },
        note: delivered ? undefined : 'No delivery target — no TeamsConfig.primary and no SM conversation ref.',
    };
}

