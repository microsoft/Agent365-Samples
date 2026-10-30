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

import { graphHttp as axios } from './graphHttp';
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
  /** Call / content correlation ids — shared with this call's Copilot insights. */
  callId?: string;
  contentCorrelationId?: string;
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
        `could not resolve the owner UPN to AAD Object ID for /onlineMeetings call`
      );
      return [];
    }
    const url =
      `${GRAPH_V1}/users/${encodeURIComponent(userId)}` +
      `/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`;
    log.debug('transcriptFetch', `GET transcripts meeting=${meetingId.slice(0, 8)}…`);
    const items: { id?: string; createdDateTime?: string; transcriptContentUrl?: string; callId?: string; contentCorrelationId?: string }[] = [];
    let pageUrl: string | undefined = url;
    while (pageUrl) {
      const res: { data: { value?: typeof items; '@odata.nextLink'?: string } } = await axios.get(pageUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      items.push(...(res.data?.value ?? []));
      pageUrl = res.data?.['@odata.nextLink'];
    }
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
        callId: t.callId ?? undefined,
        contentCorrelationId: t.contentCorrelationId ?? undefined,
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
        `could not resolve the owner UPN to AAD Object ID for /transcripts/{id}/content call`
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

/** Identifies the occurrence whose insights we want. */
export interface InsightsOccurrence {
  callId?: string;
  contentCorrelationId?: string;
  callIds?: string[];
  contentCorrelationIds?: string[];
  /** Earliest plausible creation time for this occurrence's insights (ms). */
  windowStart: number;
  /** Insights created at/after this belong to a later occurrence (ms). */
  windowEnd?: number;
}

/**
 * Keep only insight records that belong to the captured occurrence. A
 * recurring meeting's aiInsights collection holds every occurrence's
 * results, so records are matched by the transcript's correlation ids; when
 * the transcript has none, insights are not used: publication time cannot
 * establish which occurrence produced them. Use the transcript instead.
 */
export function selectInsightsForOccurrence(insights: any[], occ: InsightsOccurrence): any[] {
  const calls = new Set([...(occ.callIds ?? []), ...(occ.callId ? [occ.callId] : [])]);
  const correlations = new Set([...(occ.contentCorrelationIds ?? []), ...(occ.contentCorrelationId ? [occ.contentCorrelationId] : [])]);
  return insights.filter((ins) => {
    // Publication time does not identify the call: an older call's insights
    // can arrive late. Without correlation, use this occurrence's transcript.
    return correlations.has(ins.contentCorrelationId) || calls.has(ins.callId);
  });
}

export async function fetchAiInsightsForMeeting(
  opts: GraphOpts,
  userUpn: string,
  meetingId: string,
  occurrence: InsightsOccurrence
): Promise<InsightsResult> {
  const token = await acquireGraphToken(opts);
  const userId = await resolveUserIdForOnlineMeetings(opts, userUpn);
  if (!userId) {
    log.warn(
      'insightsFetch',
      `could not resolve the owner UPN to AAD Object ID for /aiInsights call`
    );
    return { available: false };
  }
  const path = `/copilot/users/${encodeURIComponent(userId)}/onlineMeetings/${encodeURIComponent(meetingId)}/aiInsights`;

  // Try v1.0 first.
  log.debug('insightsFetch', `GET v1.0 aiInsights meeting=${meetingId.slice(0, 8)}…`);
  const v1 = await tryFetchInsights(token, `${GRAPH_V1}${path}`);
  if (v1.status === 'ok') {
    log.debug('insightsFetch', `v1.0 returned ${v1.data.length} insight object(s) for meeting=${meetingId.slice(0, 8)}…`);
    return normalise(selectInsightsForOccurrence(v1.data, occurrence));
  }
  if (v1.status === 'unsupported') {
    log.debug('insightsFetch', `v1.0 forbidden for meeting=${meetingId.slice(0, 8)}… (403) — tenant may lack Copilot licence`);
    return { available: false, unsupported: true };
  }

  // Fall back to /beta when v1.0 is empty or returns 404 (the endpoint may
  // only exist on beta in this tenant).
  log.debug('insightsFetch', `v1.0 ${v1.status}, trying /beta for meeting=${meetingId.slice(0, 8)}…`);
  const beta = await tryFetchInsights(token, `${GRAPH_BETA}${path}`);
  if (beta.status === 'ok') {
    log.debug('insightsFetch', `beta returned ${beta.data.length} insight object(s) for meeting=${meetingId.slice(0, 8)}…`);
    return normalise(selectInsightsForOccurrence(beta.data, occurrence));
  }
  // Only declare insights unavailable when BOTH versions say so.
  if (
    beta.status === 'unsupported' ||
    (v1.status === 'not-found' && beta.status === 'not-found')
  ) {
    log.debug('insightsFetch', `insights unsupported for meeting=${meetingId.slice(0, 8)}… on v1.0 and beta`);
    return { available: false, unsupported: true };
  }

  log.debug('insightsFetch', `insights not ready yet for meeting=${meetingId.slice(0, 8)}… (no insights on v1.0 or beta yet)`);
  return { available: false };
}

async function tryFetchInsights(
  token: string,
  url: string
): Promise<
  | { status: 'ok'; data: any[] }
  | { status: 'not-ready' }
  | { status: 'not-found' }
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
    // A 404 can be version-specific (endpoint only on beta); the caller
    // decides. 403 means the tenant/app genuinely can't read insights.
    if (status === 404) return { status: 'not-found' };
    if (status === 403) return { status: 'unsupported' };
    log.warn('insightsFetch', `aiInsights request failed (${url.includes('/beta/') ? 'beta' : 'v1.0'})`, {
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
