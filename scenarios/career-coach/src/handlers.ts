// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Deterministic handlers for Adaptive Card Action.Execute submits + the
 * proactive learning-portal webhook. These bypass the LLM main loop entirely
 * and just run TypeScript against SharePoint. LLM calls are only made for:
 *   - Generating 5 quiz questions per course (llm-tasks.generateQuizQuestions).
 *   - Grading short-answer quiz responses (llm-tasks.gradeShortAnswers).
 *   - Composing the completion email prose (llm-tasks.composeCompletionEmail).
 *
 * Each function returns quickly (<1s in the happy path — LLM sub-calls dominate
 * only when explicitly needed) so the Action.Execute invoke never times out.
 */

import { TurnContext, MessageFactory, Authorization } from '@microsoft/agents-hosting';
import { CardPayload, renderCard, PlanReviewSkill } from './cards';
import {
    LearningCatalogRow, CompetencyFrameworkRow, UserLearningQuizSummary,
    SP_CONFIG, UserState, UserGoal, UserSkill, UserLearningRecord,
} from './career-coach-types';
import {
    readCompetencyFramework, readLearningCatalog, readUserState, readPreviousPlans, readLearningPortalStatus,
    readAllQuizResponsesForUser,
    upsertUserState, appendQuizResponse,
    findRole, matchCoursesForSkill, gapCategoryFor,
    recomputeGoalsAndOverall, applyQuizPass, applyQuizFail,
    diffPortalAgainstPlan, pickNextPendingQuiz,
    gradeMcqAnswer, summarizeGrading,
    computeMilestoneAggregate,
    GradedAnswer, QuizQuestionWithKey,
    today, nowIso,
} from './career-coach-service';
import {
    generateQuizQuestions, gradeShortAnswers, composeCompletionEmail, ShortGradeInput,
} from './llm-tasks';
import { getAgenticGraphClient, getMyManager, getMyProfile, sendMail } from './graph-service';
import { getQuiz, getOrCreateQuiz, bumpAttempts, clearQuiz, markGraded, unmarkGraded, wasGraded, queueQuizzes, dequeueQuiz, peekQueuedQuizzes } from './quiz-cache';
import { withUserLock } from './user-lock';

// ============================================================================
// STAGE 1 helper — build a skillPath card for a role name (LLM path calls this too).
// ============================================================================

export interface BuildSkillPathResult {
    ok: true;
    card: CardPayload;
    roleId: string;
    roleTitle: string;
    /** The framework rows for the matched role, so caller can stash them for Stage 2. */
    frameworkRows: CompetencyFrameworkRow[];
}
export interface BuildSkillPathMiss { ok: false; reason: string }

export async function buildSkillPathForRole(
    context: TurnContext,
    authorization: Authorization,
    roleInput: string,
): Promise<BuildSkillPathResult | BuildSkillPathMiss> {
    const graph = getAgenticGraphClient(context, authorization);
    const framework = await readCompetencyFramework(graph);
    const match = findRole(framework, roleInput);
    if (!match) {
        const uniqueRoles = Array.from(new Set(framework.map((r) => r.RoleTitle))).slice(0, 8);
        return {
            ok: false,
            reason: `I don't recognize "${roleInput}" as a role in our framework. Available: ${uniqueRoles.join(', ')}. Which one are you targeting?`,
        };
    }
    const skills = match.skills.map((s, i) => ({
        id: `skill_${i + 1}`,
        competencyId: s.CompetencyId,
        name: s.CompetencyName,
        target: Number(s.RequiredLevel),
        description: s.LevelDescription,
    }));
    const card: CardPayload = {
        type: 'skillPath',
        roleTitle: match.roleTitle,
        interactive: true,
        intro: `Rate your current level for each skill (0 = never touched, 4 = advanced).`,
        skills,
        footer: 'Pick 0–4 for each — then click Continue.',
    };
    return { ok: true, card, roleId: match.roleId, roleTitle: match.roleTitle, frameworkRows: match.skills };
}

// ============================================================================
// STAGE 2 — SKILL RATINGS → PLAN REVIEW (deterministic)
// ============================================================================

export interface SkillRatingInput {
    id: string;
    competencyId: string;
    name: string;
    target: number;
    level: number | null;
}

export async function handleSkillRatingsSubmit(
    context: TurnContext,
    authorization: Authorization,
    args: { roleTitle: string; skills: SkillRatingInput[] },
): Promise<void> {
    const graph = getAgenticGraphClient(context, authorization);
    // We still need the catalog for course matching. Framework is optional here
    // because the target level is already carried in each skill entry.
    const catalog = await readLearningCatalog(graph);

    const planSkills: PlanReviewSkill[] = args.skills.map((s) => {
        const level = typeof s.level === 'number' ? s.level : 0;
        const target = Number(s.target);
        const gap = Math.max(0, target - level);
        const courses = matchCoursesForSkill(catalog, s.competencyId, level, target, 3)
            .map((c) => ({
                courseId: c.CourseId,
                title: c.Title,
                url: c.URL,
                provider: c.Provider,
                format: c.Format,
                fromLevel: Number(c.FromLevel),
                toLevel: Number(c.ToLevel),
            }));
        return {
            competencyId: s.competencyId,
            name: s.name,
            target,
            current: level,
            gap,
            status: gapCategoryFor(level, target),
            courses,
        };
    });

    const totalCourses = planSkills.reduce((sum, s) => sum + (s.courses?.length ?? 0), 0);
    const card: CardPayload = {
        type: 'planReview',
        roleTitle: args.roleTitle,
        intro: 'Here are your gaps and the courses that will close them. Click 💾 Save my plan below to lock this in.',
        skills: planSkills,
        totalCourses,
        footer: `Click 💾 Save my plan when you're ready.`,
    };
    await sendCard(context, card);
}

