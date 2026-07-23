// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Optional Jira seed script.
 *
 * Populates a *pre-existing* Jira Scrum project with sample user stories, sub-tasks,
 * and one active sprint so the live-mode demo has something to work against. Skip
 * this entirely if you're running with `JIRA_MODE=mock`.
 *
 * Prerequisites (all one-off, done via the Jira UI):
 *   1. Create a free Atlassian Cloud site: https://www.atlassian.com/software/jira/free
 *   2. Create a Scrum project (any template). Note the project key (e.g. DEMO) and
 *      board id (the number in the board URL, e.g. `.../boards/1` -> 1).
 *   3. Create a Jira API token: https://id.atlassian.com/manage-profile/security/api-tokens
 *   4. Fill JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY, JIRA_BOARD_ID
 *      in `.env` (see `.env.template`).
 *
 * Then run:
 *   npm run seed:jira
 *
 * What this creates (idempotent by issue summary):
 *   - 2 user-story issues
 *   - 5 sub-task issues linked to their parent stories
 *   - 1 sprint on the configured board, with all issues moved into it
 *   - The sprint is left in the `future` state; start it manually from the board
 *     UI once you're ready to demo (or extend this script to POST /sprint/{id}
 *     with `state: active`).
 *
 * Topology lives in `sprint.sample.json` — edit that if you want different data.
 */

import { configDotenv } from 'dotenv';
configDotenv();

import 'isomorphic-fetch';
import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';

interface Subtask {
    summary: string;
    assigneeKey: string;
    storyPoints?: number;
}

interface Story {
    type: 'story';
    summary: string;
    description?: string;
    assigneeKey: string;
    storyPoints?: number;
    labels?: string[];
    subtasks?: Subtask[];
}

interface SeedConfig {
    baseUrl: string;
    email: string;
    apiToken: string;
    projectKey: string;
    boardId: number;
}

function loadConfig(): SeedConfig {
    const need = (name: string): string => {
        const v = process.env[name];
        if (!v) throw new Error(`Missing env var: ${name}. See .env.template.`);
        return v;
    };
    const boardId = Number(need('JIRA_BOARD_ID'));
    if (!Number.isFinite(boardId)) throw new Error('JIRA_BOARD_ID must be a number.');
    return {
        baseUrl: need('JIRA_BASE_URL').replace(/\/$/, ''),
        email: need('JIRA_EMAIL'),
        apiToken: need('JIRA_API_TOKEN'),
        projectKey: need('JIRA_PROJECT_KEY'),
        boardId,
    };
}

