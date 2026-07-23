// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Card action router. Parses either:
//   - Adaptive Card Action.Submit click  (arrives as activity.value = {verb, ...})
//   - or a plain text keyword reply      (blocked / extend / ontrack / approve / …)
// Then dispatches to a handler that prompts the LLM to do the follow-up work
// (send extension request card to leader, book meeting, etc.).
//
// If nothing matches (activity has no card data and no keyword), returns
// { handled: false } so the caller can proceed with the normal LLM turn.

import { TurnContext } from '@microsoft/agents-hosting';
import type { Client } from '../client';
import {
  findLatestOpenFollowupForOwner,
  getFollowup,
  markResolved,
  PendingFollowup,
  recordOwnerResponse,
} from '../state/followupStore';
import { acknowledgePlannerTask, completePlannerTask, findOpenTaskByTitle, updatePlannerTaskDueDate, updatePlannerTaskTitle } from '../graph/plannerTools';
import { resolveAadToUpn } from '../graph/peopleTools';
import { sendBlockerMeetingCardDirect, sendExtensionRequestCardDirect, sendPlainDmToUser } from './followupCards';

export interface CardActionResult {
  handled: boolean;
  replyText?: string;
}

// Demo tenant runs in UTC, but the leader / owners are in India — propose
// meeting times against IST wall-clock, matching what the leader sees.
const DISPLAY_TZ = process.env.BRIEF_DISPLAY_TZ?.trim() || 'Asia/Kolkata';

// ─── Idempotency guard for card invokes ───────────────────────────────────
// Teams retries an Action.Submit invoke if the bot doesn't ack within ~5 s
// (and, more rarely, on transient socket errors). Retries reuse the same
// activity.id, so we key the dedupe on activity.id + verb. Any card action
// (ontrack, extend, blocked, approve_extend, reject_extend, reassign,
// book_meeting, defer_blocker, esc_reassign, esc_extend, esc_escalate,
// decision "Got it") is protected — a retried click becomes a no-op.
//
// The book_meeting handler also has its own time-slot-based dedupe below;
// this outer guard catches everything else too.
const cardInvokeSeen = new Map<string, number>();
const CARD_INVOKE_DEDUPE_MS = 60 * 1000;

function shouldSkipCardInvoke(key: string): boolean {
  const now = Date.now();
  for (const [k, ts] of cardInvokeSeen) {
    if (now - ts > CARD_INVOKE_DEDUPE_MS) cardInvokeSeen.delete(k);
  }
  if (cardInvokeSeen.has(key)) return true;
  cardInvokeSeen.set(key, now);
  return false;
}

// Legacy per-timeslot guard for book_meeting (belt & suspenders — kept in
// case Teams ever splits a retry across a fresh activity.id).
const bookMeetingSeen = new Map<string, number>();
const BOOK_MEETING_DEDUPE_MS = 60 * 1000;

function shouldSkipBookMeeting(key: string): boolean {
  const now = Date.now();
  for (const [k, ts] of bookMeetingSeen) {
    if (now - ts > BOOK_MEETING_DEDUPE_MS) bookMeetingSeen.delete(k);
  }
  if (bookMeetingSeen.has(key)) return true;
  bookMeetingSeen.set(key, now);
  return false;
}

/**
 * Deterministic meeting-slot proposer for the "I'm blocked" flow. Returns 3
 * candidate slots in the next 3 business days at 10:00, 14:00, 16:00 in
 * DISPLAY_TZ. Each slot has:
 *   - label: human-readable display for the card button ("Wed 15 Jul 10:00 AM IST")
 *   - iso:   ISO string with UTC offset the calendar API can consume
 *
 * Kept deliberately simple: no availability lookups (the leader picks the one
 * that works). Deterministic → no LLM hallucinations.
 */
