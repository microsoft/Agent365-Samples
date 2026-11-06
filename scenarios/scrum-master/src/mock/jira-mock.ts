// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Realistic seeded Jira sprint for offline / mock mode.
 *
 * When JIRA_MODE=mock, `getJiraClient()` returns this in-memory implementation.
 * The state is *mutable* on purpose — transitions and comments modify the seed so
 * the demo shows real board changes without touching Atlassian.
 */

import {
    JiraClient,
    JiraIssue,
    JiraSprint,
    JiraTransition,
    JiraUser,
} from '../services/jira';

const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const daysAhead = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

const USERS: Record<string, JiraUser> = {
    alex: { accountId: 'acc-alex', displayName: 'Alex Rivera', emailAddress: 'alex@contoso.com' },
    priya: { accountId: 'acc-priya', displayName: 'Priya Sharma', emailAddress: 'priya@contoso.com' },
    arjun: { accountId: 'acc-arjun', displayName: 'Arjun Nair', emailAddress: 'arjun@contoso.com' },
    sam: { accountId: 'acc-sam', displayName: 'Samantha Chen', emailAddress: 'sam@contoso.com' },
    chetan: { accountId: 'acc-chetan', displayName: 'Chetan Sharma', emailAddress: 'chetan@contoso.com' },
};

const SPRINT: JiraSprint = {
    id: 101,
    name: 'SCRUM Sprint 0',
    state: 'active',
    startDate: daysAgo(7),
    endDate: daysAhead(7),
    goal: 'Ship the Scrum Master Assistant POC end-to-end demo',
};

const TRANSITION_FLOW: { from: string; to: string; transitionId: string; transitionName: string }[] = [
    { from: 'To Do', to: 'In Progress', transitionId: '11', transitionName: 'Start progress' },
    { from: 'In Progress', to: 'In Review', transitionId: '21', transitionName: 'Send for review' },
    { from: 'In Review', to: 'Done', transitionId: '31', transitionName: 'Complete' },
];

const ISSUES: JiraIssue[] = [
    makeIssue('SCRUM-1', 'Wire up Adaptive Card standup flow', 'In Progress', USERS.priya, 5),
    makeIssue('SCRUM-2', 'Jira REST client for issue transitions', 'In Review', USERS.arjun, 3),
    makeIssue('SCRUM-3', 'SharePoint list schema + setup script', 'Done', USERS.sam, 5),
    makeIssue('SCRUM-4', 'Sprint report markdown generator', 'To Do', USERS.arjun, 8),
    makeIssue('SCRUM-5', 'Warn timer: mid-sprint risk detection', 'To Do', USERS.priya, 5),
    makeIssue('SCRUM-6', 'Chase blockers: propose unblock meeting', 'In Progress', USERS.alex, 3),
    makeIssue('SCRUM-7', 'Board reconciliation: safe forward transitions', 'To Do', USERS.sam, 5),
    makeIssue('SCRUM-8', 'Q&A tool: OpenAI agent Jira grounding', 'In Progress', USERS.alex, 3),
    makeIssue('SCRUM-9', 'Team roster SharePoint list + seed data', 'Done', USERS.chetan, 2),
    makeIssue('SCRUM-10', 'Adaptive Card wireframes JSON', 'Done', USERS.priya, 3),
    makeIssue('SCRUM-11', 'Local cron scheduler for standup timer', 'To Do', USERS.arjun, 2),
    makeIssue('SCRUM-12', 'Notifications channel /config command', 'To Do', USERS.sam, 3),
];

function makeIssue(key: string, summary: string, status: string, assignee: JiraUser, points: number): JiraIssue {
    return {
        id: `id-${key}`,
        key,
        summary,
        status,
        statusCategory: status === 'Done' ? 'done' : status === 'To Do' ? 'new' : 'indeterminate',
        assignee,
        storyPoints: points,
        url: `mock://jira/browse/${key}`,
        sprintId: SPRINT.id,
        dueDate: null,
        parentKey: null,
        issueType: 'Story',
    };
}

const COMMENTS: Record<string, string[]> = {};

class MockJiraClient implements JiraClient {
    async getActiveSprint(): Promise<JiraSprint | null> {
        return { ...SPRINT };
    }

    async getSprint(sprintId: number): Promise<JiraSprint> {
        if (sprintId !== SPRINT.id) throw new Error(`Mock: sprint ${sprintId} not found`);
        return { ...SPRINT };
    }

    async searchSprintIssues(sprintId: number): Promise<JiraIssue[]> {
        if (sprintId !== SPRINT.id) return [];
        return ISSUES.map(i => ({ ...i }));
    }

    async getSprintSubtasks(_sprintId: number, _parentKeys: string[]): Promise<JiraIssue[]> {
        // Mock has no sub-tasks; the flat ISSUES array simulates parent stories only.
        return [];
    }

    async getIssue(issueKey: string): Promise<JiraIssue> {
        const issue = ISSUES.find(i => i.key === issueKey);
        if (!issue) throw new Error(`Mock: issue ${issueKey} not found`);
        return { ...issue };
    }

    async getTransitions(issueKey: string): Promise<JiraTransition[]> {
        const issue = ISSUES.find(i => i.key === issueKey);
        if (!issue) return [];
        return TRANSITION_FLOW
            .filter(t => t.from === issue.status)
            .map(t => ({ id: t.transitionId, name: t.transitionName, toStatus: t.to }));
    }

    async transitionIssue(issueKey: string, transitionId: string, comment?: string): Promise<void> {
        const issue = ISSUES.find(i => i.key === issueKey);
        if (!issue) throw new Error(`Mock: issue ${issueKey} not found`);
        const t = TRANSITION_FLOW.find(x => x.transitionId === transitionId && x.from === issue.status);
        if (!t) throw new Error(`Mock: transition ${transitionId} not available from ${issue.status}`);
        issue.status = t.to;
        issue.statusCategory = t.to === 'Done' ? 'done' : t.to === 'To Do' ? 'new' : 'indeterminate';
        if (comment) await this.addComment(issueKey, comment);
        console.log(`[MockJira] ${issueKey}: ${t.from} -> ${t.to}`);
    }

    async addComment(issueKey: string, body: string): Promise<void> {
        (COMMENTS[issueKey] ||= []).push(body);
        console.log(`[MockJira] comment on ${issueKey}: ${body}`);
    }

    async getComments(issueKey: string, limit = 5): Promise<import('../services/jira').JiraComment[]> {
        const raw = (COMMENTS[issueKey] ?? []).slice(-limit).reverse();
        return raw.map((body, i) => ({
            id: `mock-${issueKey}-${i}`,
            author: 'Mock Author',
            createdIso: new Date().toISOString(),
            body,
        }));
    }
}

export function mockJira(): JiraClient {
    return new MockJiraClient();
}