// ============================================================================
// STAGE 3 — SAVE PLAN (deterministic)
// ============================================================================

/** Rebuilds the plan-review card from the Save button payload, in its locked "saved" state. */
export function savedPlanReviewCard(input: Pick<SavePlanInput, 'roleTitle' | 'groups' | 'ratings'>): Extract<CardPayload, { type: 'planReview' }> {
    const skills: PlanReviewSkill[] = (input.ratings ?? []).map((r) => {
        const current = Number(r.level ?? 0);
        const target = Number(r.target ?? 0);
        const group = (input.groups ?? []).find((g) => g.competencyId === r.competencyId);
        return {
            competencyId: r.competencyId,
            name: r.name,
            target,
            current,
            gap: Math.max(0, target - current),
            status: gapCategoryFor(current, target),
            courses: (group?.courses ?? []).map((c) => ({ ...c })),
        };
    });
    return {
        type: 'planReview',
        roleTitle: input.roleTitle,
        intro: 'Here are your gaps and the courses that will close them.',
        skills,
        totalCourses: skills.reduce((sum, s) => sum + (s.courses?.length ?? 0), 0),
        saved: true,
    };
}

/** True once a saved plan has any learning activity that a re-save would wipe out. */
function planHasProgress(state: UserState): boolean {
    return (state.OverallProgress ?? 0) > 0 ||
        (state.LearningProgress ?? []).some((lp) => lp.status !== 'Recommended' || !!lp.quizResult);
}

export interface SavePlanInput {
    userAADId: string;
    displayName: string;
    roleTitle: string;
    /** From the Save button payload — the LLM-generated groups may or may not have targetRoleId. */
    targetRoleId?: string;
    groups: Array<{
        skill: string;
        competencyId: string;
        courses: Array<{
            courseId: string;
            title: string;
            url?: string;
            provider?: string;
            format?: string;
            fromLevel?: number;
            toLevel?: number;
        }>;
    }>;
    /** Ratings captured in the skill-path card — used to build Skills[] with currentLevel + targetLevel. */
    ratings: Array<{ competencyId: string; name: string; level: number; target: number }>;
}

export async function handleSavePlanSubmit(
    context: TurnContext,
    authorization: Authorization,
    input: SavePlanInput,
): Promise<void> {
    const result = await savePlan(context, authorization, input);
    if (result.message) await sendPlain(context, result.message);
    await sendCard(context, result.card);
}

/** Builds the Save input from a planReview card payload (same mapping as the card's Save button). */
export function savePlanInputFromReview(
    review: Extract<CardPayload, { type: 'planReview' }>,
    userAADId: string,
    displayName: string,
): SavePlanInput {
    const skills = review.skills ?? [];
    return {
        userAADId,
        displayName,
        roleTitle: review.roleTitle,
        groups: skills
            .filter((s) => (s.courses?.length ?? 0) > 0)
            .map((s) => ({
                skill: s.name,
                competencyId: s.competencyId ?? '',
                courses: (s.courses ?? []).map((c) => ({
                    courseId: c.courseId ?? '', title: c.title, url: c.url, provider: c.provider,
                    format: c.format, fromLevel: c.fromLevel, toLevel: c.toLevel,
                })),
            })),
        ratings: skills.map((s) => ({ competencyId: s.competencyId ?? '', name: s.name, level: s.current, target: s.target })),
    };
}

export interface SavePlanResult {
    /** False when an existing plan with progress was kept instead of overwritten. */
    saved: boolean;
    message?: string;
    card: CardPayload;
}

/** Stage 3 save, shared by the Teams Save button and the email "Save it" reply. */
export async function savePlan(
    context: TurnContext,
    authorization: Authorization,
    input: SavePlanInput,
): Promise<SavePlanResult> {
    // Serialised per user: the read-then-write below must not interleave with a sync or quiz grade.
    return withUserLock(input.userAADId, () => savePlanLocked(context, authorization, input));
}

