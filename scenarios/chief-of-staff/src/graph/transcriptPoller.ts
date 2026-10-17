// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Meeting capture orchestrator. Replaces the old tenant-wide getAllTranscripts
// polling. Every tick it does two passes:
//
//   1. DISCOVERY — calendar-view over recent + upcoming meetings where BOTH
//      the leader and the CoS agent are on the invite (any organizer). New
//      occurrences become pending captures with a wait budget scaled to
//      meeting length; existing ones are refreshed if they were rescheduled.
//
//   2. RETRY SWEEP — for each pending capture whose next-check has arrived,
//      fetch the transcript that belongs to THIS occurrence + AI insights.
//      When ready, the capture is marked READY (not complete) and returned.
//      The scheduler acknowledges it as complete only after runCapture
//      succeeds; a failure leaves it READY for a later retry.
//
// Returns the READY captures so the scheduler can fire runCapture on each.

import { Authorization, TurnContext } from '@microsoft/agents-hosting';
import { checkEventParticipation, discoverQualifyingMeetings, type ObservedOccurrence } from './meetingWatcher';
import {
  fetchAiInsightsForMeeting,
  fetchTranscriptContent,
  fetchTranscriptsForMeeting,
  InsightsResult,
  TranscriptSummary,
} from './meetingArtifactsFetch';
import {
  computeWaitBudget,
  createPendingCapture,
  findCapturesDueForCheck,
  getCapture,
  hasCaptureForEvent,
  isTranscriptClaimed,
  listAll,
  markCaptureGaveUp,
  markCaptureRevoked,
  reopenRevokedCapture,
  markCaptureReady,
  PendingCapture,
  pickNextRetryDelayMinutes,
  rescheduleCapture,
  SimpleActionItem,
  SimpleMeetingNote,
  updateCapture,
} from '../state/pendingCaptureStore';
import { log } from '../util/logger';

// Kept the exported name so scheduler.ts doesn't need a diff for the import.
export interface DetectedTranscript {
  /** Calendar event id — the scheduler acknowledges completion with it. */
  eventId: string;
  meetingId: string;
  transcriptId: string;
  organizerId: string;
  chatId?: string;
  createdDateTime?: string;
  subject?: string;
  /** Raw WebVTT body if the app-perm content fetch succeeded. */
  transcriptContent?: string;
  insightsAvailable: boolean;
  actionItems?: SimpleActionItem[];
  meetingNotes?: SimpleMeetingNote[];
}

export interface PollOptions {
  authorization: Authorization;
  context: TurnContext;
  authHandlerName: string;
}

// Env-driven config, read fresh each tick so restarts pick up changes.
function readConfig() {
  const leaderUpn = process.env.LEADER_UPN?.trim() ?? '';
  const cosAgentUpn = process.env.COS_AGENT_UPN?.trim() ?? '';
  // CAPTURE_GRAPH_OWNER controls which user's Graph endpoints we hit:
  //   'cos-agent' (default) — read /users/{cos-agent}/... requires the Teams
  //     application-access policy granted only to the CoS agent UPN. Zero
  //     per-leader setup: any leader who invites the CoS to a meeting gets
  //     captured. Works iff attendee-role access is sufficient for the
  //     transcript/insights endpoints in your tenant.
  //   'leader' — read /users/{leader}/... requires the policy granted to each
  //     leader (or -Global). Guaranteed to work but per-leader setup cost.
  const ownerMode = (process.env.CAPTURE_GRAPH_OWNER?.trim() || 'cos-agent').toLowerCase();
  const graphOwnerUpn = ownerMode === 'leader' ? leaderUpn : cosAgentUpn;

  return {
    leaderUpn,
    cosAgentUpn,
    graphOwnerUpn,
    ownerMode,
    watchHours: Number(process.env.TRANSCRIPT_WATCH_HOURS ?? '4'),
    insightsMultiplier: Number(process.env.INSIGHTS_WAIT_MULTIPLIER ?? '0.5'),
    insightsMinMinutes: Number(process.env.INSIGHTS_MIN_WAIT_MINUTES ?? '3'),
    insightsMaxMinutes: Number(process.env.INSIGHTS_MAX_WAIT_MINUTES ?? '30'),
    giveUpAfterHours: Number(process.env.CAPTURE_GIVE_UP_AFTER_HOURS ?? '4'),
  };
}

