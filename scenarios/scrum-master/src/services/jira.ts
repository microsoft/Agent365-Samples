// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Thin Jira REST v3 + Agile 1.0 wrapper for the Scrum Master Assistant.
 *
 * Only the operations the POC needs are exposed. When `JIRA_MODE=mock` a fixed
 * seeded sprint is returned instead of calling Atlassian, so demos work offline.
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { getJiraConfig, JiraConfig } from '../config';
import { mockJira } from '../mock/jira-mock';
import { attachHttpLogging } from '../util/httpLogger';

export interface JiraUser {
    accountId: string;
    displayName: string;
    emailAddress?: string;
}

export interface JiraIssue {
    id: string;
    key: string;
    summary: string;
    status: string;
    statusCategory: 'new' | 'indeterminate' | 'done' | string;
    assignee: JiraUser | null;
    storyPoints: number | null;
    url: string;
    sprintId: number | null;
    /** ISO date (yyyy-mm-dd) or null. Populated from Jira `duedate` field. */
    dueDate: string | null;
    /** Parent story key when this issue is a sub-task, else null. */
    parentKey: string | null;
    /** Human name of the issue type (Story / Task / Bug / Subtask). */
    issueType: string;
}

export interface JiraTransition {
    id: string;
    name: string;
    toStatus: string;
}

export interface JiraSprint {
    id: number;
    name: string;
    state: 'future' | 'active' | 'closed';
    startDate: string | null;
    endDate: string | null;
    goal: string | null;
}

export interface JiraComment {
    id: string;
    author: string;
    createdIso: string;
    body: string;   // plain-text (ADF stripped)
}

export interface JiraClient {
    getSprints?(state: 'active' | 'closed' | 'future'): Promise<JiraSprint[]>;
    getActiveSprint(): Promise<JiraSprint | null>;
    getSprint(sprintId: number): Promise<JiraSprint>;
    searchSprintIssues(sprintId: number): Promise<JiraIssue[]>;
    /**
     * Fetch every sub-task whose parent is one of the given issue keys.
     * Needed because Jira Cloud team-managed projects do NOT return sub-tasks
     * from `/rest/agile/1.0/sprint/{id}/issue` — sub-tasks inherit sprint
     * membership from their parent and are only reachable via JQL.
     */
    getSprintSubtasks(sprintId: number, parentKeys: string[]): Promise<JiraIssue[]>;
    getIssue(issueKey: string): Promise<JiraIssue>;
    /** Fetch the N most-recent comments (default 5), newest first. */
    getComments(issueKey: string, limit?: number): Promise<JiraComment[]>;
    getTransitions(issueKey: string): Promise<JiraTransition[]>;
    transitionIssue(issueKey: string, transitionId: string, comment?: string): Promise<void>;
    addComment(issueKey: string, body: string): Promise<void>;
}

function assertProjectIssue(issueKey: string, projectKey: string): string {
    const key = issueKey.trim().toUpperCase();
    const project = projectKey.trim().toUpperCase();
    const match = key.match(/^([A-Z][A-Z0-9]*)-(\d+)$/);
    if (!match || match[1] !== project) {
        throw new Error('Issue reads are restricted to the configured Jira project.');
    }
    return key;
}

function isProjectIssue(issueKey: unknown, projectKey: string): boolean {
    if (typeof issueKey !== 'string') return false;
    try {
        assertProjectIssue(issueKey, projectKey);
        return true;
    } catch {
        return false;
    }
}

function projectJql(projectKey: string): string {
    const key = assertProjectIssue(`${projectKey.trim()}-1`, projectKey);
    return `project = "${key.split('-')[0]}"`;
}

export class LiveJiraClient implements JiraClient {
    private readonly http: AxiosInstance;

