// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// Boot-time config summary. Prints a one-shot banner covering every env var
// the agent depends on so misconfig surfaces immediately — not five minutes
// into a demo when a Graph call 401s.
//
// Called once from `src/index.ts` after `configDotenv()` and BEFORE any
// module that reads config is imported, so the output is the first useful
// line in `npm run dev`.

/**
 * Print a boxed startup banner covering config critical for the scrum-master
 * scenario. Non-fatal — never throws — so misconfig doesn't prevent boot; the
 * per-module errors that follow are more actionable anyway.
 */
export function printStartupBanner(): void {
    const line = '─'.repeat(64);
    const row = (label: string, value: string) => `  ${label.padEnd(28)} ${value}`;

    console.log('');
    console.log(`┌${line}┐`);
    console.log('  Scrum Master autopilot — Agent 365 scenario sample');
    console.log(`└${line}┘`);
    console.log(row('NODE_ENV', process.env.NODE_ENV ?? '(unset)'));
    console.log(row('LOG_LEVEL', process.env.LOG_LEVEL ?? 'info'));
    console.log(row('LOG_HTTP', process.env.LOG_HTTP ?? 'false'));
    console.log('');
    console.log('  Jira');
    console.log(row('  JIRA_MODE', process.env.JIRA_MODE ?? '(unset — defaults to mock)'));
    if ((process.env.JIRA_MODE ?? 'mock').toLowerCase() === 'live') {
        console.log(row('  JIRA_BASE_URL', mask(process.env.JIRA_BASE_URL)));
        console.log(row('  JIRA_PROJECT_KEY', process.env.JIRA_PROJECT_KEY ?? MISSING));
        console.log(row('  JIRA_BOARD_ID', process.env.JIRA_BOARD_ID ?? MISSING));
        console.log(row('  JIRA_EMAIL', mask(process.env.JIRA_EMAIL)));
        console.log(row('  JIRA_API_TOKEN', maskSecret(process.env.JIRA_API_TOKEN)));
    }
    console.log('');
    console.log('  SharePoint (Microsoft Graph, delegated)');
    console.log(row('  SHAREPOINT_SITE_URL', mask(process.env.SHAREPOINT_SITE_URL)));
    console.log(row('  SHAREPOINT_LISTS_PREFIX', process.env.SHAREPOINT_LISTS_PREFIX ?? 'SMA_'));
    console.log(row('  GRAPH_TENANT_ID', process.env.GRAPH_TENANT_ID ?? 'common'));
    console.log(row('  GRAPH_CLIENT_ID', mask(process.env.GRAPH_CLIENT_ID)));
    console.log('');
    console.log('  Azure OpenAI / OpenAI');
    console.log(row('  AZURE_OPENAI_ENDPOINT', mask(process.env.AZURE_OPENAI_ENDPOINT)));
    console.log(row('  AZURE_OPENAI_DEPLOYMENT', process.env.AZURE_OPENAI_DEPLOYMENT ?? MISSING));
    console.log(row('  AZURE_OPENAI_API_KEY', maskSecret(process.env.AZURE_OPENAI_API_KEY)));
    console.log(row('  OPENAI_API_KEY', maskSecret(process.env.OPENAI_API_KEY)));
    console.log('');
    console.log('  Scheduling');
    console.log(row('  LOCAL_CRON', process.env.LOCAL_CRON ?? 'true'));
    console.log(row('  STANDUP_CRON', process.env.STANDUP_CRON ?? '(default)'));
    console.log(row('  NIGHTLY_CRON', process.env.NIGHTLY_CRON ?? '(default)'));
    console.log(row('  TIMEZONE', process.env.TIMEZONE ?? 'Asia/Kolkata'));
    console.log('');
    console.log('  Internal endpoints');
    console.log(row('  INTERNAL_TRIGGER_TOKEN', maskSecret(process.env.INTERNAL_TRIGGER_TOKEN)));
    console.log('');
}

const MISSING = '(MISSING)';

/** Mask a config-shaped value so we don't leak endpoints or emails into logs. */
function mask(v: string | undefined): string {
    if (!v) return MISSING;
    if (v.length <= 12) return v;
    return `${v.slice(0, 8)}…${v.slice(-6)}`;
}

/** Aggressively mask a secret — 4 chars max, then ellipsis. */
function maskSecret(v: string | undefined): string {
    if (!v) return MISSING;
    return `${v.slice(0, 4)}…redacted (${v.length} chars)`;
}