/**
 * Public entry — the scheduler calls this every POLL_MEETINGS_MS.
 * Returns the captures that just became READY.
 */
export async function pollForNewTranscripts(
  opts: PollOptions
): Promise<DetectedTranscript[]> {
  const cfg = readConfig();
  if (!cfg.leaderUpn) return [];
  if (!cfg.cosAgentUpn) {
    log.warn(
      'capturePoller',
      'COS_AGENT_UPN not set — cannot filter meetings by CoS-invited. Skipping.'
    );
    return [];
  }
  if (!cfg.graphOwnerUpn) {
    log.warn(
      'capturePoller',
      `CAPTURE_GRAPH_OWNER=${cfg.ownerMode} but the corresponding UPN env is empty. Skipping.`
    );
    return [];
  }

  // ── Pass 1: discovery ──
  await runDiscoveryPass(opts, cfg);

  // ── Pass 2: retry sweep ──
  const ready = await runRetrySweep(opts, cfg);

  // ── Per-tick summary at debug level ──
  const all = listAll();
  if (all.length > 0) {
    const counts = all.reduce<Record<string, number>>((acc, c) => {
      acc[c.status] = (acc[c.status] ?? 0) + 1;
      return acc;
    }, {});
    log.debug('capturePoller', `pending capture store: ${all.length} total`, counts);
  }

  return ready;
}

// Latest discovery results. `qualifiedThisPass` lets the retry sweep skip the
// per-event participation re-check for events discovery just confirmed;
// `observedByJoinUrl` holds every online occurrence (invited or not), used as
// transcript-window boundaries for occurrences sharing a join URL.
let qualifiedThisPass = new Set<string>();
let observedByJoinUrl = new Map<string, ObservedOccurrence[]>();

async function runDiscoveryPass(
  opts: PollOptions,
  cfg: ReturnType<typeof readConfig>
): Promise<void> {
  const observed: ObservedOccurrence[] = [];
  const meetings = await discoverQualifyingMeetings(
    {
      authorization: opts.authorization,
      context: opts.context,
      authHandlerName: opts.authHandlerName,
      graphOwnerUpn: cfg.graphOwnerUpn,
      leaderUpn: cfg.leaderUpn,
      cosAgentUpn: cfg.cosAgentUpn,
      watchHours: cfg.watchHours,
    },
    observed
  );
  qualifiedThisPass = new Set(meetings.map((m) => m.eventId));
  // Keep the previous map if discovery failed (it returns nothing then).
  if (observed.length > 0) {
    const byUrl = new Map<string, ObservedOccurrence[]>();
    for (const o of observed) {
      const list = byUrl.get(o.joinWebUrl) ?? [];
      list.push(o);
      byUrl.set(o.joinWebUrl, list);
    }
    observedByJoinUrl = byUrl;
  }

  let newlyTracked = 0;
  for (const m of meetings) {
    const budget = computeWaitBudget(m.durationMinutes, {
      multiplier: cfg.insightsMultiplier,
      minMinutes: cfg.insightsMinMinutes,
      maxMinutes: cfg.insightsMaxMinutes,
    });
    const giveUpAfter = m.endTime + cfg.giveUpAfterHours * 60 * 60 * 1000;
    if (hasCaptureForEvent(m.eventId)) {
      if (!getCapture(m.eventId)?.joinWebUrl) updateCapture(m.eventId, { joinWebUrl: m.joinWebUrl });
      // Re-invited after a revocation: discovery confirms it qualifies again.
      if (
        reopenRevokedCapture(m.eventId, {
          startTime: m.startTime,
          endTime: m.endTime,
          durationMinutes: m.durationMinutes,
          waitBudgetMinutes: budget,
          giveUpAfter,
        })
      ) {
        log.info('capturePoller', `reopened ${eventRef(m.eventId)} — the event qualifies again after its invitation was withdrawn`);
        continue;
      }
      // The same event id can move (reschedule). Refresh its deadlines so it
      // isn't abandoned before the meeting happens.
      const outcome = rescheduleCapture(m.eventId, {
        startTime: m.startTime,
        endTime: m.endTime,
        durationMinutes: m.durationMinutes,
        waitBudgetMinutes: budget,
        giveUpAfter,
      });
      if (outcome !== 'unchanged') {
        log.info('capturePoller', `${eventRef(m.eventId)} was rescheduled — capture ${outcome}`);
      }
      continue;
    }
    createPendingCapture({
      eventId: m.eventId,
      meetingId: m.meetingId,
      joinWebUrl: m.joinWebUrl,
      subject: m.subject,
      organizerAad: m.organizerAad,
      ownerUpn: cfg.graphOwnerUpn,
      chatId: undefined,
      startTime: m.startTime,
      endTime: m.endTime,
      durationMinutes: m.durationMinutes,
      waitBudgetMinutes: budget,
      giveUpAfter,
    });
    log.debug(
      'capturePoller',
      `added pending capture ${eventRef(m.eventId)} durationMin=${m.durationMinutes} waitBudgetMin=${budget}`
    );
    newlyTracked++;
  }
  if (newlyTracked > 0) {
    log.info(
      'capturePoller',
      `discovery: added ${newlyTracked} new qualifying meeting(s)`
    );
  }
}

