// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Fetchers for a specific meeting's transcripts + AI insights (Copilot).
//
// Transcripts:
//   GET /users/{userId}/onlineMeetings/{meetingId}/transcripts
//     Scope: OnlineMeetingTranscript.Read.All (delegated)
//
// AI insights (Copilot — requires M365 Copilot licenses):
//   GET /copilot/users/{userId}/onlineMeetings/{meetingId}/aiInsights
//     Scope: OnlineMeetingAiInsight.Read.All (delegated)
//   Returns callAiInsight[] with `actionItems` and `meetingNotes`.
//   Falls back to /beta if /v1.0 returns 404 in the target tenant.

import axios from 'axios';
import { Authorization, TurnContext } from '@microsoft/agents-hosting';
import { acquireGraphToken, resolveUpnToAad } from './peopleTools';
import { SimpleActionItem, SimpleMeetingNote } from '../state/pendingCaptureStore';
import { log } from '../util/logger';

const GRAPH_V1 = 'https://graph.microsoft.com/v1.0';
const GRAPH_BETA = 'https://graph.microsoft.com/beta';

export interface GraphOpts {
  authorization: Authorization;
  context: TurnContext;
  authHandlerName: string;
}

/**
 * /users/{id}/onlineMeetings/... requires the user id segment to be an AAD
 * Object ID (GUID). It rejects a UPN with 400 "userId in request URL is not
 * a GUID". This helper resolves UPN → GUID once (cached via peopleTools) and
 * short-circuits when the input already looks like a GUID.
 */
async function resolveUserIdForOnlineMeetings(
  opts: GraphOpts,
  userUpnOrGuid: string
): Promise<string | undefined> {
  const isGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    userUpnOrGuid
  );
  if (isGuid) return userUpnOrGuid;
  const aad = await resolveUpnToAad(userUpnOrGuid, opts);
  return aad ?? undefined;
}

export interface TranscriptSummary {
  transcriptId: string;
  createdDateTime?: string;
  transcriptContentUrl?: string;
}

/**
 * List transcripts for a specific meeting. Returns [] if none yet or on any
 * error (never throws — the caller retries).
 */
export async function fetchTranscriptsForMeeting(
  opts: GraphOpts,
  userUpn: string,
  meetingId: string
): Promise<TranscriptSummary[]> {
  try {
    const token = await acquireGraphToken(opts);
    const userId = await resolveUserIdForOnlineMeetings(opts, userUpn);
    if (!userId) {
      log.warn(
        'transcriptFetch',
        `could not resolve UPN "${userUpn}" to AAD Object ID for /onlineMeetings call`
      );
      return [];
    }
    const url =
      `${GRAPH_V1}/users/${encodeURIComponent(userId)}` +
      `/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`;
    log.debug('transcriptFetch', `GET ${url}`);
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const items = (res.data?.value ?? []) as any[];
    log.debug(
      'transcriptFetch',
      `meeting=${meetingId.slice(0, 8)}… returned ${items.length} transcript(s)`
    );
    return items
      .filter((t) => t.id)
      .map((t) => ({
        transcriptId: String(t.id),
        createdDateTime: t.createdDateTime,
        transcriptContentUrl: t.transcriptContentUrl,
      }));
  } catch (err) {
    const e = err as any;
    const status = e?.response?.status;
    if (status === 403) {
      log.warn(
        'transcriptFetch',
        '403 — grant OnlineMeetingTranscript.Read.All to the agent app.'
      );
    } else if (status === 404) {
      log.debug(
        'transcriptFetch',
        `meeting=${meetingId.slice(0, 8)}… 404 — no transcripts yet (normal early in the retry window)`
      );
    } else {
      log.warn('transcriptFetch', `meeting=${meetingId.slice(0, 8)}… failed`, {
        status,
        body: e?.response?.data ?? e?.message ?? String(e),
      });
    }
    return [];
  }
}

/**
 * Fetch the actual transcript BODY (WebVTT) for a specific transcript.
 *
 * We do this via the standalone app-permission Graph worker so the LLM can
 * receive the transcript inline in its prompt without depending on
 * `mcp_TeamsServer.get_meeting_transcript` (whose own Graph call currently
 * fails with BadRequest for these token-shaped transcriptIds).
 *
 * Endpoint:
 *   GET /users/{userId}/onlineMeetings/{meetingId}/transcripts/{transcriptId}/content
 *     Accept: text/vtt
 *     Scope: OnlineMeetingTranscript.Read.All (application)
 *
 * Returns undefined on any failure so the caller can fall back to MCP or a
 * meta-summary prompt with no transcript body.
 */