function proposeMeetingSlots(now = new Date()): Array<{ label: string; iso: string }> {
  // The three hours-of-day we offer, in DISPLAY_TZ.
  const HOURS = [10, 14, 16];
  const slots: Array<{ label: string; iso: string }> = [];

  // Walk business days starting tomorrow.
  const nowTzYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [ty, tm, td] = nowTzYmd.split('-').map(Number);

  let dayOffset = 1;
  while (slots.length < 3) {
    // Compute the date in DISPLAY_TZ terms.
    // We use UTC midnight of the derived Y-M-D and then add the local hour;
    // for common TZs (like IST which is UTC+5:30, no DST) that is stable
    // enough for a demo. If DISPLAY_TZ has DST this drifts by ≤1 hour on
    // transition days — acceptable for the demo scenario.
    const base = new Date(Date.UTC(ty, tm - 1, td + dayOffset));
    const dow = base.getUTCDay(); // 0=Sun, 6=Sat
    dayOffset++;
    if (dow === 0 || dow === 6) continue; // skip weekends

    for (const hour of HOURS) {
      if (slots.length >= 3) break;
      // IST is UTC+5:30 → subtract 330 min to get equivalent UTC instant.
      // For non-IST TZs, use the local time as UTC (acceptable demo drift).
      const offsetMin = DISPLAY_TZ === 'Asia/Kolkata' ? 330 : 0;
      const localMs = Date.UTC(
        base.getUTCFullYear(),
        base.getUTCMonth(),
        base.getUTCDate(),
        hour,
        0,
        0
      );
      const utcMs = localMs - offsetMin * 60 * 1000;
      const utc = new Date(utcMs);

      const dayLabel = utc.toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: DISPLAY_TZ,
      });
      const timeLabel = utc.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: DISPLAY_TZ,
      });
      const tzAbbr = DISPLAY_TZ === 'Asia/Kolkata' ? 'IST' : DISPLAY_TZ;

      slots.push({
        label: `${dayLabel} ${timeLabel} ${tzAbbr}`,
        iso: utc.toISOString(),
      });
    }
  }
  return slots;
}

/**
 * Compute a sensible new due date for an extension request — 5 business days
 * from `max(today, currentDue)`. Deterministic; the LLM used to hallucinate
 * this and picked dates from its training-cutoff era (e.g. "2023-10-05"),
 * which Planner then rejected because the past date was before startDate.
 *
 * Returns an ISO 8601 string like "2026-07-21T00:00:00.000Z".
 */
function computeNextDueDateIso(currentDueIso?: string | null): string {
  const now = Date.now();
  let base = now;
  if (currentDueIso) {
    const parsed = Date.parse(currentDueIso);
    if (!Number.isNaN(parsed) && parsed > now) base = parsed;
  }
  // Anchor at midnight UTC to keep the value tidy in cards and Planner.
  const d = new Date(base);
  d.setUTCHours(0, 0, 0, 0);

  // Add 5 business days (skip Sat=6, Sun=0).
  let added = 0;
  while (added < 5) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d.toISOString();
}

/**
 * Extract a card-action payload from an incoming activity.
 * Teams surfaces Action.Submit clicks as `activity.value = {verb, ...}`.
 * We also fall back to keyword matching in `activity.text`.
 */
function extractIntent(
  context: TurnContext
): { verb: string; data: Record<string, unknown> } | null {
  const value = (context.activity as any).value as Record<string, unknown> | undefined;
  if (value && typeof value === 'object' && typeof (value as any).verb === 'string') {
    return { verb: String((value as any).verb).toLowerCase(), data: value };
  }
  const rawText = (context.activity.text ?? '').trim();
  if (!rawText) return null;
  const text = rawText.toLowerCase();

  // Keyword fallback — accept the words the card told the user to type.
  const kwMap: Record<string, string> = {
    'on track': 'ontrack',
    ontrack: 'ontrack',
    'i am on track': 'ontrack',
    'on-track': 'ontrack',

    extend: 'extend',
    'need more time': 'extend',
    'more time': 'extend',

    blocked: 'blocked',
    "i'm blocked": 'blocked',
    'im blocked': 'blocked',
    stuck: 'blocked',

    complete: 'complete',
    completed: 'complete',
    done: 'complete',
    'task done': 'complete',
    'task complete': 'complete',
    finished: 'complete',
    'i finished': 'complete',
    'im done': 'complete',
    "i'm done": 'complete',

    approve: 'approve_extend',
    'approve extension': 'approve_extend',
    reject: 'reject_extend',
    reassign: 'reassign',
    defer: 'defer_blocker',
    escalate: 'esc_escalate',
  };
  for (const [kw, verb] of Object.entries(kwMap)) {
    if (text === kw || text.startsWith(kw + ' ')) {
      if (verb === 'complete') {
        const hint = extractQuotedTitleHint(rawText);
        return { verb, data: hint ? { taskTitleHint: hint } : {} };
      }
      return { verb, data: {} };
    }
  }

  // Fuzzy completion intent detection — matches phrases the exact-prefix
  // keyword map above won't catch, e.g.:
  //   "The task 'Send draft proposal to Alex' is completed"
  //   "Hi — I finished the Contoso proposal"
  //   "'Send proposal' is done"
  // Two conditions: a completion verb appears AND either a quoted title
  // hint is present OR the message is short enough to unambiguously mean
  // "the task I was just asked about is done".
  const completionVerbRegex = /\b(complet(?:ed?|ing)|finish(?:ed)?|done|closed?|wrapped(?:\s+up)?)\b/i;
  if (completionVerbRegex.test(text)) {
    const hint = extractQuotedTitleHint(rawText);
    if (hint) {
      return { verb: 'complete', data: { taskTitleHint: hint } };
    }
    // Short message + completion verb → treat as "close my latest task".
    // Ignore long-form messages (>140 chars) so we don't hijack a genuine
    // question or narrative that happens to contain the word "done".
    if (rawText.length <= 140) {
      return { verb: 'complete', data: {} };
    }
  }

  return null;
}