    constructor(private readonly cfg: JiraConfig) {
        const auth = Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');
        this.http = axios.create({
            baseURL: cfg.baseUrl,
            timeout: 15000,
            headers: {
                Authorization: `Basic ${auth}`,
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
        });
        attachHttpLogging(this.http);
    }

    async getSprints(state: 'active' | 'closed' | 'future'): Promise<JiraSprint[]> {
        const sprints: JiraSprint[] = [];
        let startAt = 0;
        while (true) {
            const res = await this.http.get(`/rest/agile/1.0/board/${this.cfg.boardId}/sprint`, {
                params: { state, startAt, maxResults: 100 },
            }).catch(this.wrap(`getSprints(${state})`));
            const values: any[] = res.data?.values ?? [];
            sprints.push(...values.map(mapSprint));
            startAt += values.length;
            if (!values.length || res.data.isLast === true ||
                (typeof res.data.total === 'number' && startAt >= res.data.total)) break;
        }
        return sprints;
    }

    async getActiveSprint(): Promise<JiraSprint | null> {
        const res = await this.http.get(`/rest/agile/1.0/board/${this.cfg.boardId}/sprint`, {
            params: { state: 'active' },
        }).catch(this.wrap('getActiveSprint'));
        const values: any[] = res.data?.values ?? [];
        if (values.length === 0) return null;
        return mapSprint(values[0]);
    }

    async getSprint(sprintId: number): Promise<JiraSprint> {
        const res = await this.http.get(`/rest/agile/1.0/sprint/${sprintId}`)
            .catch(this.wrap(`getSprint(${sprintId})`));
        return mapSprint(res.data);
    }

    async searchSprintIssues(sprintId: number): Promise<JiraIssue[]> {
        const issues: JiraIssue[] = [];
        let startAt = 0;
        while (true) {
            const res = await this.http.get(`/rest/agile/1.0/sprint/${sprintId}/issue`, {
                params: {
                    jql: projectJql(this.cfg.projectKey),
                    fields: 'summary,status,assignee,customfield_10016,duedate,parent,issuetype',
                    startAt, maxResults: 100,
                },
            }).catch(this.wrap(`searchSprintIssues(${sprintId})`));
            const page: any[] = res.data?.issues ?? [];
            issues.push(...page
                .filter(i => isProjectIssue(i.key, this.cfg.projectKey)
                    && (!i.fields?.parent || isProjectIssue(i.fields.parent.key, this.cfg.projectKey)))
                .map(i => mapIssue(i, this.cfg.baseUrl, sprintId)));
            startAt += page.length;
            if (!page.length || res.data.isLast === true ||
                (typeof res.data.total === 'number' && startAt >= res.data.total)) break;
        }
        return Array.from(new Map(issues.map(i => [i.key, i])).values());
    }

    async getSprintSubtasks(sprintId: number, parentKeys: string[]): Promise<JiraIssue[]> {
        if (parentKeys.length === 0) return [];
        parentKeys = parentKeys.map(key => assertProjectIssue(key, this.cfg.projectKey));
        const jql = `${projectJql(this.cfg.projectKey)} AND parent in (${parentKeys.map(k => `"${k}"`).join(', ')})`;
        const issues: JiraIssue[] = [];
        let nextPageToken: string | undefined;
        const seenTokens = new Set<string>();
        do {
            const res = await this.http.post('/rest/api/3/search/jql', {
                jql,
                fields: ['summary', 'status', 'assignee', 'customfield_10016', 'duedate', 'parent', 'issuetype'],
                maxResults: 100,
                ...(nextPageToken ? { nextPageToken } : {}),
            }).catch(this.wrap(`getSprintSubtasks(${parentKeys.length} parents)`));
            issues.push(...(res.data?.issues ?? [])
                .filter((i: any) => isProjectIssue(i.key, this.cfg.projectKey)
                    && isProjectIssue(i.fields?.parent?.key, this.cfg.projectKey)
                    && parentKeys.includes(i.fields.parent.key.trim().toUpperCase()))
                .map((i: any) => mapIssue(i, this.cfg.baseUrl, sprintId)));
            nextPageToken = res.data?.isLast === true ? undefined : res.data?.nextPageToken;
            if (nextPageToken && seenTokens.has(nextPageToken)) throw new Error('Jira returned a repeated search page token');
            if (nextPageToken) seenTokens.add(nextPageToken);
        } while (nextPageToken);
        return Array.from(new Map(issues.map(i => [i.key, i])).values());
    }

    async getIssue(issueKey: string): Promise<JiraIssue> {
        issueKey = assertProjectIssue(issueKey, this.cfg.projectKey);
        const res = await this.http.get(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
            params: { fields: 'summary,status,assignee,customfield_10016,sprint' },
        }).catch(this.wrap(`getIssue(${issueKey})`));
        assertProjectIssue(res.data?.key ?? '', this.cfg.projectKey);
        return mapIssue(res.data, this.cfg.baseUrl, null);
    }