const PARTICIPATION_RECHECK_RETRY_MS = 5 * 60 * 1000;

async function runRetrySweep(
  opts: PollOptions,
  cfg: ReturnType<typeof readConfig>
): Promise<DetectedTranscript[]> {
  const now = Date.now();
  const due = findCapturesDueForCheck(now);
  if (due.length === 0) return [];

  const ready: DetectedTranscript[] = [];
  for (const cap of due) {
    // The invitation can change after discovery (CoS removed, meeting
    // cancelled). Re-verify before fetching or processing anything, unless
    // this tick's discovery already confirmed the event.
    if (!qualifiedThisPass.has(cap.eventId)) {
      const verdict = await checkEventParticipation(
        opts,
        cap.ownerUpn,
        cap.eventId,
        cfg.leaderUpn,
        cfg.cosAgentUpn
      );
      if (verdict === 'disqualified') {
        log.info('capturePoller', `retiring ${eventRef(cap.eventId)} — no longer qualifies (CoS/leader removed, cancelled, or deleted)`);
        markCaptureRevoked(cap.eventId);
        continue;
      }
      if (verdict === 'unknown') {
        updateCapture(cap.eventId, { nextCheckAt: now + PARTICIPATION_RECHECK_RETRY_MS });
        continue;
      }
    }
    const result = await advanceCapture(opts, cap, now);
    if (result) ready.push(result);
  }
  return ready;
}

/**
 * Attempt to move a single capture forward: fetch transcript + insights as
 * needed, decide readiness, or schedule the next retry.
 */
