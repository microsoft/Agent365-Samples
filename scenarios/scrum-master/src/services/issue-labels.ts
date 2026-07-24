// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Shared UI-label helpers for Jira issues.
 *
 * The team refers to issues as "Task-14" in cards and chat, but Jira internally
 * uses the project key (e.g. "EDP-14"). These helpers translate in both
 * directions so the LLM / user never has to see the raw project key.
 *
 *   toTaskLabel("EDP-14")  -> "Task-14"
 *   toJiraKey("Task-14")   -> "EDP-14"   (reads JIRA_PROJECT_KEY from env)
 *   toJiraKey("EDP-14")    -> "EDP-14"   (pass-through)
 *   cleanIssueTitle("User Story: X") -> "X"
 */

/** "EDP-14" -> "Task-14". Only rewrites the project prefix; number preserved. */
export function toTaskLabel(issueKey: string | null | undefined): string {
    if (!issueKey) return '';
    const m = issueKey.match(/^[A-Z][A-Z0-9]*-(\d+)$/);
    return m ? `Task-${m[1]}` : issueKey;
}

/**
 * Reverse of toTaskLabel. Accepts many forms the LLM/user might send:
 *   "Task-14", "task 14", "TASK14", "#14", "14"  ->  "EDP-14"
 *   "EDP-14", "edp-14"                            ->  "EDP-14"
 *   any other real Jira-style key                 ->  returned as-is (upper-cased)
 */
export function toJiraKey(input: string | null | undefined): string {
    if (!input) return '';
    const s = String(input).trim();
    // Already a canonical PROJ-N key? Just normalize case.
    const canonical = s.match(/^([A-Za-z][A-Za-z0-9]*)-(\d+)$/);
    if (canonical) return `${canonical[1].toUpperCase()}-${canonical[2]}`;
    // "Task-14" / "task 14" / "task14" / "#14" / "14"
    const taskish = s.match(/^(?:task\s*-?\s*|#)?(\d+)$/i);
    if (taskish) {
        const project = (process.env.JIRA_PROJECT_KEY ?? 'EDP').toUpperCase();
        return `${project}-${taskish[1]}`;
    }
    return s.toUpperCase();
}

/**
 * Strip the noisy hierarchy prefixes we bake into Jira summaries so that
 * cards / chat replies show the human-meaningful title.
 *
 *   "User Story: Employee listing page"          -> "Employee listing page"
 *   "Task 1: [Backend API]: Implement /login"    -> "Implement /login"
 *   "Bug: Employee list off-by-one on last…"     -> "Employee list off-by-one on last…"
 */
export function cleanIssueTitle(summary: string | null | undefined): string {
    if (!summary) return '';
    const taskCat = summary.match(/^\s*Task\s+\d+\s*:\s*\[[^\]]+\]\s*:\s*(.+)$/i);
    if (taskCat) return taskCat[1].trim();
    const prefixed = summary.match(/^\s*(?:User Story|Story|Bug|Task)\s*:\s*(.+)$/i);
    if (prefixed) return prefixed[1].trim();
    return summary.trim();
}