function makeClient(cfg: SeedConfig): AxiosInstance {
    const auth = Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');
    return axios.create({
        baseURL: cfg.baseUrl,
        timeout: 20_000,
        headers: {
            Authorization: `Basic ${auth}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
    });
}

// Map assigneeKey (from sprint.sample.json) -> Jira accountId (from team.sample.json).
// We look up team.sample.json so a single edit of the personas propagates everywhere.
function loadAccountIdMap(): Record<string, string> {
    const teamPath = path.join(__dirname, 'team.sample.json');
    const raw = fs.readFileSync(teamPath, 'utf-8');
    const rows: Array<{ Title: string; JiraAccountId: string }> = JSON.parse(raw);
    // "Alice (Scrum Master)" -> "alice"
    const map: Record<string, string> = {};
    for (const r of rows) {
        const key = r.Title.split(/[\s(]/)[0].toLowerCase();
        map[key] = r.JiraAccountId;
    }
    return map;
}

async function findExistingIssueKey(
    http: AxiosInstance,
    projectKey: string,
    summary: string,
): Promise<string | null> {
    // Escape any embedded double-quote in the summary for JQL.
    const escapedSummary = summary.replace(/"/g, '\\"');
    const jql = `project = "${projectKey}" AND summary ~ "\\"${escapedSummary}\\""`;
    const res = await http.post('/rest/api/3/search/jql', {
        jql,
        fields: ['summary'],
        maxResults: 5,
    });
    const issues: any[] = res.data?.issues ?? [];
    // Exact-match filter — `~` is fuzzy.
    const hit = issues.find(i => i.fields?.summary?.trim() === summary.trim());
    return hit ? hit.key : null;
}

function adfParagraph(text: string): any {
    return {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    };
}

async function createIssue(
    http: AxiosInstance,
    projectKey: string,
    issueTypeName: 'Story' | 'Subtask',
    summary: string,
    accountId: string,
    opts: {
        description?: string;
        parentKey?: string;
        storyPoints?: number;
        labels?: string[];
    } = {},
): Promise<string> {
    const fields: Record<string, unknown> = {
        project: { key: projectKey },
        summary,
        issuetype: { name: issueTypeName },
        assignee: { accountId },
    };
    if (opts.description) fields.description = adfParagraph(opts.description);
    if (opts.parentKey) fields.parent = { key: opts.parentKey };
    if (opts.labels?.length) fields.labels = opts.labels;
    // customfield_10016 is the default "Story Points" field on Jira Cloud.
    if (opts.storyPoints != null) fields.customfield_10016 = opts.storyPoints;

    const res = await http.post('/rest/api/3/issue', { fields });
    return res.data.key as string;
}

async function ensureSprint(
    http: AxiosInstance,
    boardId: number,
    name: string,
): Promise<number> {
    const listRes = await http.get(`/rest/agile/1.0/board/${boardId}/sprint`, {
        params: { state: 'future,active' },
    });
    const existing = (listRes.data?.values ?? []).find((s: any) => s.name === name);
    if (existing) {
        console.log(`[seed:jira] sprint already exists: ${name} (id=${existing.id})`);
        return existing.id;
    }
    const create = await http.post('/rest/agile/1.0/sprint', {
        name,
        originBoardId: boardId,
        goal: 'Deliver the initial employee directory experience.',
    });
    console.log(`[seed:jira] created sprint: ${name} (id=${create.data.id})`);
    return create.data.id;
}

async function moveIssuesToSprint(
    http: AxiosInstance,
    sprintId: number,
    issueKeys: string[],
): Promise<void> {
    if (issueKeys.length === 0) return;
    // Sprint move accepts max 50 keys at a time.
    for (let i = 0; i < issueKeys.length; i += 50) {
        const chunk = issueKeys.slice(i, i + 50);
        await http.post(`/rest/agile/1.0/sprint/${sprintId}/issue`, { issues: chunk });
    }
    console.log(`[seed:jira] moved ${issueKeys.length} issue(s) into sprint ${sprintId}`);
}

async function main() {
    console.log('[seed:jira] Starting Jira sample-data seed...');
    const cfg = loadConfig();
    const http = makeClient(cfg);
    const accounts = loadAccountIdMap();

    const stories: Story[] = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'sprint.sample.json'), 'utf-8'),
    );

    const createdIssueKeys: string[] = [];

    for (const story of stories) {
        const parentAccount = accounts[story.assigneeKey];
        if (!parentAccount) {
            throw new Error(
                `assigneeKey "${story.assigneeKey}" not found in team.sample.json accountIds`,
            );
        }

        let parentKey = await findExistingIssueKey(http, cfg.projectKey, story.summary);
        if (parentKey) {
            console.log(`[seed:jira] story exists: ${parentKey} — ${story.summary}`);
        } else {
            parentKey = await createIssue(http, cfg.projectKey, 'Story', story.summary, parentAccount, {
                description: story.description,
                storyPoints: story.storyPoints,
                labels: story.labels,
            });
            console.log(`[seed:jira] created story: ${parentKey} — ${story.summary}`);
        }
        createdIssueKeys.push(parentKey);

        for (const sub of story.subtasks ?? []) {
            const subAccount = accounts[sub.assigneeKey];
            if (!subAccount) {
                throw new Error(
                    `assigneeKey "${sub.assigneeKey}" not found in team.sample.json accountIds`,
                );
            }
            const existingSub = await findExistingIssueKey(http, cfg.projectKey, sub.summary);
            if (existingSub) {
                console.log(`[seed:jira]   sub-task exists: ${existingSub} — ${sub.summary}`);
                createdIssueKeys.push(existingSub);
                continue;
            }
            const subKey = await createIssue(http, cfg.projectKey, 'Subtask', sub.summary, subAccount, {
                parentKey,
                storyPoints: sub.storyPoints,
            });
            console.log(`[seed:jira]   created sub-task: ${subKey} — ${sub.summary}`);
            createdIssueKeys.push(subKey);
        }
    }

    const sprintName = 'Sprint 1 — Sample data';
    const sprintId = await ensureSprint(http, cfg.boardId, sprintName);
    await moveIssuesToSprint(http, sprintId, createdIssueKeys);

    console.log('');
    console.log('[seed:jira] Done.');
    console.log(`  Project:   ${cfg.projectKey}`);
    console.log(`  Board:     ${cfg.boardId}`);
    console.log(`  Sprint:    ${sprintName} (id=${sprintId})`);
    console.log(`  Issues:    ${createdIssueKeys.length}`);
    console.log('');
    console.log('Next: open the board in Jira and click "Start sprint" when ready to demo.');
}

main().catch(err => {
    const detail = err?.response?.data ?? err?.message ?? err;
    console.error('[seed:jira] failed:', typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
    process.exit(1);
});