async function savePlanLocked(
    context: TurnContext,
    authorization: Authorization,
    input: SavePlanInput,
): Promise<SavePlanResult> {
    const graph = getAgenticGraphClient(context, authorization);

    // Guard: never let a repeat Save (old card, double click) wipe a plan that already has
    // progress for the same role. A plan with no progress yet is safe to re-save.
    const existing = await readUserState(graph, input.userAADId);
    if (existing && existing.state.TargetRole.trim().toLowerCase() === input.roleTitle.trim().toLowerCase()
        && planHasProgress(existing.state)) {
        console.warn(`[SavePlan] Skipped re-save: "${input.roleTitle}" plan already has progress.`);
        return {
            saved: false,
            message: `Your **${existing.state.TargetRole}** plan is already saved and has progress — I didn't overwrite it. Here's where you stand:`,
            card: buildProgressCardFromState(existing.state),
        };
    }

    // Attempt to resolve targetRoleId from the framework if the caller didn't include it.
    let targetRoleId = input.targetRoleId ?? '';
    if (!targetRoleId) {
        try {
            const framework = await readCompetencyFramework(graph);
            const match = findRole(framework, input.roleTitle);
            if (match) targetRoleId = match.roleId;
        } catch { /* non-fatal */ }
    }

    // Build Skills[] from ratings.
    const skills: UserSkill[] = input.ratings.map((r) => ({
        competencyId: r.competencyId,
        competencyName: r.name,
        currentLevel: Number(r.level ?? 0),
        targetLevel: Number(r.target ?? 0),
        gap: Math.max(0, Number(r.target ?? 0) - Number(r.level ?? 0)),
        gapCategory: gapCategoryFor(Number(r.level ?? 0), Number(r.target ?? 0)),
        source: 'Self-reported',
        lastUpdated: today(),
    }));

    // Build Goals[] — one per skill with gap > 0.
    const goals: UserGoal[] = skills
        .filter((s) => s.gap > 0)
        .map((s, i) => ({
            goalId: `goal-${i + 1}`,
            competencyId: s.competencyId,
            competencyName: s.competencyName,
            status: 'Not Started',
            progressPct: 0,
            createdDate: today(),
        }));

    // Build LearningProgress[] — flatten every group's courses into a single list.
    const learning: UserLearningRecord[] = [];
    for (const g of input.groups ?? []) {
        for (const c of g.courses ?? []) {
            if (!c.courseId) continue; // require a real courseId
            learning.push({
                courseId: c.courseId,
                courseTitle: c.title,
                skillId: g.competencyId,
                status: 'Recommended',
                recommendedDate: today(),
                url: c.url ?? '',
            });
        }
    }

    // Read + fill manager info if we can (best-effort).
    let managerName: string | undefined; let managerEmail: string | undefined;
    try {
        const mgr = await getMyManager(graph, input.userAADId);
        if (mgr) { managerName = mgr.displayName; managerEmail = mgr.mail; }
    } catch { /* non-fatal */ }

    let state: UserState = {
        Title: input.displayName,
        UserAADId: input.userAADId,
        CurrentRole: '',
        CurrentLevel: '',
        TargetRole: input.roleTitle,
        TargetRoleId: targetRoleId,
        TotalExperience: '',
        OverallProgress: 0,
        Goals: goals,
        Skills: skills,
        LearningProgress: learning,
        ManagerAsks: '',
        PlanCreatedDate: today(),
        LastCheckIn: today(),
        ManagerName: managerName,
        ManagerEmail: managerEmail,
        LastSyncDate: nowIso(),
        Milestone80Fired: false,
        Completion100Fired: false,
        PlanStatus: 'Active',
    };
    // Recompute (all goals should be 0% at save time, but this future-proofs it).
    state = recomputeGoalsAndOverall(state);

    // Each goal has its own row. An active goal with no progress yet is simply re-saved in place;
    // one with progress is kept as history (Replaced) and the new goal gets a new row.
    let target = existing ?? undefined;
    if (existing && planHasProgress(existing.state)) {
        await upsertUserState(graph, { ...existing.state, PlanStatus: 'Replaced', PlanCompletedDate: today() }, existing);
        console.log(`[SavePlan] Kept unfinished "${existing.state.TargetRole}" goal as Replaced (item ${existing.itemId}).`);
        target = undefined;
    }
    await upsertUserState(graph, state, target);
    console.log(`[SavePlan] Saved "${state.TargetRole}" plan (${goals.length} goals, ${learning.length} courses).`);

    return { saved: true, card: buildProgressCardFromState(state) };
}

// ============================================================================
// STAGE 4-SYNC — WEBHOOK / "check my progress" (deterministic)
// ============================================================================

export async function handleSyncProgress(
    context: TurnContext,
    authorization: Authorization,
    userAADId: string,
): Promise<void> {
    const graph = getAgenticGraphClient(context, authorization);
    // The read-diff-write happens under the user lock, so a quiz result persisted by a concurrent
    // submission is never overwritten by a stale snapshot. Sending cards happens after release.
    const synced = await withUserLock(userAADId, async () => {
        const userRecord = await readUserState(graph, userAADId);
        if (!userRecord) return null;
        const portal = await readLearningPortalStatus(graph, userAADId);
        const { updatedState, newlyCompleted } = diffPortalAgainstPlan(userRecord.state, portal);
        await upsertUserState(graph, updatedState, userRecord);
        return { updatedState, newlyCompleted, portal };
    });
    if (!synced) {
        await sendPlain(context, await noActiveGoalMessage(graph, userAADId));
        return;
    }
    const { updatedState, newlyCompleted, portal } = synced;

    // Any newly-completed course → build quiz + render.
    const nextPending = pickNextPendingQuiz(updatedState, portal);
    if (nextPending) {
        await sendPlain(context, `Nice — I see you finished **${nextPending.courseTitle}**. Let's lock it in with a quick check. 📝`);
        await emitQuizFor(context, authorization, userAADId, nextPending.courseId);
        if (newlyCompleted.length > 1) {
            await sendPlain(context, `You have ${newlyCompleted.length - 1} more course(s) to validate — I'll queue the next quiz after this one.`);
        }
        return;
    }

    // No pending quizzes — just show progress.
    await sendCard(context, buildProgressCardFromState(updatedState));

    // If milestones haven't fired yet but the plan is already at 80/100, fire them now.
    // (Covers the case where a milestone was skipped or its email delivery failed and the
    // user is asking for a resend via "check my progress".)
    if (updatedState.OverallProgress >= 80 && !updatedState.Milestone80Fired) {
        await fireMilestone80(context, authorization, userAADId, updatedState);
    }
    if (updatedState.OverallProgress === 100 && !updatedState.Completion100Fired) {
        await fireCompletion100(context, authorization, userAADId, updatedState);
    }
}

