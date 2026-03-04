# User Identity Rollout — Implementation Plan

## Context

Agents need to identify who they are talking to in order to personalize responses and log user activity. The universal pattern across all 15 samples is:

1. Log `Activity.From` fields (`Name`, `Id`, `AadObjectId`) at message handler entry
2. Inject the user's display name into the LLM system instructions / prompt
3. Document the pattern in the sample README

No new tool files, no Graph calls, no per-orchestrator tool registration.

The `dotnet/agent-framework` sample was originally built with a `CurrentUserTool` (LLM-callable tools + Graph `/me`). That is being simplified to match the uniform pattern used by all other samples.

---

## Workflow

For `dotnet/agent-framework` (Step 0):
1. Make changes locally
2. User deploys and tests manually
3. Commit and push
4. Proceed with remaining samples

---

## Step 0 — Simplify `dotnet/agent-framework` (branch `users/sellak/user-identity`)

**Delete:** `dotnet/agent-framework/sample-agent/Tools/CurrentUserTool.cs`

**Modify `Agent/MyAgent.cs`:**
- Remove the `CurrentUserTool` instantiation and the two `AIFunctionFactory.Create(currentUserTool.*)` registrations
- Remove the Graph-related instruction from `AgentInstructionsTemplate`:
  ```
  For richer user profile information (email, job title, department), use {{CurrentUserTool.GetCurrentUserExtendedProfileAsync}}.
  ```
- Keep: `accessToken` acquisition, `agentId` warning log, logging of `Activity.From`, `{userName}` injection into instructions

**Modify `README.md`:**
- Simplify "Working with User Identity" to the activity-payload pattern only (field table + log snippet)
- Remove "Extended profile from Microsoft Graph" subsection
- Remove `Tools/CurrentUserTool.cs` file reference

**Verify:** `dotnet build` passes, no `CurrentUserTool` references remain.

---

## Changes Per Sample (Steps 1–9, after Step 0 is tested and committed)

Every sample gets the same three changes — no new files:

| # | Change | Detail |
|---|--------|--------|
| 1 | **Log** | Add structured log of `Activity.From` (Name, Id, AadObjectId) at the start of the message handler |
| 2 | **Inject** | Read `Activity.From.Name` and inject it into the LLM system instructions / prompt template as the user's display name |
| 3 | **README** | Add "Working with User Identity" section (see template below) |

---

### C# — `dotnet/semantic-kernel/sample-agent/`

**Modify `Agents/MyAgent.cs`:**

```csharp
var fromAccount = turnContext.Activity.From;
_logger?.LogInformation(
    "Turn received from user — DisplayName: '{Name}', UserId: '{Id}', AadObjectId: '{AadObjectId}'",
    fromAccount?.Name ?? "(unknown)",
    fromAccount?.Id ?? "(unknown)",
    fromAccount?.AadObjectId ?? "(none)");
```

Inject `Activity.From.Name` into the SK kernel's system instructions using the same `{userName}` template replacement pattern as the reference.

**Modify `README.md`** — add section.

---

### Python — 5 samples

Python uses `activity.from_property`. Samples with `turn_context_utils.py` (`claude`, `crewai`) already extract `caller_name`, `caller_id`, `caller_aad_object_id` — reuse those.

**Modify `agent.py` in each sample:**

```python
from_prop = turn_context.activity.from_property
logger.info(
    "Turn received from user — DisplayName: '%s', UserId: '%s', AadObjectId: '%s'",
    getattr(from_prop, "name", None) or "(unknown)",
    getattr(from_prop, "id", None) or "(unknown)",
    getattr(from_prop, "aad_object_id", None) or "(none)",
)
display_name = getattr(from_prop, "name", None) or "unknown"
```

Inject `display_name` into the system prompt string.

| Sample | Notes |
|--------|-------|
| `python/agent-framework/sample-agent/` | No existing identity code. Add logging + injection. |
| `python/claude/sample-agent/` | Has `turn_context_utils.py` — reuse `caller_details`. |
| `python/openai/sample-agent/` | No existing identity code. Add logging + injection. |
| `python/crewai/sample_agent/` | Has `turn_context_utils.py` — reuse `caller_details`. |
| `python/google-adk/sample-agent/` | No existing identity code. Add logging + injection. |

**Modify `README.md`** in each — add section.

---

### Node.js / TypeScript — 8 samples

**Modify `src/agent.ts` in each sample (except n8n):**

```typescript
const from = turnContext.activity?.from;
logger.info(
  `Turn received from user — DisplayName: '${from?.name ?? "(unknown)"}', UserId: '${from?.id ?? "(unknown)"}', AadObjectId: '${from?.aadObjectId ?? "(none)"}'`
);
const displayName = from?.name ?? "unknown";
```

Inject `displayName` into the system prompt string.

