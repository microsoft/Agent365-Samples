// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// IMPORTANT: Load environment variables FIRST before any other imports
// This ensures NODE_ENV and other config is available when AgentApplication initializes
import { configDotenv } from 'dotenv';
configDotenv();

import { TurnState, AgentApplication, TurnContext, MemoryStorage, MessageFactory } from '@microsoft/agents-hosting';
import { Activity, ActivityTypes, Attachment } from '@microsoft/agents-activity';
// A365 Observability — best-effort instrumentation (verify against official sample)
import { BaggageBuilder, BaggageBuilderUtils, ExecuteToolScope, InvokeAgentScope } from '@microsoft/opentelemetry';
import type { AgentDetails, CallerDetails, InvokeAgentScopeDetails, A365Request, Channel } from '@microsoft/opentelemetry';

// Notification Imports
import '@microsoft/agents-a365-notifications';
import { AgentNotificationActivity, NotificationType, createEmailResponseActivity } from '@microsoft/agents-a365-notifications';

import { Client, getClient, hasClient } from './client';
import { extractCards, buildMessageCard, defaultWelcomeAttachment, CardPayload, renderCard } from './cards';
import { getAgenticGraphClient } from './graph-service';
import * as proactiveRefs from './proactive-refs';
import { FileStorage } from './file-storage';
import { handleSkillRatingsSubmit, handleSavePlanSubmit, savePlan, savePlanInputFromReview, handleQuizSubmit, handleSyncProgress, emitQuizFor, queueReportedCourses, savedPlanReviewCard, handleCompletedAllCourses, findReportedCourses, handleReportedCompletions, validateBlockedCourses, SkillRatingInput } from './handlers';
import { getQuiz, queueQuizzes, wasGraded } from './quiz-cache';
import { takeBlockedCompletions } from './sharepoint-tools';
import { extractEmailText, extractQuotedHistory, emailTurnPrompt, llmResponseToEmailHtml, isSavePlanIntent, findPlanReview, cardPayloadToHtml, markdownToHtml } from './email-conversation';
import { getPendingPlan, putPendingPlan, clearPendingPlan } from './email-plan-store';
import { observabilityConversationId, observabilitySessionDescription, setObservabilityConversationId } from './observability/conversation-id';

/**
 * Adaptive Card Action.Execute delivers the full action envelope
 * `{ type, title, verb, data: { ...actualInputs } }` to the actionExecute handler,
 * not the flat submit values. This helper unwraps one level when we detect the
 * envelope shape, so downstream code can read input ids directly. If the SDK
 * ever changes to pass flat data, this becomes a no-op.
 */
function unwrapActionData(raw: any): any {
  if (raw && typeof raw === 'object' && typeof raw.verb === 'string' && raw.data && typeof raw.data === 'object') {
    return raw.data;
  }
  return raw;
}

/** Fire a plain prose message from proactive turns before the deterministic card. */
async function sendPreface(ctx: TurnContext, text: string): Promise<void> {
  try { await ctx.sendActivity(MessageFactory.text(text)); } catch { /* non-fatal */ }
}

/**
 * Summarizes an outgoing activity for observability output messages: message text as-is,
 * Adaptive Cards as "[card] <first TextBlock>". Typing indicators etc. are ignored.
 */
function describeOutgoing(activity: Partial<Activity>): string | undefined {
  if (activity?.type && activity.type !== 'message') return undefined;
  const parts: string[] = [];
  if (activity?.text) parts.push(String(activity.text));
  for (const att of activity?.attachments ?? []) {
    const body: any[] = (att as any)?.content?.body ?? [];
    const firstText = (function find(items: any[]): string | undefined {
      for (const item of items ?? []) {
        if (item?.type === 'TextBlock' && item.text) return String(item.text);
        const nested = find(item?.items ?? item?.columns ?? []);
        if (nested) return nested;
      }
      return undefined;
    })(body);
    parts.push(`[card] ${firstText ?? (att as any)?.contentType ?? 'attachment'}`);
  }
  for (const entity of (activity?.entities ?? []) as any[]) {
    if (entity?.type === 'emailResponse' && entity.htmlBody) {
      const plain = String(entity.htmlBody).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      parts.push(`[email reply] ${plain}`);
    }
  }
  const out = parts.join('\n').trim();
  return out ? out.slice(0, 1000) : undefined;
}

/**
 * Detects bounce / non-delivery-report (NDR) emails. Replying to them fails (502) and only
 * loops the error, so they're ignored. Matches on the system sender or on the standard NDR text.
 */
function isBounceEmail(activity: Partial<Activity>, htmlBody?: string): boolean {
  const from = activity?.from as any;
  const sender = `${from?.name ?? ''} ${from?.id ?? ''}`.toLowerCase();
  if (/postmaster|mailer-daemon|microsoftexchange[0-9a-f]{6,}/.test(sender) || sender.trim().startsWith('microsoft outlook')) return true;
  const text = `${activity?.text ?? ''} ${htmlBody ?? ''}`.toLowerCase().replace(/<[^>]+>/g, ' ');
  return [
    'delivery has failed to these recipients',
    'undeliverable:',
    'delivery status notification (failure)',
    "your message couldn't be delivered",
    'your message could not be delivered',
    'mail delivery failed',
  ].some((p) => text.includes(p));
}

/** True for transient network failures (DNS, connection resets, timeouts) — worth a simple retry. */
function isNetworkError(err: unknown): boolean {
  const e = err as any;
  const text = `${e?.message ?? ''} ${e?.code ?? ''} ${e?.cause?.code ?? ''} ${e?.cause?.message ?? ''}`.toLowerCase();
  return /fetch failed|enotfound|eai_again|econnreset|econnrefused|etimedout|socket hang up|network|timed out|timeout|und_err/.test(text);
}

/** Detect free-text phrases that mean "check my progress" / "run a sync". */
function isSyncIntent(text: string): boolean {
  const t = text.toLowerCase().trim();
  const patterns = [
    'check my progress', 'sync my learning', 'sync my progress',
    'any updates', 'what have i completed', 'update my progress',
    'resend completion email', 'resend the email', 'resend email',
    'refire milestones', 'recheck progress', 'progress check',
  ];
  return patterns.some((p) => t === p || t.includes(p));
}