// ============================================================================
// STAGE 4b PHASE A — build & send quiz for one course (deterministic + LLM Q gen)
// ============================================================================

export async function emitQuizFor(
    context: TurnContext,
    authorization: Authorization,
    userAADId: string,
    courseId: string,
): Promise<void> {
    const graph = getAgenticGraphClient(context, authorization);
    const catalog = await readLearningCatalog(graph);
    const course = catalog.find((c) => c.CourseId === courseId);
    if (!course) {
        await sendPlain(context, `I couldn't find course ${courseId} in the catalog. Skipping the quiz.`);
        return;
    }
    // Reuse a cached quiz if we recently generated it (e.g., after a failed submit). Concurrent
    // callers share one in-flight generation so every card sent is graded against the same key.
    const questions = await getOrCreateQuiz(userAADId, courseId, () => generateQuizQuestions(course));
    // A freshly-sent card is a new attempt: allow it to be submitted, and drop it from the queue.
    unmarkGraded(userAADId, courseId);
    dequeueQuiz(userAADId, courseId);

    const skillIds = String(course.SkillIds ?? '').split(';').map((s) => s.trim()).filter(Boolean);
    const primarySkillId = skillIds[0] ?? '';

    const card: CardPayload = {
        type: 'quiz',
        courseId: course.CourseId,
        courseTitle: course.Title,
        skillId: primarySkillId,
        skillName: undefined,
        intro: `5 quick questions to lock in what you learned. Pass = 4 of 5.`,
        questions: questions.map((q) => ({
            id: q.id,
            type: q.type,
            text: q.text,
            choices: q.choices,
            topicTag: q.topicTag,
            // NOTE: we do NOT include correctAnswer here — that stays server-side in quiz-cache.
        })),
        footer: `Take your time — you can retry if you don't pass.`,
    };
    await sendCard(context, card);
}

// ============================================================================
// STAGE 4 — "I completed all the courses" (deterministic)
// ============================================================================

/** A course only counts as done once its quiz was passed — a bare "Complete" status doesn't count. */
function isValidated(lp: UserLearningRecord): boolean {
    return lp.status === 'Complete' && !!lp.quizResult?.passed;
}

/** One entry per courseId (a course can appear under two skills in LearningProgress). */
function uniqueCourses(list: UserLearningRecord[]): UserLearningRecord[] {
    const seen = new Set<string>();
    return list.filter((lp) => !!lp.courseId && !seen.has(lp.courseId) && !!seen.add(lp.courseId));
}

/** Lists the courses to validate, queues all but the first, and sends the first quiz. */
async function startValidationQueue(
    context: TurnContext,
    authorization: Authorization,
    userAADId: string,
    courses: UserLearningRecord[],
    lead: string,
): Promise<void> {
    const list = courses.map((lp, i) => `${i + 1}. ${lp.courseTitle}`).join('\n');
    await sendPlain(context,
        `${lead}\n\n${list}\n\n` +
        `Each one gets a quick 5-question check (pass = 4 of 5). ` +
        (courses.length > 1 ? `We'll go one at a time — starting with **${courses[0].courseTitle}**.` : `Here it is:`));
    queueQuizzes(userAADId, courses.slice(1).map((lp) => lp.courseId));
    await emitQuizFor(context, authorization, userAADId, courses[0].courseId);
}

/**
 * Treats "I completed all (my) courses" as every not-yet-validated course in the user's plan:
 * lists them, queues them, and starts the first quiz. Each course still has to pass its own
 * quiz before it counts as Complete.
 */
export async function handleCompletedAllCourses(
    context: TurnContext,
    authorization: Authorization,
    userAADId: string,
): Promise<void> {
    const graph = getAgenticGraphClient(context, authorization);
    const record = await readUserState(graph, userAADId);
    if (!record) {
        await sendPlain(context, await noActiveGoalMessage(graph, userAADId));
        return;
    }
    const remaining = uniqueCourses(record.state.LearningProgress).filter((lp) => !isValidated(lp));
    if (remaining.length === 0) {
        await sendPlain(context, "You've already validated every course in your plan — nothing left to quiz. 🎉");
        await sendCard(context, buildProgressCardFromState(record.state));
        return;
    }
    const count = remaining.length === 1 ? '1 course' : `${remaining.length} courses`;
    await startValidationQueue(context, authorization, userAADId, remaining,
        `Amazing work! 🎉 You have **${count}** in your plan still to validate:`);
}

/** Courses from the user's plan named (by title or course id) in a chat message. */
export interface ReportedCourses {
    state: UserState;
    named: UserLearningRecord[];
}

