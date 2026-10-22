// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * MVP 7 — Sprint-close Report (rev 2, 14 Jul 2026).
 *
 * Auto-generates the demo notes / retro data / release notes for a sprint and
 * posts the whole summary inline as a Teams message in the configured group
 * chat — no SharePoint file, no external link. Format follows the template the
 * manager provided (Completed → Deliverables → Deployments → Demo Highlights →
 * Release Notes → Action Items → Sprint Metrics).
 *
 * Triggered from the nightly cron once the sprint's `endDate` has passed, or on
 * demand from `POST /api/internal/nightly-check?force=report`.
 */

import { DateTime } from 'luxon';

import { getJiraClient, JiraIssue, JiraSprint } from '../services/jira';
import { getScheduleConfig } from '../config';
import { listItems, findByField } from '../services/sharepoint';
import { listTeamMembers } from '../services/team-roster';
import { sendProactive } from '../services/proactive';

interface BlockerFields {
    Title: string; StandupId: string; ReporterAadId: string; OwnerAadId: string;
    BlockerText: string; State: string; MeetingEventId?: string;
}
interface TeamsConfigFields {
    Title: string; TeamId: string; ChannelId: string; ConversationRef: string;
    ConfiguredByAadId: string; ConfiguredAtUtc: string;
}

// --- classification helpers ---------------------------------------------

const RX_DEPLOYMENT = /deploy|devops|ci\/cd|\bpipeline\b|release pipeline|azure app service|github actions/i;
const RX_ACCESSIBILITY = /accessibility|\ba11y\b|\baxe\b|wcag/i;
const RX_E2E = /\be2e\b|end.?to.?end|integration test|playwright|regression test/i;
const RX_PROD_DEPLOY = /production|prod deploy|uat|release/i;
const RX_TAG_PREFIX = /^\s*\[([^\]]+)\]\s*/; // strip leading [BE] / [FE] / [QA] etc.

function cleanSummary(s: string): string {
    return s.replace(RX_TAG_PREFIX, '').trim();
}

function firstLetterUpper(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Strip "As a X, I want Y so that Z" prefix and keep the core capability. */
function cleanUserStorySummary(summary: string): string {
    const m = summary.match(/^\s*As an?\s+[^,]+,\s*I want\s+(?:to\s+)?(.+?)\s+so\s+(?:that\s+)?I?\s*(.+)$/i);
    if (m) return `${firstLetterUpper(m[1].trim())} — ${m[2].trim()}`;
    return summary.trim();
}

function dedupeSimilar(items: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of items) {
        const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(raw);
    }
    return out;
}

// --- markdown builder ---------------------------------------------------

