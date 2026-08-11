// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Brief handler — DETERMINISTIC.
//
// Prior version relied on gpt-4o to filter Planner tasks + the leader's
// calendar and call send_brief_card. That path was flaky: sometimes the
// LLM returned all-empty arrays, sometimes it mislabeled event times, and
// occasionally it leaked "Truncated_ITERATION" sentinels into the card
// after hitting max-iteration.
//
// This version does all the work in TypeScript:
//   1. GET /planner/plans/{plan}/tasks           (app-only Graph)
//   2. GET /users/{leader}/calendarView          (app-only Graph)
//   3. Split tasks into PRIORITIES / WATCH by dueDateTime + title prefix.
//   4. Keep only FUTURE calendar events (start > now), sorted by start.
//   5. Format each row in server-local TZ, then build the Adaptive Card
//      in code and DM the leader via sendCardProactively.

import axios from 'axios';
import { CloudAdapter, TurnContext, TurnState } from '@microsoft/agents-hosting';
import type { Client } from '../client';
import { acquireAppOnlyGraphToken } from '../graph/graphAppToken';
import { buildBriefAdaptiveCard, BriefCardArgs } from '../cards/briefTool';
import { getBotAppId, sendCardProactively } from '../cards/proactiveSend';
import { hasConversationRef } from '../state/conversationRefs';
import { getPlannerPlanId } from '../graph/plannerConfig';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface BriefPayload {
  scope?: 'daily' | 'weekly';
}

interface PlannerTask {
  id: string;
  title: string;
  percentComplete: number;
  dueDateTime?: string | null;
  /** Planner priority: 1=Urgent, 3=Important, 5=Medium (default), 9=Low. */
  priority?: number | null;
  /** Map of AAD Object ID → assignment record. */
  assignments?: Record<string, unknown>;
}

interface CalEvent {
  subject: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
}

async function fetchPlanTasks(token: string, planId: string): Promise<PlannerTask[]> {
  const res = await axios.get(`${GRAPH_BASE}/planner/plans/${planId}/tasks`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (res.data?.value ?? []) as PlannerTask[];
}

async function fetchLeaderCalendar(
  token: string,
  leaderUpn: string,
  horizonHours: number
): Promise<CalEvent[]> {
  const now = new Date();
  const end = new Date(now.getTime() + horizonHours * 60 * 60 * 1000);
  const url =
    `${GRAPH_BASE}/users/${encodeURIComponent(leaderUpn)}/calendarView` +
    `?startDateTime=${now.toISOString()}&endDateTime=${end.toISOString()}` +
    `&$select=subject,start,end&$orderby=start/dateTime&$top=25`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' },
  });
  return (res.data?.value ?? []) as CalEvent[];
}

// Demo tenant runs in UTC, but the leader is in India — always render
// times in IST so cards read naturally.
const DISPLAY_TZ = process.env.BRIEF_DISPLAY_TZ?.trim() || 'Asia/Kolkata';

/** ISO "YYYY-MM-DD" of a given moment as seen in DISPLAY_TZ. */
function isoDateInTz(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const day = parts.find((p) => p.type === 'day')!.value;
  return `${y}-${m}-${day}`;
}

/** "Wed 15 Jul" in DISPLAY_TZ. */
function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: DISPLAY_TZ,
  });
}

/** "Tue 3:00 PM IST" in DISPLAY_TZ. */
function shortDateTime(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: DISPLAY_TZ });
  const time = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: DISPLAY_TZ,
  });
  const tzAbbr = DISPLAY_TZ === 'Asia/Kolkata' ? 'IST' : DISPLAY_TZ;
  return `${day} ${time} ${tzAbbr}`;
}

function truncate(s: string, max = 90): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Deep-link into the web Planner "My tasks" page for a specific task. */
function plannerTaskUrl(taskId: string): string {
  const tenantId = (process.env.GRAPH_TENANT_ID || process.env.M365_TENANT_ID || '').trim();
  const idPart = encodeURIComponent(taskId);
  return tenantId
    ? `https://tasks.office.com/${encodeURIComponent(tenantId)}/Home/Task/${idPart}`
    : `https://tasks.office.com/Home/Task/${idPart}`;
}

/** Process-lifetime cache for aad → displayName lookups (cheap Graph calls). */
const briefNameCache = new Map<string, string>();