async function advanceCapture(
  opts: PollOptions,
  cap: PendingCapture,
  now: number
): Promise<DetectedTranscript | undefined> {
  // Already READY (restart, or an earlier runCapture failed): re-emit the
  // stored payload without refetching. It is acknowledged only on success.
  if (cap.status === 'ready' && cap.transcriptId) {
    log.info('capturePoller', `re-emitting READY capture ${eventRef(cap.eventId)} for processing`);
    return toDetectedTranscript(cap);
  }

  // Bump attempts up front so the retry ladder advances even on failures.
  cap.attempts += 1;

  log.debug(
    'capturePoller',
    `advance ${eventRef(cap.eventId)} attempt=${cap.attempts} transcriptId=${cap.transcriptId ? cap.transcriptId.slice(0, 8) + '…' : '∅'} insightsFetched=${cap.insightsFetched}`
  );

  // Give-up guard: too much time has passed with no readable content (no
  // transcript, or a transcript whose body never fetched and no insights).
  const hasReadableContent = (c: PendingCapture) =>
    !!c.transcriptContent ||
    (c.insightsActionItems?.length ?? 0) + (c.insightsMeetingNotes?.length ?? 0) > 0;
  if (now > cap.giveUpAfter && !hasReadableContent(cap)) {
    log.warn(
      'capturePoller',
      `giving up on ${eventRef(cap.eventId)} — no ${cap.transcriptId ? 'readable transcript content' : 'transcript'} after ${(
        (now - cap.endTime) /
        (60 * 60 * 1000)
      ).toFixed(1)}h`
    );
    markCaptureGaveUp(cap.eventId);
    return undefined;
  }

  // 1) Ensure we have the transcript for THIS occurrence. A recurring meeting
  //    reuses its join URL, so the list can contain earlier occurrences'
  //    transcripts — pick only one created during this occurrence that no
  //    other capture has already consumed.
  if (!cap.transcriptId) {
    const transcripts = await fetchTranscriptsForMeeting(
      opts,
      cap.ownerUpn,
      cap.meetingId
    );
    const match = selectTranscriptForOccurrence(transcripts, cap, now);
    if (match) {
      updateCapture(cap.eventId, {
        transcriptId: match.transcriptId,
        transcriptFetchedAt: now,
        transcriptCallId: match.callId,
        transcriptCorrelationId: match.contentCorrelationId,
      });
      cap.transcriptId = match.transcriptId;
      cap.transcriptFetchedAt = now;
      cap.transcriptCallId = match.callId;
      cap.transcriptCorrelationId = match.contentCorrelationId;
    } else if (transcripts.length > 0) {
      log.debug(
        'capturePoller',
        `${eventRef(cap.eventId)}: ${transcripts.length} transcript(s) found, none belong to this occurrence yet`
      );
    }
  }

  // 1b) If we have the transcriptId but not the body yet, fetch the WebVTT
  //     content via the app-permission Graph worker so the LLM can extract
  //     from it inline (no dependency on mcp_TeamsServer.get_meeting_transcript
  //     which currently 400s for these token-shaped ids).
  if (cap.transcriptId && !cap.transcriptContent) {
    const content = await fetchTranscriptContent(
      opts,
      cap.ownerUpn,
      cap.meetingId,
      cap.transcriptId
    );
    if (content) {
      updateCapture(cap.eventId, { transcriptContent: content });
      cap.transcriptContent = content;
    }
  }

  // 2) If transcript is here, try insights (once per cycle until fetched).
  let insights: InsightsResult | undefined;
  if (cap.transcriptId && !cap.insightsFetched) {
    // Only insights correlated with THIS occurrence's transcript count; a
    // recurring meeting's collection also holds earlier occurrences.
    insights = await fetchAiInsightsForMeeting(opts, cap.ownerUpn, cap.meetingId, {
      callId: cap.transcriptCallId,
      contentCorrelationId: cap.transcriptCorrelationId,
      windowStart: (cap.startTime ?? cap.endTime - cap.durationMinutes * 60 * 1000) - 15 * 60 * 1000,
    });
    if (insights.available) {
      updateCapture(cap.eventId, {
        insightsFetched: true,
        insightsActionItems: insights.actionItems,
        insightsMeetingNotes: insights.meetingNotes,
      });
      cap.insightsFetched = true;
      cap.insightsActionItems = insights.actionItems;
      cap.insightsMeetingNotes = insights.meetingNotes;
    } else if (insights.unsupported) {
      // Copilot unavailable in this tenant — mark tried, don't keep waiting.
      updateCapture(cap.eventId, { insightsFetched: true });
      cap.insightsFetched = true;
    }
  }

  // 3) Decide readiness.
  const waitMs = cap.waitBudgetMinutes * 60 * 1000;
  const waitedFor = now - (cap.transcriptFetchedAt ?? cap.endTime);
  const waitBudgetExhausted = waitedFor >= waitMs;

  // Bug 5 fast-path: if the raw transcript body is already inlined AND we've
  // given insights at least one polite retry (attempts >= 2), stop waiting.
  // The transcript alone is enough for the LLM to extract action items —
  // insights are just a nice-to-have. In tenants where the Copilot license is
  // present but insights render slowly (or never), this saves ~15-20 min per
  // meeting. When insights DO arrive on attempt 1, `cap.insightsFetched`
  // already fires and this branch is redundant.
  //
  // Demo mode: set CAPTURE_MIN_ATTEMPTS_TRANSCRIPT_ONLY=1 to fire on the
  // first successful transcript fetch (skips the 3-min polite retry). Use
  // when you're demoing a meeting that already ended hours ago and know
  // Copilot insights aren't coming.
  const minAttemptsForTranscriptOnly = Math.max(
    1,
    Number(process.env.CAPTURE_MIN_ATTEMPTS_TRANSCRIPT_ONLY ?? '2')
  );
  const transcriptSufficient =
    !!cap.transcriptContent && cap.attempts >= minAttemptsForTranscriptOnly;

  // A transcript id alone is not enough: the body must have been fetched, or
  // Copilot insights must carry usable items. Otherwise keep retrying the
  // artifact fetch (bounded by giveUpAfter above).
  const ready =
    !!cap.transcriptId &&
    hasReadableContent(cap) &&
    (cap.insightsFetched || waitBudgetExhausted || transcriptSufficient);

  if (ready) {
    const insightsCount =
      (cap.insightsActionItems?.length ?? 0) +
      (cap.insightsMeetingNotes?.length ?? 0);
    log.info(
      'capturePoller',
      `READY: ${eventRef(cap.eventId)} meeting=${cap.meetingId.slice(
        0,
        8
      )} transcript=✓ content=${cap.transcriptContent ? `✓ (${cap.transcriptContent.length}ch)` : '✗'} insights=${insightsCount > 0 ? `✓ (${insightsCount})` : '✗'} after ${cap.attempts} attempt(s)`
    );

    // Durably READY — NOT complete. The scheduler acknowledges completion
    // only after runCapture succeeds, so a downstream failure or a restart
    // re-emits this capture instead of silently dropping the meeting.
    markCaptureReady(cap.eventId);
    return toDetectedTranscript(cap);
  }

  // 4) Schedule next retry.
  const delayMin = pickNextRetryDelayMinutes(cap.attempts, cap.waitBudgetMinutes);
  updateCapture(cap.eventId, { nextCheckAt: now + delayMin * 60 * 1000 });
  log.debug(
    'capturePoller',
    `not ready — next check for ${eventRef(cap.eventId)} in ${delayMin} min (waitBudget=${cap.waitBudgetMinutes} min, waitedSoFar=${((now - (cap.transcriptFetchedAt ?? cap.endTime)) / 60000).toFixed(1)} min)`
  );
  return undefined;
}

