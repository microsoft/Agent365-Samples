// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Career Coach — deterministic service layer.
 *
 * Every piece of "business logic" that used to be delegated to the LLM lives here as
 * pure TypeScript. The LLM keeps three well-scoped jobs:
 *   1. Understand free-text user intent ("I want to be an AI Engineer").
 *   2. Generate 5 quiz questions from a course (small focused sub-call in llm-tasks.ts).
 *   3. Grade short-answer responses (small focused sub-call in llm-tasks.ts).
 *   4. Compose the completion email prose (small focused sub-call in llm-tasks.ts).
 *
 * Everything else — gap analysis, course ranking, saving UserState, syncing progress,
 * grading MCQ, bumping levels, recomputing goals, firing milestone/completion cards —
 * is deterministic code below. That makes card submissions:
 *   - Fast (<1s vs 10-30s for an LLM turn)
 *   - Reliable (no hallucinated GUIDs, no wrong skill bumped, no bogus 100% claims)
 *   - Testable (pure functions with obvious inputs/outputs)
 */

import { Client as MsGraphClient } from '@microsoft/microsoft-graph-client';
import {
    SP_CONFIG,
    CompetencyFrameworkRow, LearningCatalogRow,
    UserState, UserGoal, UserSkill, UserLearningRecord, UserLearningQuizSummary,
    LearningPortalStatusRow,
} from './career-coach-types';
import { getColumnMap, toDisplayFields, toInternalFields } from './sharepoint-column-map';
import { getSiteId, getListIdByName } from './graph-service';

// ============================================================================
// Read helpers — thin wrappers that give back typed rows keyed by display name.
// ============================================================================

async function pagedItems(graph: MsGraphClient, siteId: string, listId: string): Promise<Array<{ id: string; fields: Record<string, any> }>> {
    const colMap = await getColumnMap(graph, siteId, listId);
    const rows: Array<{ id: string; fields: Record<string, any> }> = [];
    let url: string | undefined = `/sites/${siteId}/lists/${listId}/items?$expand=fields&$top=200`;
    while (url) {
        const page: any = await graph.api(url).get();
        for (const item of page?.value ?? []) {
            const fields = toDisplayFields(item.fields ?? {}, colMap);
            rows.push({ id: item.id, fields });
        }
        url = page?.['@odata.nextLink'] ? String(page['@odata.nextLink']).replace('https://graph.microsoft.com/v1.0', '') : undefined;
    }
    return rows;
}

export async function readCompetencyFramework(graph: MsGraphClient, siteId?: string): Promise<CompetencyFrameworkRow[]> {
    const site = siteId ?? await getSiteId();
    const listId = await getListIdByName(site, SP_CONFIG.lists.competencyFramework);
    if (!listId) throw new Error(`List not found: ${SP_CONFIG.lists.competencyFramework}`);
    const items = await pagedItems(graph, site, listId);
    return items.map((r) => r.fields as unknown as CompetencyFrameworkRow);
}

export async function readLearningCatalog(graph: MsGraphClient, siteId?: string): Promise<LearningCatalogRow[]> {
    const site = siteId ?? await getSiteId();
    const listId = await getListIdByName(site, SP_CONFIG.lists.learningCatalog);
    if (!listId) throw new Error(`List not found: ${SP_CONFIG.lists.learningCatalog}`);
    const items = await pagedItems(graph, site, listId);
    return items.map((r) => r.fields as unknown as LearningCatalogRow);
}

export interface UserStateRecord { itemId: string; siteId: string; listId: string; state: UserState }

/** Reads the UserState row for one user. Returns null if the user has no plan yet. */
export async function readUserState(graph: MsGraphClient, userAADId: string, siteId?: string): Promise<UserStateRecord | null> {
    const site = siteId ?? await getSiteId();
    const listId = await getListIdByName(site, SP_CONFIG.lists.userState);
    if (!listId) throw new Error(`List not found: ${SP_CONFIG.lists.userState}`);
    const items = await pagedItems(graph, site, listId);
    const row = items.find((r) => String(r.fields?.UserAADId ?? '').toLowerCase() === userAADId.toLowerCase());
    if (!row) return null;
    return {
        itemId: row.id,
        siteId: site,
        listId,
        state: hydrateUserState(row.fields),
    };
}

export async function readLearningPortalStatus(graph: MsGraphClient, userAADId: string, siteId?: string): Promise<LearningPortalStatusRow[]> {
    const site = siteId ?? await getSiteId();
    const listId = await getListIdByName(site, SP_CONFIG.lists.learningPortalStatus);
    if (!listId) return [];
    const items = await pagedItems(graph, site, listId);
    return items
        .map((r) => r.fields as unknown as LearningPortalStatusRow)
        .filter((r) => String(r?.UserAADId ?? '').toLowerCase() === userAADId.toLowerCase());
}

