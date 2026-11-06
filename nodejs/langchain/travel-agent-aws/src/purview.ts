// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Microsoft Purview data loss prevention (DLP) gate, adapted from the Agent 365 skill
// purview-dlp-integration (assets/purview.ts). Off unless PURVIEW_DLP_ENABLED=true.
//
// Each prompt is sent to the Microsoft Graph beta processContent API with the agent's own
// agentic Graph token (evaluated as /me, the agent user). When a DLP policy scoped to the
// agent's blueprint says "block", the turn stops before the model sees the prompt. Responses
// can also be submitted for audit (PURVIEW_CHECK_OUTPUT); the Applications workload has no
// response blocking, so that check audits, and withholds a reply only when it fails closed.
// processContent also writes the Purview audit record.
//
// Differences from the skill's guard, for this sample:
//   - The policy location is the turn's own blueprint (recipient.agenticAppBlueprintId), so one
//     backend serving several tenants' blueprints (tenant-registry.ts) evaluates each tenant's
//     policy. PURVIEW_APP_ID is only the fallback for turns without one (e.g. Agents Playground).
//   - Production logs carry the decision, HTTP status and counts only; Graph error bodies and
//     raw responses are logged only in verbose mode (log.ts), as they can echo content.
//   - The token source is passed in, so the gate can be tested without a live tenant.
//
// Settings (.env locally; deploy-aws.ps1 publishes them as function settings):
//   PURVIEW_DLP_ENABLED=true          turn the gate on (default off)
//   PURVIEW_FAIL_MODE=closed|open     closed (default): an error or timeout blocks the turn
//   PURVIEW_CHECK_OUTPUT=true|false   default true: also submit the reply for audit
//   PURVIEW_TIMEOUT_MS=2000           per-call limit, token included
//   PURVIEW_APP_NAME=<name>           display name sent with each check (default: Travel Agent AWS)
//   PURVIEW_APP_ID=<blueprint id>     fallback policy location for turns without a blueprint id
//   PURVIEW_DEBUG=false               true: log Purview's raw response (verbose mode only)
//
// Every content entry MUST carry a non-empty `name`: without it Graph answers HTTP 200 with a
// processingError and no policy actions, which looks like "allowed". processingErrors therefore
// count as a failure (blocked when failing closed).

import { randomUUID } from 'node:crypto';
import { isVerbose } from './log.js';

export const PURVIEW_GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const PROCESS_CONTENT_URL = 'https://graph.microsoft.com/beta/me/dataSecurityAndGovernance/processContent';
const MAX_CONTENT_CHARS = 100_000;
const DEFAULT_APP_NAME = 'Travel Agent AWS';

export type DlpActivity = 'uploadText' | 'downloadText';
export type DlpDecision = 'allowed' | 'blocked' | 'error' | 'disabled';

export interface DlpVerdict {
  /** True: stop the turn (or withhold the reply). */
  blocked: boolean;
  decision: DlpDecision;
  /** Fixed reason code for logs; never content. */
  reason?: string;
}

/** The parts of the turn the check needs (all from the authenticated activity). */
export interface DlpTurn {
  /** recipient.agenticAppBlueprintId: the blueprint the DLP policy is scoped to. */
  blueprintId?: string;
  /** recipient.agenticAppId: the agent instance. */
  agentId?: string;
  conversationId?: string;
}