/**
 * Read-only: finds the plan courses a "I completed …" message names. Returns null when the
 * user has no plan or names no plan course, so the caller can fall back to the LLM.
 */
export async function findReportedCourses(
    context: TurnContext,
    authorization: Authorization,
    userAADId: string,
    userText: string,
): Promise<ReportedCourses | null> {
    const text = userText.toLowerCase();
    const graph = getAgenticGraphClient(context, authorization);
    const record = await readUserState(graph, userAADId);
    if (!record) return null;
    const named = uniqueCourses(record.state.LearningProgress).filter((lp) =>
        (lp.courseTitle && text.includes(lp.courseTitle.toLowerCase())) || text.includes(lp.courseId.toLowerCase()));
    return named.length ? { state: record.state, named } : null;
}

/** Quizzes the courses found by findReportedCourses one at a time (already-passed ones are acknowledged). */
export async function handleReportedCompletions(
    context: TurnContext,
    authorization: Authorization,
    userAADId: string,
    reported: ReportedCourses,
): Promise<void> {
    const pending = reported.named.filter((lp) => !isValidated(lp));
    const already = reported.named.filter(isValidated);
    if (pending.length === 0) {
        await sendPlain(context, `You've already passed the quiz for ${already.map((lp) => `**${lp.courseTitle}**`).join(' and ')} — that's tracked. 👍`);
        await sendCard(context, buildProgressCardFromState(reported.state));
        return;
    }
    const alreadyNote = already.length ? ` (${already.map((lp) => lp.courseTitle).join(', ')} ${already.length === 1 ? 'is' : 'are'} already validated.)` : '';
    await startValidationQueue(context, authorization, userAADId, pending,
        `Nice work! 🎉 Let's lock ${pending.length === 1 ? 'it' : 'these'} in:${alreadyNote}`);
}

/**
 * Called after an LLM turn in which the progress guard blocked the model from marking
 * courses Complete: quiz those courses so the user isn't left waiting.
 */
export async function validateBlockedCourses(
    context: TurnContext,
    authorization: Authorization,
    userAADId: string,
    courseIds: string[],
): Promise<void> {
    const graph = getAgenticGraphClient(context, authorization);
    const record = await readUserState(graph, userAADId);
    if (!record) return;
    const pending = uniqueCourses(record.state.LearningProgress)
        .filter((lp) => courseIds.includes(lp.courseId) && !isValidated(lp));
    if (pending.length === 0) return;
    await startValidationQueue(context, authorization, userAADId, pending,
        `Before I can mark ${pending.length === 1 ? 'this course' : 'these courses'} complete, ${pending.length === 1 ? 'it needs' : 'each needs'} a passed quiz:`);
}

// ============================================================================
// STAGE 4 helper — queue the other courses a user reported as completed in chat.
// ============================================================================

/**
 * When a user reports several finished courses in one chat message, only the first gets a
 * quiz immediately. Queue the rest (courses in the user's plan whose title or id appears in
 * the message and that aren't Complete yet) so the post-grading step can quiz them next.
 * Returns the queued course titles.
 */
export async function queueReportedCourses(
    context: TurnContext,
    authorization: Authorization,
    userAADId: string,
    userText: string,
    excludeCourseId: string,
): Promise<string[]> {
    const text = userText.toLowerCase();
    if (!text) return [];
    const graph = getAgenticGraphClient(context, authorization);
    const record = await readUserState(graph, userAADId);
    if (!record) return [];
    const reported = uniqueCourses(record.state.LearningProgress).filter((lp) =>
        lp.courseId !== excludeCourseId &&
        !isValidated(lp) &&
        ((lp.courseTitle && text.includes(lp.courseTitle.toLowerCase())) || text.includes(lp.courseId.toLowerCase())),
    );
    queueQuizzes(userAADId, reported.map((lp) => lp.courseId));
    return reported.map((lp) => lp.courseTitle);
}

// ============================================================================
// STAGE 4b PHASE B — QUIZ SUBMIT (deterministic MCQ + LLM short-answer)
// ============================================================================

export interface QuizSubmitInput {
    userAADId: string;
    courseId: string;
    skillId?: string;
    answersByQuestionId: Record<string, string>;
}

// In-flight idempotency guard for quiz grading (see handleQuizSubmit wrapper).
const gradingInFlight = new Set<string>();

export async function handleQuizSubmit(
    context: TurnContext,
    authorization: Authorization,
    input: QuizSubmitInput,
): Promise<void> {
    // A double-clicked quiz card fires two invokes ~ms apart. Without an atomic claim both
    // would grade, append duplicate attempts, and double-fire the milestone/completion email
    // cascade before either persists the one-shot guard. Node is single-threaded, so this
    // check-and-add is atomic; the claim is released once grading settles.
    const claimKey = `${input.userAADId}:${input.courseId}`;
    if (gradingInFlight.has(claimKey)) {
        console.warn(`[QuizSubmit] Duplicate submit ignored — already grading ${claimKey}.`);
        return;
    }
    gradingInFlight.add(claimKey);
    try {
        await handleQuizSubmitInner(context, authorization, input);
    } finally {
        gradingInFlight.delete(claimKey);
    }
}