/** Parse the JSON columns stored as strings back into objects. */
function hydrateUserState(fields: any): UserState {
    const parseJson = (v: any, fallback: any) => {
        if (Array.isArray(v)) return v;
        if (v == null || v === '') return fallback;
        try { return JSON.parse(String(v)); } catch { return fallback; }
    };
    return {
        Title: fields.Title ?? '',
        UserAADId: fields.UserAADId ?? '',
        CurrentRole: fields.CurrentRole ?? '',
        CurrentLevel: fields.CurrentLevel ?? '',
        TargetRole: fields.TargetRole ?? '',
        TargetRoleId: fields.TargetRoleId ?? '',
        TotalExperience: fields.TotalExperience ?? '',
        OverallProgress: Number(fields.OverallProgress ?? 0) || 0,
        Goals: parseJson(fields.Goals, []),
        Skills: parseJson(fields.Skills, []),
        LearningProgress: parseJson(fields.LearningProgress, []),
        ManagerAsks: fields.ManagerAsks ?? '',
        PlanCreatedDate: fields.PlanCreatedDate ?? '',
        LastCheckIn: fields.LastCheckIn ?? '',
        ManagerName: fields.ManagerName ?? undefined,
        ManagerEmail: fields.ManagerEmail ?? undefined,
        LastSyncDate: fields.LastSyncDate ?? undefined,
        Milestone80Fired: normBool(fields.Milestone80Fired),
        Completion100Fired: normBool(fields.Completion100Fired),
    };
}

function normBool(v: any): boolean {
    if (v === true) return true;
    if (typeof v === 'string') {
        const s = v.toLowerCase();
        return s === 'true' || s === 'yes' || s === '1';
    }
    return false;
}

/** Serialize UserState's JSON columns to strings for SharePoint text columns. */
function serializeUserState(state: UserState): Record<string, unknown> {
    return {
        Title: state.Title,
        UserAADId: state.UserAADId,
        CurrentRole: state.CurrentRole,
        CurrentLevel: state.CurrentLevel,
        TargetRole: state.TargetRole,
        TargetRoleId: state.TargetRoleId,
        TotalExperience: state.TotalExperience,
        OverallProgress: state.OverallProgress,
        Goals: JSON.stringify(state.Goals ?? []),
        Skills: JSON.stringify(state.Skills ?? []),
        LearningProgress: JSON.stringify(state.LearningProgress ?? []),
        ManagerAsks: state.ManagerAsks,
        PlanCreatedDate: state.PlanCreatedDate,
        LastCheckIn: state.LastCheckIn,
        ManagerName: state.ManagerName ?? '',
        ManagerEmail: state.ManagerEmail ?? '',
        LastSyncDate: state.LastSyncDate ?? '',
        Milestone80Fired: !!state.Milestone80Fired,
        Completion100Fired: !!state.Completion100Fired,
    };
}

// ============================================================================
// Write helpers — direct SharePoint POST/PATCH with column-map translation.
// ============================================================================

export async function upsertUserState(graph: MsGraphClient, state: UserState, existing?: UserStateRecord): Promise<UserStateRecord> {
    const site = existing?.siteId ?? await getSiteId();
    const listId = existing?.listId ?? await getListIdByName(site, SP_CONFIG.lists.userState);
    if (!listId) throw new Error(`List not found: ${SP_CONFIG.lists.userState}`);
    const colMap = await getColumnMap(graph, site, listId);
    const displayFields = serializeUserState(state);
    const internal = toInternalFields(displayFields, colMap);
    if (existing?.itemId) {
        await graph.api(`/sites/${site}/lists/${listId}/items/${existing.itemId}/fields`).update(internal);
        return { itemId: existing.itemId, siteId: site, listId, state };
    }
    const created = await graph.api(`/sites/${site}/lists/${listId}/items`).post({ fields: internal });
    return { itemId: created.id, siteId: site, listId, state };
}

