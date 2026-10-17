// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Card action router. Parses either:
//   - Adaptive Card Action.Submit click  (arrives as activity.value = {verb, ...})
//   - or a plain text keyword reply      (blocked / extend / ontrack / approve / …)
// Then dispatches to a deterministic TypeScript handler (Planner writes,
// proactive DMs, leader cards). The only handler that still calls the LLM is
// book_meeting, which uses it purely as the transport to mcp_CalendarTools.
//
// If nothing matches (activity has no card data and no keyword), returns
// { handled: false } so the caller can proceed with the normal LLM turn.

import { TurnContext } from '@microsoft/agents-hosting';
import type { Client } from '../client';
import {
  cancelOutstandingRequestsForTask,
  cancelOwnerRequest,
  findLatestOpenFollowupForOwner,
  findOpenFollowupForOwnerTask,
  findPendingExtensionRequests,
  findPendingLeaderDeliveries,
  getFollowup,
  markResolved,
  PendingFollowup,
  queueLeaderDelivery,
  recordExtensionRequest,
  recordLeaderDeliveryAttempt,
  recordOwnerResponse,
  setExtensionStatus,
} from '../state/followupStore';
import {
  acknowledgePlannerTask,
  completePlannerTask,
  findOpenTaskByTitle,
  getPlannerTaskDetails,
  isTaskInAllowedPlan,
  updatePlannerTaskDueDate,
  updatePlannerTaskTitle,
} from '../graph/plannerTools';
import { resolveAadToUpn } from '../graph/peopleTools';
import {
  sendBlockerMeetingCardDirect,
  sendExtensionRequestCardDirect,
  sendPlainDmToUser,
  type CardToolOptions,
} from './followupCards';
import { civilDateInZone, DISPLAY_TZ, formatDisplayDate, zonedWallTimeToUtc } from '../util/time';

export interface CardActionResult {
  handled: boolean;
  replyText?: string;
}

// Verbs a task owner sends from their own check-in / assignment card.
const OWNER_VERBS = new Set(['ontrack', 'extend', 'blocked', 'complete']);
// Verbs only the configured leader may trigger (extension, blocker, escalation cards).
const LEADER_VERBS = new Set([
  'approve_extend',
  'reject_extend',
  'reassign',
  'book_meeting',
  'defer_blocker',
  'esc_reassign',
  'esc_extend',
  'esc_escalate',
]);