/** Build the scheduler payload from a capture's stored artifacts. */
function toDetectedTranscript(cap: PendingCapture): DetectedTranscript {
  const insightsCount =
    (cap.insightsActionItems?.length ?? 0) + (cap.insightsMeetingNotes?.length ?? 0);
  return {
    eventId: cap.eventId,
    meetingId: cap.meetingId,
    transcriptId: cap.transcriptId!,
    organizerId: cap.organizerAad ?? '',
    chatId: cap.chatId,
    subject: cap.subject,
    transcriptContent: cap.transcriptContent,
    insightsAvailable: insightsCount > 0,
    actionItems: cap.insightsActionItems,
    meetingNotes: cap.insightsMeetingNotes,
  };
}

// Transcripts are created when transcription starts, which happens during
// the meeting. Allow a little slack on both sides for meetings that start
// early or run over, but never reach into another occurrence on the same
// online meeting (recurring series and back-to-back meetings reuse one join
// URL): next to a neighbouring occurrence the slack stops at the midpoint of
// the gap, and the boundary belongs to the later occurrence.
const OCCURRENCE_EARLY_SLACK_MS = 15 * 60 * 1000;
const OCCURRENCE_LATE_SLACK_MS = 15 * 60 * 1000;

type OccurrenceSpan = { startTime?: number; endTime: number; durationMinutes: number };