export async function appendQuizResponse(graph: MsGraphClient, row: {
    userAADId: string;
    courseId: string;
    courseTitle: string;
    skillId: string;
    attemptDate: string;
    score: number;
    passed: boolean;
    attempts: number;
    feedback: any[];
}, siteId?: string): Promise<void> {
    const site = siteId ?? await getSiteId();
    const listId = await getListIdByName(site, SP_CONFIG.lists.quizResponses);
    if (!listId) throw new Error(`List not found: ${SP_CONFIG.lists.quizResponses}`);
    const colMap = await getColumnMap(graph, site, listId);
    const displayFields: Record<string, unknown> = {
        Title: `${row.courseTitle} · attempt ${row.attempts}`,
        UserAADId: row.userAADId,
        CourseId: row.courseId,
        SkillId: row.skillId,
        AttemptDate: row.attemptDate,
        Score: row.score,
        Passed: row.passed,
        QuestionsJSON: JSON.stringify(row.feedback ?? []),
    };
    const internal = toInternalFields(displayFields, colMap);
    await graph.api(`/sites/${site}/lists/${listId}/items`).post({ fields: internal });
}

// ============================================================================
// Pure business logic (deterministic; no I/O; unit-testable).
// ============================================================================

export function gapCategoryFor(currentLevel: number, targetLevel: number): 'Strong' | 'Growing' | 'To Build' {
    const gap = targetLevel - currentLevel;
    if (gap <= 0) return 'Strong';
    if (gap === 1) return 'Growing';
    return 'To Build';
}

export interface RoleMatch { roleId: string; roleTitle: string; skills: CompetencyFrameworkRow[] }

/**
 * Find the best-matching role for a free-text role name. Prefers exact matches on
 * RoleTitle (case-insensitive); falls back to contains matching. Returns null on no match.
 */
export function findRole(framework: CompetencyFrameworkRow[], userInput: string): RoleMatch | null {
    const q = userInput.trim().toLowerCase();
    if (!q) return null;
    const byRole = new Map<string, { roleId: string; roleTitle: string; skills: CompetencyFrameworkRow[] }>();
    for (const row of framework) {
        const key = row.RoleId;
        if (!byRole.has(key)) byRole.set(key, { roleId: row.RoleId, roleTitle: row.RoleTitle, skills: [] });
        byRole.get(key)!.skills.push(row);
    }
    // Exact title match wins.
    for (const r of byRole.values()) {
        if (r.roleTitle.toLowerCase() === q) return r;
    }
    // Contains match.
    for (const r of byRole.values()) {
        if (r.roleTitle.toLowerCase().includes(q) || q.includes(r.roleTitle.toLowerCase())) return r;
    }
    // Match on RoleId (rare, but useful for scripts).
    for (const r of byRole.values()) {
        if (r.roleId.toLowerCase() === q) return r;
    }
    return null;
}

/**
 * Rank courses for a skill gap.
 *
 * Inclusion rule: a course "helps" this gap when its level range OVERLAPS with the
 * user's gap zone (currentLevel → targetLevel). Concretely:
 *   - ToLevel   > currentLevel  — the course must teach something new the user doesn't already know.
 *   - FromLevel ≤ targetLevel   — the course must not be aimed at users who are already past target.
 *
 * We used to require FromLevel ≤ currentLevel, which excluded perfectly good foundational
 * courses starting one level above a beginner (e.g. a "L1→L2" course was hidden from a L0
 * user). That produced misleading "No course currently available" cells even when the
 * catalog had a suitable match.
 *
 * Ranking prioritizes courses whose FromLevel is closest to currentLevel (best-fit start),
 * then whose ToLevel is closest to targetLevel (best-fit end).
 */
export function matchCoursesForSkill(
    catalog: LearningCatalogRow[],
    competencyId: string,
    currentLevel: number,
    targetLevel: number,
    max = 3,
): LearningCatalogRow[] {
    if (targetLevel <= currentLevel) return [];
    const candidates = catalog.filter((c) => {
        const ids = String(c.SkillIds ?? '').split(';').map((s) => s.trim()).filter(Boolean);
        if (!ids.includes(competencyId)) return false;
        const from = Number(c.FromLevel);
        const to = Number(c.ToLevel);
        return to > currentLevel && from <= targetLevel;
    });
    candidates.sort((a, b) => {
        const aFromDist = Math.abs(Number(a.FromLevel) - currentLevel);
        const bFromDist = Math.abs(Number(b.FromLevel) - currentLevel);
        if (aFromDist !== bFromDist) return aFromDist - bFromDist;
        const aToDist = Math.abs(Number(a.ToLevel) - targetLevel);
        const bToDist = Math.abs(Number(b.ToLevel) - targetLevel);
        return aToDist - bToDist;
    });
    return candidates.slice(0, max);
}

/**
 * Recompute Goals[i].progressPct + Goals[i].status + OverallProgress purely from
 * LearningProgress course counts. This is the ONE truth for progress — no level ratios.
 */