export async function fetchTranscriptContent(
  opts: GraphOpts,
  userUpn: string,
  meetingId: string,
  transcriptId: string
): Promise<string | undefined> {
  try {
    const token = await acquireGraphToken(opts);
    const userId = await resolveUserIdForOnlineMeetings(opts, userUpn);
    if (!userId) {
      log.warn(
        'transcriptFetch',
        `could not resolve UPN "${userUpn}" to AAD Object ID for /transcripts/{id}/content call`
      );
      return undefined;
    }
    const url =
      `${GRAPH_V1}/users/${encodeURIComponent(userId)}` +
      `/onlineMeetings/${encodeURIComponent(meetingId)}` +
      `/transcripts/${encodeURIComponent(transcriptId)}/content`;
    log.debug(
      'transcriptFetch',
      `GET (content) meeting=${meetingId.slice(0, 8)}… transcript=${transcriptId.slice(0, 8)}…`
    );
    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/vtt',
      },
      // Ensure we don't parse as JSON — WebVTT is plain text.
      responseType: 'text',
      transformResponse: (v) => v,
    });
    const body = typeof res.data === 'string' ? res.data : String(res.data ?? '');
    log.debug(
      'transcriptFetch',
      `content fetched: ${body.length} chars for transcript=${transcriptId.slice(0, 8)}…`
    );
    return body || undefined;
  } catch (err) {
    const e = err as any;
    log.warn(
      'transcriptFetch',
      `content fetch failed for transcript=${transcriptId.slice(0, 8)}…`,
      {
        status: e?.response?.status,
        body:
          typeof e?.response?.data === 'string'
            ? e.response.data.slice(0, 300)
            : e?.response?.data ?? e?.message ?? String(e),
      }
    );
    return undefined;
  }
}

/**
 * Fetch Copilot AI insights for a meeting. Tries v1.0 then falls back to
 * /beta. Normalises to SimpleActionItem[] + SimpleMeetingNote[] so callers
 * don't have to know about callAiInsight shape.
 *
 * Returns { available: false } when insights aren't there yet. Returns
 * { available: false, unsupported: true } when the tenant doesn't have
 * Copilot licenses (404/403 patterns).
 */
export interface InsightsResult {
  available: boolean;
  unsupported?: boolean;
  actionItems?: SimpleActionItem[];
  meetingNotes?: SimpleMeetingNote[];
}

export async function fetchAiInsightsForMeeting(
  opts: GraphOpts,
  userUpn: string,
  meetingId: string
): Promise<InsightsResult> {
  const token = await acquireGraphToken(opts);
  const userId = await resolveUserIdForOnlineMeetings(opts, userUpn);
  if (!userId) {
    log.warn(
      'insightsFetch',
      `could not resolve UPN "${userUpn}" to AAD Object ID for /aiInsights call`
    );
    return { available: false };
  }
  const path = `/copilot/users/${encodeURIComponent(userId)}/onlineMeetings/${encodeURIComponent(meetingId)}/aiInsights`;

  // Try v1.0 first.
  log.debug('insightsFetch', `GET ${GRAPH_V1}${path}`);
  const v1 = await tryFetchInsights(token, `${GRAPH_V1}${path}`);
  if (v1.status === 'ok') {
    log.debug('insightsFetch', `v1.0 returned ${v1.data.length} insight object(s) for meeting=${meetingId.slice(0, 8)}…`);
    return normalise(v1.data);
  }
  if (v1.status === 'unsupported') {
    log.debug('insightsFetch', `v1.0 unsupported for meeting=${meetingId.slice(0, 8)}… (403/404) — tenant may lack Copilot licence`);
    return { available: false, unsupported: true };
  }

  // Fall back to beta if v1.0 was 404 (endpoint not enabled in this tenant).
  log.debug('insightsFetch', `v1.0 not-ready, trying /beta ${GRAPH_BETA}${path}`);
  const beta = await tryFetchInsights(token, `${GRAPH_BETA}${path}`);
  if (beta.status === 'ok') {
    log.debug('insightsFetch', `beta returned ${beta.data.length} insight object(s) for meeting=${meetingId.slice(0, 8)}…`);
    return normalise(beta.data);
  }
  if (beta.status === 'unsupported') {
    log.debug('insightsFetch', `beta unsupported for meeting=${meetingId.slice(0, 8)}…`);
    return { available: false, unsupported: true };
  }

  log.debug('insightsFetch', `insights not ready yet for meeting=${meetingId.slice(0, 8)}… (empty response on both v1.0 and beta)`);
  return { available: false };
}

async function tryFetchInsights(
  token: string,
  url: string
): Promise<
  | { status: 'ok'; data: any[] }
  | { status: 'not-ready' }
  | { status: 'unsupported' }
> {
  try {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const items = (res.data?.value ?? []) as any[];
    if (items.length === 0) return { status: 'not-ready' };
    return { status: 'ok', data: items };
  } catch (err) {
    const e = err as any;
    const status = e?.response?.status;
    if (status === 404 || status === 403) return { status: 'unsupported' };
    log.warn('insightsFetch', `${url} failed`, {
      status,
      body: e?.response?.data ?? e?.message ?? String(e),
    });
    return { status: 'not-ready' };
  }
}

/** Flatten callAiInsight[] into our simple shape. */
function normalise(insights: any[]): InsightsResult {
  const actionItems: SimpleActionItem[] = [];
  const meetingNotes: SimpleMeetingNote[] = [];
  for (const ins of insights) {
    for (const ai of ins.actionItems ?? []) {
      actionItems.push({
        title: String(ai.title ?? ai.text ?? '').trim(),
        ownerDisplayName: ai.owner?.displayName ?? ai.assignedTo?.displayName,
        ownerUpn:
          ai.owner?.userPrincipalName ??
          ai.owner?.email ??
          ai.assignedTo?.userPrincipalName,
        dueDateTime: ai.dueDateTime ?? ai.due?.dateTime,
        description: ai.description,
      });
    }
    for (const mn of ins.meetingNotes ?? []) {
      meetingNotes.push({
        title: mn.title,
        content: mn.content ?? mn.text,
      });
    }
  }
  return {
    available: actionItems.length > 0 || meetingNotes.length > 0,
    actionItems,
    meetingNotes,
  };
}
