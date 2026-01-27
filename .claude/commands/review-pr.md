# Review Pull Request

Review code changes in a specific pull request using a comprehensive multi-agent code review process with specialized reviewers for security, patterns, quality, and standards.

## Usage

```
/review-pr <PR_NUMBER>
```

**Examples:**
- `/review-pr 123` - Review pull request #123
- `/review-pr 45` - Review pull request #45

## Instructions

You are coordinating a comprehensive code review for pull request #$ARGUMENTS.

### Step 1: Gather PR Information

First, collect information about the pull request:

1. Get PR details, changed files, and the HEAD commit SHA:
   ```bash
   gh pr view $ARGUMENTS --json number,title,body,baseRefName,headRefName,headRefOid,url,files
   gh pr diff $ARGUMENTS
   ```

2. Extract key information:
   - List of changed files
   - PR URL for linking in review comments
   - **HEAD commit SHA** (`headRefOid`) - required for posting inline comments

3. **IMPORTANT**: Save the diff output - you will need it to:
   - Include relevant diff context snippets in each finding
   - Determine the exact **diff line numbers** for inline comments (line numbers as they appear in the diff, not file line numbers)
   - Determine the **side** (RIGHT for additions `+`, LEFT for deletions `-`)

4. Create the `.codereviews/` directory if it doesn't exist.

### Step 2: Launch Parallel Code Reviews

Launch FOUR sub-agents in parallel using the Task tool. Each agent MUST receive:
- The PR number: $ARGUMENTS
- The list of changed files (so they stay scoped to PR files only)
- The PR URL for generating clickable links

**CRITICAL**: You MUST launch all four agents in a SINGLE message with FOUR parallel Task tool calls:

1. **security-compliance-reviewer** (`subagent_type: security-compliance-reviewer`)
   - Prompt: "Review PR #$ARGUMENTS for security compliance. Files changed: [list files]. PR URL: [url]. Focus on authentication, secrets, token handling, logging security, and input validation. Output your review in the structured markdown format."

2. **agent365-anti-pattern-detector** (`subagent_type: agent365-anti-pattern-detector`)
   - Prompt: "Review PR #$ARGUMENTS for architectural anti-patterns. Files changed: [list files]. PR URL: [url]. Focus on initialization flow, message processing flow, observability patterns, and SDK usage. Output your review in the structured markdown format."

3. **pr-quality-guardian** (`subagent_type: pr-quality-guardian`)
   - Prompt: "Review PR #$ARGUMENTS for quality standards. Files changed: [list files]. PR URL: [url]. Focus on copyright headers, legacy references (Kairo), documentation completeness, lock files, and configuration quality. Output your review in the structured markdown format."

4. **sample-code-reviewer** (`subagent_type: sample-code-reviewer`)
   - Prompt: "Review PR #$ARGUMENTS for code quality. Files changed: [list files]. PR URL: [url]. Focus on sample independence, language-specific anti-patterns (C#, Python, TypeScript), error handling, and code clarity. Output your review in the structured markdown format."

### Step 3: Consolidate Reviews

After all four agents complete, consolidate their findings into a single report:

1. **Merge findings** - Combine all issues from the four agents
2. **Deduplicate** - Remove redundant findings, noting when multiple agents identified the same issue
3. **Prioritize** - Sort by severity: Critical → High → Medium → Low
4. **Renumber** - Assign sequential IDs: CRM-001, CRM-002, etc.

### Step 4: Write the Review Report

Write the consolidated review to a markdown file using the Write tool:

**File path**: `.codereviews/claude-pr$ARGUMENTS-<yyyyMMdd_HHmmss>.md`

Use this exact format:

````markdown
# Code Review Report

---

## Review Metadata

```
PR Number:           #$ARGUMENTS
PR Title:            [title from gh pr view]
PR Iteration:        1
Review Date/Time:    [ISO 8601 timestamp]
HEAD Commit:         [headRefOid from gh pr view - required for inline comments]
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

[Consolidated critical issues with structured format]

### High Priority Issues

[Consolidated high priority issues]

### Medium Priority Issues

[Consolidated medium priority issues]

### Low Priority Issues

[Consolidated low priority issues]

---

## Positive Observations

[What was done well across all review dimensions]

---

## Recommendations

[Prioritized, actionable next steps]

---

## Approval Status

**Final Status:** [APPROVED / APPROVED WITH MINOR NOTES / CHANGES REQUESTED / REJECTED]
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
| **PR Link** | [View in PR](https://github.com/.../pull/$ARGUMENTS/files#...) |
| **Opened** | [ISO 8601 timestamp] |
| **Resolved** | - [ ] No |
| **Resolution** | _pending_ |
| **Agent Resolvable** | Yes / No / Partial |

**Description:**
[Detailed explanation of the issue]

**Diff Context:**
IMPORTANT: Include the relevant diff snippet from the PR that shows the code being discussed. This makes the review self-contained - readers should understand the issue without needing to look at the PR.
```diff
- old code line (what was removed or changed)
+ new code line (what was added or changed to)
```

**Suggestion:**
[Specific recommendation]
````

### Inline Comment Fields Explained

The following fields are **required** for posting inline comments on the PR:

| Field | Description | Example |
|-------|-------------|---------|
| **File** | The exact path to the file as it appears in the diff | `python/openai/sample-agent/host_agent_server.py` |
| **Diff Line** | The line number where the comment should appear in the diff. For multi-line issues, use the **last line** of the relevant code block. Count lines in the diff hunk, not the file. | `47` |
| **Diff Side** | Which side of the diff: `RIGHT` for added/modified lines (`+`), `LEFT` for removed lines (`-`). Most comments should be on `RIGHT`. | `RIGHT` |

**How to determine Diff Line:**
1. Look at the diff hunk header (e.g., `@@ -10,5 +10,8 @@`)
2. Count lines from the start of the hunk
3. The line number is relative to the new file for `RIGHT`, old file for `LEFT`
4. For additions (`+` lines), use the line number shown after the `+` in the hunk header

**Example:**
```diff
@@ -45,6 +45,9 @@ def start_server(self):
         port = int(os.getenv("PORT", "3978"))
+        # Detect production environment
+        is_production = os.getenv("WEBSITE_SITE_NAME") is not None
+        host = "0.0.0.0" if is_production else "localhost"
         print(f"Starting server on {host}:{port}")
```
For a comment on the `host = "0.0.0.0"` line:
- **File**: `python/openai/sample-agent/host_agent_server.py`
- **Diff Line**: `48` (line 45 + 3 new lines)
- **Diff Side**: `RIGHT` (it's an addition)

### Step 5: Report to User

After writing the review file, inform the user:
1. The path to the review file
2. A summary of findings by severity count
3. The overall approval status
4. Remind them about `/resolve-review` if there are agent-resolvable issues