async function handleQuizSubmitInner(
    context: TurnContext,
    authorization: Authorization,
    input: QuizSubmitInput,
): Promise<void> {
    const graph = getAgenticGraphClient(context, authorization);
    if (wasGraded(input.userAADId, input.courseId)) {
        await sendPlain(context, "You've already submitted this quiz — your results are above. 👍");
        return;
    }
    const cached = getQuiz(input.userAADId, input.courseId);
    if (!cached || cached.length === 0) {
        await sendPlain(context,
            "Your quiz session expired (server was restarted). Say **check my progress** and I'll regenerate the quiz.");
        return;
    }

    // Grade every question.
    const graded: GradedAnswer[] = [];
    const shortInputs: ShortGradeInput[] = [];
    for (const q of cached) {
        const userAns = String(input.answersByQuestionId[q.id] ?? '').trim();
        if (q.type === 'mcq') {
            graded.push(gradeMcqAnswer(q, userAns));
        } else {
            // Placeholder — will fill in after the LLM sub-call returns.
            graded.push({
                id: q.id, type: 'short', text: q.text, correctAnswer: q.correctAnswer,
                userAnswer: userAns, correct: false, topicTag: q.topicTag,
                explanation: undefined,
            });
            shortInputs.push({
                id: q.id, questionText: q.text, correctIdea: q.correctAnswer,
                userAnswer: userAns, topicTag: q.topicTag,
            });
        }
    }
    if (shortInputs.length > 0) {
        try {
            const shortResults = await gradeShortAnswers(shortInputs);
            for (const r of shortResults) {
                const idx = graded.findIndex((g) => g.id === r.id);
                if (idx >= 0) {
                    graded[idx] = { ...graded[idx], correct: r.correct, explanation: r.explanation };
                }
            }
        } catch (err) {
            console.warn('[QuizSubmit] Short-answer grading failed; marking short answers wrong:', (err as any)?.message ?? err);
        }
    }

    const summary = summarizeGrading(graded);

    // Load user + course context and persist, as one critical section per user. A concurrent sync, or
    // a submission for another course, can't read the same plan and overwrite this result (or lose theirs).
    const persisted = await withUserLock(input.userAADId, async () => {
        const userRecord = await readUserState(graph, input.userAADId);
        if (!userRecord) return { ok: false as const, problem: "I couldn't find your plan to record the quiz result. Save a plan first." };
        const catalog = await readLearningCatalog(graph, userRecord.siteId);
        const course = catalog.find((c) => c.CourseId === input.courseId);
        if (!course) return { ok: false as const, problem: `I couldn't find course ${input.courseId} in the catalog to record the quiz.` };
        // Counted only once the reads succeed, so a network failure above isn't an attempt.
        const attempts = bumpAttempts(input.userAADId, input.courseId) || 1;
        const lp = userRecord.state.LearningProgress.find((l) => l.courseId === input.courseId);
        const courseTitle = lp?.courseTitle ?? course.Title;

        const quizResult: UserLearningQuizSummary = {
            attemptDate: nowIso(),
            score: summary.score,
            passed: summary.passed,
            topicTagsWrong: summary.topicTagsWrong,
            attempts,
        };

        // WRITE #1 — QuizResponses row.
        try {
            await appendQuizResponse(graph, {
                userAADId: input.userAADId,
                courseId: input.courseId,
                courseTitle,
                skillId: input.skillId || (String(course.SkillIds ?? '').split(';')[0] ?? ''),
                attemptDate: quizResult.attemptDate,
                score: summary.score,
                passed: summary.passed,
                attempts,
                feedback: graded,
            }, userRecord.siteId);
        } catch (err) {
            console.warn('[QuizSubmit] appendQuizResponse failed (non-fatal):', (err as any)?.message ?? err);
        }

        // WRITE #2 — UserState update.
        const previousOverall = userRecord.state.OverallProgress;
        const nextState = summary.passed
            ? applyQuizPass(userRecord.state, input.courseId, quizResult, course)
            : applyQuizFail(userRecord.state, input.courseId, quizResult);
        await upsertUserState(graph, nextState, userRecord);
        return { ok: true as const, userRecord, course, courseTitle, previousOverall, nextState };
    });
    if (!persisted.ok) {
        await sendPlain(context, persisted.problem);
        return;
    }
    const { userRecord, course, courseTitle, previousOverall, nextState } = persisted;

    // Render the quizResult card.
    const feedbackCard = graded.map((g) => ({
        id: g.id, text: g.text, userAnswer: g.userAnswer, correct: g.correct,
        correctAnswer: g.correctAnswer, topicTag: g.topicTag,
        explanation: g.explanation,
    }));
    const skillNameForFooter = nextState.Skills.find((s) => s.competencyId === (input.skillId || String(course.SkillIds).split(';')[0]))?.competencyName;
    const footer = summary.passed
        ? `Nice work! ${skillNameForFooter ? `You've moved up in **${skillNameForFooter}** 🎉` : 'Keep going!'}`
        : `You're close — review the tagged topics and reply "retry quiz for ${courseTitle}" when ready.`;
    await sendCard(context, {
        type: 'quizResult',
        courseTitle,
        skillName: skillNameForFooter,
        score: summary.score,
        total: cached.length,
        passed: summary.passed,
        feedback: feedbackCard,
        footer,
    });

    markGraded(input.userAADId, input.courseId);
    dequeueQuiz(input.userAADId, input.courseId);

    let milestoneShown = false;
    if (summary.passed) {
        clearQuiz(input.userAADId, input.courseId);

        // POST-QUIZ CASCADE — 80% milestone + 100% completion.
        if (previousOverall < 80 && nextState.OverallProgress >= 80 && !nextState.Milestone80Fired) {
            await fireMilestone80(context, authorization, input.userAADId, nextState);
            milestoneShown = true;
        }
        if (nextState.OverallProgress === 100 && !nextState.Completion100Fired) {
            await fireCompletion100(context, authorization, input.userAADId, nextState);
            milestoneShown = true;
        }
    }

    // NEXT STEP — never leave the user hanging after the result card.
    // 1) another learning-portal completion awaiting a quiz, else 2) a course the user
    // reported in chat (queued when the first quiz was sent).
    let next: { courseId: string; courseTitle: string } | null = null;
    try {
        const portal = await readLearningPortalStatus(graph, input.userAADId, userRecord.siteId);
        const fromPortal = pickNextPendingQuiz(nextState, portal);
        if (fromPortal && fromPortal.courseId !== input.courseId) next = fromPortal;
    } catch (err) {
        console.warn('[QuizSubmit] Cascade lookup failed (non-fatal):', (err as any)?.message ?? err);
    }
    if (!next) {
        for (const id of peekQueuedQuizzes(input.userAADId)) {
            const entry = nextState.LearningProgress.find((l) => l.courseId === id);
            if (entry && !isValidated(entry)) { next = { courseId: id, courseTitle: entry.courseTitle }; break; }
            dequeueQuiz(input.userAADId, id);
        }
    }

    if (next) {
        await sendPlain(context, summary.passed
            ? `Next up: **${next.courseTitle}** — here's its quick check. 📝`
            : `You can retry **${courseTitle}** any time — just say "retry quiz for ${courseTitle}". Meanwhile, here's the quick check for **${next.courseTitle}**. 📝`);
        await emitQuizFor(context, authorization, input.userAADId, next.courseId);
    } else if (summary.passed && !milestoneShown) {
        await sendCard(context, {
            ...buildProgressCardFromState(nextState),
            footer: `Here's where you stand now. Tell me when you finish your next course and I'll quiz you on it. 🚀`,
        } as CardPayload);
    }
}

