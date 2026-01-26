# Review Staged Changes

Review staged (uncommitted) changes using a comprehensive multi-agent code review process. Use this before committing to get feedback on your changes.

## Usage

```
/review-staged
```

No arguments required - reviews all currently staged changes.

## Instructions

You are coordinating a comprehensive code review for staged changes that haven't been committed yet.

### Step 1: Gather Staged Changes Information

First, collect information about the staged changes:

1. Get list of staged files:
   ```bash
   git diff --cached --name-only
   ```

2. Get the full diff of staged changes:
   ```bash
   git diff --cached
   ```

3. **IMPORTANT**: Save the diff output - you will need it to include relevant diff context snippets in each finding.

4. If there are no staged changes, inform the user and suggest they stage files with `git add`.

5. Create the `.codereviews/` directory if it doesn't exist.

### Step 2: Launch Parallel Code Reviews

Launch FOUR sub-agents in parallel using the Task tool. Each agent MUST receive:
- The list of staged files (so they stay scoped)
- The diff content for context

**CRITICAL**: You MUST launch all four agents in a SINGLE message with FOUR parallel Task tool calls:

1. **security-compliance-reviewer** (`subagent_type: security-compliance-reviewer`)
   - Prompt: "Review staged changes for security compliance. Files changed: [list files]. This is a pre-commit review, not a PR. Focus on authentication, secrets, token handling, logging security, and input validation. Output your review in the structured markdown format. Since this is not a PR, omit PR Link fields or mark them as N/A."

2. **agent365-anti-pattern-detector** (`subagent_type: agent365-anti-pattern-detector`)
   - Prompt: "Review staged changes for architectural anti-patterns. Files changed: [list files]. This is a pre-commit review, not a PR. Focus on initialization flow, message processing flow, observability patterns, and SDK usage. Output your review in the structured markdown format. Since this is not a PR, omit PR Link fields or mark them as N/A."

3. **pr-quality-guardian** (`subagent_type: pr-quality-guardian`)
   - Prompt: "Review staged changes for quality standards. Files changed: [list files]. This is a pre-commit review, not a PR. Focus on copyright headers, legacy references (Kairo), documentation completeness, lock files, and configuration quality. Output your review in the structured markdown format. Since this is not a PR, omit PR Link fields or mark them as N/A."

4. **sample-code-reviewer** (`subagent_type: sample-code-reviewer`)
   - Prompt: "Review staged changes for code quality. Files changed: [list files]. This is a pre-commit review, not a PR. Focus on sample independence, language-specific anti-patterns (C#, Python, TypeScript), error handling, and code clarity. Output your review in the structured markdown format. Since this is not a PR, omit PR Link fields or mark them as N/A."

### Step 3: Consolidate Reviews

After all four agents complete, consolidate their findings into a single report:

1. **Merge findings** - Combine all issues from the four agents
2. **Deduplicate** - Remove redundant findings, noting when multiple agents identified the same issue
3. **Prioritize** - Sort by severity: Critical → High → Medium → Low
4. **Renumber** - Assign sequential IDs: CRM-001, CRM-002, etc.

### Step 4: Write the Review Report

Write the consolidated review to a markdown file using the Write tool:

**File path**: `.codereviews/claude-staged-<yyyyMMdd_HHmmss>.md`

Use this exact format:

````markdown
# Code Review Report (Staged Changes)

---

## Review Metadata

```
Review Type:         Pre-commit (Staged Changes)
Review Date/Time:    [ISO 8601 timestamp]
Subagents Used:      security-compliance-reviewer, agent365-anti-pattern-detector, pr-quality-guardian, sample-code-reviewer
```

---

## Overview

[Brief summary of what was reviewed and overall assessment]

---

## Files Reviewed

- `path/to/file1.ext`
- `path/to/file2.ext`

---

## Findings

### Critical Issues

[Consolidated critical issues - these MUST be fixed before committing]

### High Priority Issues

[Consolidated high priority issues - strongly recommend fixing]

### Medium Priority Issues

[Consolidated medium priority issues - recommended improvements]

### Low Priority Issues

[Consolidated low priority issues - nice to have]

---

## Positive Observations

[What was done well across all review dimensions]

---

## Recommendations

[Prioritized, actionable next steps before committing]

---

## Commit Readiness

**Status:** [READY TO COMMIT / FIX ISSUES FIRST / NEEDS DISCUSSION]

[Brief explanation of the status]
````

### Structured Issue Format

For EVERY finding, use this structure:

````markdown
#### [CRM-001] Issue Title

| Field | Value |
|-------|-------|
| **Identified By** | `security-compliance-reviewer` / `agent365-anti-pattern-detector` / `pr-quality-guardian` / `sample-code-reviewer` / `multiple` |
| **File** | `full/path/to/filename.ext` |
| **Line(s)** | 42-58 |
| **Diff Line** | 47 |
| **Diff Side** | RIGHT |
| **Severity** | `critical` / `high` / `medium` / `low` |
| **Opened** | [ISO 8601 timestamp] |
| **Resolved** | - [ ] No |
| **Resolution** | _pending_ |
| **Agent Resolvable** | Yes / No / Partial |

**Description:**
[Detailed explanation of the issue]

**Diff Context:**
IMPORTANT: Include the relevant diff snippet that shows the code being discussed. This makes the review self-contained - readers should understand the issue without needing to look at the staged changes.
```diff
- old code line (what was removed or changed)
+ new code line (what was added or changed to)
```

**Suggestion:**
[Specific recommendation]
````

### Inline Comment Fields

Even though staged changes are not a PR yet, capture these fields so inline comments can be posted when a PR is created:

| Field | Description | Example |
|-------|-------------|---------|
| **File** | The exact path to the file | `python/openai/sample-agent/host_agent_server.py` |
| **Diff Line** | The line number in the diff where the issue occurs. For multi-line issues, use the **last line**. | `47` |
| **Diff Side** | `RIGHT` for added/modified lines (`+`), `LEFT` for removed lines (`-`) | `RIGHT` |

**Note:** To post these findings as inline PR comments later, use `/review-pr` after creating the PR, or create a PR and use `/post-review-comments` with the staged review file (it will attempt to map the findings).

### Step 5: Report to User

After writing the review file, inform the user:
1. The path to the review file
2. A summary of findings by severity count
3. The commit readiness status
4. If there are critical issues, list them briefly so the user knows what must be fixed
5. Remind them about `/resolve-review` if there are agent-resolvable issues
