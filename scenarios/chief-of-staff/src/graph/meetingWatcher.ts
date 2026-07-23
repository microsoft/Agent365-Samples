// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Calendar-driven meeting discovery. Every poll cycle we read the calendar of
// GRAPH_OWNER (either the leader or the CoS agent — see CAPTURE_GRAPH_OWNER
// env), keep only events that are:
//   - Teams online meetings (isOnlineMeeting = true)
//   - organized by the leader (organizer.emailAddress.address == LEADER_UPN)
//   - CoS agent is an invited attendee
//   - already ended
// Then resolve each event's joinWebUrl -> onlineMeeting.id so downstream code
// can fetch transcripts + insights for that specific meeting.
//
// The GRAPH_OWNER split matters for the Teams application-access policy:
//   - "leader" mode: policy must be granted per leader (or -Global)
//   - "cos-agent" mode: policy granted to just the CoS agent's UPN, and every
//     leader just invites the CoS to their meetings — no per-leader setup

import axios from 'axios';
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
  chatId?: string;
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
  /** UPN who must be the event organizer for it to qualify. */
  leaderUpn: string;
  /** UPN who must be in event attendees for it to qualify (the CoS agent). */
  cosAgentUpn: string;
  watchHours: number;
}

/**
 * Discover meetings that qualify for CoS capture. Never throws — logs and
 * returns [] on failure so the poller keeps running.
 */
export async function discoverQualifyingMeetings(
  opts: MeetingWatcherOptions
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
    // and FILTER events where organizer == leader AND CoS is invited.
    const url =
      `${GRAPH_BASE}/users/${encodeURIComponent(graphOwnerUpn)}/calendarView` +
      `?startDateTime=${start}&endDateTime=${end}` +
      `&$select=id,subject,start,end,isOnlineMeeting,onlineMeeting,organizer,attendees` +
      `&$top=50`;

    log.debug(
      'meetingWatcher',
      `reading calendar as ${graphOwnerUpn} (window=[-${watchHours}h, +${forwardHours}h])`
    );

    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        // Force Graph to return start/end times as UTC. Without this header the
        // response uses the mailbox owner's default TZ, which breaks the naive
        // `Date.parse(ev.end.dateTime + 'Z')` parsing below (would silently
        // compute the wrong endMs, wrong giveUpAfter, wrong "ended already").
        Prefer: 'outlook.timezone="UTC"',
      },
    });

    const events = (res.data?.value ?? []) as any[];
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
      if (!ev.isOnlineMeeting) {
        log.debug('meetingWatcher', `skip "${subject}" — not a Teams online meeting`);
        continue;
      }
      const joinUrl: string | undefined = ev.onlineMeeting?.joinUrl;
      if (!joinUrl) {
        log.debug('meetingWatcher', `skip "${subject}" — no onlineMeeting.joinUrl on event`);
        continue;
      }

      const organizerAddr: string | undefined =
        ev.organizer?.emailAddress?.address?.toLowerCase();
      const attendees = (ev.attendees ?? []) as any[];
      const attendeeAddrs = attendees
        .map((a) => (a.emailAddress?.address ?? '').toLowerCase())
        .filter(Boolean);
      // Everyone on the invite (organizer + attendees). We qualify a meeting
      // whenever BOTH the leader AND the CoS are on it — regardless of who
      // organized it. This lets delegates, shared mailboxes, or other people
      // schedule meetings on the leader's behalf and still get captured.
      const participants = new Set<string>([
        ...(organizerAddr ? [organizerAddr] : []),
        ...attendeeAddrs,
      ]);
      const leaderInvolved = participants.has(leaderUpnLower);
      const cosInvolved = participants.has(cosUpnLower);
      if (!leaderInvolved) {
        log.debug(
          'meetingWatcher',
          `skip "${subject}" — leader (${leaderUpnLower}) not on invite (organizer=${organizerAddr})`,
          { attendees: attendeeAddrs }
        );
        continue;
      }
      if (!cosInvolved) {
        log.debug(
          'meetingWatcher',
          `skip "${subject}" — CoS (${cosUpnLower}) not on invite`,
          { attendees: attendeeAddrs }
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
        log.debug('meetingWatcher', `skip "${subject}" — missing end.dateTime`);
        continue;
      }
      const endedAlready = endMs < now;
      const startedAlready = isFinite(startMs) && startMs < now;
      log.debug(
        'meetingWatcher',
        `candidate "${subject}" start=${ev.start?.dateTime ?? '?'} end=${ev.end?.dateTime ?? '?'} startedAlready=${startedAlready} endedAlready=${endedAlready}`
      );

      // Resolve joinWebUrl → onlineMeetingId (still queried as graphOwnerUpn).
      const meetingId = await resolveOnlineMeetingId(opts, token, graphOwnerUpn, joinUrl);
      if (!meetingId) {
        log.warn(
          'meetingWatcher',
          `could not resolve onlineMeetingId for event "${subject}" — skipping`
        );
        continue;
      }

      log.info(
        'meetingWatcher',
        `✓ QUALIFIED "${subject}" (${endedAlready ? 'ended' : 'in-progress/upcoming'}) meetingId=${meetingId.slice(0, 12)}…`
      );
      qualifying.push({
        eventId: String(ev.id),
        meetingId,
        subject,
        organizerUpn: organizerAddr,
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
async function resolveOnlineMeetingId(
  opts: MeetingWatcherOptions,
  token: string,
  userUpn: string,
  joinWebUrl: string
): Promise<string | undefined> {
  try {
    // Resolve UPN → GUID (cached). If already looks like a GUID, use as-is.
    const isGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userUpn);
    const userId = isGuid ? userUpn : await resolveUpnToAad(userUpn, opts);
    if (!userId) {
      log.warn(
        'meetingWatcher',
        `resolveOnlineMeetingId: could not resolve UPN "${userUpn}" to AAD Object ID`
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
    return items[0]?.id;
  } catch (err) {
    const e = err as any;
    log.warn('meetingWatcher', 'resolveOnlineMeetingId failed', {
      status: e?.response?.status,
      body: e?.response?.data ?? e?.message ?? String(e),
    });
    return undefined;
  }
}