    async getTransitions(issueKey: string): Promise<JiraTransition[]> {
        const res = await this.http.get(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`)
            .catch(this.wrap(`getTransitions(${issueKey})`));
        return (res.data?.transitions ?? []).map((t: any) => ({
            id: t.id,
            name: t.name,
            toStatus: t.to?.name ?? '',
        }));
    }

    async transitionIssue(issueKey: string, transitionId: string, comment?: string): Promise<void> {
        // Note: Jira Cloud silently drops `update.comment` embedded in the transitions payload
        // on some tenants (transition still applies, comment is lost). Do them as two calls to
        // guarantee both land.
        await this.http.post(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
            transition: { id: transitionId },
        }).catch(this.wrap(`transitionIssue(${issueKey} -> ${transitionId})`));
        if (comment) {
            await this.addComment(issueKey, comment).catch(err => {
                console.warn(`[Jira] transition applied but comment failed on ${issueKey}: ${(err as Error).message}`);
            });
        }
    }

    async addComment(issueKey: string, body: string): Promise<void> {
        await this.http.post(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
            body: adfText(body),
        }).catch(this.wrap(`addComment(${issueKey})`));
    }

    async getComments(issueKey: string, limit = 5): Promise<JiraComment[]> {
        issueKey = assertProjectIssue(issueKey, this.cfg.projectKey);
        // Jira can resolve an old same-project key to an issue moved elsewhere.
        // Comments carry no issue key, so verify the resolved issue before reading them.
        await this.getIssue(issueKey);
        // Jira Cloud returns comments oldest-first by default — request desc order so
        // "latest N" is just the first N entries after the response.
        const res = await this.http.get(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
            params: { orderBy: '-created', maxResults: limit },
        }).catch(this.wrap(`getComments(${issueKey})`));
        const comments: any[] = res.data?.comments ?? [];
        return comments.slice(0, limit).map((c: any) => ({
            id: String(c.id),
            author: c.author?.displayName ?? '(unknown)',
            createdIso: c.created ?? '',
            body: adfToPlainText(c.body),
        }));
    }

    private wrap(op: string) {
        return (err: unknown): never => {
            const ax = err as AxiosError<any>;
            const status = ax.response?.status;
            const detail = ax.response?.data ? JSON.stringify(ax.response.data) : ax.message;
            throw new Error(`Jira ${op} failed (${status ?? 'network'}): ${detail}`);
        };
    }
}

function mapSprint(raw: any): JiraSprint {
    return {
        id: raw.id,
        name: raw.name,
        state: raw.state,
        startDate: raw.startDate ?? null,
        endDate: raw.endDate ?? null,
        goal: raw.goal ?? null,
    };
}

function mapIssue(raw: any, baseUrl: string, sprintId: number | null): JiraIssue {
    const f = raw.fields ?? {};
    const assignee = f.assignee
        ? {
            accountId: f.assignee.accountId,
            displayName: f.assignee.displayName,
            emailAddress: f.assignee.emailAddress,
        }
        : null;
    return {
        id: raw.id,
        key: raw.key,
        summary: f.summary ?? '',
        status: f.status?.name ?? 'Unknown',
        statusCategory: f.status?.statusCategory?.key ?? 'new',
        assignee,
        storyPoints: typeof f.customfield_10016 === 'number' ? f.customfield_10016 : null,
        url: `${baseUrl.replace(/\/$/, '')}/browse/${raw.key}`,
        sprintId,
        dueDate: (typeof f.duedate === 'string' && f.duedate.length > 0) ? f.duedate : null,
        parentKey: f.parent?.key ?? null,
        issueType: f.issuetype?.name ?? 'Unknown',
    };
}

// Atlassian Document Format wrapper for plain-text comments.
// Splits on newlines so each line becomes its own paragraph — this makes
// multi-line standup / blocker comments render correctly in the Jira UI.
function adfText(text: string) {
    const lines = text.split(/\r?\n/);
    const paragraphs = lines.map(line =>
        line.length === 0
            ? { type: 'paragraph' }
            : { type: 'paragraph', content: [{ type: 'text', text: line }] },
    );
    return {
        type: 'doc',
        version: 1,
        content: paragraphs,
    };
}

/**
 * Reverse of adfText — walks an ADF document tree and returns the plain-text
 * concatenation, newlines between block-level nodes. Tolerant of unknown node
 * shapes (returns "" when the input is null/undefined/non-object).
 */
function adfToPlainText(node: any): string {
    if (!node) return '';
    if (typeof node === 'string') return node;
    // Leaf text node.
    if (node.type === 'text' && typeof node.text === 'string') return node.text;
    if (node.type === 'hardBreak') return '\n';
    // Block-level container — recurse into content array.
    const parts: string[] = [];
    if (Array.isArray(node.content)) {
        for (const child of node.content) parts.push(adfToPlainText(child));
    }
    const joined = parts.join('');
    // Paragraphs / list items / headings get a trailing newline so structure survives.
    if (['paragraph', 'listItem', 'heading', 'blockquote', 'codeBlock', 'bulletList', 'orderedList'].includes(node.type)) {
        return joined + '\n';
    }
    return joined;
}

let cached: JiraClient | null = null;

export function getJiraClient(): JiraClient {
    if (cached) return cached;
    const cfg = getJiraConfig();
    if (cfg.mode === 'mock') {
        const mock = mockJira();
        const getIssue = mock.getIssue.bind(mock);
        const getComments = mock.getComments.bind(mock);
        const searchSprintIssues = mock.searchSprintIssues.bind(mock);
        const getSprintSubtasks = mock.getSprintSubtasks.bind(mock);
        // The seeded board is SCRUM regardless of a leftover live project setting.
        mock.getIssue = async key => {
            const issue = await getIssue(assertProjectIssue(key, 'SCRUM'));
            assertProjectIssue(issue.key, 'SCRUM');
            return issue;
        };
        mock.getComments = async (key, limit) =>
            getComments(assertProjectIssue(key, 'SCRUM'), limit);
        mock.searchSprintIssues = async sprintId =>
            (await searchSprintIssues(sprintId)).filter(issue => isProjectIssue(issue.key, 'SCRUM'));
        mock.getSprintSubtasks = async (sprintId, parentKeys) => {
            const parents = parentKeys.map(key => assertProjectIssue(key, 'SCRUM'));
            return (await getSprintSubtasks(sprintId, parents))
                .filter(issue => isProjectIssue(issue.key, 'SCRUM') && parents.includes(issue.parentKey ?? ''));
        };
        cached = mock;
    } else {
        cached = new LiveJiraClient(cfg);
    }
    console.log(`[Jira] Using ${cfg.mode} client`);
    return cached;
}
