// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * OpenAI Agents SDK function-tools that let the LLM query the live Jira board
 * during a Q&A turn (MVP 5 — "Answer").
 *
 * The LLM decides when to call these based on the user's message; we register
 * the toolset via `agent.tools = [...]` when we build the agent for an Answer
 * request.
 */

import { tool } from '@openai/agents';
import { z } from 'zod';

import { getJiraClient } from './jira';
import { toTaskLabel, toJiraKey, cleanIssueTitle } from './issue-labels';

export const getIssueTool = tool({
    name: 'jira_get_issue',
    description:
        'Fetch a single Jira issue by its friendly key (e.g. "Task-14" or "Task-207"). Returns key ' +
        '(displayed as Task-N), a clean summary (prefixes like "User Story:" stripped), status, ' +
        'assignee display name, story points, and a URL. Use this when the user asks about a specific item.',
    parameters: z.object({
        issueKey: z.string().describe('The task key, e.g. "Task-14". Bare numbers like "14" are also accepted.'),
    }),
    execute: async ({ issueKey }) => {
        const jiraKey = toJiraKey(issueKey);
        console.log(`[jira-tool] jira_get_issue received=${JSON.stringify(issueKey)} mapped=${jiraKey}`);
        try {
            const issue = await getJiraClient().getIssue(jiraKey);
            return {
                key: toTaskLabel(issue.key),
                summary: cleanIssueTitle(issue.summary),
                status: issue.status,
                assignee: issue.assignee?.displayName ?? null,
                storyPoints: issue.storyPoints,
                url: issue.url,
            };
        } catch (e) {
            console.error(`[jira-tool] jira_get_issue failed key=${jiraKey}:`, (e as Error).message);
            return { error: `Could not fetch ${toTaskLabel(jiraKey)}: ${(e as Error).message}` };
        }
    },
});

export const listSprintIssuesTool = tool({
    name: 'jira_list_sprint_issues',
    description:
        'List all issues in the currently active sprint. Returns an array of ' +
        '{ key (as Task-N), summary (cleaned), status, assignee, storyPoints }. Use this when the user ' +
        'asks about "the sprint", "what\'s left", or general progress questions.',
    parameters: z.object({}).describe('No parameters.'),
    execute: async () => {
        const jira = getJiraClient();
        const sprint = await jira.getActiveSprint();
        if (!sprint) return { error: 'No active sprint found.' };
        const issues = await jira.searchSprintIssues(sprint.id);
        return {
            sprint: { id: sprint.id, name: sprint.name, endDate: sprint.endDate },
            issues: issues.map(i => ({
                key: toTaskLabel(i.key),
                summary: cleanIssueTitle(i.summary),
                status: i.status,
                assignee: i.assignee?.displayName ?? null,
                storyPoints: i.storyPoints,
            })),
        };
    },
});

export const getIssueCommentsTool = tool({
    name: 'jira_get_issue_comments',
    description:
        'Fetch the most recent comments on a Jira issue (e.g. standup updates, blocker notes, PR reviews). ' +
        'Use this whenever the user asks about "latest update", "what did X say", "recent activity", ' +
        '"any news on", or the "history" of a specific item. Returns newest-first with author + timestamp.',
    parameters: z.object({
        issueKey: z.string().describe('The task key, e.g. "Task-15". Bare numbers like "15" are also accepted.'),
        limit: z.number().int().min(1).max(20).default(5)
            .describe('How many most-recent comments to return. Default 5.'),
    }),
    execute: async ({ issueKey, limit }) => {
        const jiraKey = toJiraKey(issueKey);
        const taskLabel = toTaskLabel(jiraKey);
        try {
            const comments = await getJiraClient().getComments(jiraKey, limit);
            if (comments.length === 0) {
                return { issueKey: taskLabel, comments: [], note: 'No comments on this issue yet.' };
            }
            return {
                issueKey: taskLabel,
                count: comments.length,
                comments: comments.map(c => ({
                    author: c.author,
                    createdIso: c.createdIso,
                    body: c.body.trim(),
                })),
            };
        } catch (e) {
            return { error: `Could not fetch comments for ${taskLabel}: ${(e as Error).message}` };
        }
    },
});

export const JIRA_TOOLS = [getIssueTool, listSprintIssuesTool, getIssueCommentsTool];
