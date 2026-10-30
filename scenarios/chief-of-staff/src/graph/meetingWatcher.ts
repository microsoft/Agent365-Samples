// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Calendar-driven meeting discovery. Every poll cycle we read the calendar of
// GRAPH_OWNER (either the leader or the CoS agent — see CAPTURE_GRAPH_OWNER
// env), keep only events that are:
//   - Teams online meetings (isOnlineMeeting = true)
//   - attended by BOTH the leader and the CoS agent (as organizer or
//     attendee) — regardless of who organized the meeting
//   - inside the watch window, including in-progress and upcoming
//     occurrences (the transcript retry loop waits for the transcript)
// Then resolve each event's joinWebUrl -> onlineMeeting.id so downstream code
// can fetch transcripts + insights for that specific meeting.
//
// The GRAPH_OWNER split matters for the Teams application-access policy:
//   - "leader" mode: policy must be granted per leader (or -Global)
//   - "cos-agent" mode: policy granted to just the CoS agent's UPN, and every
//     leader just invites the CoS to their meetings — no per-leader setup

import { graphHttp as axios } from './graphHttp';
import { Authorization, TurnContext } from '@microsoft/agents-hosting';
import { acquireGraphToken, resolveUpnToAad } from './peopleTools';
import { log } from '../util/logger';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface QualifyingMeeting {
  eventId: string;
  meetingId: string; // onlineMeeting id (base64ish)
  subject: string;
  organizerAad?: string;
  organizerUpn?: string;
  /** Meeting chat thread id (onlineMeeting.chatInfo.threadId). */
  chatId?: string;
  /** Scheduled start of this occurrence (epoch ms), when known. */
  startTime?: number;
  endTime: number; // epoch ms
  durationMinutes: number;
  joinWebUrl: string;
}

export interface MeetingWatcherOptions {
  authorization: Authorization;
  context: TurnContext;
  authHandlerName: string;
  /** UPN whose calendar we read + whose /users/{}/onlineMeetings we hit. */
  graphOwnerUpn: string;
  /** UPN who must be on the invite (organizer or attendee) — the leader. */
  leaderUpn: string;
  /** UPN who must be in event attendees for it to qualify (the CoS agent). */
  cosAgentUpn: string;
  watchHours: number;
}

/**
 * Every Teams occurrence seen in the window — qualifying or not. Recurring and
 * back-to-back meetings can share one join URL, so occurrences the CoS isn't
 * invited to still bound which transcript belongs to a captured occurrence.
 */
export interface ObservedOccurrence {
  eventId: string;
  joinWebUrl: string;
  startTime?: number;
  endTime: number;
  durationMinutes: number;
}

/**
 * People actually on the invite: the organizer plus attendees who have not
 * declined. Shared by discovery and the pre-processing re-check so both apply
 * the same participation rule.
 */
export function eventParticipants(ev: any): Set<string> {
  const organizerAddr: string | undefined = ev.organizer?.emailAddress?.address?.toLowerCase();
  const attendeeAddrs = ((ev.attendees ?? []) as any[])
    .filter((a) => String(a?.status?.response ?? '').toLowerCase() !== 'declined')
    .map((a) => (a.emailAddress?.address ?? '').toLowerCase())
    .filter(Boolean);
  return new Set<string>([...(organizerAddr ? [organizerAddr] : []), ...attendeeAddrs]);
}

/**
 * Re-read one calendar event and report whether it still qualifies for
 * capture (not cancelled, both the leader and the CoS still on the invite).
 * 'unknown' means the lookup itself failed — callers must retry rather than
 * treat it as a revocation.
 */
export async function checkEventParticipation(
  opts: Pick<MeetingWatcherOptions, 'authorization' | 'context' | 'authHandlerName'>,
  ownerUpn: string,
  eventId: string,
  leaderUpn: string,
  cosAgentUpn: string
): Promise<'qualified' | 'disqualified' | 'unknown'> {
  try {
    const token = await acquireGraphToken(opts as MeetingWatcherOptions);
    const url =
      `${GRAPH_BASE}/users/${encodeURIComponent(ownerUpn)}/events/${encodeURIComponent(eventId)}` +
      `?$select=id,isCancelled,isOnlineMeeting,organizer,attendees`;
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    const ev = res.data ?? {};
    if (ev.isCancelled || ev.isOnlineMeeting === false) return 'disqualified';
    const participants = eventParticipants(ev);
    return participants.has(leaderUpn.toLowerCase()) && participants.has(cosAgentUpn.toLowerCase())
      ? 'qualified'
      : 'disqualified';
  } catch (err) {
    const status = (err as any)?.response?.status;
    if (status === 404) return 'disqualified'; // event deleted
    log.warn('meetingWatcher', `participation re-check failed for event=…${eventId.slice(-8)} (status=${status ?? 'n/a'}) — will retry`);
    return 'unknown';
  }
}

/**
 * Discover meetings that qualify for CoS capture. Never throws — logs and
 * returns [] on failure so the poller keeps running.
 */
