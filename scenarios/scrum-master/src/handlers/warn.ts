// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * MVP 4 — Warn (sprint-goal risk detection).
 *
 * Runs on the nightly timer. For each active sprint, compute:
 *   - progress: elapsed time as % of sprint duration
 *   - toDoRatio: story points still in `To Do` ÷ committed points
 * If `progress ≥ WARN_SPRINT_PROGRESS_PCT` AND `toDoRatio ≥ WARN_TODO_PCT`,
 * emit a SprintRisks row and DM the SM a plain-text risk report.
 *
 * Falls back to item count when any issue lacks valid story points
 * (common on real boards).
 */

import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import { getJiraClient, JiraIssue, JiraSprint } from '../services/jira';
import { getWarnConfig, getScheduleConfig } from '../config';
import { claimItemState, claimSprintRisk, updateItem } from '../services/sharepoint';
import { listTeamMembers } from '../services/team-roster';
import { sendProactive } from '../services/proactive';

interface SprintRiskFields {
    Title: string;
    SprintId: string;
    DetectedUtc: string;
    Reason: string;
    PointsToDoPct: number;
    Payload: string;
    State?: 'pending' | 'claimed' | 'delivered';
    DeliveredUtc?: string;
}

export interface RiskAssessment {
    sprintId: number;
    sprintName: string;
    progressPct: number;
    toDoPct: number;
    itemsToDo: number;
    itemsTotal: number;
    pointsToDo: number;
    pointsTotal: number;
    usePoints: boolean;      // false = we fell back to item counts
    atRisk: boolean;
    reason: string;
}

export function assessSprint(sprint: JiraSprint, issues: JiraIssue[], nowUtc = new Date()): RiskAssessment {
    const cfg = getWarnConfig();
    let progressPct = 0;
    if (sprint.startDate && sprint.endDate) {
        const start = DateTime.fromISO(sprint.startDate).toMillis();
        const end = DateTime.fromISO(sprint.endDate).toMillis();
        const now = nowUtc.getTime();
        if (end > start) progressPct = Math.max(0, Math.min(1, (now - start) / (end - start)));
    }

    const hasValidEstimate = (issue: JiraIssue): boolean =>
        typeof issue.storyPoints === 'number' && Number.isFinite(issue.storyPoints) && issue.storyPoints >= 0;
    const pointsTotal = issues.reduce((s, i) => s + (hasValidEstimate(i) ? i.storyPoints! : 0), 0);
    const pointsToDo = issues.filter(i => i.status === 'To Do').reduce((s, i) => s + (hasValidEstimate(i) ? i.storyPoints! : 0), 0);
    const itemsTotal = issues.length;
    const itemsToDo = issues.filter(i => i.status === 'To Do').length;

    const usePoints = issues.every(hasValidEstimate) && Number.isFinite(pointsTotal) && pointsTotal > 0;
    const toDoPct = usePoints
        ? (pointsTotal > 0 ? pointsToDo / pointsTotal : 0)
        : (itemsTotal > 0 ? itemsToDo / itemsTotal : 0);

    const atRisk = progressPct >= cfg.sprintProgressPct && toDoPct >= cfg.todoPct;

    const reason = atRisk
        ? `${Math.round(toDoPct * 100)}% of ${usePoints ? 'points' : 'items'} still in To Do at ${Math.round(progressPct * 100)}% sprint duration ` +
        `(thresholds: ≥${Math.round(cfg.todoPct * 100)}% To Do at ≥${Math.round(cfg.sprintProgressPct * 100)}% progress)`
        : 'within thresholds';

    return {
        sprintId: sprint.id, sprintName: sprint.name,
        progressPct, toDoPct,
        itemsToDo, itemsTotal, pointsToDo, pointsTotal,
        usePoints, atRisk, reason,
    };
}

