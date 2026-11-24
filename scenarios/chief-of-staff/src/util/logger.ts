// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Level-based logger for the CoS agent. Every module should prefer this over
// raw console.* so verbosity can be controlled centrally via LOG_LEVEL.
//
//   LOG_LEVEL env values (case-insensitive): error | warn | info | debug | trace
//   Default: info
//
// Usage:
//   import { log } from '../util/logger';
//   log.info('scheduler', 'firing followup');
//   log.debug('meetingWatcher', 'event rejected', { subject, reason: 'not organized by leader' });

const LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
type Level = (typeof LEVELS)[number];

function currentLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return (LEVELS as readonly string[]).includes(raw) ? (raw as Level) : 'info';
}

function shouldLog(level: Level): boolean {
  return LEVELS.indexOf(level) <= LEVELS.indexOf(currentLevel());
}

function stamp(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function fmt(scope: string, level: Level, msg: string): string {
  const tag =
    level === 'debug' ? 'DEBUG ' : level === 'trace' ? 'TRACE ' : '';
  return `${stamp()} [${scope}] ${tag}${redactLogText(msg)}`;
}

/** Provider errors can echo request URLs, ids, and content. Log metadata only. */
export function errorSummary(error: unknown): { status?: number; code?: string; name: string } {
  const e = error as { name?: unknown; code?: unknown; response?: { status?: unknown; data?: { error?: { code?: unknown } } } } | null;
  const status = e?.response?.status;
  const code = e?.response?.data?.error?.code ?? e?.code;
  return {
    ...(typeof status === 'number' ? { status } : {}),
    ...(typeof code === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]{0,60}$/.test(code) ? { code } : {}),
    name: typeof e?.name === 'string' && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : 'OperationError',
  };
}

export function providerError(error: unknown): string {
  // Literal strings here are repository validation messages, not provider bodies.
  return typeof error === 'string' ? redactLogText(error) : JSON.stringify(errorSummary(error));
}

export function redactLogText(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (s) => `${s.slice(0, 8)}…`)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[address]');
}

/** Redact obvious secrets from a value before printing. */
function safe(meta: unknown): unknown {
  if (!meta) return '';
  try {
    const json = JSON.stringify(meta, (k, v) => {
      if (['body', 'stack', 'request', 'response', 'config'].includes(k)) return '[omitted]';
      if (v instanceof Error || (k === 'error' && v != null)) return errorSummary(v);
      if (typeof k === 'string' && /token|secret|password|api[-_]?key|authorization/i.test(k)) {
        return typeof v === 'string' && v.length > 8 ? `${v.slice(0, 4)}…redacted` : '<redacted>';
      }
      return typeof v === 'string' ? redactLogText(v) : v;
    });
    // Trim very large payloads so a debug log doesn't scroll a terminal into orbit.
    return json.length > 4000 ? json.slice(0, 4000) + '…[truncated]' : json;
  } catch {
    return '[unserializable metadata]';
  }
}

export const log = {
  error(scope: string, msg: string, meta?: unknown) {
    if (shouldLog('error'))
      console.error(fmt(scope, 'error', msg), meta !== undefined ? safe(meta) : '');
  },
  warn(scope: string, msg: string, meta?: unknown) {
    if (shouldLog('warn'))
      console.warn(fmt(scope, 'warn', msg), meta !== undefined ? safe(meta) : '');
  },
  info(scope: string, msg: string, meta?: unknown) {
    if (shouldLog('info'))
      console.log(fmt(scope, 'info', msg), meta !== undefined ? safe(meta) : '');
  },
  debug(scope: string, msg: string, meta?: unknown) {
    if (shouldLog('debug'))
      console.log(fmt(scope, 'debug', msg), meta !== undefined ? safe(meta) : '');
  },
  trace(scope: string, msg: string, meta?: unknown) {
    if (shouldLog('trace'))
      console.log(fmt(scope, 'trace', msg), meta !== undefined ? safe(meta) : '');
  },
  level: currentLevel,
};