export function recomputeGoalsAndOverall(state: UserState): UserState {
    const learning = state.LearningProgress ?? [];
    const goals = (state.Goals ?? []).map((g) => {
        const total = learning.filter((lp) => lp.skillId === g.competencyId).length;
        const done = learning.filter((lp) => lp.skillId === g.competencyId && lp.status === 'Complete').length;
        const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;
        const status: UserGoal['status'] =
            done === 0 ? 'Not Started' :
                done === total ? 'Complete' :
                    'In Progress';
        return { ...g, progressPct, status };
    });
    const overall = goals.length > 0
        ? Math.round(goals.reduce((sum, g) => sum + g.progressPct, 0) / goals.length)
        : 0;
    return { ...state, Goals: goals, OverallProgress: overall };
}

/** Bump a skill's currentLevel to the given ToLevel (only if higher). Recomputes gap + gapCategory. */
export function bumpSkillLevel(state: UserState, competencyId: string, toLevel: number): UserState {
    const skills = (state.Skills ?? []).map((s) => {
        if (s.competencyId !== competencyId) return s;
        const newLevel = Math.max(s.currentLevel, toLevel);
        const gap = Math.max(0, s.targetLevel - newLevel);
        return {
            ...s,
            currentLevel: newLevel,
            gap,
            gapCategory: gapCategoryFor(newLevel, s.targetLevel),
            source: 'Course completion' as const,
            lastUpdated: today(),
        };
    });
    return { ...state, Skills: skills };
}

/**
 * Apply a passed quiz: marks the LP entry Complete, bumps each SkillId listed on the course,
 * then recomputes goals + overall progress.
 */
export function applyQuizPass(
    state: UserState,
    courseId: string,
    quizResult: UserLearningQuizSummary,
    course: LearningCatalogRow,
): UserState {
    const learning = (state.LearningProgress ?? []).map((lp) => {
        if (lp.courseId !== courseId) return lp;
        return {
            ...lp,
            status: 'Complete' as const,
            completedDate: today(),
            quizResult,
        };
    });
    let next: UserState = { ...state, LearningProgress: learning };
    const skillIds = String(course.SkillIds ?? '').split(';').map((s) => s.trim()).filter(Boolean);
    for (const sid of skillIds) {
        next = bumpSkillLevel(next, sid, Number(course.ToLevel));
    }
    return recomputeGoalsAndOverall(next);
}

/** Apply a failed quiz: only stores the quiz summary — nothing else changes. */
export function applyQuizFail(state: UserState, courseId: string, quizResult: UserLearningQuizSummary): UserState {
    const learning = (state.LearningProgress ?? []).map((lp) =>
        lp.courseId === courseId ? { ...lp, quizResult } : lp,
    );
    return { ...state, LearningProgress: learning };
}

/**
 * Diff portal telemetry against the user's plan. Applies percentComplete / timeSpentMinutes
 * to matched LP entries. Identifies courses that are newly-complete (portal Status=Complete
 * AND our LP.status !== Complete AND no passing quiz yet).
 */
export interface SyncResult {
    updatedState: UserState;
    changed: boolean;
    newlyCompleted: UserLearningRecord[];
}

export function diffPortalAgainstPlan(state: UserState, portal: LearningPortalStatusRow[]): SyncResult {
    const learning = [...(state.LearningProgress ?? [])];
    const newlyCompleted: UserLearningRecord[] = [];
    let changed = false;

    for (const row of portal) {
        const idx = learning.findIndex((lp) => lp.courseId === row.CourseId);
        if (idx < 0) continue; // portal row for a course outside the plan — skip
        const lp = learning[idx];
        const newPct = Number(row.PercentComplete ?? lp.percentComplete ?? 0);
        const newMins = Number(row.TimeSpentMinutes ?? lp.timeSpentMinutes ?? 0);
        let status = lp.status;
        // Portal says Complete + we haven't validated with quiz yet → newly-completed.
        if (row.Status === 'Complete' && lp.status !== 'Complete' && !lp.quizResult?.passed) {
            newlyCompleted.push(lp);
        }
        if (row.Status === 'In Progress' && lp.status === 'Recommended') {
            status = 'In Progress';
        }
        const nextLp: UserLearningRecord = { ...lp, percentComplete: newPct, timeSpentMinutes: newMins, status };
        if (JSON.stringify(nextLp) !== JSON.stringify(lp)) {
            learning[idx] = nextLp;
            changed = true;
        }
    }

    let next: UserState = { ...state, LearningProgress: learning, LastSyncDate: nowIso() };
    // Always recompute goals + OverallProgress from the (possibly-updated) LP.
    next = recomputeGoalsAndOverall(next);
    return { updatedState: next, changed, newlyCompleted };
}