export function buildSprintReportMarkdown(opts: {
    sprint: JiraSprint;
    stories: JiraIssue[];         // parent-level Story / Bug / Task
    subtasks: JiraIssue[];        // Jira sub-tasks
    blockers: BlockerFields[];
    tz: string;
}): string {
    const { sprint, stories, subtasks, blockers, tz } = opts;
    const start = sprint.startDate ? DateTime.fromISO(sprint.startDate).setZone(tz).toFormat('dd LLL yyyy') : '—';
    const end = sprint.endDate ? DateTime.fromISO(sprint.endDate).setZone(tz).toFormat('dd LLL yyyy') : '—';

    // Slice work by outcome.
    const doneStories = stories.filter(i => i.issueType === 'Story' && i.status === 'Done');
    const missedStories = stories.filter(i => i.issueType === 'Story' && i.status !== 'Done');
    const doneBugs = stories.filter(i => i.issueType === 'Bug' && i.status === 'Done');
    const openBugs = stories.filter(i => i.issueType === 'Bug' && i.status !== 'Done');

    const allTasksDone = subtasks.filter(i => i.status === 'Done');
    const allTasksTotal = subtasks.length;

    const deploymentTasks = allTasksDone.filter(t => RX_DEPLOYMENT.test(t.summary));
    const prodDeployments = deploymentTasks.filter(t => RX_PROD_DEPLOY.test(t.summary));
    const accessibilityTasks = allTasksDone.filter(t => RX_ACCESSIBILITY.test(t.summary));
    const e2eTasks = allTasksDone.filter(t => RX_E2E.test(t.summary));

    const lines: string[] = [];

    // === Header ===
    lines.push(`### ${sprint.name} — Sprint Summary (${start} – ${end})`);
    lines.push('');

    // === Completed User Stories ===
    lines.push('✅ **Completed User Stories**');
    lines.push('');
    if (doneStories.length === 0) {
        lines.push('- _No user stories reached Done this sprint._');
    } else {
        for (const s of doneStories) {
            lines.push(`- ${cleanUserStorySummary(s.summary)} ([${s.key}](${s.url}))`);
        }
    }
    lines.push('');

    // === Key Deliverables ===
    lines.push('✅ **Key Deliverables**');
    lines.push('');
    const deliverables = dedupeSimilar(
        allTasksDone
            .filter(t => !RX_DEPLOYMENT.test(t.summary))    // deployments have their own section
            .map(t => firstLetterUpper(cleanSummary(t.summary))),
    );
    if (deliverables.length === 0) {
        lines.push('- _No deliverables shipped this sprint._');
    } else {
        for (const d of deliverables.slice(0, 12)) lines.push(`- ${d}`);
    }
    lines.push('');

    // === Deployments ===
    lines.push('✅ **Deployments**');
    lines.push('');
    if (deploymentTasks.length === 0) {
        lines.push('- _No deployment tasks completed._');
    } else {
        for (const d of deploymentTasks) lines.push(`- ${cleanSummary(d.summary)} ([${d.key}](${d.url}))`);
    }
    lines.push('');

    // === Demo Highlights ===
    lines.push('### Demo Highlights');
    lines.push('');
    const highlights = buildDemoHighlights(doneStories, allTasksDone, doneBugs);
    if (highlights.length === 0) {
        lines.push('- _Nothing shipped this sprint._');
    } else {
        for (const h of highlights) lines.push(`- ${h}`);
    }
    lines.push('');

    // === Release Notes ===
    lines.push('### Release Notes');
    lines.push('');
    lines.push('**New Features**');
    if (doneStories.length === 0) {
        lines.push('- _None._');
    } else {
        for (const s of doneStories) lines.push(`- ${cleanUserStorySummary(s.summary)}`);
    }
    lines.push('');
    lines.push('**Improvements**');
    const improvements = extractImprovements(allTasksDone);
    if (improvements.length === 0) {
        lines.push('- _None._');
    } else {
        for (const imp of improvements) lines.push(`- ${imp}`);
    }
    if (doneBugs.length > 0) {
        lines.push('');
        lines.push('**Bug Fixes**');
        for (const b of doneBugs) lines.push(`- ${cleanSummary(b.summary)} ([${b.key}](${b.url}))`);
    }
    lines.push('');

    // === Action Items for Next Sprint ===
    lines.push('### Action Items for Next Sprint');
    lines.push('');
    lines.push('| Action Item | Owner | Target Sprint |');
    lines.push('|---|---|---|');
    const actions = buildActionItems(missedStories, openBugs, allTasksDone, blockers);
    if (actions.length === 0) {
        lines.push('| _No follow-up actions identified._ | — | — |');
    } else {
        for (const a of actions) lines.push(`| ${a.item} | ${a.owner} | ${a.sprint} |`);
    }
    lines.push('');

    // === Carry-over (only if any) ===
    if (missedStories.length > 0) {
        lines.push('### Carry-over to Next Sprint');
        lines.push('');
        for (const m of missedStories) {
            lines.push(`- [${m.key}](${m.url}) — ${cleanUserStorySummary(m.summary)} — _${m.status}_`);
        }
        lines.push('');
    }

    // === Sprint Metrics ===
    lines.push('### Sprint Metrics');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|---|---|');
    lines.push(`| User Stories Delivered | **${doneStories.length}** of ${doneStories.length + missedStories.length} committed |`);
    lines.push(`| Tasks Completed | **${allTasksDone.length}** of ${allTasksTotal} |`);
    lines.push(`| Bugs Resolved | **${doneBugs.length}** |`);
    lines.push(`| Deployments | **${deploymentTasks.length}** |`);
    lines.push(`| Production / UAT Releases | **${prodDeployments.length}** |`);
    lines.push(`| Accessibility Reviews | **${accessibilityTasks.length}** |`);
    lines.push(`| E2E Test Executions | **${e2eTasks.length}** |`);
    if (blockers.length > 0) {
        lines.push(`| Blockers Encountered | **${blockers.length}** |`);
    }
    lines.push('');

    return lines.join('\n');
}

