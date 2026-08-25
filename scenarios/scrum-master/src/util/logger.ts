// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Level-based logger for the scrum-master scenario. Every module should prefer
// this over raw `console.*` so verbosity can be controlled centrally through
// the `LOG_LEVEL` env var and secrets never leak into logs.
//
//   LOG_LEVEL env values (case-insensitive): error | warn | info | debug | trace
//   Default: info
//
// Usage:
//   import { log } from '../util/logger';
//   log.info('standup', 'DMs sent', { count: 4 });
//   log.debug('reconcile', 'classifier matched', { key: 'DEMO-14', pattern: 'in review' });
//
// This file is intentionally dependency-free (uses only console.*) so it can be
// imported from anywhere without pulling in extra transitive modules at boot.

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
    // HH:MM:SS.mmm — matches the format the base sample's connector logs use.
    return new Date().toISOString().slice(11, 23);
}

function fmt(scope: string, level: Level, msg: string): string {
    const tag = level === 'debug' ? 'DEBUG ' : level === 'trace' ? 'TRACE ' : '';
    return `${stamp()} [${scope}] ${tag}${msg}`;
}

/**
 * Redact obvious secrets from a value before printing. Matches any key whose
 * name looks like a credential and clips it to a short prefix; also caps very
 * large payloads so a debug log doesn't scroll a terminal into orbit.
 */
function safe(meta: unknown): unknown {
    if (meta === undefined || meta === null) return '';
    try {
        const json = JSON.stringify(meta, (k, v) => {
            if (typeof k === 'string' && /token|secret|password|api[-_]?key|authorization/i.test(k)) {
                return typeof v === 'string' && v.length > 8 ? `${v.slice(0, 4)}…redacted` : '<redacted>';
            }
            return v;
        });
        return json.length > 4000 ? json.slice(0, 4000) + '…[truncated]' : json;
    } catch {
        return String(meta);
    }
}

export const log = {
    error(scope: string, msg: string, meta?: unknown) {
        if (shouldLog('error')) console.error(fmt(scope, 'error', msg), meta !== undefined ? safe(meta) : '');
    },
    warn(scope: string, msg: string, meta?: unknown) {
        if (shouldLog('warn')) console.warn(fmt(scope, 'warn', msg), meta !== undefined ? safe(meta) : '');
    },
    info(scope: string, msg: string, meta?: unknown) {
        if (shouldLog('info')) console.log(fmt(scope, 'info', msg), meta !== undefined ? safe(meta) : '');
    },
    debug(scope: string, msg: string, meta?: unknown) {
        if (shouldLog('debug')) console.log(fmt(scope, 'debug', msg), meta !== undefined ? safe(meta) : '');
    },
    trace(scope: string, msg: string, meta?: unknown) {
        if (shouldLog('trace')) console.log(fmt(scope, 'trace', msg), meta !== undefined ? safe(meta) : '');
    },
    level: currentLevel,
};