interface ProcessContentResponse {
  protectionScopeState?: string;
  policyActions?: Array<Record<string, unknown>>;
  processingErrors?: Array<Record<string, unknown>>;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

export function purviewEnabled(): boolean {
  return envBool('PURVIEW_DLP_ENABLED', false);
}

export function purviewChecksOutput(): boolean {
  return purviewEnabled() && envBool('PURVIEW_CHECK_OUTPUT', true);
}

function failClosed(): boolean {
  return (process.env.PURVIEW_FAIL_MODE ?? 'closed').trim().toLowerCase() !== 'open';
}

function timeoutMs(): number {
  const n = Number(process.env.PURVIEW_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 2000;
}

/** A block is any policy action whose restrictionAction is "block". */
export function isBlockAction(actions?: Array<Record<string, unknown>>): boolean {
  return !!actions?.some((a) => String(a?.restrictionAction ?? '').toLowerCase() === 'block');
}

/** The policy location: the turn's blueprint first, then the configured fallbacks. */
export function policyAppId(turn: DlpTurn): string {
  return (
    turn.blueprintId?.trim() ||
    process.env.PURVIEW_APP_ID?.trim() ||
    process.env.agent365Observability__agentBlueprintId?.trim() ||
    process.env.connections__service_connection__settings__clientId?.trim() ||
    ''
  );
}

export function buildProcessContentBody(activity: DlpActivity, text: string, turn: DlpTurn, appId: string) {
  const appName = process.env.PURVIEW_APP_NAME?.trim() || DEFAULT_APP_NAME;
  const now = new Date().toISOString();
  return {
    contentToProcess: {
      contentEntries: [
        {
          '@odata.type': 'microsoft.graph.processConversationMetadata',
          identifier: randomUUID(),
          content: { '@odata.type': 'microsoft.graph.textContent', data: text },
          agents: [
            {
              '@odata.type': 'microsoft.graph.aiAgentInfo',
              blueprintId: appId,
              identifier: turn.agentId?.trim() || appId,
              name: appName,
              version: '1.0',
            },
          ],
          // Required and non-empty (see the header).
          name: `${appName} message`,
          correlationId: turn.conversationId || randomUUID(),
          sequenceNumber: activity === 'uploadText' ? 0 : 1,
          isTruncated: false,
          createdDateTime: now,
          modifiedDateTime: now,
          contentCategory: 'ai',
        },
      ],
      activityMetadata: { activity },
      integratedAppMetadata: { name: appName, version: '1.0.0' },
      protectedAppMetadata: {
        name: appName,
        version: '1.0.0',
        applicationLocation: {
          '@odata.type': 'microsoft.graph.policyLocationApplication',
          value: appId,
        },
      },
    },
  };
}

/** Checks a prompt before the model sees it. Never throws. */
export function evaluatePrompt(text: string, turn: DlpTurn, getToken: () => Promise<string>): Promise<DlpVerdict> {
  return evaluate('uploadText', text, turn, getToken);
}

/** Submits a reply for audit before it is sent. Never throws. */
export function evaluateResponse(text: string, turn: DlpTurn, getToken: () => Promise<string>): Promise<DlpVerdict> {
  return evaluate('downloadText', text, turn, getToken);
}

async function evaluate(
  activity: DlpActivity,
  text: string,
  turn: DlpTurn,
  getToken: () => Promise<string>,
): Promise<DlpVerdict> {
  if (!purviewEnabled()) return { blocked: false, decision: 'disabled' };
  const fail = (reason: string): DlpVerdict => ({ blocked: failClosed(), decision: 'error', reason });
  // Never approve a whole message on the strength of a prefix, even when failing open.
  if (text.length > MAX_CONTENT_CHARS) {
    console.warn(`[purview] ${activity} -> BLOCKED (content over ${MAX_CONTENT_CHARS} characters)`);
    return { blocked: true, decision: 'error', reason: 'content-too-long' };
  }
  const appId = policyAppId(turn);
  if (!appId) {
    console.error(`[purview] ${activity} -> no blueprint id for the policy location (set PURVIEW_APP_ID)`);
    return fail('no-app-id');
  }

  const reqId = randomUUID();
  const limit = timeoutMs();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, limit);
  });
  try {
    const token = await Promise.race([getToken(), deadline]);
    if (!token) throw new Error('no-token');
    const res = await Promise.race([
      fetch(PROCESS_CONTENT_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Client-Request-Id': reqId,
        },
        body: JSON.stringify(buildProcessContentBody(activity, text, turn, appId)),
      }),
      deadline,
    ]);

    if (res.status !== 200) {
      const detail = isVerbose() ? `: ${(await res.text().catch(() => '')).slice(0, 300)}` : '';
      console.error(`[purview] ${activity} -> HTTP ${res.status} reqId=${reqId}${detail}`);
      return fail(`graph-${res.status}`);
    }

    const json = (await res.json()) as ProcessContentResponse;
    const actions = json.policyActions ?? [];
    const errors = json.processingErrors ?? [];
    const summary = `HTTP 200, ${actions.length} policyAction(s), scopeState=${json.protectionScopeState ?? 'n/a'}, errors=${errors.length}`;

    // The request was malformed (often a missing content-entry name): nothing was evaluated.
    if (errors.length) {
      const detail = isVerbose() ? ` ${JSON.stringify(errors).slice(0, 500)}` : '';
      console.error(`[purview] ${activity} -> REQUEST ERROR (${summary}) reqId=${reqId}${detail}`);
      return fail('processing-errors');
    }
    if (isBlockAction(actions)) {
      console.warn(`[purview] ${activity} -> BLOCKED (${summary}) reqId=${reqId}`);
      return { blocked: true, decision: 'blocked', reason: 'policy-block' };
    }
    const raw = isVerbose() && envBool('PURVIEW_DEBUG', false) ? ` raw=${JSON.stringify(json).slice(0, 700)}` : '';
    console.log(`[purview] ${activity} -> allowed (${summary}) reqId=${reqId}${raw}`);
    return { blocked: false, decision: 'allowed' };
  } catch (err) {
    const e = err as Error;
    const reason = e?.name === 'AbortError' || e?.message === 'timeout' ? 'timeout' : e?.message === 'no-token' ? 'no-token' : (e?.name || 'Error');
    console.error(`[purview] ${activity} -> error (${reason}) reqId=${reqId}`);
    return fail(reason === 'timeout' ? `timeout-${limit}ms` : reason);
  } finally {
    clearTimeout(timer);
  }
}