/**
 * Find the next course that (a) is Complete in the portal, (b) has no passing quiz yet, and
 * (c) is not yet Complete in the user's plan. Returns the LP entry to quiz on, or null.
 */
export function pickNextPendingQuiz(state: UserState, portal: LearningPortalStatusRow[]): UserLearningRecord | null {
    const completedCourseIds = new Set(
        portal.filter((r) => r.Status === 'Complete').map((r) => r.CourseId),
    );
    for (const lp of state.LearningProgress ?? []) {
        if (!completedCourseIds.has(lp.courseId)) continue;
        if (lp.status === 'Complete') continue;
        if (lp.quizResult?.passed) continue;
        return lp;
    }
    return null;
}

// ============================================================================
// Grading — deterministic MCQ scoring. Short-answer scoring lives in llm-tasks.ts.
// ============================================================================

export interface QuizQuestionWithKey {
    id: string;
    type: 'mcq' | 'short';
    text: string;
    choices?: string[];
    correctAnswer: string;   // for MCQ: "A"|"B"|"C"|"D"; for short: canonical key idea
    topicTag: string;
    explanation?: string;    // for short: what "correct" looks like
}

export interface GradedAnswer {
    id: string;
    type: 'mcq' | 'short';
    text: string;
    choices?: string[];
    userAnswer: string;
    correctAnswer: string;
    correct: boolean;
    topicTag: string;
    explanation?: string;
}

export function gradeMcqAnswer(q: QuizQuestionWithKey, userAnswer: string): GradedAnswer {
    const a = String(userAnswer ?? '').trim().toUpperCase().charAt(0);
    const key = String(q.correctAnswer ?? '').trim().toUpperCase().charAt(0);
    return {
        id: q.id,
        type: 'mcq',
        text: q.text,
        choices: q.choices,
        userAnswer: a,
        correctAnswer: key,
        correct: !!a && a === key,
        topicTag: q.topicTag,
    };
}

/** Aggregate a list of graded answers into a quiz summary. */
export function summarizeGrading(feedback: GradedAnswer[]): { score: number; passed: boolean; topicTagsWrong: string[] } {
    const score = feedback.filter((f) => f.correct).length;
    return {
        score,
        passed: score >= 4,
        topicTagsWrong: feedback.filter((f) => !f.correct).map((f) => f.topicTag),
    };
}

// ============================================================================
// Milestone helpers.
// ============================================================================

export interface MilestoneAggregate {
    stillToClose: Array<{ name: string; progressPct: number }>;
    areasToStrengthen: string[];
}

/**
 * Aggregate wrong-answer topic tags across all QuizResponses rows to identify
 * the user's weakest topics. Falls back to gap>0 skill names if the user has no
 * wrong-answered questions on record.
 */
export function computeMilestoneAggregate(
    state: UserState,
    allQuizResponses: Array<{ QuestionsJSON: string }>,
): MilestoneAggregate {
    const tally = new Map<string, number>();
    for (const q of allQuizResponses ?? []) {
        try {
            const arr = JSON.parse(q.QuestionsJSON ?? '[]') as GradedAnswer[];
            for (const item of arr) {
                if (item?.correct === false && item?.topicTag) {
                    tally.set(item.topicTag, (tally.get(item.topicTag) ?? 0) + 1);
                }
            }
        } catch { /* ignore malformed */ }
    }
    const areasToStrengthen = Array.from(tally.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([tag]) => tag);
    if (areasToStrengthen.length === 0) {
        areasToStrengthen.push(
            ...(state.Skills ?? [])
                .filter((s) => s.gap > 0)
                .slice(0, 5)
                .map((s) => s.competencyName),
        );
    }
    const stillToClose = (state.Goals ?? [])
        .filter((g) => g.progressPct < 100)
        .map((g) => ({ name: g.competencyName, progressPct: g.progressPct }));
    return { stillToClose, areasToStrengthen };
}

export async function readAllQuizResponsesForUser(graph: MsGraphClient, userAADId: string, siteId?: string): Promise<Array<{ QuestionsJSON: string }>> {
    const site = siteId ?? await getSiteId();
    const listId = await getListIdByName(site, SP_CONFIG.lists.quizResponses);
    if (!listId) return [];
    const items = await pagedItems(graph, site, listId);
    return items
        .map((r) => r.fields as any)
        .filter((r) => String(r?.UserAADId ?? '').toLowerCase() === userAADId.toLowerCase())
        .map((r) => ({ QuestionsJSON: String(r?.QuestionsJSON ?? '[]') }));
}

// ============================================================================
// Convenience.
// ============================================================================

export function today(): string { return new Date().toISOString().slice(0, 10); }
export function nowIso(): string { return new Date().toISOString(); }