export async function discoverQualifyingMeetings(
  opts: MeetingWatcherOptions,
  observed?: ObservedOccurrence[]
): Promise<QualifyingMeeting[]> {
  const { graphOwnerUpn, leaderUpn, cosAgentUpn, watchHours } = opts;
  if (!graphOwnerUpn || !leaderUpn || !cosAgentUpn) return [];

  try {
    const token = await acquireGraphToken(opts);
    // Window includes the recent past AND a forward slice, so meetings that
    // haven't reached their scheduled end (or start) yet still get discovered.
    // The transcript-fetch retry loop naturally handles "not ready yet" via
    // 404s and backoff, so we don't need to gate on scheduled end anymore.
    const forwardHours = Number(process.env.TRANSCRIPT_WATCH_FORWARD_HOURS ?? '24');
    const start = new Date(Date.now() - watchHours * 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + forwardHours * 60 * 60 * 1000).toISOString();

    // calendarView is the correct endpoint for expanded recurring events.
    // We read the CALENDAR of graphOwnerUpn (leader or cos-agent, per env)
    // and keep events where BOTH the leader and the CoS are on the invite.
    const url =
      `${GRAPH_BASE}/users/${encodeURIComponent(graphOwnerUpn)}/calendarView` +
      `?startDateTime=${start}&endDateTime=${end}` +
      `&$select=id,subject,start,end,isCancelled,isOnlineMeeting,onlineMeeting,organizer,attendees` +
      `&$top=100`;

    log.debug(
      'meetingWatcher',
      `reading watched calendar (window=[-${watchHours}h, +${forwardHours}h])`
    );

    // calendarView is paged (expanded recurrences count individually) — follow
    // @odata.nextLink until exhausted so busy calendars aren't truncated.
    const events: any[] = [];
    let pageUrl: string | null = url;
    let pages = 0;
    while (pageUrl) {
      const res: any = await axios.get(pageUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      events.push(...((res.data?.value ?? []) as any[]));
      pageUrl = res.data?.['@odata.nextLink'] ?? null;
      pages++;
    }
    if (pages > 1) {
      log.info('meetingWatcher', `calendarView returned ${events.length} event(s) across ${pages} pages`);
    }
    const now = Date.now();
    const cosUpnLower = cosAgentUpn.toLowerCase();
    const leaderUpnLower = leaderUpn.toLowerCase();

    log.debug(
      'meetingWatcher',
      `calendarView returned ${events.length} event(s) in window [-${watchHours}h, +${forwardHours}h]`
    );

    const qualifying: QualifyingMeeting[] = [];
    for (const ev of events) {
      const subject = String(ev.subject ?? '(untitled)');
      // Log-safe reference: never the meeting subject or attendee addresses.
      // Event ids share a mailbox prefix, so the tail is what distinguishes them.
      const ref = `event=…${String(ev.id ?? '?').slice(-8)}`;
      if (!ev.isOnlineMeeting) {
        log.debug('meetingWatcher', `skip ${ref} — not a Teams online meeting`);
        continue;
      }
      const joinUrl: string | undefined = ev.onlineMeeting?.joinUrl;
      if (!joinUrl) {
        log.debug('meetingWatcher', `skip ${ref} — no onlineMeeting.joinUrl on event`);
        continue;
      }
      // Record every online occurrence (qualifying or not) as a transcript
      // window boundary for other occurrences on the same join URL.
      if (observed && !ev.isCancelled) {
        const oEnd = ev.end?.dateTime ? Date.parse(ev.end.dateTime + 'Z') : NaN;
        const oStart = ev.start?.dateTime ? Date.parse(ev.start.dateTime + 'Z') : NaN;
        if (isFinite(oEnd)) {
          observed.push({
            eventId: String(ev.id),
            joinWebUrl: joinUrl,
            startTime: isFinite(oStart) ? oStart : undefined,
            endTime: oEnd,
            durationMinutes: isFinite(oStart) ? Math.max(1, Math.round((oEnd - oStart) / 60000)) : 30,
          });
        }
      }

      if (ev.isCancelled) {
        log.debug('meetingWatcher', `skip ${ref} — cancelled`);
        continue;
      }
      const organizerAddr: string | undefined =
        ev.organizer?.emailAddress?.address?.toLowerCase();
      const attendeeAddrs = ((ev.attendees ?? []) as any[])
        .map((a) => (a.emailAddress?.address ?? '').toLowerCase())
        .filter(Boolean);
      // Everyone on the invite who hasn't declined (organizer + attendees). We
      // qualify a meeting whenever BOTH the leader AND the CoS are on it —
      // regardless of who organized it. This lets delegates, shared
      // mailboxes, or other people schedule meetings on the leader's behalf
      // and still get captured. Same rule as checkEventParticipation.
      const participants = eventParticipants(ev);
      const leaderInvolved = participants.has(leaderUpnLower);
      const cosInvolved = participants.has(cosUpnLower);
      if (!leaderInvolved) {
        log.debug(
          'meetingWatcher',
          `skip ${ref} — leader not on invite (attendees=${attendeeAddrs.length})`
        );
        continue;
      }
      if (!cosInvolved) {
        log.debug(
          'meetingWatcher',
          `skip ${ref} — CoS not on invite (attendees=${attendeeAddrs.length})`
        );
        continue;
      }

      const endMs = ev.end?.dateTime ? Date.parse(ev.end.dateTime + 'Z') : NaN;
      const startMs = ev.start?.dateTime ? Date.parse(ev.start.dateTime + 'Z') : NaN;
      // NOTE: we USED to skip meetings whose scheduled end was in the future.
      // That excluded meetings the leader had joined-and-left early. We now
      // discover them regardless — the transcript-fetch retry loop naturally
      // sits on a 404 and re-checks until Teams publishes the transcript, and
      // gives up after CAPTURE_GIVE_UP_AFTER_HOURS if nothing appears.
      if (!isFinite(endMs)) {
        log.debug('meetingWatcher', `skip ${ref} — missing end.dateTime`);
        continue;
      }
      const endedAlready = endMs < now;
      const startedAlready = isFinite(startMs) && startMs < now;
      log.debug(
        'meetingWatcher',
        `candidate ${ref} start=${ev.start?.dateTime ?? '?'} end=${ev.end?.dateTime ?? '?'} startedAlready=${startedAlready} endedAlready=${endedAlready}`
      );

      // Resolve joinWebUrl → onlineMeetingId (still queried as graphOwnerUpn).
      const online = await resolveOnlineMeeting(opts, token, graphOwnerUpn, joinUrl);
      const meetingId = online?.id;
      if (!meetingId) {
        log.warn(
          'meetingWatcher',
          `could not resolve onlineMeetingId for ${ref} — skipping`
        );
        continue;
      }

      log.info(
        'meetingWatcher',
        `✓ QUALIFIED ${ref} (${endedAlready ? 'ended' : 'in-progress/upcoming'}) meetingId=${meetingId.slice(0, 12)}…`
      );
      qualifying.push({
        eventId: String(ev.id),
        meetingId,
        chatId: online?.chatThreadId,
        subject,
        organizerAad: ev.organizer?.emailAddress?.address ? undefined : undefined, // resolved elsewhere if needed
        organizerUpn: organizerAddr,
        startTime: isFinite(startMs) ? startMs : undefined,
        endTime: endMs,
        durationMinutes: isFinite(startMs)
          ? Math.max(1, Math.round((endMs - startMs) / 60000))
          : 30,
        joinWebUrl: joinUrl,
      });
    }

    return qualifying;
  } catch (err) {
    const e = err as any;
    const status = e?.response?.status;
    if (status === 403) {
      log.warn(
        'meetingWatcher',
        '403 Forbidden — grant Calendars.Read to the agent app in Entra and admin-consent.'
      );
    } else {
      log.warn('meetingWatcher', 'discovery failed', {
        status,
        body: e?.response?.data ?? e?.message ?? String(e),
      });
    }
    return [];
  }
}

/**
 * Resolve a Teams joinWebUrl to its onlineMeeting.id via Graph.
 * Returns undefined on failure.
 *
 * IMPORTANT: Graph's /users/{id}/onlineMeetings endpoint requires the user id
 * to be a GUID (AAD Object ID) — it does NOT accept a UPN like calendarView
 * does. We resolve the UPN once here and cache via peopleTools.resolveUpnToAad.
 */
async function resolveOnlineMeeting(
  opts: MeetingWatcherOptions,
  token: string,
  userUpn: string,
  joinWebUrl: string
): Promise<{ id: string; chatThreadId?: string } | undefined> {
  try {
    // Resolve UPN → GUID (cached). If already looks like a GUID, use as-is.
    const isGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userUpn);
    const userId = isGuid ? userUpn : await resolveUpnToAad(userUpn, opts);
    if (!userId) {
      log.warn(
        'meetingWatcher',
        `resolveOnlineMeeting: could not resolve the owner UPN to AAD Object ID`
      );
      return undefined;
    }
    // $filter needs the URL escaped and single-quoted.
    const filter = `joinWebUrl eq '${joinWebUrl.replace(/'/g, "''")}'`;
    const url =
      `${GRAPH_BASE}/users/${encodeURIComponent(userId)}/onlineMeetings` +
      `?$filter=${encodeURIComponent(filter)}`;
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const items = (res.data?.value ?? []) as any[];
    if (!items[0]?.id) return undefined;
    // chatInfo.threadId is the meeting chat — used for attendee lookup and
    // the capture summary post.
    return { id: String(items[0].id), chatThreadId: items[0].chatInfo?.threadId ?? undefined };
  } catch (err) {
    const e = err as any;
    log.warn('meetingWatcher', 'resolveOnlineMeeting failed', {
      status: e?.response?.status,
      body: e?.response?.data ?? e?.message ?? String(e),
    });
    return undefined;
  }
}