/** Detect "I completed all (the/my) courses" style messages (not negated ones). */
export function isCompletedAllIntent(text: string): boolean {
  const t = text.toLowerCase().replace(/[’']/g, "'").trim();
  if (t.endsWith('?')) return false;
  if (/\b(not|haven't|havent|didn't|didnt|yet to|still need|how do i|can i)\b/.test(t)) return false;
  const verb = /\b(completed|complete|finished|finish|done)\b/.test(t);
  const all = /\b(all|every|each)\b/.test(t);
  const what = /\b(courses?|trainings?|modules?|of them|everything|my plan|the plan|learning)\b/.test(t) || /\b(all|everything)\s*[.!🎉]*$/.test(t);
  return verb && all && what;
}

/** Detect "I completed / finished …" course reports (not questions or negations). */
export function isCompletionReport(text: string): boolean {
  const t = text.toLowerCase().replace(/[’']/g, "'").trim();
  if (t.endsWith('?')) return false;
  if (/\b(not|haven't|havent|didn't|didnt|yet to|still need|how do i|can i)\b/.test(t)) return false;
  return /\b(completed|complete|finished|finish|done|passed)\b/.test(t);
}

export class MyAgent extends AgentApplication<TurnState> {
  static authHandlerName: string = 'agentic';

  constructor() {
    super({
      storage: new MemoryStorage(),
      // Enable the built-in Proactive subsystem so we can DM users from an HTTP webhook.
      // Use FileStorage (disk-backed) so nodemon restarts don't wipe the SDK's
      // Conversation records — otherwise proactive.continueConversation throws
      // -120742 "Conversation not found" after every code change. The aadObjectId ->
      // conversationId map lives separately on disk in .proactive-refs.json.
      proactive: {
        storage: new FileStorage('.proactive-storage.json'),
        failOnUnsignedInConnections: false,
      },
      authorization: {
        agentic: {
          type: 'agentic',
        } // scopes set in the .env file...
      }
    });

    // ── A365 lifecycle-event guard — MUST out-rank every other route ──
    // A365 emits system "agentLifecycle" events (e.g. AgenticUserIdentityUpdated) during
    // onboarding. They are type:event with a `value` object that has no `action`. The hosting
    // SDK registers adaptiveCards.actionExecute() as Invoke-priority routes whose selector calls
    // parseValueActionExecuteSelector() on the activity value — and that helper THROWS
    // "Invalid action value" whenever the value isn't a card action. Route selection runs
    // Invoke routes before our notification route, so the throw crashes the turn first, which
    // then triggers a failed error-reply to the onboarding conversation (HTTP 502) on a loop.
    // Registering this as an Agentic+Invoke route with rank 0 (RouteRank.First) makes it
    // short-circuit selection BEFORE the adaptiveCards selectors run. Lifecycle events need no
    // reply, so we just acknowledge them.
    this.addRoute(
      async (context: TurnContext) =>
        context.activity?.type === ActivityTypes.Event &&
        String((context.activity as any)?.name ?? '').toLowerCase() === 'agentlifecycle',
      async (context: TurnContext) => {
        console.log(`[Lifecycle] Acknowledged agentLifecycle event (valueType=${(context.activity as any)?.valueType ?? ''}) — no reply sent.`);
      },
      true,  // isInvokeRoute
      0,     // rank = RouteRank.First
      [],    // authHandlers
      true,  // isAgenticRoute → priority 0 (Agentic + Invoke), evaluated before adaptiveCards
    );

    // Route agent notifications
    this.onAgentNotification("agents:*", async (context: TurnContext, state: TurnState, agentNotificationActivity: AgentNotificationActivity) => {
      await this.handleAgentNotificationActivity(context, state, agentNotificationActivity);
    }, 1, [MyAgent.authHandlerName]);

    this.onActivity(ActivityTypes.Message, async (context: TurnContext, state: TurnState) => {
      await this.handleAgentMessageActivity(context, state);
    }, [MyAgent.authHandlerName]);

    // Handle agent install / uninstall events (agentInstanceCreated / InstallationUpdate)
    this.onActivity(ActivityTypes.InstallationUpdate, async (context: TurnContext, state: TurnState) => {
      await this.handleInstallationUpdateActivity(context, state);
    });

    // Feature 2 (Per-course quiz): the Submit button on the quiz card. We grade the
    // answers DETERMINISTICALLY (MCQ = letter match; short-answer = focused LLM sub-call
    // via handlers.ts) — no full LLM turn. This eliminates hallucinated skill bumps,
    // wrong goal completion, and 10-30s invoke timeouts.
    this.adaptiveCards.actionExecute('careercoach_quiz_submit', async (context: TurnContext, _state: TurnState, rawData: any) => {
      const data = unwrapActionData(rawData);
      try {
        const courseId = String(data?.courseId ?? '');
        const skillId = String(data?.skillId ?? '');
        const meta: Array<{ id: string; type: string; topicTag: string }> = Array.isArray(data?.questionMeta) ? data.questionMeta : [];
        const answersByQuestionId: Record<string, string> = {};
        for (const m of meta) {
          answersByQuestionId[m.id] = data && typeof data[m.id] !== 'undefined' ? String(data[m.id]) : '';
        }
        const userAADId = context.activity?.from?.aadObjectId ?? '';
        if (!userAADId || !courseId) {
          console.warn('[Quiz] Missing userAADId or courseId in submit payload.');
          return 'Sorry — could not identify the quiz. Please try again.';
        }
        console.log(`[Quiz] Deterministic grading for course ${courseId} (${Object.keys(answersByQuestionId).length} answers).`);
        // Lock the card: replace it with a read-only copy showing the submitted answers so it
        // can't be edited or resubmitted. Best-effort, same pattern as the skill-ratings card.
        try {
          const cardMessageId = (context.activity as any).replyToId;
          const questions = getQuiz(userAADId, courseId);
          if (cardMessageId && questions && questions.length > 0) {
            const readOnlyAttachment = renderCard({
              type: 'quiz',
              courseId,
              courseTitle: String(data?.courseTitle ?? '') || courseId,
              skillId,
              intro: '5 quick questions to lock in what you learned. Pass = 4 of 5.',
              questions: questions.map((q) => ({ id: q.id, type: q.type, text: q.text, choices: q.choices, topicTag: q.topicTag })),
              readOnly: true,
              answers: answersByQuestionId,
            });
            if (readOnlyAttachment) {
              await context.updateActivity({ type: 'message', id: cardMessageId, attachments: [readOnlyAttachment] } as any);
              console.log(`[Quiz] Card updated to read-only (id=${cardMessageId}).`);
            }
          }
        } catch (err) {
          console.warn('[Quiz] updateActivity to read-only failed (non-fatal):', (err as any)?.message ?? err);
        }
        // Fire-and-forget so the invoke returns fast (LLM short-answer grading + writes
        // can take ~5-10s; Teams' invoke timeout is ~10s and shows a red banner if we exceed it).
        const quizTitle = String(data?.courseTitle ?? '') || courseId;
        const answerSummary = Object.entries(answersByQuestionId).map(([id, a]) => `${id}: ${a || '(no answer)'}`).join('\n');
        this.runDeferred(context, {
          label: 'Quiz',
          action: `grade your **${quizTitle}** quiz`,
          // Safe to resubmit only while the attempt wasn't recorded; keeps the user's answers.
          restore: () => {
            const questions = getQuiz(userAADId, courseId);
            if (wasGraded(userAADId, courseId) || !questions?.length) return undefined;
            return renderCard({
              type: 'quiz',
              courseId,
              courseTitle: quizTitle,
              skillId,
              intro: '5 quick questions to lock in what you learned. Pass = 4 of 5.',
              questions: questions.map((q) => ({ id: q.id, type: q.type, text: q.text, choices: q.choices, topicTag: q.topicTag })),
              answers: answersByQuestionId,
            });
          },
          retryHint: (restored) => restored
            ? 'Your answers are still filled in — click **Submit answers** to try again.'
            : 'Say **check my progress** and I\'ll pick up where we left off.',
        }, () => this.runObserved(context, `Submitted quiz answers for ${quizTitle} (${courseId}):\n${answerSummary}`,
          { name: 'grade_quiz', description: 'Grade the course quiz and record the result', args: { courseId, skillId } },
          () => handleQuizSubmit(context, this.authorization, {
            userAADId,
            courseId,
            skillId,
            answersByQuestionId,
          }),
        ));
        return 'Grading your answers…';
      } catch (err) {
        console.error('[Quiz] Failed to route quiz submission:', (err as any)?.message ?? err);
        return 'Sorry — I could not process the quiz answers. Please try submitting again.';
      }
    });

    // Stage 2 (Plan review): the "Continue — see my gaps" button on the skill-path card.
    // Deterministic — we compute gaps + rank courses from LearningCatalog directly, no LLM.
    // The submit payload carries skills[] with {id, competencyId, name, target} + user's ratings.
    this.adaptiveCards.actionExecute('careercoach_skill_ratings', async (context: TurnContext, _state: TurnState, rawData: any) => {
      const data = unwrapActionData(rawData);
      try {
        const meta: Array<{ id: string; competencyId?: string; name: string; target?: number }> = Array.isArray(data?.skills) ? data.skills : [];
        const roleTitle = String(data?.roleTitle ?? '');

        // Ratings arrive at the top level of `data`, keyed by input id (e.g. { skill_1: '2', ... }).
        const lookup = (id: string): unknown => {
          if (!data || !id) return undefined;
          const variants = [id, id.replace(/-/g, '_'), id.replace(/_/g, '-'), id.replace(/[-_]/g, ''), id.toLowerCase(), id.toUpperCase()];
          for (const v of variants) {
            if (typeof data[v] !== 'undefined' && data[v] !== null && String(data[v]).trim() !== '') return data[v];
          }
          return undefined;
        };

        const skills: SkillRatingInput[] = meta.map((m) => {
          const raw = lookup(m.id);
          const level = typeof raw !== 'undefined' ? Number(raw) : null;
          return {
            id: m.id,
            competencyId: m.competencyId ?? '',
            name: m.name,
            target: Number(m.target ?? 0),
            level: (typeof level === 'number' && !isNaN(level)) ? level : null,
          };
        });

        const rated = skills.filter((s) => s.level !== null).length;
        if (rated === 0) {
          console.warn('[SkillRatings] User clicked Continue but no ratings arrived. Meta ids:', meta.map((m) => m.id).join(', '));
          await context.sendActivity(MessageFactory.attachment(buildMessageCard(
            'Please pick your level for each skill before clicking **Continue**. Even choosing **0 · Not started** counts — I just need to know where you\'re starting from. 🙂',
          )));
          return 'Please rate each skill first.';
        }
        console.log(`[SkillRatings] Deterministic plan review for role "${roleTitle}" — ${rated}/${skills.length} skills rated.`);

        // Replace the interactive card with a read-only summary showing the user's picks.
        // This disables the dropdowns and hides the Continue button, giving clear "submitted"
        // feedback. Best-effort — if updateActivity fails (e.g. we don't have replyToId), we
        // just continue with the fire-and-forget handler below.
        try {
          const cardMessageId = (context.activity as any).replyToId;
          if (cardMessageId) {
            const readOnlyAttachment = renderCard({
              type: 'skillPath',
              roleTitle,
              interactive: true,
              readOnly: true,
              intro: `Rate your current level for each skill (0 = never touched, 4 = advanced).`,
              skills: skills.map((s) => ({
                id: s.id,
                competencyId: s.competencyId,
                name: s.name,
                target: s.target,
                currentLevel: s.level ?? 0,
              })),
            });
            if (readOnlyAttachment) {
              await context.updateActivity({
                type: 'message',
                id: cardMessageId,
                attachments: [readOnlyAttachment],
              } as any);
              console.log(`[SkillRatings] Card updated to read-only (id=${cardMessageId}).`);
            }
          } else {
            console.warn('[SkillRatings] No replyToId on invoke — cannot update the card to read-only.');
          }
        } catch (err) {
          console.warn('[SkillRatings] updateActivity to read-only failed (non-fatal):', (err as any)?.message ?? err);
        }

        // Fire-and-forget deterministic handler (SharePoint reads take ~1-2s; still returns fast).
        const ratingSummary = skills.map((s) => `${s.name}: ${s.level ?? 'not rated'} (target ${s.target})`).join('\n');
        this.runDeferred(context, {
          label: 'SkillRatings',
          action: `build your **${roleTitle}** gap analysis`,
          // Unlock the rating card with the user's picks kept, unless the plan was already shown.
          restore: (delivered) => delivered > 0 ? undefined : renderCard({
            type: 'skillPath',
            roleTitle,
            interactive: true,
            intro: `Rate your current level for each skill (0 = never touched, 4 = advanced).`,
            skills: skills.map((s) => ({
              id: s.id,
              competencyId: s.competencyId,
              name: s.name,
              target: s.target,
              currentLevel: s.level ?? 0,
            })),
          }),
          retryHint: (restored) => restored
            ? 'Your ratings are still selected — click **Continue — see my gaps** to try again.'
            : `Reply with **${roleTitle}** to start the ratings again.`,
        }, () => this.runObserved(context, `Rated my skills for ${roleTitle}:\n${ratingSummary}`,
          { name: 'build_plan_review', description: 'Compute skill gaps and recommend courses', args: { roleTitle } },
          () => handleSkillRatingsSubmit(context, this.authorization, { roleTitle, skills }),
        ));
        return 'Got it — building your gap analysis and course picks…';
      } catch (err) {
        console.error('[SkillRatings] routing failed:', (err as any)?.message ?? err);
        return 'Sorry — I could not read your ratings. Please try clicking Continue again.';
      }
    });

    // Stage 3 (Save plan): the "Save my plan" button on the planReview card.
    // Deterministic — we build UserState in TypeScript and POST directly. No LLM.
    // The submit payload carries {courseCount, groups:[{skill, competencyId, courses:[...]}]}
    // AND we need the user's ratings — since those aren't in the save payload, we take
    // them from what the LLM would have carried… but with the deterministic path they
    // arrive as part of `data.ratings` (added by cards.ts).
    this.adaptiveCards.actionExecute('careercoach_save_plan', async (context: TurnContext, _state: TurnState, rawData: any) => {
      const data = unwrapActionData(rawData);
      try {
        const groups = Array.isArray(data?.groups) ? data.groups : [];
        const ratings: Array<{ competencyId: string; name: string; level: number; target: number }> =
          Array.isArray(data?.ratings) ? data.ratings : [];
        const roleTitle = String(data?.roleTitle ?? '');
        const targetRoleId = data?.targetRoleId ? String(data.targetRoleId) : undefined;
        const userAADId = context.activity?.from?.aadObjectId ?? '';
        const displayName = context.activity?.from?.name ?? 'user';
        if (!userAADId) {
          console.warn('[SavePlan] Missing userAADId; cannot save.');
          return 'Sorry — I could not identify you. Please try again.';
        }
        if (ratings.length === 0) {
          console.warn('[SavePlan] Missing ratings in payload; the plan may be saved with empty Skills/Goals.');
        }
        console.log(`[SavePlan] Deterministic save: role="${roleTitle}" groups=${groups.length} ratings=${ratings.length}`);
        // Lock the card: swap it for a read-only "Plan saved" copy so Save can't be clicked again.
        try {
          const cardMessageId = (context.activity as any).replyToId;
          const savedAttachment = cardMessageId ? renderCard(savedPlanReviewCard({ roleTitle, groups, ratings })) : undefined;
          if (cardMessageId && savedAttachment) {
            await context.updateActivity({ type: 'message', id: cardMessageId, attachments: [savedAttachment] } as any);
            console.log(`[SavePlan] Card updated to saved/read-only (id=${cardMessageId}).`);
          }
        } catch (err) {
          console.warn('[SavePlan] updateActivity to read-only failed (non-fatal):', (err as any)?.message ?? err);
        }
        const courseCount = groups.reduce((n: number, g: any) => n + (Array.isArray(g?.courses) ? g.courses.length : 0), 0);
        this.runDeferred(context, {
          label: 'SavePlan',
          action: `save your **${roleTitle}** plan`,
          // Bring the Save button back, unless the saved plan was already shown.
          restore: (delivered) => delivered > 0 ? undefined
            : renderCard({ ...savedPlanReviewCard({ roleTitle, groups, ratings }), saved: false, footer: "Click 💾 Save my plan when you're ready." }),
          retryHint: (restored) => restored
            ? 'Click **💾 Save my plan** again to retry.'
            : 'Say **check my progress** to see what was saved.',
        }, () => this.runObserved(context, `Save my plan: ${roleTitle} (${courseCount} courses across ${groups.length} skills)`,
          { name: 'save_plan', description: 'Save the career plan to SharePoint and show the progress card', args: { roleTitle, courseCount } },
          () => handleSavePlanSubmit(context, this.authorization, {
            userAADId, displayName, roleTitle, targetRoleId, groups, ratings,
          }),
        ));
        return 'Saving your plan…';
      } catch (err) {
        console.error('[SavePlan] routing failed:', (err as any)?.message ?? err);
        return 'Sorry — I could not save the plan just now. Please try clicking Save again.';
      }
    });

    // Welcome-card tile clicks. Each tile fires Action.Execute with verb "careercoach_welcome"
    // and { intent: "goal" | "skills" | "prep" | "progress" }. We route "progress" straight
    // through the deterministic sync handler; the other three synthesize a natural-language
    // user message and re-enter the standard message flow so the LLM picks up from there.
    this.adaptiveCards.actionExecute('careercoach_welcome', async (context: TurnContext, state: TurnState, rawData: any) => {
      const data = unwrapActionData(rawData);
      const intent = String(data?.intent ?? '');
      const aadObjectId = context.activity?.from?.aadObjectId ?? '';
      console.log(`[Welcome] Tile clicked: intent=${intent}`);
      try {
        if (intent === 'progress') {
          if (!aadObjectId) return 'I could not identify you. Please try again.';
          // Fire-and-forget — sync + card render + potential milestone cascade can take a few
          // seconds; returning fast prevents Teams' invoke timeout ("Something went wrong").
          this.runDeferred(context, {
            label: 'Welcome',
            action: 'check your progress',
            retryHint: () => 'Say **check my progress** to try again.',
          }, () => this.runObserved(context, 'Show my progress (welcome card tile)',
            { name: 'sync_progress', description: 'Sync learning progress from the learning portal and show the progress card' },
            () => handleSyncProgress(context, this.authorization, aadObjectId),
          ));
          return 'Checking your progress…';
        }
        const synthByIntent: Record<string, string> = {
          goal: 'I want to set a target role and build my career development plan.',
          skills: 'Show me my skill gaps for my target role.',
          prep: 'Help me prep for my next 1:1 with my manager.',
        };
        const synthetic = synthByIntent[intent];
        if (!synthetic) {
          console.warn(`[Welcome] Unknown intent "${intent}" — ignoring.`);
          return 'Sorry — I did not recognize that action. Try typing what you want to do.';
        }
        (context.activity as any).text = synthetic;
        (context.activity as any).value = undefined;
        // Fire-and-forget so the invoke returns fast — the full LLM turn (with SharePoint reads)
        // can easily exceed Teams' 10s Action.Execute timeout otherwise.
        this.runDeferred(context, {
          label: 'Welcome',
          action: 'start that',
          retryHint: () => 'Please type what you\'d like to do (for example, "I want to set a new goal").',
        }, () => this.handleAgentMessageActivity(context, state));
        return 'On it — one moment…';
      } catch (err) {
        console.error('[Welcome] routing failed:', (err as any)?.message ?? err);
        return 'Sorry — that action failed. Please try again.';
      }
    });
  }

  /**
 * Handles incoming user messages and sends responses.
 */
  async handleAgentMessageActivity(turnContext: TurnContext, state: TurnState): Promise<void> {
    const userMessage = turnContext.activity.text?.trim() || '';

    const from = turnContext.activity?.from;
    console.log(`Turn received from user — DisplayName: '${from?.name ?? "(unknown)"}', UserId: '${from?.id ?? "(unknown)"}', AadObjectId: '${from?.aadObjectId ?? "(none)"}'`);
    const displayName = from?.name ?? 'unknown';

    // Capture this conversation for proactive messaging so the /api/portal-event webhook
    // can DM this user later. Best-effort — never fail the turn on a persistence hiccup.
    await this.rememberConversationForProactive(turnContext).catch((e) =>
      console.warn('[Proactive] rememberConversation failed (non-fatal):', (e as any)?.message ?? e),
    );

    // Welcome-card tile clicks arrive as Action.Submit — activity.text may be empty and
    // the payload lives in activity.value = { action: "welcome_goal" | "welcome_skills" | "welcome_prep" | "welcome_progress" }.
    // Route each to the corresponding flow (synthesized text or deterministic handler).
    // (Left disabled — the welcome card now uses Action.Execute with verb "careercoach_welcome",
    // handled by the actionExecute registration in the constructor above.)

    // Refresh userMessage from activity.text in case we just synthesized it above.
    const effectiveUserMessage = turnContext.activity.text?.trim() || userMessage;

    if (!effectiveUserMessage) {
      await turnContext.sendActivity(MessageFactory.attachment(buildMessageCard('Please send me a message and I\'ll help you!')));
      return;
    }

    // Preview the welcome card on demand (useful for returning users during testing).
    if (effectiveUserMessage.toLowerCase() === '/welcome') {
      await turnContext.sendActivity(MessageFactory.attachment(defaultWelcomeAttachment(displayName)));
      return;
    }

    // "check my progress" and similar phrases → deterministic Stage 4-SYNC (no LLM turn).
    // This is the same path the proactive webhook uses. Handles the milestone + completion
    // cascade automatically when the user's plan crosses the thresholds.
    const aadObjectId = from?.aadObjectId;
    if (aadObjectId && isSyncIntent(effectiveUserMessage)) {
      console.log(`[Sync] Deterministic sync triggered by user text: "${effectiveUserMessage}"`);
      try {
        await this.runObserved(turnContext, effectiveUserMessage,
          { name: 'sync_progress', description: 'Sync learning progress from the learning portal and show the progress card' },
          () => handleSyncProgress(turnContext, this.authorization, aadObjectId));
      } catch (err) {
        console.error('[Sync] handleSyncProgress failed:', (err as any)?.message ?? err);
        await turnContext.sendActivity(MessageFactory.text(`Sorry — I hit an error syncing your progress: ${(err as any)?.message ?? err}`));
      }
      return;
    }

    // "I completed all the courses" → deterministic: list every not-yet-validated course in the
    // plan and quiz them one by one (the LLM path can't match "all" to specific courses).
    if (aadObjectId && isCompletedAllIntent(effectiveUserMessage)) {
      console.log(`[CompletedAll] Triggered by user text: "${effectiveUserMessage}"`);
      try {
        await this.runObserved(turnContext, effectiveUserMessage,
          { name: 'validate_all_courses', description: 'List every course in the plan still to validate and start the first quiz' },
          () => handleCompletedAllCourses(turnContext, this.authorization, aadObjectId));
      } catch (err) {
        console.error('[CompletedAll] handleCompletedAllCourses failed:', (err as any)?.message ?? err);
        await turnContext.sendActivity(MessageFactory.text(`Sorry — I hit an error checking your courses: ${(err as any)?.message ?? err}`));
      }
      return;
    }

    // "I completed <course> …" naming courses from the plan → deterministic quiz queue.
    // Falls through to the LLM when no plan course is named (e.g. a course outside the plan).
    if (aadObjectId && isCompletionReport(effectiveUserMessage)) {
      try {
        const reported = await findReportedCourses(turnContext, this.authorization, aadObjectId, effectiveUserMessage);
        if (reported) {
          console.log(`[CompletedCourses] Deterministic quiz queue for: "${effectiveUserMessage.replace(/\s+/g, ' ').slice(0, 120)}"`);
          await this.runObserved(turnContext, effectiveUserMessage,
            { name: 'validate_reported_courses', description: 'Quiz the courses the user reported as completed', args: { courseIds: reported.named.map((lp) => lp.courseId) } },
            () => handleReportedCompletions(turnContext, this.authorization, aadObjectId, reported));
          return;
        }
      } catch (err) {
        console.error('[CompletedCourses] handleReportedCompletions failed:', (err as any)?.message ?? err);
        await turnContext.sendActivity(MessageFactory.text(`Sorry — I hit an error checking your courses: ${(err as any)?.message ?? err}`));
        return;
      }
    }

    // Send a typing indicator immediately (awaited so it arrives before the LLM call starts).
    // The typing loop below keeps it alive while we work — no plain-text "working on it" bubble,
    // so every turn produces exactly one polished Adaptive Card.
    // Non-fatal: a transient "fetch failed" sending the indicator must never crash the turn.
    try {
      await turnContext.sendActivity({ type: 'typing' } as Activity);
    } catch (e) {
      console.warn('Initial typing indicator failed (non-fatal):', (e as any)?.message ?? e);
    }

    // Background loop refreshes the "..." animation every ~4s (it times out after ~5s).
    // Only visible in 1:1 and small group chats.
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    const startTypingLoop = () => {
      typingInterval = setInterval(() => {
        turnContext.sendActivity({ type: 'typing' } as Activity).catch(() => {
          // Typing indicator failed — non-critical, continue
        });
      }, 4000);
    };
    const stopTypingLoop = () => { clearInterval(typingInterval); };

    startTypingLoop();

    // A365 Observability — best-effort instrumentation (verify against official sample)
    // Outer baggage scope populated from TurnContext (tenant / agent identity). The exporter's
    // app-only token is resolved on demand by the token resolver (see telemetry.ts).
    const baggageScope = BaggageBuilderUtils.fromTurnContext(
      new BaggageBuilder(),
      turnContext as any
    ).sessionDescription(observabilitySessionDescription(turnContext))
      .build();

    try {
      await baggageScope.run(async () => {
        // InvokeAgentScope wraps the whole agent turn; the InferenceScope in
        // client.invokeAgentWithScope nests under it.
        const invokeScope = this.startInvokeAgentScope(turnContext, effectiveUserMessage);
        try {
          await invokeScope.withActiveSpanAsync(async () => {
            const client: Client = await getClient(this.authorization, MyAgent.authHandlerName, turnContext, displayName);
            const response = await client.invokeAgentWithScope(effectiveUserMessage, { turnContext, authorization: this.authorization });
            invokeScope.recordOutputMessages([response]);
            // New-user welcome: the model emits a ::welcome:: control token; we render the
            // designed welcome card here (with the real display name) instead of prose.
            if (response.includes('::welcome::')) {
              await turnContext.sendActivity(MessageFactory.attachment(defaultWelcomeAttachment(displayName)));
              return;
            }
            // Render EVERY response as an Adaptive Card: any leading prose becomes a message
            // card, followed by any structured ```card views the model emitted.
            // Quiz cards are deferred: an LLM-authored quiz has no server-side answer key, so
            // the deterministic grader can't score it. We regenerate it via emitQuizFor instead.
            const { text, attachments, deferred } = extractCards(response, { deferTypes: ['quiz'] });
            const cards = [] as ReturnType<typeof buildMessageCard>[];
            if (text) cards.push(buildMessageCard(text));
            cards.push(...attachments);
            if (cards.length > 0) {
              await turnContext.sendActivity(MessageFactory.list(cards));
            } else if (deferred.length === 0) {
              await turnContext.sendActivity(response);
            }
            const quizUser = turnContext.activity?.from?.aadObjectId;
            const quiz = deferred.find((p) => p.type === 'quiz') as Extract<CardPayload, { type: 'quiz' }> | undefined;
            // Courses the progress guard stopped the LLM from marking Complete this turn.
            const blocked = takeBlockedCompletions(turnContext);
            if (quiz && quizUser && quiz.courseId) {
              console.log(`[Quiz] Replacing LLM-authored quiz with deterministic quiz for course ${quiz.courseId}.`);
              try {
                const queued = await queueReportedCourses(turnContext, this.authorization, quizUser, effectiveUserMessage, String(quiz.courseId));
                if (queued.length) console.log(`[Quiz] Queued ${queued.length} more reported course(s): ${queued.join(' | ')}`);
              } catch (err) {
                console.warn('[Quiz] Could not queue reported courses (non-fatal):', (err as any)?.message ?? err);
              }
              queueQuizzes(quizUser, blocked.filter((id) => id !== String(quiz.courseId)));
              await emitQuizFor(turnContext, this.authorization, quizUser, String(quiz.courseId));
            } else if (blocked.length && quizUser) {
              // The LLM tried to mark courses Complete without a quiz and didn't offer one —
              // start the quizzes ourselves so the user isn't left waiting.
              console.log(`[ProgressGuard] Starting quizzes for blocked course(s): ${blocked.join(', ')}`);
              await validateBlockedCourses(turnContext, this.authorization, quizUser, blocked);
            }
          });
        } catch (scopeError) {
          invokeScope.recordError(scopeError as Error);
          throw scopeError;
        } finally {
          invokeScope.dispose();
        }
      });
    } catch (error) {
      console.error('LLM query error:', error);
      const err = error as any;
      try {
        await turnContext.sendActivity(MessageFactory.attachment(buildMessageCard(`Sorry — something went wrong: ${err.message || err}`)));
      } catch (sendErr) {
        console.warn('Failed to send error message (non-fatal):', (sendErr as any)?.message ?? sendErr);
      }
    } finally {
      stopTypingLoop();
      baggageScope.dispose();
    }
  }

  /**
   * Runs a card action's work after the invoke has already returned ("Got it…", "Saving…").
   * On failure the user is told, instead of the chat going silent: the clicked card is unlocked
   * (via `restore`, e.g. with the user's picks kept) when it's safe to resubmit, and a short
   * message explains what failed and how to retry. `restore` receives how many messages the
   * work already delivered, so it can skip unlocking when results were already shown.
   */
  private async runDeferred(
    context: TurnContext,
    opts: {
      label: string;
      action: string;
      restore?: (delivered: number) => Attachment | undefined;
      retryHint: (restored: boolean) => string;
    },
    work: () => Promise<unknown>,
  ): Promise<void> {
    let delivered = 0;
    context.onSendActivities(async (_ctx, activities, next) => {
      const result = await next();
      delivered += activities.filter((a) => a.type === 'message').length;
      return result;
    });
    try {
      await work();
    } catch (err) {
      const network = isNetworkError(err);
      console.error(`[${opts.label}] Deferred step failed${network ? ' (network)' : ''}:`, (err as any)?.message ?? err);

      let restored = false;
      const cardMessageId = (context.activity as any).replyToId;
      try {
        const attachment = cardMessageId ? opts.restore?.(delivered) : undefined;
        if (attachment) {
          await context.updateActivity({ type: 'message', id: cardMessageId, attachments: [attachment] } as any);
          restored = true;
          console.log(`[${opts.label}] Card unlocked for retry (id=${cardMessageId}).`);
        }
      } catch (restoreErr) {
        console.warn(`[${opts.label}] Could not unlock the card (non-fatal):`, (restoreErr as any)?.message ?? restoreErr);
      }

      const reason = network ? ' — I lost the connection to Microsoft 365 for a moment' : '';
      const text = `Sorry — I couldn't ${opts.action} just now${reason}. ${opts.retryHint(restored)}`;
      // The same outage can also break this reply, so try twice before giving up.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await context.sendActivity(MessageFactory.attachment(buildMessageCard(text)));
          return;
        } catch (sendErr) {
          if (attempt === 2) {
            console.error(`[${opts.label}] Could not tell the user about the failure:`, (sendErr as any)?.message ?? sendErr);
          } else {
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
      }
    }
  }

  /**
   * Stores the current TurnContext in the SDK's proactive subsystem and remembers the
   * AAD Object ID -> conversationId mapping in `.proactive-refs.json`. Called at the top of
   * every user message so any user who has ever talked to the agent is reachable proactively.
   */
  private async rememberConversationForProactive(turnContext: TurnContext): Promise<void> {
    const aad = turnContext.activity?.from?.aadObjectId;
    if (!aad) return;
    const convId = await this.proactive.storeConversation(turnContext);
    proactiveRefs.setRef(aad, convId);
  }

  /**
   * Real-time trigger: a Power Automate flow watching the SharePoint `LearningPortalStatus`
   * list POSTs to `/api/portal-event` with the affected user's AADId (and optionally the row
   * fields). This method:
   *   1. Looks up the user's cached conversationId (they must have opened the agent at least
   *      once so we know how to reach them in Teams).
   *   2. Opens a proactive Teams turn via `app.proactive.continueConversation(...)`.
   *   3. Inside that turn, synthesizes a "check my progress" user message so the existing
   *      Stage 4-SYNC flow (deterministic SharePoint read/diff via Graph) picks up the change, diffs UserState, and
   *      renders the quiz card if the row shows a course just completed.
   *
   * Returns a small ack object the HTTP handler can serialize to JSON.
   */
  async handleProactivePortalEvent(aadObjectId: string, payload: any): Promise<{ ok: boolean; reason?: string }> {
    if (!aadObjectId) return { ok: false, reason: 'aadObjectId is required in the request body.' };

    const convId = proactiveRefs.getRef(aadObjectId);
    if (!convId) {
      const reason = `No cached conversation for aadObjectId=${aadObjectId}. Ask the user to open the agent in Teams once, then re-fire the trigger.`;
      console.warn('[Proactive] ' + reason);
      return { ok: false, reason };
    }

    // Optional heads-up prose we thread into the LLM turn — nudges the model to explain what
    // triggered the message (from the user's perspective the DM appears out of nowhere).
    const courseId = typeof payload?.CourseId === 'string' ? payload.CourseId : undefined;
    const status = typeof payload?.Status === 'string' ? payload.Status : undefined;
    const preface = courseId
      ? `Your learning portal just updated${status ? ` (status: ${status})` : ''} for course ${courseId} — checking your plan now.`
      : `Your learning portal just updated — checking your plan now.`;

    // The LLM's Stage 4-SYNC section triggers on any of these phrases. We prepend a short
    // preface so the model addresses the user warmly before the sync card arrives.
    const syntheticText = `${preface} check my progress`;

    try {
      await this.proactive.continueConversation(
        this.adapter,
        convId,
        async (ctx: TurnContext, _state: TurnState) => {
          if (ctx.activity.from) {
            (ctx.activity.from as any).aadObjectId = aadObjectId;
          }
          const hasAgentIdentity = !!(ctx.activity.recipient as any)?.agenticAppId;
          console.log(`[Proactive] Continuing conversation for aadObjectId=${aadObjectId} (convId=${convId}, agentIdentity=${hasAgentIdentity ? 'present' : 'missing'})`);
          // Deterministic Stage 4-SYNC — no LLM turn. Reads UserState + LearningPortalStatus,
          // diffs, writes changes, and either shows progress card or emits the next-queued quiz.
          // Traced as an event-triggered run (EventToAgent): the input describes the portal
          // event and the caller is the employee whose learning-portal row changed.
          const eventInput = `Learning portal event: course ${courseId ?? '(unspecified)'}${status ? ` is now ${status}` : ' updated'} for this user`;
          await this.runObserved(ctx, eventInput,
            { name: 'sync_progress', description: 'Sync learning progress after a learning-portal update and quiz newly completed courses', args: { courseId, status } },
            async () => {
              await sendPreface(ctx, preface);
              await handleSyncProgress(ctx, this.authorization, aadObjectId);
            });
        },
        [], // don't require any OAuth handler to sign in — runtime Graph uses agentic auth
        { type: 'message' as any, text: syntheticText },
      );
      return { ok: true };
    } catch (err) {
      const msg = (err as any)?.message ?? String(err);
      console.error('[Proactive] continueConversation failed:', msg);
      return { ok: false, reason: msg };
    }
  }

  // A365 Observability — best-effort instrumentation (verify against official sample)
  /**
   * Agent / caller / request details for this turn's spans. Identity is resolved live from the
   * turn's recipient (agentic instance + blueprint). The env agent id is only a fallback when it
   * isn't the blueprint id — a blueprint can't export over the S2S route.
   */
  private observabilityDetails(turnContext: TurnContext, content: string): { agentDetails: AgentDetails; callerDetails: CallerDetails; request: A365Request } {
    const recipient = turnContext.activity?.recipient as any;
    const from = turnContext.activity?.from as any;
    const envAgentId = process.env.agent365Observability__agentId;
    const fallbackAgentId = envAgentId && envAgentId !== process.env.agent365Observability__agentBlueprintId ? envAgentId : undefined;
    const agentDetails: AgentDetails = {
      // Empty when the turn has no agent identity (e.g. Playground): the exporter then drops the
      // spans quietly instead of requesting a token for an identity that doesn't exist.
      agentId: recipient?.agenticAppId || fallbackAgentId || '',
      agentName: process.env.agent365Observability__agentName || 'Employee Career Coach',
      agentDescription: process.env.agent365Observability__agentDescription || 'Employee Career Coach',
      agentAUID: recipient?.agenticUserId || undefined,
      agentBlueprintId: recipient?.agenticAppBlueprintId || process.env.agent365Observability__agentBlueprintId || undefined,
      tenantId: recipient?.tenantId || process.env.agent365Observability__tenantId || undefined,
    };
    const callerDetails: CallerDetails = {
      userDetails: {
        userId: from?.aadObjectId || from?.id || '',
        userName: from?.name || '',
        userEmail: typeof from?.id === 'string' && from.id.includes('@') ? from.id : undefined,
      },
    };
    const request: A365Request = {
      content,
      conversationId: observabilityConversationId(turnContext),
      channel: { name: turnContext.activity?.channelId } as Channel,
    };
    return { agentDetails, callerDetails, request };
  }

  /** Starts the InvokeAgentScope (invoke_agent span) for a turn. */
  private startInvokeAgentScope(turnContext: TurnContext, userMessage: string): InvokeAgentScope {
    const { agentDetails, callerDetails, request } = this.observabilityDetails(turnContext, userMessage);
    const scopeDetails: InvokeAgentScopeDetails = {
      endpoint: { host: process.env.WEBSITE_HOSTNAME || process.env.HOST || 'localhost', port: Number(process.env.PORT) || 3978 },
    };
    const scope = InvokeAgentScope.start(request, scopeDetails, agentDetails, callerDetails);
    scope.recordInputMessages([userMessage]);
    return scope;
  }

  /**
   * Runs a code-handled step with the same observability shape as an LLM turn:
   * baggage → invoke_agent → (optional) execute_tool. The input and every message the agent
   * sends are recorded as the run's input / output messages, so these turns reach Defender /
   * Purview / the admin center just like LLM turns. Pass `tool: null` when the work already
   * creates its own child spans (e.g. LLM calls). Errors are recorded and rethrown.
   */
  private async runObserved(
    turnContext: TurnContext,
    input: string,
    tool: { name: string; description: string; args?: Record<string, unknown> } | null,
    work: () => Promise<unknown>,
  ): Promise<void> {
    const outputs: string[] = [];
    turnContext.onSendActivities(async (_ctx, activities, next) => {
      for (const a of activities) {
        const summary = describeOutgoing(a);
        if (summary) outputs.push(summary);
      }
      return next();
    });
    const baggageScope = BaggageBuilderUtils.fromTurnContext(new BaggageBuilder(), turnContext as any)
      .conversationId(observabilityConversationId(turnContext))
      .sessionDescription(observabilitySessionDescription(turnContext))
      .build();
    await baggageScope.run(async () => {
      const invokeScope = this.startInvokeAgentScope(turnContext, input);
      try {
        await invokeScope.withActiveSpanAsync(async () => {
          if (!tool) {
            await work();
            return;
          }
          const { agentDetails, callerDetails, request } = this.observabilityDetails(turnContext, input);
          const toolScope = ExecuteToolScope.start(request, {
            toolName: tool.name,
            description: tool.description,
            toolType: 'function',
            toolCallId: `${tool.name}-${Date.now()}`,
            arguments: tool.args ?? {},
          }, agentDetails, callerDetails.userDetails);
          try {
            await toolScope.withActiveSpanAsync(work);
            toolScope.recordResponse(outputs.length ? outputs.join('\n---\n') : 'completed');
          } catch (err) {
            toolScope.recordError(err as Error);
            throw err;
          } finally {
            toolScope.dispose();
          }
        });
        invokeScope.recordOutputMessages(outputs.length ? outputs : ['(no message sent)']);
      } catch (err) {
        invokeScope.recordError(err as Error);
        throw err;
      } finally {
        invokeScope.dispose();
      }
    });
  }


  async handleAgentNotificationActivity(context: TurnContext, state: TurnState, agentNotificationActivity: AgentNotificationActivity) {
    switch (agentNotificationActivity.notificationType) {
      case NotificationType.EmailNotification: {
        if (isBounceEmail(context.activity, agentNotificationActivity.emailNotification?.htmlBody)) {
          console.log(`[Email] Ignored bounce / non-delivery email from '${context.activity.from?.name ?? 'unknown'}' — no reply sent.`);
          break;
        }
        // Trace the whole email run (invoke_agent) so its LLM calls have a root span and the
        // run is eligible for Defender / Purview / admin-center reporting. Like a Teams turn, the
        // input is the user's message (the email text, quoted history removed).
        const sender = context.activity.from?.name || 'unknown sender';
        // One conversation per email thread in Activity (the per-message conversation id changes each email).
        setObservabilityConversationId(context, agentNotificationActivity.emailNotification?.conversationId);
        const emailInput = extractEmailText(context.activity.text, agentNotificationActivity.emailNotification?.htmlBody)
          || `Email from ${sender}`;
        try {
          await this.runObserved(context, emailInput, null,
            () => this.handleEmailNotification(context, state, agentNotificationActivity));
        } catch (err) {
          console.error('[Email] Email notification run failed:', (err as any)?.message ?? err);
        }
        break;
      }
      case NotificationType.AgentLifecycleNotification:
        // Lifecycle events (e.g. agent instance created during onboarding) are one-way system
        // notifications delivered to a system conversation. Replying is not allowed and returns
        // a 502 from the connector, so we only log and never call sendActivity here.
        console.log(`Received agent lifecycle notification (type ${agentNotificationActivity.notificationType}) — no reply sent.`);
        break;
      default:
        // Never let a reply failure (e.g. system conversations that reject replies) crash the turn.
        try {
          await context.sendActivity(`Received notification of type: ${agentNotificationActivity.notificationType}`);
        } catch (error) {
          console.error(`Failed to reply to notification of type ${agentNotificationActivity.notificationType}:`, (error as any)?.message ?? error);
        }
    }
  }

  private async handleEmailNotification(context: TurnContext, state: TurnState, activity: AgentNotificationActivity): Promise<void> {
    const emailNotification = activity.emailNotification;
    const emailText = extractEmailText(context.activity.text, emailNotification?.htmlBody);
    const reply = async (html: string): Promise<void> => {
      try {
        await context.sendActivity(createEmailResponseActivity(html));
      } catch (err) {
        console.warn('[Email] Could not send the email reply (non-fatal):', (err as any)?.message ?? err);
      }
    };

    // Only people in this organization get a conversation, scoped to their own plan. Anyone can
    // email the agent, so unknown / external / guest senders are ignored (no reply, no data).
    const from = context.activity.from as any;
    const recipient = context.activity.recipient as any;
    const senderAddress = String(from?.id ?? '').trim();
    if (!senderAddress || senderAddress.toLowerCase() === String(recipient?.id ?? '').toLowerCase()) return;
    let sender: { id?: string; displayName?: string; userType?: string } | null = null;
    try {
      const graph = getAgenticGraphClient(context, this.authorization);
      sender = await graph.api(`/users/${encodeURIComponent(senderAddress)}`).select('id,displayName,userType').get();
    } catch (err) {
      console.warn('[Email] Sender lookup failed:', (err as any)?.message ?? err);
    }
    if (!sender?.id || (sender.userType && sender.userType !== 'Member')) {
      console.warn(`[Email] Ignored email from a sender outside the organization — no reply sent.`);
      return;
    }
    // Same identity fields a Teams turn carries, so the conversation is scoped to this user's plan.
    from.aadObjectId = sender.id;
    if (sender.displayName) from.name = sender.displayName;
    const displayName = sender.displayName || from?.name || 'there';

    if (!emailText) {
      await reply(`<p>Hi ${displayName.split(' ')[0]}, your email looks empty — what would you like help with? 🙂</p>`);
      return;
    }
    console.log(`[Email] Conversation turn from '${displayName}' (${emailText.length} chars).`);

    // The activity conversation id changes with every email; the email thread id is stable.
    const threadKey = `email:${emailNotification?.conversationId || context.activity.conversation?.id || ''}`;

    // "Save it" → save the plan proposed earlier in this thread with the same code as the Teams Save button.
    if (isSavePlanIntent(emailText)) {
      const pending = await getPendingPlan(threadKey, sender.id);
      if (pending) {
        console.log(`[Email] Saving plan "${pending.roleTitle}" from this thread's planReview.`);
        try {
          const result = await savePlan(context, this.authorization, savePlanInputFromReview(pending, sender.id, displayName));
          await clearPendingPlan(threadKey);
          const intro = result.saved
            ? `<p>Your <b>${pending.roleTitle}</b> plan is saved! 🎉 Tell me when you complete a course and I'll track your progress.</p>`
            : markdownToHtml(result.message ?? '');
          await reply(intro + cardPayloadToHtml(result.card));
        } catch (error) {
          console.error('[Email] Plan save failed:', (error as any)?.message ?? error);
          await reply('<p>Sorry — I couldn\'t save your plan just now. Please reply "Save it" again in a moment.</p>');
        }
        return;
      }
      console.log('[Email] Save requested but no pending plan for this thread — handing to the LLM.');
    }

    try {
      // Same Career Coach LLM, tools and rules as Teams. The email thread id keys the client
      // cache, so replies in the thread keep the conversation history. With no history (first
      // email, or after a restart), the quoted thread below the reply restores the context.
      const quotedHistory = hasClient(threadKey) ? '' : extractQuotedHistory(context.activity.text, emailNotification?.htmlBody);
      if (quotedHistory) console.log(`[Email] No history for this thread — using ${quotedHistory.length} chars of quoted email history.`);
      const client: Client = await getClient(this.authorization, MyAgent.authHandlerName, context, displayName, threadKey);
      const response = await client.invokeAgentWithScope(emailTurnPrompt(emailText, quotedHistory), { turnContext: context, authorization: this.authorization });
      const plan = findPlanReview(response);
      if (plan) await putPendingPlan(threadKey, sender.id, plan);
      let html = llmResponseToEmailHtml(response, displayName);
      if (takeBlockedCompletions(context).length) {
        html += '<p>📝 Courses only count as complete after their quick quiz — open <b>Career Coach</b> in Microsoft Teams and tell me which courses you finished to take it.</p>';
      }
      await reply(html);
    } catch (error) {
      console.error('Email notification error:', (error as any)?.message ?? error);
      await reply('<p>Sorry — I couldn\'t process your email just now. Please try again, or message me in Microsoft Teams.</p>');
    }
  }
  /**
   * Handles agent install and uninstall events (agentInstanceCreated / InstallationUpdate).
   * Sends a welcome message on install and a farewell on uninstall.
   */
  async handleInstallationUpdateActivity(context: TurnContext, state: TurnState): Promise<void> {
    const from = context.activity?.from;
    console.log(`InstallationUpdate received — Action: '${context.activity.action ?? "(none)"}', DisplayName: '${from?.name ?? "(unknown)"}', UserId: '${from?.id ?? "(unknown)"}'`);

    if (context.activity.action === 'add') {
      await context.sendActivity(MessageFactory.attachment(defaultWelcomeAttachment(from?.name)));
    } else if (context.activity.action === 'remove') {
      await context.sendActivity(MessageFactory.attachment(buildMessageCard('Thank you for using Career Coach. Your growth journey continues — best of luck!')));
    }
  }
}

export const agentApplication = new MyAgent();
