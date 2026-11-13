// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Centralized env-var reader for the Scrum Master Assistant.
 *
 * Everything is optional at import time so the base sample can still boot without any
 * of the SMA config present; callers request individual sections via `getJiraConfig()` etc.
 * and each helper throws a clear error if a required var is missing.
 */

function required(name: string): string {
    const v = process.env[name];
    if (!v || v.trim() === '') {
        throw new Error(`Missing required env var: ${name}`);
    }
    return v.trim();
}

function optional(name: string, fallback = ''): string {
    const v = process.env[name];
    return v && v.trim() !== '' ? v.trim() : fallback;
}

function numeric(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}

function boundedNumeric(name: string, fallback: number, min: number, max: number): number {
    const n = Number(optional(name, String(fallback)));
    if (!Number.isFinite(n) || n < min || n > max) {
        throw new Error(`${name} must be a finite number between ${min} and ${max}`);
    }
    return n;
}

export type JiraMode = 'live' | 'mock';

export function getJiraMode(): JiraMode {
    // Default to 'mock' so a fresh clone with no `.env` runs offline against
    // src/mock/jira-mock.ts instead of throwing on missing Jira credentials.
    // README documents mock as the default; keep them aligned.
    return optional('JIRA_MODE', 'mock').toLowerCase() === 'live' ? 'live' : 'mock';
}

export interface JiraConfig {
    mode: JiraMode;
    baseUrl: string;
    email: string;
    apiToken: string;
    projectKey: string;
    boardId: number;
}

export function getJiraConfig(): JiraConfig {
    const mode = getJiraMode();
    if (mode === 'mock') {
        return {
            mode,
            baseUrl: 'mock://jira',
            email: 'mock@example.com',
            apiToken: 'mock',
            projectKey: optional('JIRA_PROJECT_KEY', 'SCRUM'),
            boardId: numeric('JIRA_BOARD_ID', 1),
        };
    }
    return {
        mode,
        baseUrl: required('JIRA_BASE_URL'),
        email: required('JIRA_EMAIL'),
        apiToken: required('JIRA_API_TOKEN'),
        projectKey: required('JIRA_PROJECT_KEY'),
        boardId: requiredBoardId(),
    };
}

function requiredBoardId(): number {
    const boardId = Number(required('JIRA_BOARD_ID'));
    if (!Number.isSafeInteger(boardId) || boardId <= 0) {
        throw new Error('JIRA_BOARD_ID must be a positive safe integer');
    }
    return boardId;
}

export interface SharePointConfig {
    siteUrl: string;
    listsPrefix: string;
}

export function getSharePointConfig(): SharePointConfig {
    return {
        siteUrl: required('SHAREPOINT_SITE_URL'),
        listsPrefix: optional('SHAREPOINT_LISTS_PREFIX', 'SMA_'),
    };
}

export interface GraphAuthConfig {
    tenantId: string;
    clientId: string;
}

export function getGraphAuthConfig(): GraphAuthConfig {
    return {
        tenantId: optional('GRAPH_TENANT_ID', 'common'),
        clientId: optional('GRAPH_CLIENT_ID', '14d82eec-204b-4c2f-b7e8-296a70dab67e'),
    };
}

export interface ScheduleConfig {
    standupCron: string;
    nightlyCron: string;
    cutoffHours: number;
    timezone: string;
    localCron: boolean;
}

export function getScheduleConfig(): ScheduleConfig {
    return {
        standupCron: optional('STANDUP_CRON', '0 30 3 * * 1-5'),
        nightlyCron: optional('NIGHTLY_CRON', '0 0 19 * * *'),
        // Node timers support delays from 1 through 2^31-1 milliseconds.
        cutoffHours: boundedNumeric('STANDUP_CUTOFF_HOURS', 4, 1 / 3600_000, 2_147_483_647 / 3600_000),
        timezone: optional('TIMEZONE', 'Asia/Kolkata'),
        localCron: optional('LOCAL_CRON', 'true').toLowerCase() === 'true',
    };
}

export interface WarnConfig {
    todoPct: number;
    sprintProgressPct: number;
}

export function getWarnConfig(): WarnConfig {
    return {
        todoPct: boundedNumeric('WARN_TODO_PCT', 0.40, 0, 1),
        sprintProgressPct: boundedNumeric('WARN_SPRINT_PROGRESS_PCT', 0.50, 0, 1),
    };
}

export function getInternalTriggerToken(): string {
    return optional('INTERNAL_TRIGGER_TOKEN', '');
}