function buildDemoHighlights(stories: JiraIssue[], tasksDone: JiraIssue[], bugs: JiraIssue[]): string[] {
    const highlights: string[] = [];
    for (const s of stories.slice(0, 5)) highlights.push(cleanUserStorySummary(s.summary));
    if (tasksDone.some(t => RX_ACCESSIBILITY.test(t.summary))) {
        highlights.push('Accessible and inclusive UI with a11y checks in CI');
    }
    if (tasksDone.some(t => RX_E2E.test(t.summary))) {
        highlights.push('Automated E2E test coverage safeguarding critical flows');
    }
    if (tasksDone.some(t => RX_DEPLOYMENT.test(t.summary))) {
        highlights.push('Deployed across environments via automated CI/CD pipeline');
    }
    if (bugs.length > 0) {
        highlights.push(`Fixed ${bugs.length} production issue(s), improving stability`);
    }
    return highlights;
}

function extractImprovements(tasksDone: JiraIssue[]): string[] {
    const buckets: string[] = [];
    if (tasksDone.some(t => RX_ACCESSIBILITY.test(t.summary))) buckets.push('Accessibility compliance (WCAG 2.1 AA)');
    if (tasksDone.some(t => /responsive|mobile|breakpoint|tablet/i.test(t.summary))) buckets.push('Responsive user experience across viewports');
    if (tasksDone.some(t => /api|backend|endpoint|rest/i.test(t.summary))) buckets.push('Backend integrations and API validations');
    if (tasksDone.some(t => /jwt|auth|argon|rate.?limit|security/i.test(t.summary))) buckets.push('Authentication and security hardening');
    if (tasksDone.some(t => /prisma|schema|migration|database/i.test(t.summary))) buckets.push('Data model and migration foundations');
    if (tasksDone.some(t => /performance|cache|debounce|optimization/i.test(t.summary))) buckets.push('Performance optimisations (debounce, caching)');
    return buckets;
}

interface ActionItem { item: string; owner: string; sprint: string; }

function buildActionItems(
    missedStories: JiraIssue[],
    openBugs: JiraIssue[],
    tasksDone: JiraIssue[],
    blockers: BlockerFields[],
): ActionItem[] {
    const actions: ActionItem[] = [];
    // Carry-over stories.
    for (const m of missedStories.slice(0, 3)) {
        actions.push({
            item: `Carry-over: ${cleanUserStorySummary(m.summary)} (${m.key})`,
            owner: m.assignee?.displayName ?? 'Unassigned',
            sprint: 'Sprint 2',
        });
    }
    // Open bugs.
    for (const b of openBugs.slice(0, 3)) {
        actions.push({
            item: `Close open bug: ${cleanSummary(b.summary)} (${b.key})`,
            owner: b.assignee?.displayName ?? 'Bug triage',
            sprint: 'Sprint 2',
        });
    }
    // Cross-cutting suggestions when the theme was missing this sprint.
    if (!tasksDone.some(t => RX_E2E.test(t.summary))) {
        actions.push({ item: 'Increase automation coverage (E2E + regression)', owner: 'QA Team', sprint: 'Sprint 2' });
    }
    if (!tasksDone.some(t => RX_ACCESSIBILITY.test(t.summary))) {
        actions.push({ item: 'Introduce accessibility checks in CI/CD', owner: 'Dev Team', sprint: 'Sprint 2' });
    }
    if (!tasksDone.some(t => /deploy.*checklist|readiness|runbook/i.test(t.summary))) {
        actions.push({ item: 'Create deployment readiness checklist', owner: 'Release Team', sprint: 'Sprint 2' });
    }
    if (blockers.length >= 2) {
        actions.push({ item: 'Retro: root-cause the top blockers to prevent recurrence', owner: 'Scrum Master', sprint: 'Sprint 2' });
    }
    return actions.slice(0, 6);
}