function occurrenceStart(o: OccurrenceSpan): number {
  return o.startTime ?? o.endTime - o.durationMinutes * 60 * 1000;
}

/**
 * Other occurrences of the same online meeting: tracked captures plus every
 * occurrence discovery saw on the same join URL — including ones the CoS is
 * not invited to, which never become captures.
 */
function sameMeetingNeighbors(
  cap: Pick<PendingCapture, 'eventId' | 'meetingId' | 'joinWebUrl'>
): OccurrenceSpan[] {
  const byEvent = new Map<string, OccurrenceSpan>();
  if (cap.meetingId) {
    for (const c of listAll()) {
      if (c.meetingId === cap.meetingId && c.eventId !== cap.eventId) byEvent.set(c.eventId, c);
    }
  }
  if (cap.joinWebUrl) {
    for (const o of observedByJoinUrl.get(cap.joinWebUrl) ?? []) {
      if (o.eventId !== cap.eventId && !byEvent.has(o.eventId)) byEvent.set(o.eventId, o);
    }
  }
  return Array.from(byEvent.values());
}

/** Log-safe event reference — event ids share a mailbox prefix, so use the tail. */
function eventRef(eventId: string | undefined): string {
  return `event=…${String(eventId ?? '?').slice(-8)}`;
}

/**
 * Pick the transcript that belongs to this calendar occurrence: created
 * between (scheduled start - slack) and (scheduled end + slack), with the
 * slack capped so it never overlaps a neighbouring occurrence of the same
 * online meeting, and not already consumed by another capture.
 */
export function selectTranscriptForOccurrence(
  transcripts: TranscriptSummary[],
  cap: Pick<PendingCapture, 'eventId' | 'meetingId' | 'joinWebUrl' | 'startTime' | 'endTime' | 'durationMinutes'>,
  now: number,
  neighbors: OccurrenceSpan[] = sameMeetingNeighbors(cap)
): TranscriptSummary | undefined {
  const start = occurrenceStart(cap);
  let windowStart = start - OCCURRENCE_EARLY_SLACK_MS;
  let windowEnd = cap.endTime + OCCURRENCE_LATE_SLACK_MS;
  let endExclusive = false;
  for (const n of neighbors) {
    const nStart = occurrenceStart(n);
    if (n.endTime <= start) {
      // Earlier occurrence: start no earlier than the midpoint of the gap.
      windowStart = Math.max(windowStart, Math.min(start, (n.endTime + start) / 2));
    } else if (nStart >= cap.endTime) {
      // Later occurrence: stop at the midpoint; the boundary belongs to it.
      const limit = Math.max(cap.endTime, (cap.endTime + nStart) / 2);
      if (limit <= windowEnd) {
        windowEnd = limit;
        endExclusive = true;
      }
    }
  }
  if (now < windowStart) return undefined;
  const candidates = transcripts
    .filter((t) => !isTranscriptClaimed(t.transcriptId, cap.eventId))
    .filter((t) => {
      const created = t.createdDateTime ? Date.parse(t.createdDateTime) : NaN;
      if (!Number.isFinite(created) || created < windowStart) return false;
      return endExclusive ? created < windowEnd : created <= windowEnd;
    })
    .sort((a, b) => Date.parse(a.createdDateTime!) - Date.parse(b.createdDateTime!));
  return candidates[0];
}