| Sample | Notes |
|--------|-------|
| `nodejs/openai/sample-agent/` | Add logging + injection. |
| `nodejs/claude/sample-agent/` | Add logging + injection. |
| `nodejs/langchain/sample-agent/` | Add logging + injection. |
| `nodejs/devin/sample-agent/` | Explore structure first, then apply. |
| `nodejs/n8n/` | **README only** — no agent code to modify. |
| `nodejs/perplexity/sample-agent/` | Already extracts userId/userName/aadObjectId — add log line + inject into prompt. |
| `nodejs/vercel-sdk/sample-agent/` | Add logging + injection. |
| `nodejs/copilot-studio/sample-agent/` | Explore structure first, then apply. |

**Modify `README.md`** in each — add section.

---

## Design Doc Updates (4 files)

Prose additions only — no code changes.

| File | Change |
|------|--------|
| `docs/design.md` | Add "User Identity" note under Message Processing Flow |
| `dotnet/docs/design.md` | Add C# logging snippet + name-injection pattern |
| `python/docs/design.md` | Add Python snippet using `activity.from_property` |
| `nodejs/docs/design.md` | Add TypeScript snippet using `activity?.from` |

Content for all four:
> Agents identify the user from `Activity.From` (populated by the A365 platform on every message). Log `Id`, `Name`, and `AadObjectId` at `Information`/`info` level at message handler entry. Inject `Name` into LLM system instructions for personalization. For extended profile data (email, job title), a delegated Graph call to `/me` is required (app-only tokens use `/users/{AadObjectId}`).

---

## README "Working with User Identity" Template

Use this in every sample README:

```markdown
## Working with User Identity

On every incoming message, the A365 platform populates `Activity.From` with basic user
information — always available with no API calls or token acquisition:

| Field | Description |
|---|---|
| `Activity.From.Id` | Channel-specific user ID (e.g., `29:1AbcXyz...` in Teams) |
| `Activity.From.Name` | Display name as known to the channel |
| `Activity.From.AadObjectId` | Azure AD Object ID — use this to call Microsoft Graph |

The sample logs these fields at the start of every message turn and injects the display name
into the LLM system instructions for personalized responses.
```

---

## Execution Order

0. **`dotnet/agent-framework`** — simplify locally → user tests → commit and push
1. **`dotnet/semantic-kernel`** — closest to reference; validates C# pattern in SK context
2. **`python/claude`**, **`python/crewai`** — already have `turn_context_utils`; quick wins
3. **`python/agent-framework`**, **`python/openai`**, **`python/google-adk`**
4. **`nodejs/perplexity`** — already extracts identity; log + inject + README
5. **`nodejs/openai`**, **`nodejs/claude`**, **`nodejs/langchain`**, **`nodejs/vercel-sdk`**
6. **`nodejs/devin`**, **`nodejs/copilot-studio`** — explore structure before modifying
7. **`nodejs/n8n`** — README only
8. **Design docs** (all 4)

---

## Testing Strategy

### Tier 1 — Build/compile gate (all samples, required)

| Language | Command | Run from |
|----------|---------|---------|
| C# | `dotnet build` | solution directory |
| Python | `python -m py_compile agent.py` | `sample-agent/` |
| TypeScript | `npm run build` | `sample-agent/` |

n8n is README-only — no build step.

### Tier 2 — `/review-staged` gate (all samples, required)

Run `/review-staged` after implementing each sample batch, before committing. All critical/high findings must be resolved.

### Tier 3 — E2E functional test (one per language, required)

`dotnet/agent-framework` is the E2E baseline (user-deployed and tested). Additionally validate one per language:

| Language | Sample | What to verify |
|----------|--------|----------------|
| C# | `dotnet/semantic-kernel` | Send a message — LLM response uses the user's name |
| Python | `python/agent-framework` | Send a message — LLM response uses the display name |
| Node.js | `nodejs/openai` | Send a message — LLM response uses the display name |

The remaining 11 samples are covered by identical pattern + build pass + `/review-staged`.

### Tier 4 — Design docs (review only)

Prose-only additions — verify accuracy against reference code, no deploy needed.

---

## Public Documentation Suggestions

**Target page:** [a365-dev-lifecycle — Step 1: Build and run agent](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/a365-dev-lifecycle#1-build-and-run-agent)

Step 1 currently lists: Observability, Notifications, Tooling, Agent Identity — no mention of identifying the human user on each message. Suggested addition (file as a docs PR against `MicrosoftDocs/agent365-docs-pr`):

**New bullet after "Agent Identity":**

```markdown
- **User Identity** – On every incoming message the A365 platform populates `Activity.From`
  with the user's display name, channel user ID, and Azure AD Object ID. No additional API call
  is required. For extended profile data (email, job title, department), call Microsoft Graph
  `/me` using the access token already acquired for the turn (delegated token with `User.Read`
  scope; use `/users/{AadObjectId}` for app-only tokens).
```

**New linked page `user-identity.md`** covering:
- The three-field table (`Activity.From.Id`, `.Name`, `.AadObjectId`)
- When to use `Activity.From` vs Graph `/me`
- Code snippet links to the Agent365-Samples repository
