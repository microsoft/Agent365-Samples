// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Timezone helpers shared by cards, the action router, and scheduled flows.
// All user-facing dates render in BRIEF_DISPLAY_TZ so a card, the daily brief,
// and a reminder never disagree about which day a task is due.

export const DISPLAY_TZ = process.env.BRIEF_DISPLAY_TZ?.trim() || 'Asia/Kolkata';

/** Date-only deadlines (including legacy UTC-midnight values) mean a local due day. */
export function normalizeDueDate(value: string): string {
  const civil = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.0+)?Z)?$/.exec(value);
  if (civil) {
    const [, y, m, d] = civil;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    if (date.toISOString().slice(0, 10) !== `${y}-${m}-${d}`) throw new Error('Invalid due date');
    return zonedWallTimeToUtc(Number(y), Number(m), Number(d), 17, 0, DISPLAY_TZ).toISOString();
  }
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('Due dates must be YYYY-MM-DD or an ISO timestamp with a timezone');
  }
  return new Date(value).toISOString();
}

/** Offset of `timeZone` from UTC, in minutes, at the given instant. */
export function zoneOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/**
 * Convert a wall-clock time in `timeZone` to the matching UTC instant, using
 * the offset in effect on that date (handles daylight-saving zones).
 */
export function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const firstOffset = zoneOffsetMinutes(timeZone, new Date(guess));
  let utcMs = guess - firstOffset * 60000;
  const secondOffset = zoneOffsetMinutes(timeZone, new Date(utcMs));
  if (secondOffset !== firstOffset) utcMs = guess - secondOffset * 60000;
  return new Date(utcMs);
}

/** Civil Y/M/D of `at` in `timeZone`. */
export function civilDateInZone(at: Date, timeZone: string): { year: number; month: number; day: number } {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  const [year, month, day] = ymd.split('-').map(Number);
  return { year, month, day };
}

/** Format an ISO date for card copy in the configured display timezone. */
export function formatDisplayDate(
  iso: string,
  options: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { ...options, timeZone: DISPLAY_TZ });
}