// --- entry point --------------------------------------------------------

export async function runSprintCloseReport(opts?: { force?: boolean; sprintId?: number }):
    Promise<{ uploaded: boolean; url?: string; note?: string; counts?: { stories: number; tasksDone: number; deployments: number; bugs: number } }> {
    const jira = getJiraClient();
    const tz = getScheduleConfig().timezone;

    // Pick sprint: explicit id > active sprint.
    let sprint: JiraSprint | null = null;
    if (opts?.sprintId) sprint = await jira.getSprint(opts.sprintId);
    else sprint = await jira.getActiveSprint();
    if (!sprint) return { uploaded: false, note: 'No sprint found.' };

    const nowMs = Date.now();
    const endMs = sprint.endDate ? DateTime.fromISO(sprint.endDate).toMillis() : NaN;
    const isEnded = Number.isFinite(endMs) && endMs < nowMs;
    if (!isEnded && !opts?.force) {
        return { uploaded: false, note: `Sprint ${sprint.name} not ended yet (endDate=${sprint.endDate}). Pass force=true for demo.` };
    }

    const [stories, blockersRows] = await Promise.all([
        jira.searchSprintIssues(sprint.id),
        listItems<BlockerFields>('blockers'),
    ]);
    const parentKeys = stories.map(s => s.key);
    const subtasks = await jira.getSprintSubtasks(sprint.id, parentKeys);
    const blockers = blockersRows.map(r => r.fields);

    const markdown = buildSprintReportMarkdown({ sprint, stories, subtasks, blockers, tz });

    // Post inline in the configured Teams channel — no SharePoint upload.
    const configRows = await findByField<TeamsConfigFields>('teamsConfig', 'Title', 'primary').catch(() => []);
    const channelRefRaw = configRows[0]?.fields?.ConversationRef;

    let delivered = false;
    if (channelRefRaw) {
        try {
            const ref = JSON.parse(channelRefRaw);
            await sendProactive(ref, async ctx => { await ctx.sendActivity(markdown); });
            delivered = true;
            console.log(`[report] Posted Sprint Close Report inline for ${sprint.name}`);
        } catch (e) {
            console.warn('[report] Bad TeamsConfig ref — falling back to SM DM:', (e as Error).message);
        }
    }
    if (!delivered) {
        const members = await listTeamMembers();
        const sm = members.find(m => m.Role === 'SM');
        if (sm?.conversationReference) {
            await sendProactive(sm.conversationReference, async ctx => { await ctx.sendActivity(markdown); });
            delivered = true;
            console.log('[report] Posted Sprint Close Report to SM DM (channel unavailable)');
        }
    }

    const doneStories = stories.filter(i => i.issueType === 'Story' && i.status === 'Done').length;
    const tasksDone = subtasks.filter(i => i.status === 'Done').length;
    const doneBugs = stories.filter(i => i.issueType === 'Bug' && i.status === 'Done').length;
    const deployments = subtasks.filter(t => t.status === 'Done' && RX_DEPLOYMENT.test(t.summary)).length;

    return {
        uploaded: delivered,
        counts: { stories: doneStories, tasksDone, deployments, bugs: doneBugs },
        note: delivered ? undefined : 'No delivery target — no TeamsConfig.primary and no SM ConversationRef.',
    };
}