async function resolveDisplayName(token: string, aad: string): Promise<string> {
  const cached = briefNameCache.get(aad);
  if (cached) return cached;
  try {
    const res = await axios.get(
      `${GRAPH_BASE}/users/${encodeURIComponent(aad)}?$select=displayName`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const name = ((res.data?.displayName ?? '') as string).trim();
    const fallback = aad.slice(0, 8);
    const value = name || fallback;
    briefNameCache.set(aad, value);
    return value;
  } catch (err) {
    console.warn(`[brief] resolveDisplayName failed for aad=${aad}:`, (err as Error)?.message);
    const fallback = aad.slice(0, 8);
    briefNameCache.set(aad, fallback);
    return fallback;
  }
}

/**
 * Map Planner's numeric priority to a stable P-band.
 *   1-2  → P0 (Urgent)
 *   3-4  → P1 (Important)
 *   5-8  → P2 (Medium — Planner default is 5)
 *   9-10 → P3 (Low)
 * Missing / weird values default to P2.
 */
function priorityBand(p?: number | null): 0 | 1 | 2 | 3 {
  const n = typeof p === 'number' ? p : 5;
  if (n <= 2) return 0;
  if (n <= 4) return 1;
  if (n <= 8) return 2;
  return 3;
}

/**
 * FIX (Bug 6): compute an EFFECTIVE priority band that combines Planner's
 * static field with runtime signals (days-until-due, percent complete). The
 * static band alone was misleading — a task due tomorrow at 0% shouldn't
 * stay "P2" just because nobody set Planner priority explicitly.
 *
 * Rules (dynamic band):
 *   overdue                                        → P0
 *   due today                                      → P0
 *   due tomorrow AND < 50% complete                → P1
 *   due within 3 days AND < 25% complete           → P1
 *   otherwise                                      → P2
 *
 * Effective = min(staticBand, dynamicBand) so we NEVER downgrade an
 * explicitly-urgent Planner task.
 */
function effectiveBand(t: PlannerTask, todayIso: string): 0 | 1 | 2 | 3 {
  const staticBand = priorityBand(t.priority);
  if (!t.dueDateTime) return staticBand;

  const dueIso = isoDateInTz(new Date(t.dueDateTime));
  const daysUntil = Math.round(
    (new Date(dueIso).getTime() - new Date(todayIso).getTime()) / (24 * 60 * 60 * 1000)
  );
  const pct = t.percentComplete ?? 0;

  let dyn: 0 | 1 | 2 | 3 = 2;
  if (daysUntil < 0) dyn = 0;
  else if (daysUntil === 0) dyn = 0;
  else if (daysUntil === 1 && pct < 50) dyn = 1;
  else if (daysUntil <= 3 && pct < 25) dyn = 1;

  return (Math.min(staticBand, dyn) as 0 | 1 | 2 | 3);
}

export async function runBrief(
  payload: BriefPayload,
  ctx: TurnContext,
  _state: TurnState,
  client: Client
): Promise<void> {
  const scope = payload.scope ?? 'daily';
  const horizonHours = scope === 'weekly' ? 24 * 7 : 24;
  console.log(`[brief] Trigger received. scope=${scope}`);

  const planId = await getPlannerPlanId();
  const leaderUpn = process.env.LEADER_UPN?.trim();
  if (!planId || !leaderUpn) {
    console.warn('[brief] PLANNER_PLAN_ID (or team-auto-resolve) or LEADER_UPN missing — skipping.');
    return;
  }

  const leaderAad =
    process.env.LEADER_AAD_ID?.trim() || (await client.resolveUpnToAad(leaderUpn));
  if (!leaderAad) {
    console.warn(`[brief] Could not resolve LEADER_UPN=${leaderUpn} to an AAD — skipping.`);
    return;
  }

  const now = new Date();
  // Anchor day boundaries in the display TZ (IST), not UTC — otherwise a
  // task due "tomorrow IST" would land in yesterday's or today's brief
  // depending on what time it's fired.
  const todayIso = isoDateInTz(now);
  const cutoffIso = isoDateInTz(new Date(now.getTime() + horizonHours * 60 * 60 * 1000));

  // ── Fetch ────────────────────────────────────────────────────────────────
  let tasks: PlannerTask[] = [];
  let events: CalEvent[] = [];
  let graphToken = '';
  try {
    graphToken = await acquireAppOnlyGraphToken();
    [tasks, events] = await Promise.all([
      fetchPlanTasks(graphToken, planId),
      fetchLeaderCalendar(graphToken, leaderUpn, horizonHours),
    ]);
  } catch (err) {
    console.error('[brief] fetch failed:', (err as Error)?.message ?? err);
    return;
  }

  // ── Filter tasks ─────────────────────────────────────────────────────────
  // Split into two buckets:
  //   PRIORITIES — open task in the horizon window, grouped by P-band.
  //   RISKS      — overdue (past-due) OR title [BLOCKER]/[RISK] OR P0 with no
  //                due date (urgent floaters).
  //
  // Rows carry STRUCTURED metadata (band / title / owner / meta / url) so
  // the card renderer can lay them out as proper columns instead of a
  // Markdown blob.
  interface Row {
    band: 0 | 1 | 2 | 3;
    dueIso: string;
    title: string;
    taskId: string;
    taskUrl: string;
    ownerName: string | null;
    meta: string;
  }
  const priorityRows: Row[] = [];
  const riskRows: Row[] = [];

  for (const t of tasks) {
    if (!t) continue;
    if ((t.percentComplete ?? 0) >= 100) continue;
    const rawTitle = t.title ?? '';
    if (rawTitle.startsWith('[DECISION]')) continue;

    const band = effectiveBand(t, todayIso);
    const isBlockerLike =
      rawTitle.startsWith('[BLOCKER]') || rawTitle.startsWith('[RISK]');
    const dueIso = t.dueDateTime ? isoDateInTz(new Date(t.dueDateTime)) : '';
    const isOverdue = !!dueIso && dueIso < todayIso;
    const inWindow = !!dueIso && dueIso >= todayIso && dueIso <= cutoffIso;

    // Resolve first assignee → display name (best-effort, cached).
    const assigneeAads = Object.keys(t.assignments ?? {});
    let ownerName: string | null = null;
    if (assigneeAads.length > 0) {
      ownerName = await resolveDisplayName(graphToken, assigneeAads[0]);
    }

    const displayTitle = truncate(rawTitle, 80);
    const base: Omit<Row, 'meta'> = {
      band,
      dueIso,
      title: displayTitle,
      taskId: t.id,
      taskUrl: plannerTaskUrl(t.id),
      ownerName,
    };

    if (isBlockerLike) {
      riskRows.push({ ...base, meta: dueIso ? `due ${shortDate(t.dueDateTime!)}` : '' });
    } else if (isOverdue) {
      const daysLate = Math.max(
        1,
        Math.round(
          (new Date(todayIso).getTime() - new Date(dueIso).getTime()) /
            (24 * 60 * 60 * 1000)
        )
      );
      riskRows.push({ ...base, meta: `${daysLate}d overdue` });
    } else if (inWindow) {
      priorityRows.push({ ...base, meta: `due ${shortDate(t.dueDateTime!)}` });
    } else if (band === 0 && !dueIso) {
      // Urgent floater without a due date — call it out as a risk.
      riskRows.push({ ...base, meta: 'no due date' });
    }
  }

  // Sort: band asc (P0 first), then due-date asc.
  const sortRows = (a: Row, b: Row) =>
    a.band - b.band || (a.dueIso || '9999').localeCompare(b.dueIso || '9999');
  priorityRows.sort(sortRows);
  riskRows.sort(sortRows);

  // ── Filter calendar ──────────────────────────────────────────────────────
  const nowMs = now.getTime();
  interface CalRow {
    when: string;
    subject: string;
  }
  const calendarRows: CalRow[] = [];
  for (const ev of events) {
    const startIso = ev.start?.dateTime;
    if (!startIso) continue;
    // Graph returns naive-format ISO in the requested TZ (we asked for UTC).
    // Force a Z so the Date parser interprets it as UTC.
    const startDate = new Date(startIso.endsWith('Z') ? startIso : `${startIso}Z`);
    if (Number.isNaN(startDate.getTime())) continue;
    if (startDate.getTime() <= nowMs) continue; // skip past/ongoing
    calendarRows.push({
      when: shortDateTime(startDate.toISOString()),
      subject: truncate(ev.subject ?? '(no subject)', 90),
    });
  }

  const cardArgs: BriefCardArgs = {
    leaderAadObjectId: leaderAad,
    headline: null,
    // Legacy string arrays — kept in sync for logging + LLM-path back-compat.
    priorities: priorityRows.map(
      (r) => `**P${r.band}** — ${r.title}${r.ownerName ? ` — @${r.ownerName}` : ''}${r.meta ? ` — ${r.meta}` : ''}`
    ),
    watchList: riskRows.map(
      (r) => `**P${r.band}** — ${r.title}${r.ownerName ? ` — @${r.ownerName}` : ''}${r.meta ? ` — ${r.meta}` : ''}`
    ),
    calendar: calendarRows.map((c) => `${c.when} — ${c.subject}`),
    // Preferred structured items — what the new card renderer actually uses.
    priorityItems: priorityRows.map((r) => ({
      band: r.band,
      title: r.title,
      taskId: r.taskId,
      taskUrl: r.taskUrl,
      ownerName: r.ownerName,
      meta: r.meta,
    })),
    watchItems: riskRows.map((r) => ({
      band: r.band,
      title: r.title,
      taskId: r.taskId,
      taskUrl: r.taskUrl,
      ownerName: r.ownerName,
      meta: r.meta,
    })),
    calendarItems: calendarRows,
  };

  console.log(
    `[brief] counts priorities=${cardArgs.priorities.length} watch=${cardArgs.watchList.length} calendar=${cardArgs.calendar.length}`
  );

  // Don't DM an all-empty card — wait for the next tick.
  if (
    cardArgs.priorities.length === 0 &&
    cardArgs.watchList.length === 0 &&
    cardArgs.calendar.length === 0
  ) {
    console.log('[brief] Skipping DM — nothing to report.');
    return;
  }

  const adapter = (ctx as any).adapter as CloudAdapter | undefined;
  if (!adapter || !hasConversationRef(leaderAad)) {
    console.warn(
      `[brief] No ConversationReference for leader aad=${leaderAad} — leader must DM the agent once.`
    );
    return;
  }

  const card = buildBriefAdaptiveCard(cardArgs);
  try {
    await sendCardProactively({
      adapter,
      botAppId: getBotAppId(),
      recipientAad: leaderAad,
      card,
    });
    console.log('[brief] ✔ DM sent to leader.');
  } catch (err) {
    console.error('[brief] send failed:', (err as Error)?.message ?? err);
  }
}