function sameAad(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

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
export function proposeMeetingSlots(now = new Date()): Array<{ label: string; iso: string }> {
  // The three hours-of-day we offer, in DISPLAY_TZ.
  const HOURS = [10, 14, 16];
  const slots: Array<{ label: string; iso: string }> = [];

  // Walk business days (in DISPLAY_TZ) starting tomorrow.
  const today = civilDateInZone(now, DISPLAY_TZ);

  let dayOffset = 1;
  while (slots.length < 3) {
    // Civil date arithmetic only — the instant for each slot is computed from
    // the zone's offset on that specific date, so DST zones stay correct.
    const civil = new Date(Date.UTC(today.year, today.month - 1, today.day + dayOffset));
    const dow = civil.getUTCDay(); // 0=Sun, 6=Sat
    dayOffset++;
    if (dow === 0 || dow === 6) continue; // skip weekends

    for (const hour of HOURS) {
      if (slots.length >= 3) break;
      const utc = zonedWallTimeToUtc(
        civil.getUTCFullYear(),
        civil.getUTCMonth() + 1,
        civil.getUTCDate(),
        hour,
        0,
        DISPLAY_TZ
      );

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
 * after `max(today, currentDue)`, counted on the BRIEF_DISPLAY_TZ calendar so
 * the date shown on cards and confirmations is the date that was computed.
 * Deterministic; the LLM used to hallucinate this and picked dates from its
 * training-cutoff era (e.g. "2023-10-05"), which Planner then rejected.
 *
 * Returns the UTC instant of 17:00 (end of business day) on the target local
 * date, so the date never shifts when rendered in DISPLAY_TZ.
 */
export function computeNextDueDateIso(currentDueIso?: string | null, now: number = Date.now()): string {
  let base = now;
  if (currentDueIso) {
    const parsed = Date.parse(currentDueIso);
    if (!Number.isNaN(parsed) && parsed > now) base = parsed;
  }
  // Civil date in the display timezone; calendar arithmetic on a UTC carrier.
  const { year, month, day } = civilDateInZone(new Date(base), DISPLAY_TZ);
  const d = new Date(Date.UTC(year, month - 1, day));

  // Add 5 business days (skip Sat=6, Sun=0).
  let added = 0;
  while (added < 5) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return zonedWallTimeToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 17, 0, DISPLAY_TZ).toISOString();
}

/** Due-date label for chat confirmations, in BRIEF_DISPLAY_TZ (matches cards). */
function dueLabel(iso: string): string {
  return formatDisplayDate(iso, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Deliver a queued owner request (extension / blocker) to the leader. Used by
 * the router right after the owner responds and by the scheduler retry pass.
 * The queued record is cleared only after the card is delivered.
 */
export async function deliverPendingLeaderRequest(
  opts: CardToolOptions,
  followup: PendingFollowup,
  leaderAad: string,
  ownerDisplayName?: string
): Promise<{ ok: boolean; error?: string }> {
  const d = followup.pendingLeaderDelivery;
  if (!d) return { ok: true };
  const ownerName = followup.ownerName || ownerDisplayName || 'the owner';
  let res: { ok: boolean; error?: string };
  if (d.kind === 'extension') {
    const suggestedNewDueDate = d.suggestedNewDueDate ?? computeNextDueDateIso(followup.dueDate);
    res = await sendExtensionRequestCardDirect(opts, {
      leaderAadObjectId: leaderAad,
      followupId: followup.followupId,
      taskId: followup.taskId,
      taskTitle: followup.taskTitle,
      ownerName,
      currentDueDate: followup.dueDate ?? null,
      suggestedNewDueDate,
      agentRationale: `Owner (${ownerName}) requested more time via the check-in card.`,
    });
    if (res.ok) recordExtensionRequest(followup.followupId, suggestedNewDueDate);
  } else {
    // Slots are recomputed per attempt so a retried card never offers past times.
    const slots = proposeMeetingSlots();
    res = await sendBlockerMeetingCardDirect(opts, {
      leaderAadObjectId: leaderAad,
      followupId: followup.followupId,
      taskId: followup.taskId,
      taskTitle: followup.taskTitle,
      ownerName,
      ownerAadObjectId: followup.ownerAad,
      blockerSummary: d.blockerSummary ?? 'No additional details provided.',
      proposedTimes: slots.map((s) => s.label),
      proposedTimesIso: slots.map((s) => s.iso),
    });
  }
  recordLeaderDeliveryAttempt(followup.followupId, res.ok, res.error);
  return res;
}

const LEADER_DELIVERY_MAX_ATTEMPTS = Math.max(1, Number(process.env.LEADER_DELIVERY_MAX_ATTEMPTS ?? '24'));

/**
 * Scheduler retry pass for owner requests that never reached the leader.
 * On success the owner is told the request was delivered; after
 * LEADER_DELIVERY_MAX_ATTEMPTS failures the owner is told to contact the
 * leader directly and the request is dropped.
 */
export async function retryPendingLeaderDeliveries(opts: CardToolOptions, leaderAad: string): Promise<void> {
  const queued = findPendingLeaderDeliveries();
  if (queued.length === 0) return;
  console.log(`[leaderDelivery] retrying ${queued.length} undelivered owner request(s)`);
  for (const f of queued) {
    const kind = f.pendingLeaderDelivery!.kind === 'extension' ? 'extension request' : 'blocker';
    // Don't forward requests for work that is already finished or deleted.
    const live = await getPlannerTaskDetails(f.taskId);
    if ((live.ok && live.percentComplete >= 100) || (!live.ok && live.notFound)) {
      cancelOutstandingRequestsForTask(f.taskId);
      console.log(`[leaderDelivery] dropped queued request for task=${f.taskId.slice(0, 8)}… — task is ${live.ok ? 'complete' : 'gone'}`);
      continue;
    }
    if (!live.ok) continue; // indeterminate — retry next cycle without spending an attempt
    const res = await deliverPendingLeaderRequest(opts, f, leaderAad);
    if (res.ok) {
      await sendPlainDmToUser(opts, f.ownerAad, `Your ${kind} for "${f.taskTitle}" has now reached the leader. I'll DM you when they decide.`);
      continue;
    }
    const attempts = getFollowup(f.followupId)?.pendingLeaderDelivery?.attempts ?? 0;
    if (attempts >= LEADER_DELIVERY_MAX_ATTEMPTS) {
      recordLeaderDeliveryAttempt(f.followupId, true);
      console.warn(`[leaderDelivery] giving up on followup=${f.followupId.slice(0, 8)}… after ${attempts} attempt(s)`);
      await sendPlainDmToUser(
        opts,
        f.ownerAad,
        `I couldn't deliver your ${kind} for "${f.taskTitle}" to the leader after several attempts. Please contact them directly.`
      );
    }
  }
}

/**
 * Extract a card-action payload from an incoming activity.
 * Teams surfaces Action.Submit clicks as `activity.value = {verb, ...}`.
 * We also fall back to keyword matching in `activity.text`.
 */
/**
 * True only when the text affirmatively reports that work is ALREADY done.
 * Uses an allow-list of completion statements; negations ("I have not
 * completed…"), questions ("Is it done?"), and future/conditional/intent
 * phrasing ("I will finish…", "almost done", "done once Bob replies") never
 * mutate Planner. Quoted task titles are ignored when classifying.
 */
export function isAffirmativeCompletion(rawText: string): boolean {
  const normalized = rawText.toLowerCase().replace(/[\u2018\u2019]/g, "'").trim();
  if (!normalized) return false;
  // Classify the sentence, not the task title it quotes.
  const text = normalized
    .replace(/"[^"]*"|`[^`]*`|[\u201C\u201D][^\u201C\u201D]*[\u201C\u201D]|(^|\s)'[^']*'(?=\s|$|[.,!])/g, ' TASK ')
    .replace(/^(hi|hello|hey|ok|okay|fyi|update|quick update)\b[\s,:;!.\u2014-]*/, '')
    .trim();
  if (!text) return false;
  if (text.includes('?')) return false;
  if (/^(is|are|was|were|did|does|do|has|have|had|can|could|will|would|should|when|what|why|how|which|who)\b/.test(text)) {
    return false;
  }
  const negation =
    /\b(not|never|no longer|nothing|yet to|still working|still in progress|not yet|cannot|can't|won't|isn't|aren't|wasn't|weren't|haven't|hasn't|hadn't|didn't|doesn't|don't)\b|n't\b/;
  if (negation.test(text)) return false;
  const nonFactual =
    /\b(will|shall|going to|gonna|plan(?:ning)? to|about to|need to|needs to|have to|has to|want to|wants to|wanted|trying to|try to|hope|hopes|hoped|hoping|wish|wishes|wished|if only|should|would|could|might|may|maybe|perhaps|probably|possibly|apparently|supposedly|ideally|supposed to|meant to|expect|expects|expected|assume|assumed|think|thought|believe|guess|imagine|pretend|almost|nearly|soon|later|tomorrow|next week|once|after|before|until|unless|if|when|whether)\b|'ll\b|'d\b/;
  if (nonFactual.test(text)) return false;
  // Belief / doubt / hearsay ("I doubt that…", "Bob said…", "seems done") and
  // any reported "that"-clause describe someone's view, not a completion the
  // sender is reporting.
  const epistemic =
    /\b(doubt|doubts|doubted|doubtful|unsure|uncertain|unclear|unlikely|wonder|wondering|question|suspect|suspects|reckon|bet|feel|feels|felt|seems?|seemed|appears?|appeared|looks like|claims?|claimed|says|said|told|heard|reportedly|allegedly|rumou?red|according to|apparently|supposedly|pretend|imagine|dream)\b/;
  if (epistemic.test(text)) return false;
  if (/\bthat\s+(task|it|this|the|our|my|your|his|her|their)\b/.test(text)) return false;
  // Requests and imperatives ("please check …", "can you confirm …", "let me
  // know …", "make sure X is done") ask about status — they don't report it.
  const request =
    /\b(please|pls|plz|kindly|check|verify|confirm|see|find out|look into|tell me|let me know|lmk|make sure|ensure|remind|ask)\b/;
  if (request.test(text)) return false;

  const done = '(done|complete|completed|finished|closed|wrapped up)';
  const statements = [
    new RegExp(`^(task\\s+|all\\s+)?(done|complete|completed|finished)\\b`),
    new RegExp(`\\b(i'm|im|i am|we're|we are)\\s+(all\\s+|now\\s+)?done\\b`),
    new RegExp(`\\b(i|we)('ve|\\s+have|\\s+had)?\\s+(just\\s+|already\\s+|now\\s+|finally\\s+)?(completed|finished|done|wrapped up|closed)\\b`),
    new RegExp(`\\b(is|are|was|were|has been|have been|got)\\s+(now\\s+|already\\s+|fully\\s+|all\\s+)?${done}\\b`),
  ];
  return statements.some((re) => re.test(text));
}

function extractIntent(
  context: TurnContext,
  isLeader: boolean
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
  };
  // Leader card replies are only honored from the configured leader; for
  // anyone else these words fall through to the normal conversational path.
  if (isLeader) {
    Object.assign(kwMap, {
      approve: 'approve_extend',
      'approve extension': 'approve_extend',
      reject: 'reject_extend',
      reassign: 'reassign',
      defer: 'defer_blocker',
      escalate: 'esc_escalate',
    });
  }
  for (const [kw, verb] of Object.entries(kwMap)) {
    if (text === kw || text.startsWith(kw + ' ')) {
      if (verb === 'complete') {
        if (!isAffirmativeCompletion(rawText)) return null;
        const hint = extractQuotedTitleHint(rawText);
        return { verb, data: hint ? { taskTitleHint: hint } : {} };
      }
      return { verb, data: {} };
    }
  }

  // Fuzzy completion intent detection — matches phrases the exact-prefix
  // keyword map above won't catch, e.g.:
  //   "The task 'Send draft proposal to Mario' is completed"
  //   "Hi — I finished the Contoso proposal"
  //   "'Send proposal' is done"
  // Requires an affirmative completion statement (no negation or question)
  // AND either a quoted title hint OR a short message that unambiguously
  // means "the task I was just asked about is done".
  const completionVerbRegex = /\b(complet(?:ed?|ing)|finish(?:ed)?|done|closed?|wrapped(?:\s+up)?)\b/i;
  if (completionVerbRegex.test(text) && isAffirmativeCompletion(rawText)) {
    const hint = extractQuotedTitleHint(rawText);
    if (hint) {
      return { verb: 'complete', data: { taskTitleHint: hint } };
    }
    // Ignore long-form messages (>140 chars) so we don't hijack a narrative
    // that happens to contain the word "done".
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

/** Resolve the PendingFollowup a verb targets.
 *  - An explicit followupId from card data wins.
 *  - A card that carries only a taskId (e.g. the assignment card's "Got it")
 *    resolves ONLY a follow-up for that same task — never an unrelated one.
 *  - Plain-text keyword replies fall back to the sender's latest open one. */
function resolveTargetFollowup(
  data: Record<string, unknown>,
  senderAad: string | undefined
): PendingFollowup | undefined {
  if (typeof data.followupId === 'string' && data.followupId) return getFollowup(data.followupId);
  if (typeof data.taskId === 'string' && data.taskId) {
    return findOpenFollowupForOwnerTask(senderAad, data.taskId);
  }
  return findLatestOpenFollowupForOwner(senderAad);
}

/**
 * Centralized authorization, evaluated before any verb runs.
 *  - Leader verbs require the sender to be the configured leader.
 *  - Owner verbs require the targeted follow-up to belong to the sender
 *    (the leader may also act on any owner card), the follow-up to still be
 *    open (closed ones accept only "complete"), and the target Planner task
 *    to be assigned to the sender RIGHT NOW (live Graph check).
 *  - A taskId submitted in card data must match the follow-up on record.
 * Returns an error message to show the sender, or undefined when allowed.
 */
async function authorizeIntent(
  verb: string,
  data: Record<string, unknown>,
  followup: PendingFollowup | undefined,
  senderAad: string | undefined,
  isLeader: boolean
): Promise<string | undefined> {
  if (!senderAad) return "I couldn't verify who sent this, so I didn't change anything.";

  if (LEADER_VERBS.has(verb)) {
    return isLeader ? undefined : 'Only the leader can act on this card.';
  }
  if (!OWNER_VERBS.has(verb) || isLeader) return undefined;

  if (followup && !sameAad(followup.ownerAad, senderAad)) {
    return 'That check-in belongs to someone else, so I did not change it.';
  }
  // Old cards stay clickable: a closed check-in only accepts "complete",
  // which is still gated by the live assignment check below.
  if (followup?.status === 'resolved' && verb !== 'complete') {
    return "That check-in is already closed, so I didn't change anything.";
  }
  // Always check the LIVE Planner assignment. A stored follow-up can predate
  // a reassignment, so matching the record alone is not authorization.
  const submittedTaskId = typeof data.taskId === 'string' && data.taskId ? data.taskId : undefined;
  if (submittedTaskId && followup && followup.taskId !== submittedTaskId) {
    return "That card doesn't match the check-in on record, so I didn't change anything.";
  }
  const targetTaskId = submittedTaskId ?? followup?.taskId;
  if (targetTaskId) {
    const details = await getPlannerTaskDetails(targetTaskId);
    if (!details.ok) return "I couldn't verify that task in Planner, so I didn't change it.";
    if (!(await isTaskInAllowedPlan(details.planId))) {
      return "That task isn't in the leadership plan, so I didn't change it.";
    }
    if (!details.assigneeAads.some((aad) => sameAad(aad, senderAad))) {
      return 'That task is not assigned to you, so I did not change it.';
    }
  }
  return undefined;
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
  const senderAad = context.activity.from?.aadObjectId;
  const isLeader = sameAad(senderAad, leaderAad);
  const intent = extractIntent(context, isLeader);
  if (!intent) return { handled: false };

  const senderName = context.activity.from?.name ?? 'the user';
  // Leader verbs target the follow-up named on the card; they must never
  // fall back to the leader's own check-ins.
  const followup = LEADER_VERBS.has(intent.verb)
    ? typeof intent.data.followupId === 'string' && intent.data.followupId
      ? getFollowup(intent.data.followupId)
      : undefined
    : resolveTargetFollowup(intent.data, senderAad);

  // Global per-activity dedupe. Teams reuses activity.id on invoke retries,
  // so if we've seen this exact click in the last 60 s we no-op — protects
  // every verb / every card from double-firing.
  const activityId = String((context.activity as any).id ?? '');
  const dedupeKey = activityId
    ? `${activityId}:${intent.verb}`
    : `${intent.verb}:${followup?.followupId ?? senderAad ?? 'unknown'}:${JSON.stringify(intent.data)}`;
  if (shouldSkipCardInvoke(dedupeKey)) {
    console.log(`[cardActionRouter] duplicate invoke suppressed verb=${intent.verb}`);
    return { handled: true };
  }

  const denial = await authorizeIntent(intent.verb, intent.data, followup, senderAad, isLeader);
  if (denial) {
    console.warn(`[cardActionRouter] denied verb=${intent.verb} leader=${isLeader}`);
    await context.sendActivity(denial);
    return { handled: true };
  }

  const startedAt = Date.now();
  console.log(
    `[cardActionRouter] verb=${intent.verb} leader=${isLeader} matchedFollowup=${followup?.followupId ?? 'none'}`
  );
  // Wrap the rest in a try/finally so we always log elapsed time — makes
  // "why did that card look slow" trivially observable.
  try {
    return await routeIntent(context, client, leaderAad, intent, followup, senderName, senderAad, isLeader);
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
  senderAad: string | undefined,
  isLeader: boolean
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
      // Non-leaders may only complete tasks assigned to them.
      const match = await findOpenTaskByTitle(titleHint, {
        assigneeAad: senderAad,
        onlyAssignedTo: isLeader ? undefined : senderAad,
      });
      if (match.ok) {
        if (match.matchType !== 'exact') {
          // Completion is destructive — never apply it to a non-exact match.
          await context.sendActivity(
            `Did you mean **"${match.title}"**? If so, reply with the exact title in quotes, e.g. \`The task "${match.title}" is done\`. I haven't changed anything yet.`
          );
          return { handled: true };
        }
        taskId = match.taskId;
        resolvedTitle = match.title;
      } else if (match.reason === 'ambiguous') {
        const list = (match.candidates ?? []).map((c) => `• "${c.title}"`).join('\n');
        await context.sendActivity(
          `I found more than one open task that could match **"${titleHint}"**. Which one is it?\n${list}\n\nReply with the full title in quotes, or use the check-in card.`
        );
        return { handled: true };
      } else if (match.reason === 'graph_error') {
        await context.sendActivity(
          `I tried to look up "${titleHint}" in Planner but the request failed. Please try again in a moment, or close it in Planner directly.`
        );
        return { handled: true };
      } else {
        // An explicit title that doesn't match must never fall back to a
        // different task (it may already be complete, or be someone else's).
        await context.sendActivity(
          `I couldn't find an open task of yours titled **"${titleHint}"** — it may already be complete. I haven't changed anything.`
        );
        return { handled: true };
      }
    }

    // Follow-up fallback only when the sender named no task at all.
    if (!taskId && !titleHint && followup) {
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
    // Drop any extension/blocker request for this task still queued for the
    // leader or awaiting a decision — the work is done.
    cancelOutstandingRequestsForTask(taskId);

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
    // The request is queued first so a failed send is retried by the scheduler.
    const suggestedNewDueDate = computeNextDueDateIso(followup.dueDate);
    const queued = queueLeaderDelivery(followup.followupId, { kind: 'extension', suggestedNewDueDate });
    const res = queued
      ? await deliverPendingLeaderRequest(client.getPeopleOpts(), queued, leaderAad, senderName)
      : { ok: false, error: 'follow-up record missing' };
    if (res.ok) {
      await context.sendActivity(
        `Thanks — I\'ve asked the leader to approve an extension to **${dueLabel(suggestedNewDueDate)}**. I\'ll DM you as soon as they decide.`
      );
    } else {
      await context.sendActivity(
        `Thanks — I\'ve saved the request but couldn\'t reach the leader just now. I\'ll keep retrying on the next follow-up cycle and DM you once it\'s delivered.`
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

    // Deterministic path — no LLM. Queue the blocker for the leader, then
    // deliver a card with 3 real slots (in BRIEF_DISPLAY_TZ). Each button
    // carries its ISO so book_meeting never parses text with the LLM. A
    // failed send stays queued and the scheduler retries it.
    const blockerText = context.activity.text?.trim() ?? '';
    const blockerSummary =
      blockerText.length > 0
        ? blockerText.length > 200
          ? blockerText.slice(0, 199) + '…'
          : blockerText
        : 'No additional details provided.';
    const queued = queueLeaderDelivery(followup.followupId, { kind: 'blocker', blockerSummary });
    const result = queued
      ? await deliverPendingLeaderRequest(client.getPeopleOpts(), queued, leaderAad, senderName)
      : { ok: false, error: 'follow-up record missing' };
    if (result.ok) {
      await context.sendActivity(
        `Understood. I\'ve flagged this to the leader with 3 candidate meeting times — I\'ll book whichever they pick and DM you the invite.`
      );
    } else {
      await context.sendActivity(
        `Understood — I\'ve saved the blocker but couldn\'t reach the leader just now. I\'ll keep retrying on the next follow-up cycle and DM you once it\'s delivered.`
      );
    }
    return { handled: true };
  }

  // ── Leader-side actions (respond to extension/blocker/escalation cards) ──
  // Leader verbs other than extension decisions act on the follow-up named on
  // the card; a bare keyword can't identify which task the leader means.
  if (
    LEADER_VERBS.has(intent.verb) &&
    !followup &&
    intent.verb !== 'approve_extend' &&
    intent.verb !== 'reject_extend'
  ) {
    await context.sendActivity('Please use the buttons on the card so I know which task you mean.');
    return { handled: true };
  }

  if (intent.verb === 'approve_extend' || intent.verb === 'reject_extend') {
    // Resolve the request: card buttons carry its followupId; a typed
    // `approve` / `reject` resolves against requests awaiting a decision.
    let target = followup;
    // A card that names a request must only ever act on THAT request. If its
    // record is gone (pruned after retention), refuse — never fall back to
    // whichever request happens to be pending now.
    const cardFollowupId =
      typeof intent.data.followupId === 'string' && intent.data.followupId ? intent.data.followupId : undefined;
    if (!target && cardFollowupId) {
      await context.sendActivity(
        "That extension request has expired or no longer exists, so I didn't change anything. If the task still needs more time, the owner can ask again."
      );
      return { handled: true };
    }
    if (!target) {
      const pending = findPendingExtensionRequests();
      if (pending.length === 0) {
        await context.sendActivity('There are no extension requests waiting for your decision.');
        return { handled: true };
      }
      if (pending.length > 1) {
        const list = pending
          .slice(0, 5)
          .map((p) => `• "${p.taskTitle}" (${p.ownerName}) → ${p.extensionRequestedTo ? dueLabel(p.extensionRequestedTo) : '?'}`)
          .join('\n');
        await context.sendActivity(
          `Several extension requests are waiting:\n${list}\n\nPlease use the buttons on the matching card so I update the right task.`
        );
        return { handled: true };
      }
      target = pending[0];
    }

    // Only a request that is still awaiting a decision can be decided. Old
    // cards for an approved / rejected / cancelled request must never
    // re-apply their proposal (that could undo a newer due date).
    if (target.extensionStatus !== 'pending' || !target.extensionRequestedTo) {
      const state =
        target.extensionStatus === 'approved'
          ? 'was already approved'
          : target.extensionStatus === 'rejected'
            ? 'was already rejected'
            : target.extensionStatus === 'cancelled'
              ? 'was cancelled because the task is complete'
              : 'is no longer pending';
      await context.sendActivity(
        `That extension request for "${target.taskTitle}" ${state}, so I didn't change anything.`
      );
      return { handled: true };
    }
    // Serialize decisions per follow-up so two quick clicks can't both apply.
    if (!tryAcquireFollowupLock(target.followupId)) {
      await context.sendActivity(`I'm already processing a decision for "${target.taskTitle}".`);
      return { handled: true };
    }
    try {
      return await decideExtension(context, client, intent.verb, target);
    } finally {
      releaseFollowupLock(target.followupId);
    }
  }

  if (intent.verb === 'reassign') return handleManualReassign(context, followup);

  if (intent.verb === 'book_meeting') {
    const timeslot = typeof intent.data.timeslot === 'string' ? intent.data.timeslot : 'the proposed time';
    const timeslotIso =
      typeof intent.data.timeslotIso === 'string' ? intent.data.timeslotIso : undefined;
    const ownerAad =
      followup?.ownerAad ?? (typeof intent.data.ownerAad === 'string' ? intent.data.ownerAad : undefined);

    // FIX: idempotency guard — Teams retries invokes on slow ack, which was
    // causing the whole flow to run twice (2 "Locked in…" messages, 2
    // calendar invites, 2 DMs to the owner). No-op on repeat clicks within
    // BOOK_MEETING_DEDUPE_MS.
    const dedupeKey = `${followup?.followupId ?? followup?.taskId ?? 'unknown'}:${timeslotIso ?? timeslot}`;
    if (shouldSkipBookMeeting(dedupeKey)) {
      console.log(`[book_meeting] duplicate click suppressed (key=${dedupeKey})`);
      return { handled: true };
    }

    const taskTitle = followup?.taskTitle ?? 'the blocked task';
    const ownerName = followup?.ownerName ?? 'the owner';

    if (followup?.meetingScheduledAt) {
      await context.sendActivity(
        `An unblock meeting for "${taskTitle}" was already booked from this card, so I didn't book another one.`
      );
      return { handled: true };
    }

    if (!timeslotIso) {
      // Nothing was booked: keep the follow-up open and the card retryable.
      bookMeetingSeen.delete(dedupeKey);
      await context.sendActivity(
        `_Couldn\'t auto-book — no ISO timestamp on the button data. Nothing was scheduled; create the invite manually if needed._`
      );
      return { handled: true };
    }

    // One booking at a time per follow-up, whichever slot was clicked: the
    // "booked" flag is only written after the calendar call returns, so two
    // quick clicks on different slots must not both reach the booking.
    const lockKey = followup?.followupId ?? dedupeKey;
    if (!tryAcquireFollowupLock(lockKey)) {
      bookMeetingSeen.delete(dedupeKey);
      await context.sendActivity(
        `I'm already booking the unblock meeting for "${taskTitle}" — I'll confirm once it's done.`
      );
      return { handled: true };
    }
    try {
      // Re-check under the lock: a booking may have finished just before.
      if (followup && getFollowup(followup.followupId)?.meetingScheduledAt) {
        await context.sendActivity(
          `An unblock meeting for "${taskTitle}" was already booked from this card, so I didn't book another one.`
        );
        return { handled: true };
      }
      // A card already delivered stays clickable after the request closes
      // (task completed, deferred, reassigned) — re-validate before booking.
      const current = followup ? getFollowup(followup.followupId) : undefined;
      if (current?.status === 'resolved') {
        bookMeetingSeen.delete(dedupeKey);
        await context.sendActivity(
          `That blocker request for "${taskTitle}" is already closed, so I didn't book a meeting.`
        );
        return { handled: true };
      }
      const taskIdToCheck = followup?.taskId;
      if (taskIdToCheck) {
        const live = await getPlannerTaskDetails(taskIdToCheck);
        if ((live.ok && live.percentComplete >= 100) || (!live.ok && live.notFound)) {
          if (followup) cancelOwnerRequest(followup.followupId);
          await context.sendActivity(
            `"${taskTitle}" is ${live.ok ? 'already complete' : 'no longer in Planner'}, so I didn't book an unblock meeting.`
          );
          return { handled: true };
        }
        if (!live.ok) {
          bookMeetingSeen.delete(dedupeKey);
          await context.sendActivity(
            `I couldn't confirm "${taskTitle}" is still open in Planner, so I didn't book anything. Please click the slot again in a minute.`
          );
          return { handled: true };
        }
      }
      // Book FIRST. The follow-up is resolved and the owner is told the meeting
      // is scheduled only after the calendar tool returns exactly "OK".
      await context.sendActivity(`📅 Booking **${timeslot}** for the unblock meeting on "${taskTitle}"…`);

      // ── Book the calendar event via mcp_CalendarTools ─────────────────────
      // The LLM is used ONLY as the transport to reach the MCP tool. All
      // decisions (start/end time, attendees, subject) are already made
      // deterministically; we hand the LLM literal values and tell it to
      // invoke the tool with those exact values — no dates for it to
      // hallucinate.
      const startIso = timeslotIso;
      const endIso = new Date(new Date(timeslotIso).getTime() + 30 * 60 * 1000).toISOString();
      const leaderUpn = process.env.LEADER_UPN?.trim() ?? '';

      // Resolve owner AAD → UPN deterministically so the owner is always on
      // the invite (the LLM is never asked to look people up).
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

      let failure: string | undefined;
      try {
        const bookResult = await client.invokeAgentWithScope(bookingPrompt);
        const trimmed = (bookResult ?? '').trim();
        // The booking contract is exactly "OK" or "FAIL: <reason>"; anything
        // else (including a failure that mentions "booked") is not success.
        if (!/^OK$/i.test(trimmed)) failure = trimmed.slice(0, 200) || 'unknown error';
      } catch (err) {
        failure = (err as Error)?.message ?? String(err);
      }
      console.log(`[book_meeting] result=${failure ? 'FAIL' : 'OK'} followup=${followup?.followupId.slice(0, 8) ?? 'none'}…`);

      if (failure) {
        // Leave the follow-up open (no meeting cooldown) and let the leader
        // click a slot again; tell the owner nothing was booked.
        bookMeetingSeen.delete(dedupeKey);
        if (ownerAad) {
          await sendPlainDmToUser(
            client.getPeopleOpts(),
            ownerAad,
            `⚠️ **Unblock meeting not booked yet: ${taskTitle}**\n\n` +
              `The leader picked ${timeslot}, but the calendar invite couldn't be created. No meeting is scheduled yet — the leader will pick another time or reach out.`
          );
        }
        await context.sendActivity(
          `_Booking failed: ${failure}. Nothing was scheduled and the check-in is still open — pick another slot on the card or create the invite manually._`
        );
        return { handled: true };
      }

      if (followup) markResolved(followup.followupId, { meetingScheduledAt: Date.now() });

      // ── Mark the Planner task with a [BLOCKER] prefix ─────────────────────
      // So the brief's Risks section surfaces it and taskComplete DMs the
      // leader when it closes. Best-effort.
      if (followup?.taskId && followup.taskTitle) {
        const alreadyPrefixed =
          followup.taskTitle.startsWith('[BLOCKER]') ||
          followup.taskTitle.startsWith('[RISK]');
        if (!alreadyPrefixed) {
          const r = await updatePlannerTaskTitle(followup.taskId, `[BLOCKER] ${followup.taskTitle}`);
          if (!r.ok) {
            console.warn(
              `[book_meeting] could not prefix task=${followup.taskId.slice(0, 8)}… with [BLOCKER]: ${r.error}`
            );
          }
        }
      }

      // ── DM the owner only now that the invite exists ──────────────────────
      let ownerLine = `No owner on record, so I couldn\'t DM them directly.`;
      if (ownerAad) {
        const r = await sendPlainDmToUser(
          client.getPeopleOpts(),
          ownerAad,
          `📅 **Meeting scheduled to unblock: ${taskTitle}**\n\n` +
            `Time: ${timeslot}\n` +
            `The leader (${process.env.LEADER_NAME?.trim() || 'the leader'}) picked this slot and the calendar invite has been sent.` +
            `\n\n_ISO start: ${timeslotIso}_`
        );
        ownerLine = r.ok
          ? `${ownerName} has been notified via DM.`
          : `Tried to DM ${ownerName} but hit an error (${r.error ?? 'unknown'}).`;
      }
      await context.sendActivity(`_📅 Calendar invite sent for ${timeslot}. ${ownerLine}_`);
      return { handled: true };
    } finally {
      releaseFollowupLock(lockKey);
    }
  }

  if (intent.verb === 'defer_blocker') {
    if (followup) markResolved(followup.followupId);
    await context.sendActivity(
      `Ok — I\'ll leave this one for you to handle. The blocker record is closed but the task is still open in Planner.`
    );
    return { handled: true };
  }

  if (intent.verb === 'esc_reassign') return handleManualReassign(context, followup);
  if (intent.verb === 'esc_extend') return handleActionForwardToExtendOffer(context, client, followup, leaderAad);
  if (intent.verb === 'esc_escalate') {
    // Deterministic DM — no LLM.
    const taskTitle = followup?.taskTitle ?? 'the task';
    const ownerName = followup?.ownerName ?? 'the owner';
    const dm = followup?.ownerAad
      ? await sendPlainDmToUser(
          client.getPeopleOpts(),
          followup.ownerAad,
          `📢 **Leader follow-up: ${taskTitle}**\n\n` +
            `${process.env.LEADER_NAME?.trim() || 'The leader'} is going to reach out to you directly about this task. ` +
            `Please have a current status ready.`
        )
      : { ok: false, error: 'no owner on record' };
    await context.sendActivity(
      `📢 Escalation acknowledged for "${taskTitle}". ` +
        (dm.ok
          ? `${ownerName} has been told you'll reach out directly.`
          : `I couldn't DM ${ownerName} (${dm.error ?? 'unknown error'}).`)
    );
    return { handled: true };
  }

  return { handled: false };
}

/** Apply the leader's decision on a pending extension request. */
async function decideExtension(
  context: TurnContext,
  client: Client,
  verb: string,
  target: PendingFollowup
): Promise<CardActionResult> {
  if (verb === 'reject_extend') {
    markResolved(target.followupId);
    setExtensionStatus(target.followupId, 'rejected');
    // Deterministic DM — no LLM.
    const dm = await sendPlainDmToUser(
      client.getPeopleOpts(),
      target.ownerAad,
      `❌ **Extension not approved: ${target.taskTitle}**\n\n` +
        `The leader didn't approve the extension, so the current due date stands. ` +
        `Reply here with what specifically is at risk of slipping and I'll pass it on.`
    );
    await context.sendActivity(
      `❌ Extension rejected for "${target.taskTitle}". ` +
        (dm.ok
          ? `${target.ownerName} has been notified via DM.`
          : `I couldn't DM ${target.ownerName} (${dm.error ?? 'unknown error'}) — please let them know directly.`)
    );
    return { handled: true };
  }

  // The stored proposal is authoritative — card button data is never used.
  const newDueDate = target.extensionRequestedTo;
  const taskTitle = target.taskTitle;
  const ownerName = target.ownerName;

  if (!target.taskId || !newDueDate) {
    await context.sendActivity(
      `I couldn't apply the extension for "${taskTitle}" — the request has no ${!target.taskId ? 'task id' : 'proposed due date'} on record. Nothing was changed; please edit the due date in Planner.`
    );
    return { handled: true };
  }

  // 1) Patch Planner first; only a successful PATCH counts as approved.
  const r = await updatePlannerTaskDueDate(target.taskId, newDueDate);
  if (!r.ok) {
    // Keep the request pending so the leader can retry.
    const dm = await sendPlainDmToUser(
      client.getPeopleOpts(),
      target.ownerAad,
      `⏳ **Extension approved, not yet synced: ${taskTitle}**\n\n` +
        `The leader approved your extension to **${dueLabel(newDueDate)}**, but Planner hasn't been updated yet. Treat the current Planner due date as unchanged until I confirm.`
    );
    await context.sendActivity(
      `⚠️ I couldn't update Planner for "${taskTitle}" (${r.error}). The request is still pending — click **Approve** again to retry, or edit the due date manually.` +
        (dm.ok ? ` ${ownerName} was told the change isn't synced yet.` : '')
    );
    return { handled: true };
  }

  markResolved(target.followupId, { extendedTo: r.newDue });
  setExtensionStatus(target.followupId, 'approved');

  // 2) DM the owner deterministically — no LLM.
  const dmText =
    `✅ **Extension approved: ${taskTitle}**\n\n` +
    `The leader approved your extension request. Your new due date is **${dueLabel(r.newDue)}**, and Planner has been updated.\n\n` +
    `Reply here if anything else changes.`;
  const dm = await sendPlainDmToUser(client.getPeopleOpts(), target.ownerAad, dmText);
  const ownerNote = dm.ok
    ? ` ${ownerName} has been notified via DM.`
    : ` (Tried to DM ${ownerName} but hit an error: ${dm.error ?? 'unknown'}.)`;

  await context.sendActivity(
    `✅ Extension approved for "${taskTitle}". Planner updated: due date moved to ${dueLabel(r.newDue)}.${ownerNote}`
  );
  return { handled: true };
}

// Per-follow-up in-flight lock. Serializes leader actions whose effects are
// not idempotent (calendar booking, extension decisions), so two quick clicks
// — even on different buttons of the same card — can't both run.
const followupLocks = new Set<string>();

function tryAcquireFollowupLock(followupId: string): boolean {
  if (followupLocks.has(followupId)) return false;
  followupLocks.add(followupId);
  return true;
}

function releaseFollowupLock(followupId: string): void {
  followupLocks.delete(followupId);
}
/**
 * Reassign is a manual handoff: the agent has no "change assignee" write
 * path, so it closes the check-in and tells the leader exactly what to do.
 * Once Planner shows the new assignee, the next follow-up cycle checks in
 * with them (orphaned check-ins for the old owner are auto-resolved).
 */
async function handleManualReassign(
  context: TurnContext,
  followup: PendingFollowup | undefined
): Promise<CardActionResult> {
  // Reassigning closes the owner's request too: a pending extension or a
  // queued leader card for this check-in must not be approvable later.
  if (followup) cancelOwnerRequest(followup.followupId);
  const taskTitle = followup?.taskTitle ?? 'this task';
  await context.sendActivity(
    `🔀 To reassign **"${taskTitle}"**, change its assignee in Planner. ` +
      `I've closed this check-in; once Planner shows the new owner, the next follow-up cycle will check in with them. ` +
      `I haven't changed the task or messaged anyone.`
  );
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
    if (followup) recordExtensionRequest(followup.followupId, suggestedNewDueDate);
    await context.sendActivity(
      `⏰ Extension proposed. I've sent you an approval card for "${followup?.taskTitle ?? 'the task'}" with a new due date of **${dueLabel(suggestedNewDueDate)}** — approve it to update Planner and notify ${followup?.ownerName ?? 'the owner'}.`
    );
  } else {
    await context.sendActivity(
      `⏰ Couldn't send the extension card (${res.error ?? 'unknown error'}). Please retry or contact ${followup?.ownerName ?? 'the owner'} directly.`
    );
  }
  return { handled: true };
}