/** Pull a quoted task-title fragment out of the message text. Supports
 *  straight double, straight single, curly double, curly single and
 *  backtick delimiters. Returns the FIRST non-trivial quoted substring
 *  (≥3 chars), or undefined. */
function extractQuotedTitleHint(text: string): string | undefined {
  // Order: straight-double, straight-single, backtick, curly-double, curly-single.
  const patterns: RegExp[] = [
    /"([^"]{3,200})"/,
    /'([^']{3,200})'/,
    /`([^`]{3,200})`/,
    /[\u201C\u201D]([^\u201C\u201D]{3,200})[\u201C\u201D]/,
    /[\u2018\u2019]([^\u2018\u2019]{3,200})[\u2018\u2019]/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1]) return m[1].trim();
  }
  return undefined;
}

/** Given a verb + data + sender, resolve the target PendingFollowup. Prefers
 *  followupId from the card data; falls back to the sender's latest open one. */
function resolveTargetFollowup(
  data: Record<string, unknown>,
  senderAad: string | undefined
): PendingFollowup | undefined {
  const fromData = typeof data.followupId === 'string' ? getFollowup(data.followupId) : undefined;
  return fromData ?? findLatestOpenFollowupForOwner(senderAad);
}

/**
 * Main entry point. Called from agent.ts handleUserMessage / handleInvoke.
 * Returns handled=true when we routed a card action (caller should NOT run
 * the normal LLM turn).
 */
export async function handleCardActionIfAny(
  context: TurnContext,
  client: Client,
  leaderAad: string
): Promise<CardActionResult> {
  const intent = extractIntent(context);
  if (!intent) return { handled: false };

  const senderAad = context.activity.from?.aadObjectId;
  const senderName = context.activity.from?.name ?? 'the user';
  const followup = resolveTargetFollowup(intent.data, senderAad);

  // Global per-activity dedupe. Teams reuses activity.id on invoke retries,
  // so if we've seen this exact click in the last 60 s we no-op — protects
  // every verb / every card from double-firing.
  const activityId = String((context.activity as any).id ?? '');
  const dedupeKey = activityId
    ? `${activityId}:${intent.verb}`
    : `${intent.verb}:${followup?.followupId ?? senderAad ?? 'unknown'}:${JSON.stringify(intent.data)}`;
  if (shouldSkipCardInvoke(dedupeKey)) {
    console.log(`[cardActionRouter] duplicate invoke suppressed verb=${intent.verb} key=${dedupeKey}`);
    return { handled: true };
  }

  const startedAt = Date.now();
  console.log(
    `[cardActionRouter] verb=${intent.verb} senderAad=${senderAad} matchedFollowup=${followup?.followupId ?? 'none'}`
  );
  // Wrap the rest in a try/finally so we always log elapsed time — makes
  // "why did that card look slow" trivially observable.
  try {
    return await routeIntent(context, client, leaderAad, intent, followup, senderName, senderAad);
  } finally {
    const elapsed = Date.now() - startedAt;
    console.log(`[cardActionRouter] verb=${intent.verb} elapsed=${elapsed}ms`);
  }
}

/** Actual per-verb dispatch. Split out so handleCardActionIfAny can wrap it
 *  in the dedupe + timing guardrails without another indent level. */
async function routeIntent(
  context: TurnContext,
  client: Client,
  leaderAad: string,
  intent: { verb: string; data: Record<string, unknown> },
  followup: PendingFollowup | undefined,
  senderName: string,
  senderAad: string | undefined
): Promise<CardActionResult> {
  // ── Owner-side actions (respond to their own check-in card) ──
  if (intent.verb === 'ontrack') {
    if (followup) {
      recordOwnerResponse(followup.followupId, 'ontrack');
      markResolved(followup.followupId);
    }

    // NEW: also patch the Planner task to make the acknowledgement visible
    // (Not started → In progress 5%, startDateTime=today). Best-effort — a
    // Graph failure should NOT block the reply.
    const taskId =
      (typeof intent.data.taskId === 'string' && intent.data.taskId) ||
      followup?.taskId ||
      undefined;
    let ackNote = '';
    if (taskId) {
      const ack = await acknowledgePlannerTask(taskId, senderName);
      if (ack.ok) {
        ackNote = ack.alreadyStarted
          ? ` (Planner already ${ack.percentComplete}% done)`
          : ` (Planner updated: started, 5%)`;
      } else {
        ackNote = ' (couldn’t update Planner — see logs)';
      }
    }

    await context.sendActivity(
      `Great — I'll mark this on-track${followup ? ` (${followup.taskTitle})` : ''}.${ackNote} 👍`
    );
    return { handled: true };
  }

  if (intent.verb === 'complete') {
    const titleHint =
      typeof intent.data.taskTitleHint === 'string' ? intent.data.taskTitleHint.trim() : undefined;

    // Resolution priority:
    //   1) Explicit taskId from card data (Adaptive Card button click).
    //   2) Fuzzy title match against open Planner tasks (chat with quoted
    //      title, e.g. `The task "Foo" is completed`). More specific than
    //      followup, so we prefer it when the user gave a title.
    //   3) Sender's latest open follow-up.
    let taskId: string | undefined =
      typeof intent.data.taskId === 'string' && intent.data.taskId ? intent.data.taskId : undefined;
    let resolvedTitle: string | undefined;

    if (!taskId && titleHint) {
      const match = await findOpenTaskByTitle(titleHint, { assigneeAad: senderAad });
      if (match.ok) {
        taskId = match.taskId;
        resolvedTitle = match.title;
      } else if (match.reason === 'ambiguous') {
        const list = (match.candidates ?? []).map((c) => `• "${c.title}"`).join('\n');
        await context.sendActivity(
          `I found more than one open task that could match **"${titleHint}"**. Which one is it?\n${list}\n\nReply with the full title in quotes, or use the check-in card.`
        );
        return { handled: true };
      } else if (match.reason === 'not_found') {
        // Fall through — maybe the sender still has an open follow-up we
        // can use as the target.
        console.log(`[actionRouter] complete: no open Planner task matched hint="${titleHint}", falling back to followup`);
      } else if (match.reason === 'graph_error') {
        await context.sendActivity(
          `I tried to look up "${titleHint}" in Planner but the request failed. Please try again in a moment, or close it in Planner directly.`
        );
        return { handled: true };
      }
    }

    if (!taskId && followup) {
      taskId = followup.taskId;
      resolvedTitle = followup.taskTitle;
    }

    if (!taskId) {
      await context.sendActivity(
        `Got it — but I couldn't find an open task that matches${titleHint ? ` **"${titleHint}"**` : ''}. Reply from the check-in card, or say the exact task title in quotes (e.g. \`The task "Send draft proposal" is done\`).`
      );
      return { handled: true };
    }

    const res = await completePlannerTask(taskId);
    if (!res.ok) {
      await context.sendActivity(
        `I tried to mark it complete but Planner rejected the update. Please close it in Planner directly — I'll pick it up on the next poll.`
      );
      return { handled: true };
    }

    // Resolve the follow-up so escalation doesn't fire; plannerPoller will
    // separately detect the 100% state and run runTaskComplete for the DMs.
    if (followup && followup.taskId === taskId) {
      recordOwnerResponse(followup.followupId, 'ontrack');
      markResolved(followup.followupId);
    }

    const title = res.title ?? resolvedTitle ?? followup?.taskTitle ?? 'that task';
    const suffix = res.alreadyComplete
      ? ` (Planner already showed it as 100%)`
      : ` (Planner updated: 100% complete)`;
    await context.sendActivity(`✅ Nice work — marking **"${title}"** complete.${suffix}`);
    return { handled: true };
  }

  if (intent.verb === 'extend') {
    if (!followup) {
      await context.sendActivity(
        `Got it — but I don\'t have an open check-in for you right now. Reply with the task title and how much more time you need, and I\'ll ask the leader.`
      );
      return { handled: true };
    }
    recordOwnerResponse(followup.followupId, 'extend');

    // Deterministic — no LLM. Compute the new date in TypeScript and post
    // the extension card straight to the leader. Previously the LLM was
    // asked to "pick a sensible date" and it hallucinated dates from its
    // training cutoff era (e.g. "2023-10-05"), which Planner then rejected.
    const suggestedNewDueDate = computeNextDueDateIso(followup.dueDate);
    const res = await sendExtensionRequestCardDirect(client.getPeopleOpts(), {
      leaderAadObjectId: leaderAad,
      followupId: followup.followupId,
      taskId: followup.taskId,
      taskTitle: followup.taskTitle,
      ownerName: followup.ownerName ?? senderName,
      currentDueDate: followup.dueDate ?? null,
      suggestedNewDueDate,
      agentRationale: `Owner (${followup.ownerName ?? senderName}) requested more time via the check-in card.`,
    });
    if (res.ok) {
      await context.sendActivity(
        `Thanks — I\'ve asked the leader to approve an extension to **${suggestedNewDueDate.slice(0, 10)}**. I\'ll DM you as soon as they decide.`
      );
    } else {
      await context.sendActivity(
        `Thanks — I\'ve noted the request but couldn\'t reach the leader with a card just now (${res.error ?? 'unknown error'}). I\'ll retry.`
      );
    }
    return { handled: true };
  }

  if (intent.verb === 'blocked') {
    if (!followup) {
      await context.sendActivity(
        `Got it — what specifically is blocking you? Reply with a short summary and I\'ll set up a meeting with the leader.`
      );
      return { handled: true };
    }
    recordOwnerResponse(followup.followupId, 'blocked');

    // Deterministic path — no LLM. Compute 3 real IST slots and post the
    // blocker card straight to the leader. The card carries the ISO for
    // each slot in button data so book_meeting doesn't need to parse
    // anything with the LLM either.
    const blockerText = context.activity.text?.trim() ?? '';
    const blockerSummary =
      blockerText.length > 0
        ? blockerText.length > 200
          ? blockerText.slice(0, 199) + '…'
          : blockerText
        : 'No additional details provided.';
    const slots = proposeMeetingSlots();
    const result = await sendBlockerMeetingCardDirect(client.getPeopleOpts(), {
      leaderAadObjectId: leaderAad,
      followupId: followup.followupId,
      taskId: followup.taskId,
      taskTitle: followup.taskTitle,
      ownerName: followup.ownerName ?? senderName,
      ownerAadObjectId: senderAad ?? followup.ownerAad,
      blockerSummary,
      proposedTimes: slots.map((s) => s.label),
      proposedTimesIso: slots.map((s) => s.iso),
    });
    if (result.ok) {
      await context.sendActivity(
        `Understood. I\'ve flagged this to the leader with 3 candidate meeting times — I\'ll book whichever they pick and DM you the invite.`
      );
    } else {
      await context.sendActivity(
        `Understood — I\'ve recorded the blocker. I couldn\'t reach the leader with a card just now (${result.error ?? 'unknown error'}), but the record is saved and I\'ll retry on the next cycle.`
      );
    }
    return { handled: true };
  }

  // ── Leader-side actions (respond to extension/blocker/escalation cards) ──
  if (intent.verb === 'approve_extend') {
    const newDueDate = typeof intent.data.newDueDate === 'string' ? intent.data.newDueDate : undefined;
    if (followup) markResolved(followup.followupId, { extendedTo: newDueDate });

    const taskId = followup?.taskId ?? (typeof intent.data.taskId === 'string' ? intent.data.taskId : undefined);
    const taskTitle = followup?.taskTitle ?? 'the task';
    const ownerAad = followup?.ownerAad ?? (typeof intent.data.ownerAad === 'string' ? intent.data.ownerAad : undefined);
    const ownerName = followup?.ownerName ?? 'the owner';

    // 1) Patch the existing Planner task's dueDateTime (no LLM, no duplicate).
    let patchNote = '';
    if (taskId && newDueDate) {
      const r = await updatePlannerTaskDueDate(taskId, newDueDate);
      if (r.ok) {
        patchNote = ` Planner updated: due date moved to ${r.newDue.slice(0, 10)}.`;
      } else {
        patchNote = ` (Planner update failed: ${r.error} — you may need to edit the due date manually.)`;
      }
    } else if (!taskId) {
      patchNote = ' (No taskId on record, so Planner was not updated automatically.)';
    } else if (!newDueDate) {
      patchNote = ' (No new due date on the button data, so Planner was not updated.)';
    }

    // 2) DM the owner deterministically — no LLM.
    let ownerNote = '';
    if (ownerAad) {
      const dueLabel = newDueDate ? newDueDate.slice(0, 10) : 'the new date agreed with the leader';
      const dmText =
        `✅ **Extension approved: ${taskTitle}**\n\n` +
        `The leader approved your extension request. Your new due date is **${dueLabel}**.\n\n` +
        `The task in Planner has been updated. Reply here if anything else changes.`;
      const r = await sendPlainDmToUser(client.getPeopleOpts(), ownerAad, dmText);
      ownerNote = r.ok
        ? ` ${ownerName} has been notified via DM.`
        : ` (Tried to DM ${ownerName} but hit an error: ${r.error ?? 'unknown'}.)`;
    } else {
      ownerNote = ' (No owner AAD on record, so I couldn\'t DM them directly.)';
    }

    await context.sendActivity(`✅ Extension approved for "${taskTitle}".${patchNote}${ownerNote}`);
    return { handled: true };
  }

  if (intent.verb === 'reject_extend') {
    if (followup) markResolved(followup.followupId);
    const prompt = `The Leader REJECTED an extension request.
- task: ${followup?.taskTitle ?? '<unknown>'}
- owner aad: ${followup?.ownerAad ?? '<unknown>'}
- owner name: ${followup?.ownerName ?? 'the owner'}

DM the owner via mcp_TeamsServer: politely explain the extension wasn't approved and ask them to reply with what specifically is at risk of slipping. Keep it constructive, one short paragraph. Return a one-line summary of what you sent.`;
    const summary = await client.invokeAgentWithScope(prompt);
    await context.sendActivity(`❌ Extension rejected. ${summary}`);
    return { handled: true };
  }

  if (intent.verb === 'reassign') {
    if (followup) markResolved(followup.followupId);
    const prompt = `The Leader wants to REASSIGN a task.
- task: ${followup?.taskTitle ?? '<unknown>'}
- current owner aad: ${followup?.ownerAad ?? '<unknown>'}
- current owner name: ${followup?.ownerName ?? 'the owner'}

DM the leader via mcp_TeamsServer: ask them who to reassign to (reply with a name or UPN), and note you'll handle the handoff DM to the current owner once they say. One short paragraph. Return one-line summary.`;
    const summary = await client.invokeAgentWithScope(prompt);
    await context.sendActivity(`🔀 Reassignment queued. ${summary}`);
    return { handled: true };
  }

  if (intent.verb === 'book_meeting') {
    const timeslot = typeof intent.data.timeslot === 'string' ? intent.data.timeslot : 'the proposed time';
    const timeslotIso =
      typeof intent.data.timeslotIso === 'string' ? intent.data.timeslotIso : undefined;
    const ownerAad = (intent.data.ownerAad as string) ?? followup?.ownerAad;

    // FIX: idempotency guard — Teams retries invokes on slow ack, which was
    // causing the whole flow to run twice (2 "Locked in…" messages, 2
    // calendar invites, 2 DMs to the owner). No-op on repeat clicks within
    // BOOK_MEETING_DEDUPE_MS.
    const dedupeKey = `${followup?.followupId ?? followup?.taskId ?? 'unknown'}:${timeslotIso ?? timeslot}`;
    if (shouldSkipBookMeeting(dedupeKey)) {
      console.log(`[book_meeting] duplicate click suppressed (key=${dedupeKey})`);
      return { handled: true };
    }

    if (followup) markResolved(followup.followupId, { meetingScheduledAt: Date.now() });

    const taskTitle = followup?.taskTitle ?? 'the blocked task';
    const ownerName = followup?.ownerName ?? 'the owner';

    // ── DM the owner (deterministic) ──────────────────────────────────────
    let ownerNotified = false;
    let ownerNoteError: string | undefined;
    if (ownerAad) {
      const ownerMsg =
        `📅 **Meeting scheduled to unblock: ${taskTitle}**\n\n` +
        `Time: ${timeslot}\n` +
        `The leader (Alex) picked this slot. Calendar invite coming next.` +
        (timeslotIso ? `\n\n_ISO start: ${timeslotIso}_` : '');
      const r = await sendPlainDmToUser(client.getPeopleOpts(), ownerAad, ownerMsg);
      ownerNotified = r.ok;
      ownerNoteError = r.error;
    }
    const ownerLine = ownerAad
      ? ownerNotified
        ? `— ${ownerName} has been notified via DM.`
        : `— tried to DM ${ownerName} but hit an error (${ownerNoteError ?? 'unknown'}).`
      : `— no owner AAD on record, so I couldn\'t DM them directly.`;

    // First-line reply to the leader (immediate, deterministic).
    await context.sendActivity(
      `📅 Locked in **${timeslot}** for the unblock meeting on "${taskTitle}" ${ownerLine}\n\n_Booking the calendar invite now…_`
    );

    // ── Mark the Planner task with a [BLOCKER] prefix ─────────────────────
    // So the brief's Risks section surfaces it and taskComplete DMs the
    // leader when it closes. Best-effort — a Graph failure should NOT
    // block the calendar booking.
    if (followup?.taskId && followup.taskTitle) {
      const alreadyPrefixed =
        followup.taskTitle.startsWith('[BLOCKER]') ||
        followup.taskTitle.startsWith('[RISK]');
      if (!alreadyPrefixed) {
        const newTitle = `[BLOCKER] ${followup.taskTitle}`;
        const r = await updatePlannerTaskTitle(followup.taskId, newTitle);
        if (!r.ok) {
          console.warn(
            `[book_meeting] could not prefix task "${followup.taskTitle}" with [BLOCKER]: ${r.error}`
          );
        }
      }
    }

    // ── Actually book the calendar event via mcp_CalendarTools ────────────
    // The LLM is used ONLY as the transport to reach the MCP tool. All
    // decisions (start/end time, attendees, subject) are already made
    // deterministically above; we hand the LLM literal values and tell it
    // to invoke the tool with those exact values — no dates for it to
    // hallucinate.
    if (timeslotIso) {
      const startIso = timeslotIso;
      const endIso = new Date(new Date(timeslotIso).getTime() + 30 * 60 * 1000).toISOString();
      const leaderUpn = process.env.LEADER_UPN?.trim() ?? '';

      // FIX (Bug 4): resolve owner AAD → UPN DETERMINISTICALLY before the
      // LLM call. Previously the prompt told the LLM to call graph_find_user
      // and silently fell through to a leader-only invite on failure —
      // meaning the blocker owner (e.g. Adele) never made it onto the
      // calendar invite for their own unblock meeting.
      let ownerUpn: string | null = null;
      if (ownerAad) {
        try {
          ownerUpn = await resolveAadToUpn(ownerAad, client.getPeopleOpts());
        } catch (err) {
          console.warn('[book_meeting] resolveAadToUpn threw:', (err as Error)?.message ?? err);
        }
      }
      if (ownerAad && !ownerUpn) {
        await context.sendActivity(
          `⚠️ Couldn't resolve ${ownerName}'s email from Graph — the calendar invite will only go to you. Please add ${ownerName} manually if you want them on the invite.`
        );
      }

      const attendeeList = ownerUpn
        ? `    - leader UPN: "${leaderUpn}"\n    - owner UPN:  "${ownerUpn}"`
        : `    - leader UPN: "${leaderUpn}"  (owner UPN unresolved — leader-only)`;

      const bookingPrompt = `Book a calendar meeting using mcp_CalendarTools. Use these EXACT values. Do NOT change them. Do NOT invent dates. Do NOT call graph_find_user — the attendee list below is already resolved.

- subject: "Unblock: ${taskTitle}"
- startDateTime: "${startIso}"  (UTC, ISO 8601)
- endDateTime:   "${endIso}"  (UTC, ISO 8601, 30 minutes after start)
- organizer:     "${leaderUpn}"
- attendees (required):
${attendeeList}
- body: "Auto-booked to unblock the task '${taskTitle}'. Blocker was reported by ${ownerName} via CoS check-in card."

Steps:
1. Call the mcp_CalendarTools create-event / book-meeting tool with the EXACT values above. Pass BOTH attendee UPNs from the list; do not drop any.
2. Return ONLY one of two exact strings (no other text, no event ids, no ids of any kind):
   - "OK" on success
   - "FAIL: <one short reason>" on error`;
      try {
        const bookResult = await client.invokeAgentWithScope(bookingPrompt);
        console.log('[book_meeting] mcp_CalendarTools raw result:', bookResult);
        const trimmed = (bookResult ?? '').trim();
        const succeeded = /^ok\b/i.test(trimmed) || /booked/i.test(trimmed);
        const userMsg = succeeded
          ? `_📅 Calendar invite sent to ${ownerName} for ${timeslot}._`
          : `_Booking failed: ${trimmed || 'unknown error'}. You may need to create the invite manually._`;
        await context.sendActivity(userMsg);
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        console.error('[book_meeting] booking failed:', msg);
        await context.sendActivity(`_Booking failed: ${msg}. You may need to create the invite manually._`);
      }
    } else {
      await context.sendActivity(
        `_Couldn\'t auto-book — no ISO timestamp on the button data. Create the invite manually if needed._`
      );
    }
    return { handled: true };
  }

  if (intent.verb === 'defer_blocker') {
    if (followup) markResolved(followup.followupId);
    await context.sendActivity(
      `Ok — I\'ll leave this one for you to handle. The blocker record is closed but the task is still open in Planner.`
    );
    return { handled: true };
  }

  if (intent.verb === 'esc_reassign') return handleActionForwardToReassign(context, client, followup);
  if (intent.verb === 'esc_extend') return handleActionForwardToExtendOffer(context, client, followup, leaderAad);
  if (intent.verb === 'esc_escalate') {
    const prompt = `The Leader wants to ESCALATE personally on a stalled task.
- task: ${followup?.taskTitle ?? '<unknown>'}
- owner aad: ${followup?.ownerAad ?? '<unknown>'}
- owner name: ${followup?.ownerName ?? 'the owner'}

DM the owner via mcp_TeamsServer: firm-but-professional message that the Leader is going to reach out directly about the task. Keep it short. Return one-line summary.`;
    const summary = await client.invokeAgentWithScope(prompt);
    await context.sendActivity(`📢 Escalation acknowledged. ${summary}`);
    return { handled: true };
  }

  return { handled: false };
}

