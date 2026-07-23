// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Meeting capture orchestrator. Replaces the old tenant-wide getAllTranscripts
// polling. Every tick it does two passes:
//
//   1. DISCOVERY — calendar-view over the leader's recent meetings, filtered
//      to (leader-organized + CoS agent invited + already ended). New ones
//      become pending captures with a wait budget scaled to meeting length.
//
//   2. RETRY SWEEP — for each pending capture whose next-check has arrived,
//      fetch its transcript + AI insights. When either "transcript + insights"
//      or "transcript + wait budget exhausted" is true, mark it READY. If the
//      transcript still isn't there past giveUpAfter, give up.
//
// Returns the READY captures so the scheduler can fire runCapture on each.

import { Authorization, TurnContext } from '@microsoft/agents-hosting';
import { discoverQualifyingMeetings } from './meetingWatcher';
import {
  fetchAiInsightsForMeeting,
  fetchTranscriptContent,
  fetchTranscriptsForMeeting,
  InsightsResult,
} from './meetingArtifactsFetch';
import {
  computeWaitBudget,
  createPendingCapture,
  findCapturesDueForCheck,
  hasCaptureForEvent,
  listAll,
  markCaptureComplete,
  markCaptureGaveUp,
  PendingCapture,
  pickNextRetryDelayMinutes,
  SimpleActionItem,
  SimpleMeetingNote,
  updateCapture,
} from '../state/pendingCaptureStore';
import { log } from '../util/logger';

// Kept the exported name so scheduler.ts doesn't need a diff for the import.
export interface DetectedTranscript {
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

async function runDiscoveryPass(
  opts: PollOptions,
  cfg: ReturnType<typeof readConfig>
): Promise<void> {
  const meetings = await discoverQualifyingMeetings({
    authorization: opts.authorization,
    context: opts.context,
    authHandlerName: opts.authHandlerName,
    graphOwnerUpn: cfg.graphOwnerUpn,
    leaderUpn: cfg.leaderUpn,
    cosAgentUpn: cfg.cosAgentUpn,
    watchHours: cfg.watchHours,
  });

  let newlyTracked = 0;
  for (const m of meetings) {
    if (hasCaptureForEvent(m.eventId)) continue;
    const budget = computeWaitBudget(m.durationMinutes, {
      multiplier: cfg.insightsMultiplier,
      minMinutes: cfg.insightsMinMinutes,
      maxMinutes: cfg.insightsMaxMinutes,
    });
    createPendingCapture({
      eventId: m.eventId,
      meetingId: m.meetingId,
      subject: m.subject,
      organizerAad: m.organizerAad,
      ownerUpn: cfg.graphOwnerUpn,
      chatId: undefined,
      endTime: m.endTime,
      durationMinutes: m.durationMinutes,
      waitBudgetMinutes: budget,
      giveUpAfter: m.endTime + cfg.giveUpAfterHours * 60 * 60 * 1000,
    });
    log.debug(
      'capturePoller',
      `added pending capture "${m.subject}" durationMin=${m.durationMinutes} waitBudgetMin=${budget}`
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

async function runRetrySweep(
  opts: PollOptions,
  _cfg: ReturnType<typeof readConfig>
): Promise<DetectedTranscript[]> {
  const now = Date.now();
  const due = findCapturesDueForCheck(now);
  if (due.length === 0) return [];

  const ready: DetectedTranscript[] = [];
  for (const cap of due) {
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
  // Bump attempts up front so the retry ladder advances even on failures.
  cap.attempts += 1;

  log.debug(
    'capturePoller',
    `advance "${cap.subject}" attempt=${cap.attempts} transcriptId=${cap.transcriptId ? cap.transcriptId.slice(0, 8) + '…' : '∅'} insightsFetched=${cap.insightsFetched}`
  );

  // Give-up guard: too much time has passed with no transcript.
  if (now > cap.giveUpAfter && !cap.transcriptId) {
    log.warn(
      'capturePoller',
      `giving up on meeting "${cap.subject}" — no transcript after ${(
        (now - cap.endTime) /
        (60 * 60 * 1000)
      ).toFixed(1)}h`
    );
    markCaptureGaveUp(cap.eventId);
    return undefined;
  }

  // 1) Ensure we have the transcript.
  if (!cap.transcriptId) {
    const transcripts = await fetchTranscriptsForMeeting(
      opts,
      cap.ownerUpn,
      cap.meetingId
    );
    if (transcripts.length > 0) {
      updateCapture(cap.eventId, {
        transcriptId: transcripts[0].transcriptId,
        transcriptFetchedAt: now,
      });
      cap.transcriptId = transcripts[0].transcriptId;
      cap.transcriptFetchedAt = now;
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
    insights = await fetchAiInsightsForMeeting(
      opts,
      cap.ownerUpn,
      cap.meetingId
    );
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

  const ready =
    !!cap.transcriptId &&
    (cap.insightsFetched || waitBudgetExhausted || transcriptSufficient);

  if (ready) {
    const insightsCount =
      (cap.insightsActionItems?.length ?? 0) +
      (cap.insightsMeetingNotes?.length ?? 0);
    log.info(
      'capturePoller',
      `READY: "${cap.subject}" meeting=${cap.meetingId.slice(
        0,
        8
      )} transcript=✓ content=${cap.transcriptContent ? `✓ (${cap.transcriptContent.length}ch)` : '✗'} insights=${insightsCount > 0 ? `✓ (${insightsCount})` : '✗'} after ${cap.attempts} attempt(s)`
    );
    markCaptureComplete(cap.eventId);
    return {
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

  // 4) Schedule next retry.
  const delayMin = pickNextRetryDelayMinutes(cap.attempts, cap.waitBudgetMinutes);
  updateCapture(cap.eventId, { nextCheckAt: now + delayMin * 60 * 1000 });
  log.debug(
    'capturePoller',
    `not ready — next check for "${cap.subject}" in ${delayMin} min (waitBudget=${cap.waitBudgetMinutes} min, waitedSoFar=${((now - (cap.transcriptFetchedAt ?? cap.endTime)) / 60000).toFixed(1)} min)`
  );
  return undefined;
}