// ============================================================================
// STAGE 6 — 80% milestone (deterministic)
// ============================================================================

async function fireMilestone80(
    context: TurnContext,
    authorization: Authorization,
    userAADId: string,
    state: UserState,
): Promise<void> {
    const graph = getAgenticGraphClient(context, authorization);
    const responses = await readAllQuizResponsesForUser(graph, userAADId);
    const agg = computeMilestoneAggregate(state, responses);
    await sendCard(context, {
        type: 'milestone80',
        roleTitle: state.TargetRole,
        overall: state.OverallProgress,
        stillToClose: agg.stillToClose,
        areasToStrengthen: agg.areasToStrengthen,
        footer: `You're at ${state.OverallProgress}% — an incredible milestone. Keep the momentum going! 🚀`,
    });
    // Persist the guard (re-read under the user lock so it can't clobber a concurrent update).
    await withUserLock(userAADId, async () => {
        const record = await readUserState(graph, userAADId);
        if (record) {
            await upsertUserState(graph, { ...record.state, Milestone80Fired: true }, record);
        }
    });
}

// ============================================================================
// STAGE 7 — 100% completion + manager email (deterministic + LLM prose)
// ============================================================================

async function fireCompletion100(
    context: TurnContext,
    authorization: Authorization,
    userAADId: string,
    state: UserState,
): Promise<void> {
    const graph = getAgenticGraphClient(context, authorization);

    // Aggregate stats deterministically.
    const completedCourses = (state.LearningProgress ?? [])
        .filter((lp) => lp.status === 'Complete')
        .map((lp) => ({ title: lp.courseTitle, url: lp.url }));
    const portal = await readLearningPortalStatus(graph, userAADId);
    const portalMinutes = portal
        .filter((r) => r.Status === 'Complete')
        .reduce((sum, r) => sum + Number(r.TimeSpentMinutes ?? 0), 0);
    const lpMinutes = (state.LearningProgress ?? [])
        .filter((lp) => lp.status === 'Complete')
        .reduce((sum, lp) => sum + Number(lp.timeSpentMinutes ?? 0), 0);
    const totalMinutes = portalMinutes > 0 ? portalMinutes : lpMinutes;

    // Compose the email (LLM sub-call for prose).
    let subject = `🎉 ${state.Title} completed the ${state.TargetRole} career plan`;
    let htmlBody = `<p>Congratulations to ${state.Title} on completing the ${state.TargetRole} career plan.</p>`;

    // Resolve manager fresh if UserState doesn't have it cached (Save-plan may have missed it,
    // or the manager relationship changed since then). Best-effort; not fatal.
    let managerName = state.ManagerName;
    let managerEmail = state.ManagerEmail;
    if (!managerEmail) {
        try {
            const mgr = await getMyManager(graph, userAADId);
            if (mgr) {
                managerName = mgr.displayName ?? managerName;
                managerEmail = mgr.mail ?? managerEmail;
                console.log(`[Completion100] Resolved manager on the fly: ${managerName} <${managerEmail}>`);
            }
        } catch (err) {
            console.warn('[Completion100] getMyManager failed (non-fatal):', (err as any)?.message ?? err);
        }
    }

    try {
        const email = await composeCompletionEmail({
            userName: state.Title,
            managerName,
            targetRole: state.TargetRole,
            completedCourses,
            totalMinutes,
            planStartDate: state.PlanCreatedDate,
        });
        subject = email.subject || subject;
        htmlBody = email.htmlBody || htmlBody;
    } catch (err) {
        console.warn('[Completion100] composeCompletionEmail failed; using fallback body:', (err as any)?.message ?? err);
    }

    // Get user's own email to include as the primary To recipient.
    let userEmail: string | undefined;
    try {
        const profile = await getMyProfile(graph, userAADId);
        userEmail = profile.mail || profile.userPrincipalName;
    } catch { /* best-effort */ }

    // Send the email deterministically. Convention:
    //   To: the user (they see the celebration too + a copy lands in their Sent Items).
    //   Cc: the manager (informed but not addressed).
    let sent = false;
    let note: string | undefined;
    const to: string[] = [];
    const cc: string[] = [];
    if (userEmail) to.push(userEmail);
    if (managerEmail && managerEmail.toLowerCase() !== (userEmail ?? '').toLowerCase()) cc.push(managerEmail);
    // Fallback: if we somehow lack a userEmail, still send to the manager only.
    if (to.length === 0 && cc.length > 0) { to.push(cc[0]); cc.length = 0; }

    if (to.length === 0) {
        note = 'No manager or user email found — the email was drafted but not sent.';
    } else {
        try {
            await sendMail({ to, cc, subject, htmlBody, fromUserId: userAADId, graph });
            sent = true;
            console.log(`[Completion100] Email sent. To=${to.join(', ')} Cc=${cc.join(', ') || '(none)'}`);
        } catch (err) {
            note = `Email send failed: ${(err as any)?.message ?? err}`;
        }
    }

    await sendCard(context, {
        type: 'completionSummary',
        roleTitle: state.TargetRole,
        managerName,
        managerEmail,
        userEmail,
        totalTimeMinutes: totalMinutes,
        coursesCompleted: completedCourses.length,
        subject,
        sent,
        note,
        footer: sent
            ? `Congratulations! An email has been sent to your manager. 🎉 This goal is now complete — say "hi" whenever you're ready to set your next one.`
            : `Your plan is 100% complete. ${note ?? ''}`,
    });

    // Only close the goal when the email actually went out — otherwise it stays Active so a
    // retry can succeed (say "check my progress"). Once Completed, the next chat starts fresh
    // with the welcome card; the goal stays in UserState as history ("show my previous goals").
    if (sent) {
        await withUserLock(userAADId, async () => {
            const record = await readUserState(graph, userAADId);
            if (record) {
                await upsertUserState(graph, {
                    ...record.state,
                    Completion100Fired: true,
                    PlanStatus: 'Completed',
                    PlanCompletedDate: today(),
                    // Cache the manager we resolved (freshly) so next reads have it too.
                    ManagerName: managerName ?? record.state.ManagerName,
                    ManagerEmail: managerEmail ?? record.state.ManagerEmail,
                }, record);
                console.log(`[Completion100] Goal "${record.state.TargetRole}" marked Completed.`);
            }
        });
    } else {
        console.warn('[Completion100] Email not sent — leaving Completion100Fired=false so a retry can succeed.');
    }
}