async function handleActionForwardToReassign(
  context: TurnContext,
  client: Client,
  followup: PendingFollowup | undefined
): Promise<CardActionResult> {
  if (followup) markResolved(followup.followupId);
  const prompt = `From an escalation card, the Leader picked REASSIGN.
- task: ${followup?.taskTitle ?? '<unknown>'}
- current owner: ${followup?.ownerName ?? 'the owner'} (aad: ${followup?.ownerAad ?? '<unknown>'})

DM the Leader via mcp_TeamsServer asking who to reassign to (a name or UPN). One short paragraph. Return a one-line summary.`;
  const summary = await client.invokeAgentWithScope(prompt);
  await context.sendActivity(`🔀 Reassignment queued. ${summary}`);
  return { handled: true };
}

async function handleActionForwardToExtendOffer(
  context: TurnContext,
  client: Client,
  followup: PendingFollowup | undefined,
  leaderAad: string
): Promise<CardActionResult> {
  if (followup) markResolved(followup.followupId);

  // Deterministic — no LLM. Compute the new date and send the extension card
  // straight to the leader for approval.
  const suggestedNewDueDate = computeNextDueDateIso(followup?.dueDate);
  const res = await sendExtensionRequestCardDirect(client.getPeopleOpts(), {
    leaderAadObjectId: leaderAad,
    followupId: followup?.followupId ?? '',
    taskId: followup?.taskId ?? '<unknown>',
    taskTitle: followup?.taskTitle ?? 'the task',
    ownerName: followup?.ownerName ?? 'the owner',
    currentDueDate: followup?.dueDate ?? null,
    suggestedNewDueDate,
    agentRationale: 'Auto-suggested after no reply to the follow-up.',
  });
  if (res.ok) {
    await context.sendActivity(
      `⏰ Extension offered. I've DM'd ${followup?.ownerName ?? 'the owner'} a card proposing a new due date of **${suggestedNewDueDate.slice(0, 10)}**.`
    );
  } else {
    await context.sendActivity(
      `⏰ Couldn't send the extension card (${res.error ?? 'unknown error'}). Please retry or contact ${followup?.ownerName ?? 'the owner'} directly.`
    );
  }
  return { handled: true };
}
