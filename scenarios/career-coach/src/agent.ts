// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// IMPORTANT: Load environment variables FIRST before any other imports
// This ensures NODE_ENV and other config is available when AgentApplication initializes
import { configDotenv } from 'dotenv';
configDotenv();

import { TurnState, AgentApplication, TurnContext, MemoryStorage, MessageFactory } from '@microsoft/agents-hosting';
import { Activity, ActivityTypes } from '@microsoft/agents-activity';
import { BaggageBuilder } from '@microsoft/agents-a365-observability';
import { AgenticTokenCacheInstance, BaggageBuilderUtils } from '@microsoft/agents-a365-observability-hosting'
import { getObservabilityAuthenticationScope } from '@microsoft/agents-a365-runtime';

// Notification Imports
import '@microsoft/agents-a365-notifications';
import { AgentNotificationActivity, NotificationType, createEmailResponseActivity } from '@microsoft/agents-a365-notifications';

import { Client, getClient } from './client';
import { extractCards, buildMessageCard, defaultWelcomeAttachment, CardPayload, renderCard } from './cards';
import { getMyProfile, getMyManager, sendMail, getAgenticGraphClient } from './graph-service';
import * as proactiveRefs from './proactive-refs';
import tokenCache, { createAgenticTokenCacheKey } from './token-cache';
import { FileStorage } from './file-storage';
import { handleSkillRatingsSubmit, handleSavePlanSubmit, handleQuizSubmit, handleSyncProgress, SkillRatingInput } from './handlers';
import { summarizeEmailSafely } from './llm-tasks';

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
        // Fire-and-forget so the invoke returns fast (LLM short-answer grading + writes
        // can take ~5-10s; Teams' invoke timeout is ~10s and shows a red banner if we exceed it).
        handleQuizSubmit(context, this.authorization, {
          userAADId,
          courseId,
          skillId,
          answersByQuestionId,
        }).catch((err) => {
          console.error('[Quiz] Deferred handleQuizSubmit failed:', (err as any)?.message ?? err);
        });
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
        handleSkillRatingsSubmit(context, this.authorization, { roleTitle, skills }).catch((err) => {
          console.error('[SkillRatings] Deferred plan-review build failed:', (err as any)?.message ?? err);
        });
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
        handleSavePlanSubmit(context, this.authorization, {
          userAADId, displayName, roleTitle, targetRoleId, groups, ratings,
        }).catch((err) => {
          console.error('[SavePlan] Deferred save failed:', (err as any)?.message ?? err);
        });
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
          handleSyncProgress(context, this.authorization, aadObjectId).catch((err) => {
            console.error('[Welcome] handleSyncProgress failed:', (err as any)?.message ?? err);
          });
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
        this.handleAgentMessageActivity(context, state).catch((err) => {
          console.error('[Welcome] Deferred LLM turn failed:', (err as any)?.message ?? err);
        });
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
        await handleSyncProgress(turnContext, this.authorization, aadObjectId);
      } catch (err) {
        console.error('[Sync] handleSyncProgress failed:', (err as any)?.message ?? err);
        await turnContext.sendActivity(MessageFactory.text(`Sorry — I hit an error syncing your progress: ${(err as any)?.message ?? err}`));
      }
      return;
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

    // Populate baggage consistently from TurnContext using hosting utilities
    const baggageScope = BaggageBuilderUtils.fromTurnContext(
      new BaggageBuilder(),
      turnContext
    ).sessionDescription('Initial onboarding session')
      .build();

    // Preloads or refreshes the Observability token used by the Agent 365 Observability exporter.
    await this.preloadObservabilityToken(turnContext);

    try {
      await baggageScope.run(async () => {
        const client: Client = await getClient(this.authorization, MyAgent.authHandlerName, turnContext, displayName);
        const response = await client.invokeAgentWithScope(effectiveUserMessage, { turnContext, authorization: this.authorization });
        // New-user welcome: the model emits a ::welcome:: control token; we render the
        // designed welcome card here (with the real display name) instead of prose.
        if (response.includes('::welcome::')) {
          await turnContext.sendActivity(MessageFactory.attachment(defaultWelcomeAttachment(displayName)));
          return;
        }
        // Feature 4 — 100% completion email. The LLM emits `::send-completion-email:: {JSON}`
        // after it has already written Completion100Fired=true to UserState in the same turn.
        // The payload contains the LLM-composed subject + htmlBody + a summary block (roleTitle,
        // coursesCompleted, totalTimeMinutes). We add the recipients from Graph and dispatch.
        if (response.includes('::send-completion-email::')) {
          await this.handleCompletionEmail(turnContext, response);
          return;
        }
        // Render EVERY response as an Adaptive Card: any leading prose becomes a message
        // card, followed by any structured ```card views the model emitted.
        const { text, attachments } = extractCards(response);
        const cards = [] as ReturnType<typeof buildMessageCard>[];
        if (text) cards.push(buildMessageCard(text));
        cards.push(...attachments);
        if (cards.length > 0) {
          await turnContext.sendActivity(MessageFactory.list(cards));
        } else {
          await turnContext.sendActivity(response);
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
   * Feature 4 — dispatches the "career plan complete" email to the user + their manager
   * via Microsoft Graph. Uses the AGENTIC-auth Graph client (a fresh token exchanged from
   * the agentic identity every turn), so this runs as the agent — not as any developer.
   * Expects the LLM response to contain a control token of the form:
   *
   *   ::send-completion-email:: {"subject":"…","htmlBody":"…","roleTitle":"…","coursesCompleted":N,"totalTimeMinutes":N}
   *
   * On success renders a `completionSummary` Adaptive Card in-chat.
   * On failure (missing manager, Graph 5xx) the card explains what happened; we NEVER crash
   * the turn.
   *
   * If the agentic identity doesn't have `User.Read.All` / `Mail.Send` consented, the Graph
   * calls throw with a clear "Insufficient privileges…" message that surfaces on the card.
   */
  private async handleCompletionEmail(turnContext: TurnContext, response: string): Promise<void> {
    const marker = '::send-completion-email::';
    const idx = response.indexOf(marker);
    let payload: {
      subject?: string;
      htmlBody?: string;
      roleTitle?: string;
      coursesCompleted?: number;
      totalTimeMinutes?: number;
    } = {};
    if (idx >= 0) {
      const tail = response.slice(idx + marker.length).trim();
      // Extract the first balanced JSON object after the token.
      const match = tail.match(/\{[\s\S]*?\}/);
      if (match) {
        try { payload = JSON.parse(match[0]); }
        catch (e) { console.warn('[Completion] Could not parse ::send-completion-email:: JSON:', (e as any)?.message ?? e); }
      }
    }

    const subject = payload.subject
      || `🎓 Career plan complete${payload.roleTitle ? `: ${payload.roleTitle}` : ''}`;
    const htmlBody = payload.htmlBody
      || `<p>Great news — a career plan has just been completed.</p>`;

    // Resolve the affected user (the chatter, from the turn) — agentic auth needs their
    // AAD Object ID because `/me` doesn't exist for app-only tokens.
    const userAadId = turnContext.activity?.from?.aadObjectId;
    if (!userAadId) {
      console.warn('[Completion] Missing turnContext.activity.from.aadObjectId — cannot resolve user for email.');
    }

    let managerName: string | undefined;
    let managerEmail: string | undefined;
    let userEmail: string | undefined;
    let note: string | undefined;
    let sent = false;
    try {
      const graph = getAgenticGraphClient(turnContext, this.authorization);
      const [me, mgr] = await Promise.all([
        getMyProfile(graph, userAadId),
        getMyManager(graph, userAadId),
      ]);
      userEmail = me?.mail || me?.userPrincipalName;
      if (mgr?.mail) {
        managerName = mgr.displayName;
        managerEmail = mgr.mail;
        await sendMail({
          graph,
          fromUserId: userAadId,
          to: [managerEmail],
          cc: userEmail ? [userEmail] : undefined,
          subject,
          htmlBody,
        });
        sent = true;
      } else if (userEmail) {
        // No manager on the account — email the user directly so they still have a record.
        note = 'No manager on file — sent to you only.';
        await sendMail({ graph, fromUserId: userAadId, to: [userEmail], subject, htmlBody });
        sent = true;
      } else {
        note = 'Neither manager nor user email could be resolved — nothing sent.';
      }
    } catch (err) {
      const msg = (err as any)?.message ?? String(err);
      console.error('[Completion] sendMail failed:', msg);
      note = `Email could not be sent right now: ${msg}. You can ask me to resend later.`;
    }

    const cardPayload: CardPayload = {
      type: 'completionSummary',
      roleTitle: payload.roleTitle,
      managerName,
      managerEmail,
      userEmail,
      totalTimeMinutes: payload.totalTimeMinutes,
      coursesCompleted: payload.coursesCompleted,
      subject,
      sent,
      note,
      footer: sent
        ? "You did it — that's a huge career milestone. 🎉 Ready to set your next goal when you are."
        : "Your progress is fully saved. Ping me and I'll retry the email.",
    };
    // Render deterministically via the shared card renderer.
    try {
      const { attachments } = extractCards('```card\n' + JSON.stringify(cardPayload) + '\n```');
      if (attachments.length) {
        await turnContext.sendActivity(MessageFactory.attachment(attachments[0]));
      } else {
        await turnContext.sendActivity(MessageFactory.attachment(buildMessageCard(
          `Career plan complete! ${sent ? '📧 Email sent.' : '📧 ' + (note ?? 'Email not sent.')}`,
        )));
      }
    } catch (err) {
      console.error('[Completion] Failed to render completion card:', (err as any)?.message ?? err);
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
          console.log(`[Proactive] Continuing conversation for aadObjectId=${aadObjectId} (convId=${convId})`);
          // Deterministic Stage 4-SYNC — no LLM turn. Reads UserState + LearningPortalStatus,
          // diffs, writes changes, and either shows progress card or emits the next-queued quiz.
          await sendPreface(ctx, preface);
          await handleSyncProgress(ctx, this.authorization, aadObjectId);
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

  /**
   * Preloads or refreshes the Observability token used by the Agent 365 Observability exporter.
   *
   * Behavior:
   * - If the environment variable `Use_Custom_Resolver` is set to `true`, this method exchanges an
   *   AAU token using the agent's authorization and stores it in the local `tokenCache`, keyed by
   *   `agentId`/`tenantId` via `createAgenticTokenCacheKey`.
   * - Otherwise, it refreshes the built-in `AgenticTokenCacheInstance` by invoking
   *   `RefreshObservabilityToken`, which is used by the default token resolver configured in the client.
   *
   * Notes:
   * - Token acquisition failures are non-fatal for this sample and should not block the user flow.
   * - `agentId` and `tenantId` are derived from the current `TurnContext` activity recipient.
   * - Uses `getObservabilityAuthenticationScope()` to obtain the exporter auth scopes.
   *
   * @param turnContext The current turn context containing activity and identity metadata.
   */
  private async preloadObservabilityToken(turnContext: TurnContext): Promise<void> {
    const agentId = turnContext?.activity?.recipient?.agenticAppId ?? '';
    const tenantId = turnContext?.activity?.recipient?.tenantId ?? '';

    // Token acquisition here is best-effort and MUST be non-fatal: a transient network
    // failure (e.g. "fetch failed" reaching the A365 token endpoint) must never crash the
    // user's turn. Catch and log instead of letting it bubble to onTurnError.
    try {
      // Set Use_Custom_Resolver === 'true' to use a custom token resolver and a custom token cache (see token-cache.ts).
      // Otherwise: use the default AgenticTokenCache via RefreshObservabilityToken.
      if (process.env.Use_Custom_Resolver === 'true') {
        const aauToken = await this.authorization.exchangeToken(turnContext, 'agentic', {
          scopes: getObservabilityAuthenticationScope()
        });

        console.log(`Preloaded Observability token for agentId=${agentId}, tenantId=${tenantId}`);
        const cacheKey = createAgenticTokenCacheKey(agentId, tenantId);
        tokenCache.set(cacheKey, aauToken?.token || '');
      } else {
        // Preload/refresh the observability token into the built-in AgenticTokenCache.
        // We don't immediately need the token here, and if acquisition fails we continue (non-fatal for this demo sample).
        await AgenticTokenCacheInstance.RefreshObservabilityToken(
          agentId,
          tenantId,
          turnContext,
          this.authorization,
          getObservabilityAuthenticationScope()
        );
      }
    } catch (error) {
      console.warn('Observability token preload failed (non-fatal, continuing):', (error as any)?.message ?? error);
    }
  }

  async handleAgentNotificationActivity(context: TurnContext, state: TurnState, agentNotificationActivity: AgentNotificationActivity) {
    switch (agentNotificationActivity.notificationType) {
      case NotificationType.EmailNotification:
        await this.handleEmailNotification(context, state, agentNotificationActivity);
        break;
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

    if (!emailNotification) {
      const errorResponse = createEmailResponseActivity('I could not find the email notification details.');
      await context.sendActivity(errorResponse);
      return;
    }

    try {
      const client: Client = await getClient(this.authorization, MyAgent.authHandlerName, context);
      const runCtx = { turnContext: context, authorization: this.authorization };

      // First, retrieve the email content
      const emailContent = await client.invokeAgentWithScope(
        `You have a new email from ${context.activity.from?.name} with id '${emailNotification.id}', ` +
        `ConversationId '${emailNotification.conversationId}'. Please retrieve this message and return it in text format.`,
        runCtx,
      );

      // Then summarize the email SAFELY. The body is untrusted sender content, so we use a
      // no-tools summarization path that treats it strictly as quoted data — a crafted email
      // must never be able to drive tool calls, SharePoint reads/writes, or data exfiltration.
      const response = await summarizeEmailSafely(emailContent);

      const emailResponseActivity = createEmailResponseActivity(response || 'I have processed your email but do not have a response at this time.');
      await context.sendActivity(emailResponseActivity);
    } catch (error) {
      console.error('Email notification error:', error);
      const errorResponse = createEmailResponseActivity('Unable to process your email at this time.');
      await context.sendActivity(errorResponse);
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