// ============================================================================
// Shared helpers
// ============================================================================

async function sendCard(context: TurnContext, payload: CardPayload): Promise<void> {
    const att = renderCard(payload);
    if (!att) {
        console.warn('[handlers] Unable to render card for payload type:', payload.type);
        return;
    }
    await context.sendActivity(MessageFactory.attachment(att));
}

/** Reply when the user has no active goal — new user, or their last goal is finished. */
async function noActiveGoalMessage(graph: ReturnType<typeof getAgenticGraphClient>, userAADId: string): Promise<string> {
    const previous = await readPreviousPlans(graph, userAADId).catch(() => []);
    if (!previous.length) return "I don't see a saved plan for you yet. Tell me your target role and we'll build one together.";
    const last = previous[0].state;
    const how = last.PlanStatus === 'Completed' ? 'completed' : 'closed';
    return `You don't have an active goal right now — you ${how} your **${last.TargetRole}** goal${last.PlanCompletedDate ? ` on ${last.PlanCompletedDate}` : ''}. ` +
        `Tell me your next target role to start a new goal, or ask to see your previous goals.`;
}

async function sendPlain(context: TurnContext, text: string): Promise<void> {
    await context.sendActivity(MessageFactory.text(text));
}

function buildProgressCardFromState(state: UserState): CardPayload {
    return {
        type: 'progress',
        roleTitle: state.TargetRole,
        overall: state.OverallProgress,
        goals: (state.Goals ?? []).map((g) => ({
            name: g.competencyName,
            progressPct: g.progressPct,
            status: g.status,
        })),
        learning: (state.LearningProgress ?? []).map((lp) => ({
            title: lp.courseTitle,
            skill: (state.Skills.find((s) => s.competencyId === lp.skillId)?.competencyName) ?? lp.skillId,
            status: lp.status,
        })),
        footer: state.OverallProgress === 100
            ? 'You made it! 🎉'
            : `Great progress! Let me know when you complete another course or need assistance!`,
    };
}