export async function runWarnCheck(opts?: { forceAlert?: boolean }): Promise<RiskAssessment | null> {
    const jira = getJiraClient();
    const sprint = await jira.getActiveSprint();
    if (!sprint) {
        console.log('[warn] No active sprint.');
        return null;
    }
    const issues = await jira.searchSprintIssues(sprint.id);
    const assessment = assessSprint(sprint, issues);
    console.log(`[warn] ${assessment.sprintName}: progress=${(assessment.progressPct * 100).toFixed(0)}% toDo=${(assessment.toDoPct * 100).toFixed(0)}% atRisk=${assessment.atRisk} forceAlert=${!!opts?.forceAlert}`);
    if (!assessment.atRisk && !opts?.forceAlert) return assessment;

    // If we're only firing because of forceAlert, still write the row + DM so the
    // demo shows the full path — but override the reason to explain why.
    if (!assessment.atRisk && opts?.forceAlert) {
        assessment.reason = `Forced alert (thresholds not tripped): ${assessment.reason}`;
    }

    const nowUtc = new Date().toISOString();
    const riskId = `${assessment.sprintId}#${nowUtc.slice(0, 10)}${opts?.forceAlert ? `#${randomUUID()}` : ''}`;
    const claimId = await claimSprintRisk<SprintRiskFields>({
        Title: riskId,
        SprintId: String(assessment.sprintId),
        DetectedUtc: nowUtc,
        Reason: assessment.reason,
        PointsToDoPct: Math.round(assessment.toDoPct * 100),
        Payload: JSON.stringify(assessment),
    });
    if (!claimId) {
        console.log(`[warn] Risk already claimed or delivered (${riskId}) — skipping notify.`);
        return assessment;
    }

    let sendStarted = false;
    let confirmedRejection = false;
    try {
        // DM the SM. Keep it plain-text for the POC.
        const members = await listTeamMembers();
        const sm = members.find(m => m.Role === 'SM');
        if (!sm?.conversationReference) {
            throw new Error('[warn] No SM conversation reference; risk alert remains pending.');
        }

        const tz = getScheduleConfig().timezone;
        const endLocal = sprint.endDate
            ? DateTime.fromISO(sprint.endDate).setZone(tz).toFormat('ccc d LLL')
            : 'unknown';

        const message =
            `⚠️ **Sprint risk detected — ${assessment.sprintName}**\n\n` +
            `• Progress: ${(assessment.progressPct * 100).toFixed(0)}% elapsed (ends ${endLocal})\n` +
            `• In To Do: ${assessment.usePoints ? `${assessment.pointsToDo}/${assessment.pointsTotal} pts` : `${assessment.itemsToDo}/${assessment.itemsTotal} items`} (${(assessment.toDoPct * 100).toFixed(0)}%)\n\n` +
            `**Reason:** ${assessment.reason}\n\n` +
            `Consider re-planning, splitting large items, or narrowing the sprint goal.`;

        const delivery = await sendProactive(sm.conversationReference, async ctx => {
            sendStarted = true;
            try {
                await ctx.sendActivity(message);
            } catch (error) {
                const status = (error as any)?.statusCode ?? (error as any)?.status;
                // Timeouts and transport/server failures may have accepted the DM.
                confirmedRejection = typeof status === 'number' && status >= 400 && status < 500 && status !== 408;
                throw error;
            }
        });
        if (!delivery.ok) {
            throw new Error(`[warn] Risk alert delivery failed: ${delivery.error ?? 'unknown send failure'}`);
        }
        sendStarted = true;
        await updateItem<SprintRiskFields>('sprintRisks', claimId, {
            State: 'delivered',
            DeliveredUtc: new Date().toISOString(),
        });
    } catch (error) {
        // Never replay an accepted/uncertain send, including failed persistence.
        if (!sendStarted || confirmedRejection) {
            await claimItemState('sprintRisks', claimId, 'claimed', 'pending');
        }
        throw error;
    }

    return assessment;
}
