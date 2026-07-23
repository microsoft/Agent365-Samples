# Chief of Staff Teammate — `chief-of-staff`

Autonomous Microsoft Agent 365 teammate that runs a leader's operating rhythm.
It captures decisions and action items from Teams meetings into Planner, sends
a daily Brief card, follows up with owners, books unblock meetings, escalates
non-responsive owners, and lets people close tasks by chat.

> 📘 Looking for architecture, flow diagrams, or extension points?
> See **[DESIGN.md](DESIGN.md)**. This README is only about getting the agent
> running end-to-end in a fresh tenant.

---

## Contents

1. [What you'll have when you're done](#1-what-youll-have-when-youre-done)
2. [Prerequisites](#2-prerequisites)
3. [Microsoft 365 tenant setup](#3-microsoft-365-tenant-setup)
4. [Clone + install](#4-clone--install)
5. [Configure `.env`](#5-configure-env)
6. [Run](#6-run)
7. [First live proof](#7-first-live-proof)
8. [Verify every feature end-to-end](#8-verify-every-feature-end-to-end)
9. [Troubleshooting](#9-troubleshooting)
10. [Deploy to Azure](#10-deploy-to-azure)

---

## 1. What you'll have when you're done

A running Node service on your dev machine (or Azure App Service) that:

| Capability | Trigger |
|---|---|
| **Capture** — extracts action items + decisions from Teams meetings and creates Planner tasks | Calendar poller finds a leader-organised meeting the CoS was invited to, transcript is fetched, LLM extracts |
| **Daily Brief** — Adaptive Card DM to the leader with priorities, watch items, upcoming meetings | Cron (default 8 AM weekdays, gated behind `BRIEF_ENABLED`) |
| **Follow-up** — Adaptive Card DM to each at-risk owner (`On track` / `Need more time` / `I'm blocked`) | Cron (default hourly) |
| **Extension request** — leader gets an approval card, agent PATCHes Planner due date on approval | Owner clicks "Need more time" or types `extend` |
| **Blocker meeting** — agent proposes 3 slots, books calendar invite on click | Owner clicks "I'm blocked" or types `blocked` |
| **Escalation** — 🚨 card DM'd to the leader if the owner ignores their follow-up | Post-followup sweep after `FOLLOWUP_ESCALATE_AFTER_HOURS`; auto-cancels if the task is closed first |
| **Task complete (Planner)** — owner marks it done in Planner, leader gets a confirmation DM | Planner poll detects `percentComplete: 100` |
| **Task complete (chat)** — owner tells the agent in plain language ("`The task "X" is done`"), agent PATCHes Planner to 100 % and notifies leader | Message router matches completion phrase + quoted title, fuzzy-matches Planner |
| **Recall / chit-chat** — the leader asks "where are we on X?" and gets a status answer, restricted to leadership team members | LLM turn with `planner_list_tasks` + `mcp_CalendarTools` |

Everything is deterministic **except** the flows that explicitly need
natural-language understanding: capture extraction (LLM parses the transcript),
recall/chit-chat, and the legacy standalone Escalate scan (`runEscalate` — LLM
drafts re-plan proposals for the leader; see `src/cos/escalate.ts`). All
routing, dedup, date math, and Planner writes are TypeScript.

---

## 2. Prerequisites

Install on your dev box:

- **Node.js ≥ 18** (`node --version`)
- **npm ≥ 9**
- **Azure CLI** (`az --version`) — needed for the one-shot Graph scope grants
- **PowerShell 7+** — the bootstrap script assumes it
- **Microsoft Graph Explorer** open in a browser tab — used once to grab the Planner bucket ID
- **Microsoft dev tunnel** — for local Teams testing:
  ```powershell
  winget install Microsoft.devtunnel
  devtunnel user login   # sign in with your M365 tenant account
  ```
- **Agent 365 CLI** — installs the `a365` command:
  ```powershell
  npm i -g @microsoft/agents-a365-cli
  a365 --version
  ```

---

## 3. Microsoft 365 tenant setup

You need one M365 tenant with:

- A **Global Administrator** account (needed for admin-consenting Graph scopes)
- A **leader** test account with a mailbox (e.g. `alex@…`)
- At least one **second test user** with a mailbox (e.g. `adele@…`)
- (Optional) **Microsoft 365 Copilot** license on the leader — enables
  pre-extracted `aiInsights` on meetings. Without it the agent falls back to
  LLM extraction from the raw transcript. Nothing else changes.

### 3a. Create the agent identity

From `chief-of-staff/`:

```powershell
a365 develop setup --agent-name "Chief-of-Staff"
```

Sign in as Global Admin when asked and let the CLI:

1. Create the agent's Entra app registration and service principal
2. Provision the agentic user (its own mailbox, Teams identity, calendar)
3. Write `a365.generated.config.json` into this folder
4. Grant the initial Graph + Agent 365 Tools scopes

**Copy** the values it prints — they populate the top of `.env` (see §5).

**Note the agent's UPN** — usually `chief-of-staff@<tenant>.onmicrosoft.com`.
Leaders will invite this UPN to their meetings so the CoS can capture them.

**Publish the agent to Teams** so the leader can install it and DM it.
From the same folder:

```powershell
a365 publish --agent-name "Chief-of-Staff" --aiteammate
```

This command generates the `manifest/` folder with your blueprint id baked
in (locally — gitignored) and pushes it to your tenant. After it runs, the
Chief-of-Staff agent user becomes discoverable in the Teams app catalog
and can be added to Teams / meetings by any tenant user. No manual
`manifest.json` editing, no `manifest.zip` sideload.

### 3b. Provision the standalone Graph worker app (required)

The agent hits Microsoft Graph constantly (calendar view, transcripts,
insights, Planner CRUD, directory lookup, group membership). **Every**
outbound Graph call is made with application-permission credentials from a
dedicated Entra app — the *cos-graph-worker*. Nothing about Graph access
depends on the blueprint or agent-instance identity, so no additional
delegated scopes (`Chat.ReadWrite`, `Tasks.ReadWrite`, `Calendars.Read`,
etc.) are needed on those apps.

**In one command:**

```powershell
cd chief-of-staff
.\scripts\bootstrap-graph-app.ps1
```

The script (idempotent — safe to re-run):

1. Creates or reuses an Entra app named `cos-graph-worker`.
2. Adds the application permissions Graph needs:
   `Calendars.Read`, `OnlineMeetings.Read.All`,
   `OnlineMeetingTranscript.Read.All`, `OnlineMeetingAiInsight.Read.All`,
   `Chat.Create`, `Chat.ReadWrite.All`,
   `Tasks.ReadWrite.All`, `User.Read.All`, `Group.Read.All`.
3. Admin-consents them tenant-wide via `az` (no browser, avoids
   AADSTS82007 in demo tenants).
4. Rotates a client secret and prints:
   ```text
   GRAPH_APP_ID=<guid>
   GRAPH_APP_SECRET=<secret>
   GRAPH_TENANT_ID=<guid>
   ```
   Paste those three into `.env`.

**One extra tenant-admin step for transcripts and insights.** Application
permissions on `/users/{id}/onlineMeetings/**` also require a Teams
*application-access policy*. Run these **once** as tenant admin:

```powershell
Install-Module MicrosoftTeams -Force -Scope CurrentUser
Connect-MicrosoftTeams

New-CsApplicationAccessPolicy `
  -Identity "cos-agent-policy" `
  -AppIds "<GRAPH_APP_ID from the bootstrap script>" `
  -Description "CoS Graph Worker access"
```

Then pick a **grant strategy** — three options, in order of preference:

| Strategy | Command | Onboarding a new leader |
|---|---|---|
| **CoS-agent-only (recommended)** — grants only to the CoS agent UPN. Every Graph call reads as the CoS agent. Any leader who invites `Chief-of-Staff@…` to a meeting gets captured. Zero admin work per leader. | `Grant-CsApplicationAccessPolicy -PolicyName "cos-agent-policy" -Identity "<COS_AGENT_UPN>"` | Just add them to the invite |
| **Tenant-wide** — grants to every user. Simple for demo tenants. Broad exposure in production. | `Grant-CsApplicationAccessPolicy -PolicyName "cos-agent-policy" -Global` | Nothing |
| **Per-leader** — precise but manual. Cmdlet re-run for each new leader. | `Grant-CsApplicationAccessPolicy -PolicyName "cos-agent-policy" -Identity "<LEADER_UPN>"` | Re-run cmdlet |

For strategy 1 (recommended), leave `CAPTURE_GRAPH_OWNER=cos-agent` in `.env`
(the default). For strategies 2 or 3, set `CAPTURE_GRAPH_OWNER=leader`.

> **Note:** policy assignment can take up to 30 minutes to propagate through
> Teams. Test with a *fresh* meeting after running the grant.

Verify:

Verify (get `<sp-object-id>` from step 6 of the bootstrap script output, or
`az ad sp list --filter "appId eq '$env:GRAPH_APP_ID'" --query [0].id -o tsv`):

```powershell
az rest --method GET `
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/<sp-object-id>/appRoleAssignments" `
  -o table
```

Nine rows expected — one per scope listed in step 2 above.

> **Adaptive-card DMs** are sent via Bot Framework proactive messaging, not
> Graph — so they need no Graph scope. The recipient must have DM'd the
> agent (or installed the app in Teams) at least once so the agent has a
> cached `ConversationReference` for them; that reference is persisted to
> `.cos-state/conversation-refs.json` and survives restarts.


### 3c. Grant Agent 365 Tools (MCP) scopes

On the **Agent 365 Tools** resource (`ea9ffc3e-8a23-4a7d-836d-234d7c7565c1`)
grant these three scopes if `a365 develop setup` didn't:

| Scope | Enables MCP server |
|---|---|
| `McpServers.Teams.All` | `mcp_TeamsServer` (Teams messages, meeting chat, DMs) |
| `McpServers.Mail.All` | `mcp_MailTools` |
| `McpServers.Calendar.All` | `mcp_CalendarTools` |

Grant admin consent.

### 3d. Create the leadership Team

> Requires §3a (both the identity-creation and the publish step) so that the
> `Chief-of-Staff@…` user is discoverable in the Teams people picker.

In Teams:

1. Create a Team named **Leadership Operations** (or similar).
2. Add the **leader** as owner.
3. Add the **agent user** (`Chief-of-Staff@…`) as a member.
4. Add the **second test user** as a member.
5. Grab the **Team ID** from the Team URL (`groupId=<GUID>`) → this is
   `LEADERSHIP_TEAM_ID` in `.env`. You can also paste the *display name*
   (`Leadership Operations`) or the *channel email* — the agent resolves
   any of those on first turn.

### 3e. Create the Planner plan

1. In the Team's General channel: **+ → Planner → Create new plan**.
2. Name it (e.g. "Leadership Rhythm").
3. Create at least one bucket named exactly **`New`** — that's where
   Capture drops action items. Optionally add `In Progress`, `Blocked`, `Done`.

**That's it.** With `LEADERSHIP_TEAM_ID` set, the agent will auto-discover
the plan and the `New` bucket at runtime — you don't need to look up any
GUIDs. On boot you'll see:

```text
[plannerConfig] Auto-resolved plan: "Leadership Rhythm" (9H_e2N…) — the only plan in team ad6f92c5…
[plannerConfig] Auto-resolved bucket: "New" (09dDjr…) in plan 9H_e2N…
```

**Only if you have multiple plans in the team**, set `PLANNER_PLAN_NAME` in
`.env` to disambiguate:

```dotenv
PLANNER_PLAN_NAME=Leadership Rhythm
```

**Only if you renamed the bucket** to something other than `New`:

```dotenv
PLANNER_BUCKET_NAME=Inbox
```

**To skip auto-resolve entirely** (fastest boot, needed if the standalone
Graph worker isn't set up), paste the explicit IDs from Planner UI + Graph
Explorer:

```text
# PLANNER_PLAN_ID — from the plan URL
https://planner.cloud.microsoft/webui/plan/<PLAN_ID>/view/board?tid=…
                                            ^^^^^^^^

# PLANNER_BUCKET_NEW — from Graph Explorer (aka.ms/ge)
GET https://graph.microsoft.com/v1.0/planner/plans/<PLAN_ID>/buckets
→ find the entry where name == "New", copy its id
```

### 3f. (Optional) Give the leader a Copilot license

Structured `aiInsights` — pre-extracted action items and meeting notes from
Copilot — dramatically reduce token cost on capture. If Copilot isn't
available in your tenant, the agent detects that and falls back to LLM
extraction from the raw WebVTT transcript. Nothing else changes.

---

## 4. Clone + install

```powershell
cd chief-of-staff
npm install
```

If npm complains about peer deps: `npm install --legacy-peer-deps`.

---

## 5. Configure `.env`

```powershell
copy .env.template .env
```

**Minimum required** for a running agent:

```dotenv
# From `a365 develop setup` output
agent_id=<agent-blueprint-id>
connections__service_connection__settings__clientId=<same-as-agent_id>
connections__service_connection__settings__clientSecret=<from-setup>
connections__service_connection__settings__tenantId=<your-tenant-id>

# Foundry (Azure OpenAI) deployment
AZURE_OPENAI_ENDPOINT=https://<your-foundry-project>.services.ai.azure.com
AZURE_OPENAI_DEPLOYMENT=gpt-4o
AZURE_OPENAI_API_KEY=<foundry-key>
AZURE_OPENAI_API_VERSION=2024-10-21

# Leader (only UPN needed — AAD auto-resolves on first turn)
LEADER_UPN=alex@yourdomain.onmicrosoft.com

# CoS agent's own inviteable UPN — REQUIRED for meeting capture
COS_AGENT_UPN=chief-of-staff@yourdomain.onmicrosoft.com
# CoS agent's AAD Object ID (a GUID, NOT the appId). Required so Adaptive
# Card DMs can create a 1:1 chat with both members listed explicitly.
# Look up: az ad user show --id $COS_AGENT_UPN --query id -o tsv
COS_AGENT_AAD_ID=<guid>

# Standalone Graph worker app — printed by scripts/bootstrap-graph-app.ps1 (§3b)
GRAPH_APP_ID=
GRAPH_APP_SECRET=
GRAPH_TENANT_ID=

# Planner — optional if LEADERSHIP_TEAM_ID is set (auto-resolved at runtime).
# Set explicitly to skip the resolve, or when the Team has multiple plans.
PLANNER_PLAN_ID=
PLANNER_BUCKET_NEW=
# Optional overrides for auto-resolve:
# PLANNER_PLAN_NAME=Leadership Rhythm   # if Team has multiple plans
# PLANNER_BUCKET_NAME=New               # override default bucket search name

# Team access control for Recall gate (also drives Planner auto-resolve)
LEADERSHIP_TEAM_ID=<team-group-id-OR-display-name-OR-channel-email>
```

**Optional tunables** (all have sensible code defaults — see `.env.template`
for the exhaustive list):

| Env | Default | Description |
|---|---|---|
| `LEADER_NAME` | — | Display name used in card copy (e.g. "Assigned by: Alex"). Falls back to "the Leader" when unset |
| `BRIEF_ENABLED` | `false` | Set to `true` to turn on the daily Brief cron |
| `CRON_BRIEF` | `0 8 * * 1-5` | When the Brief card fires (8 AM weekdays) |
| `CRON_FOLLOWUP` | `0 * * * *` | When follow-up cards fire (also runs escalation sweep) |
| `CRON_ESCALATE` | `0 */4 * * *` | Legacy standalone escalate stage |
| `CRON_TIMEZONE` | server-local | IANA TZ for the crons (e.g. `Asia/Kolkata`) |
| `POLL_MEETINGS_MS` | `60000` | Meeting-capture orchestrator cadence (60 s) |
| `POLL_TASKS_MS` | `300000` | Planner completed-task poller cadence (5 min) |
| `FOLLOWUP_ESCALATE_AFTER_HOURS` | `3` | Hours before an unanswered followup escalates |
| `FOLLOWUP_COOLDOWN_HOURS` | `4` | Suppress a fresh check-in for the same owner within this window |
| `TRANSCRIPT_WATCH_HOURS` | `4` | How far back the calendar watcher scans each tick |
| `TRANSCRIPT_WATCH_FORWARD_HOURS` | `24` | How far forward (catches in-progress/upcoming) |
| `INSIGHTS_MIN_WAIT_MINUTES` | `3` | Min budget waiting for Copilot insights |
| `INSIGHTS_MAX_WAIT_MINUTES` | `30` | Max budget waiting for Copilot insights |
| `CAPTURE_MIN_ATTEMPTS_TRANSCRIPT_ONLY` | `2` | Attempt count after which we fire capture on transcript alone (skip waiting for insights) |
| `CAPTURE_GIVE_UP_AFTER_HOURS` | `4` | Give up on a meeting whose transcript never appears |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` / `trace` |
| `LOG_HTTP` | `false` | Log every outbound HTTP call with status + latency |
| `SCHEDULER_ENABLED` | `true` | Set `false` to disable all crons + pollers |
| `BRIEF_DISPLAY_TZ` | `UTC` | Wall-clock TZ used in card copy — set to the leader's home TZ (e.g. `America/Los_Angeles`, `Europe/London`, `Asia/Kolkata`) |
| `STATE_BACKEND` | `file` | `file` (persist to disk) or `null` (in-memory only, for tests) |
| `STATE_DIR` | `./.cos-state` | Root dir for state files. On Azure App Service: `/home/data/cos-state` |
| `CAPTURE_STATE_RETENTION_DAYS` | `30` | TTL for finished captures on disk. In-flight records always kept |
| `FOLLOWUP_STATE_RETENTION_HOURS` | `72` | TTL for terminal follow-ups on disk. In-flight always kept |
| `PLANNER_PLAN_NAME` | — | Disambiguate when `LEADERSHIP_TEAM_ID` has multiple plans (case-insensitive exact match) |
| `PLANNER_BUCKET_NAME` | `New` | Bucket-name to search for in the auto-resolved plan |

---

## 6. Run

```powershell
npm run dev
```

Expected boot output:

```text
[startup] ─── Chief of Staff — Configuration Check ───
[startup] ✅ AZURE_OPENAI_DEPLOYMENT=gpt-4o — endpoint=… api-version=2024-10-21
[startup] ✅ agent_id=e320…4964 — tenant=1fe4…8d81
[startup] ✅ LEADER_UPN=alex@… — LEADER_AAD_ID will auto-resolve on first turn
[startup] ✅ PLANNER_PLAN_ID=9H_e2N…AGlda
[startup] ✅ PLANNER_BUCKET_NEW=09dDjr…FVgg
[startup] ✅ LEADERSHIP_TEAM_ID=… — Recall gated to team members
[startup] ✅ COS_AGENT_UPN=chief-of-staff@… — meetings captured only when leader-organized AND CoS-invited
[startup] ✅ COS_AGENT_AAD_ID=<masked>
[startup] ✅ GRAPH_APP_ID=<masked> — Graph calls use standalone worker app (application permissions)
[startup] ℹ️  FOLLOWUP_ESCALATE_AFTER_HOURS=3 — owners are escalated if they don't reply within this window
[startup] ℹ️  NODE_ENV=development → reads ToolingManifest.json
[startup] ─────────────────────────────────────────────
[graphAppToken] standalone Graph worker configured (appId=…)
[scheduler] starting — brief="0 8 * * 1-5" followup="0 * * * *" escalate="0 */4 * * *" meetingPoll=60s tasksPoll=300s
[agent] CosAgent initialized (agentic auth)
[server] listening on 127.0.0.1:3978
```

Any ❌ red line **must** be fixed before proceeding.

### 6a. Wire a dev tunnel so Teams can reach you

In a **second** terminal:

```powershell
devtunnel host -p 3978 --allow-anonymous
```

Copy the `https://….devtunnels.ms` URL and set it as the **Messaging
endpoint** of the Azure Bot resource that `a365 develop setup` created for
your agent — append `/api/messages` to the tunnel URL:

1. Azure Portal → **Bot services** → select the bot named after your
   agent (e.g. `Chief-of-Staff`)
2. **Settings → Configuration**
3. **Messaging endpoint** = `https://<random>.devtunnels.ms/api/messages`
4. **Apply**

For Azure App Service deployments (§10), point the same field at
`https://<app>.azurewebsites.net/api/messages` instead.

---

## 7. First live proof

1. Open Teams as **the leader**.
2. DM the Chief-of-Staff agent: `hi`.
3. Expect an LLM reply within ~10 seconds.
4. Then: `Create a Planner task called "Test task" for me due tomorrow`.
5. Expect the task to appear in the `New` bucket in Planner within seconds.

If both work → auth + LLM + Graph + Planner pipeline is proven end-to-end.

> **Important:** the scheduler and Graph pollers only start firing **after
> step 2**. The first inbound Teams message is what bootstraps the agentic
> auth context.

---

## 8. Verify every feature end-to-end

Run through this once per fresh tenant. The list is the ground-truth
acceptance test — if all pass, someone else can reproduce your setup.

### 8.1 Capture

1. As the leader, create a Teams meeting for the next few minutes.
2. Invitees: the second test user **and** the CoS agent (`COS_AGENT_UPN`).
3. Both real users join and record. Say clear action items:
   *"Adele will send the pricing model by Friday"*,
   *"Decision: we go with tiered pricing"*.
4. End the meeting.
5. Within ~60 s the meeting watcher picks it up. It waits for the transcript
   (retries at `[1, 3, 7, 15, 30]` min, capped by the wait budget), then
   either uses Copilot AI insights (rich path) or falls back to transcript-only.
6. `runCapture` fires → Planner tasks appear with owners attributed and DM
   cards land in each owner's chat with the CoS.

**Success signals in the log:**

```text
[meetingWatcher] ✓ QUALIFIED "…" (ended) meetingId=…
[capturePoller] READY: "…" transcript=✓ content=✓ (N ch) insights=…
[capture] trigger received {…transcriptContentChars:…}
[capture] DEBUG dispatching prompt to LLM (…)
POST /planner/tasks   × N
```

### 8.2 Daily Brief

- Set `BRIEF_ENABLED=true`.
- Wait until 8 AM (`CRON_BRIEF` default) **or** temporarily set
  `CRON_BRIEF=* * * * *`, restart nodemon, DM `hi` to bootstrap auth,
  wait 60 s.
- The leader receives an Adaptive Card DM with Priorities, Watch items, and
  Upcoming meetings.
- Log: `[brief] ✓ DM sent to leader.`

### 8.3 Follow-up + interactive card responses

- Seed a task in the `New` bucket due tomorrow, assigned to the second user.
- Wait for the top-of-hour cron, or accelerate via `CRON_FOLLOWUP=* * * * *`.
- The owner receives an Adaptive Card with three buttons.
  - **On track** → agent confirms; Planner is patched to `In Progress 5%`;
    the follow-up is closed.
  - **Need more time** → agent proposes a new date and DMs the leader an
    approval card. Leader clicks **Approve new date** → agent PATCHes the
    Planner due date and DMs the owner.
  - **I'm blocked** → agent proposes 3 slots and DMs the leader a meeting
    picker. Leader clicks a slot → agent books the calendar invite and DMs
    the owner.

Every card also accepts a plain-text keyword reply (`ontrack`, `extend`,
`blocked`, `approve`, `reject`, `reassign`, `defer`) — used as a fallback in
tenants where Adaptive Card actions from Graph-sent cards don't route back to
the bot.

### 8.4 Escalation (owner ignored the check-in)

- Temporarily set `FOLLOWUP_ESCALATE_AFTER_HOURS=0.05` (~3 min) and
  `CRON_FOLLOWUP=*/2 * * * *`.
- Trigger a follow-up card, don't respond.
- After ~3 min the escalation sweep DMs the leader a 🚨 escalation card
  with Reassign / Give more time / Escalate to me buttons.
- Log: `[scheduler] escalating N stale followup(s) to leader …`.

**Auto-cancel behaviour:** if the owner marks the task complete (Planner
UI, chat, or the On-track button) *before* the escalation window elapses,
the sweep silently resolves the followup instead of sending a card
(belt-and-suspenders re-check of Planner state inside the sweep, on top of
the in-memory resolve fired by `runTaskComplete`).

### 8.5 Task complete via Planner

- Mark any Planner task **Complete** in the Planner UI.
- Within ~5 min (`POLL_TASKS_MS`) `plannerPoller` detects the
  `percentComplete: 100` transition and fires `runTaskComplete`.
- The owner gets a *"Thanks — X is marked complete"* DM.
- The leader gets a *"Adele completed X"* (or *"Blocker resolved — Adele
  completed X"* if the task was `[BLOCKER]` / `[RISK]` prefixed) DM.
- Any open follow-up for that task is auto-resolved so escalation won't fire.

### 8.6 Task complete via chat

- The owner DMs the CoS in plain English, including the task name in quotes:
  ```text
  Hi — the task "Send Contoso proposal to Alex" is done.
  ```
- Agent recognises the completion intent (`complete|completed|done|finished|
  closed|wrapped`), fuzzy-matches the quoted title against open Planner
  tasks (ignoring `[BLOCKER]`/`[RISK]`/`[DECISION]`/`[COMPLETED]` prefixes,
  preferring tasks assigned to the sender), and PATCHes
  `percentComplete: 100` on the winner.
- Agent replies: `✅ Nice work — marking "…" complete. (Planner updated: 100% complete)`.
- `plannerPoller` sees the transition on its next tick and fires
  `runTaskComplete`, which DMs the leader.
- If the quoted title is ambiguous (multiple matches), the agent asks for
  clarification and lists candidates.
- If the message is short (≤140 chars) and contains a completion verb but no
  quoted title, the agent falls back to the sender's latest open follow-up.

### 8.7 Recall (leader status query)

- Leader DMs: `where are we on Contoso?`
- Agent runs a single LLM turn with `planner_list_tasks` +
  `mcp_CalendarTools` to compose a bulleted answer.
- Non-leadership-team members get a polite refusal instead of leaking any
  task titles.

### 8.8 Restart doesn't re-capture already-processed meetings

- With the agent running, capture a meeting end-to-end (§8.1).
- Confirm the resulting Planner tasks exist and are attributed to the
  right owner.
- Stop the agent (`Ctrl+C`) — nodemon will flush the state files on
  `SIGINT`; you should see `[persistentMap] hydrated … kept=N pruned=0`
  on the next start.
- Restart with `npm run dev`.
- Within one meeting-poll tick (≤ 60 s), the log should show:
  ```
  [persistentMap] hydrated …/pending-captures.json: kept=N pruned=0
  [meetingWatcher] ✓ QUALIFIED "…" (ended) …
  [capturePoller] discovery: added 0 new qualifying meeting(s)
  ```
  — the qualifying meeting is discovered again but `hasCaptureForEvent`
  returns `true`, so no new pending capture is created. No duplicate
  Planner tasks appear.
- Inspect `./.cos-state/pending-captures.json` to see the persisted
  records; complete captures have their `transcriptContent` stripped.
- Also verify `./.cos-state/conversation-refs.json` — users who DM'd the
  agent are still there, so proactive cards fire without them needing to
  say "hi" again.

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Startup banner shows `❌ AZURE_OPENAI_*` | Foundry env vars missing | Fill from Foundry portal → Deployments |
| `NODE_ENV=production` in logs but you set `development` | Your shell has NODE_ENV set | `.env` uses `override:true`, so restart the shell |
| Teams reply is `Error: 404 Resource not found` from OpenAI | Wrong `AZURE_OPENAI_API_VERSION` | Use `2024-10-21` (not `preview`) |
| `Invalid schema for function 'planner_list_tasks'` | Azure OpenAI strict schema validator | Already fixed — planner tools ship `additionalProperties: false` |
| `Access denied: Scope 'McpServers.X.All'` | MCP scope not admin-consented | Grant it in Entra (see §3c) |
| `[scheduler] X skipped — no cached conversation reference` | Cron/poll fired before any Teams message | DM the agent once (`hi`) to seed the context |
| `[meetingWatcher] 403 Forbidden` | `Calendars.Read` missing / not consented | Add + admin-consent |
| `[transcriptFetch] 403` | `OnlineMeetingTranscript.Read.All` missing, or Teams application-access policy not granted | Add scope + run the `Grant-CsApplicationAccessPolicy` from §3b |
| `[capturePoller] COS_AGENT_UPN not set — Skipping` | Env var missing | Set `COS_AGENT_UPN` and restart |
| Capture never fires even though the meeting had a transcript | Leader didn't add the CoS agent to the invite, or leader isn't the organizer | Both are required — check `event.organizer.emailAddress.address` == `LEADER_UPN` AND `event.attendees` includes `COS_AGENT_UPN` |
| `aiInsights` always empty in logs | Leader has no M365 Copilot license, or the API is `/beta`-only in your tenant | Falls back to transcript-only extraction automatically — no action needed |
| `[scheduler] N stale followup(s) but LEADER_UPN is not set` | Escalation sweep can't find the leader | Set `LEADER_UPN` |
| `[scheduler] meeting-poll skipped — previous scan still in flight` | Overlapping tick because your `POLL_MEETINGS_MS` is shorter than a full scan | Harmless — the guard is doing its job. Increase to `60000` if you don't need the density |
| Adaptive Card button clicks do nothing | Recipient's Teams client isn't routing card actions back as Invoke activities | Users can type the fallback keyword (`ontrack` / `extend` / `blocked`); the router handles both |
| `AADSTS65001: consent_required` for instance app on first Teams turn | Instance-app SP has no `oauth2PermissionGrants` for MCP / platform scopes | Re-run `a365 develop setup` for this tenant — it re-provisions the MCP / platform consents on the instance SP |
| `AADSTS82007: Static consent method not supported for service accounts` when opening the `/adminconsent` URL | Signed-in admin is a service account (common in M365 CPI demo tenants) | Skip the browser flow — Path 1 (§3b) does everything via `az` |
| Duplicate Planner tasks after a demo | Two overlapping meeting-poll ticks ran capture twice | Guard is already in place (`meetingPollInFlight` in `scheduler.ts`) — verify you're on the latest code |
| Chat message "the task X is done" creates or renames a task instead of completing it | Old build — the deterministic completion router wasn't wired | Pull latest — `actionRouter.ts` handles this via `findOpenTaskByTitle` |
| `[followup] filtered out … "[COMPLETED] …" — 100% complete` | Working as intended — Planner already shows the task complete | No action |

Set `LOG_LEVEL=debug` and `LOG_HTTP=true` to see everything at the wire
level. Every log line is single-line JSON-ish, easy to grep.

### Diagnostic scripts

- **`compare_grants.ps1`** — compares delegated permission grants + app-role
  assignments between two agent-instance service principals. Useful when
  diagnosing "why does agent A see tool X but agent B doesn't?" — set the
  two `<AGENT_*_INSTANCE_APP_ID>` placeholders at the top, run
  `pwsh ./compare_grants.ps1`, and diff the output.

---

## 10. Deploy to Azure

The same code runs on Azure App Service (Linux, Node 20):

- Build: `npm run build` → point Node runtime at `dist/index.js`
- Set the exact same env vars in App Service Configuration
- Register App Service's `https://…/api/messages` URL as the messaging
  endpoint of your agent's bot channel

**Before production**, review [DESIGN.md §10.6](DESIGN.md#106-state-persistence)
and §13 for the single-instance limitation on `PersistentMap`. If you scale
out to multiple instances, swap `FileStateBackend` for a Blob backend behind
the same public API.

On Azure App Service **set `STATE_DIR=/home/data/cos-state`** — `/home` is the
per-app persistent volume that survives restarts. The default `./.cos-state`
relative path works locally but points at the deployment folder in Azure,
which is periodically rebuilt.

`agent.ts` uses `MemoryStorage` for the turn state — switch to `BlobsStorage`
for durability across restarts of the SDK-managed turn state (separate from
our `PersistentMap`-backed stores).

---

## What's next?

- Read **[DESIGN.md](DESIGN.md)** for the architecture, per-flow sequence
  diagrams, all env vars explained, and extension points.
- Test each of the seven flows in §8 against a fresh tenant to prove
  reproducibility.
- File issues if something in the setup guide doesn't match your experience.

---

## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-nodejs/issues) section
- **Documentation**: See the [Microsoft Agents 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: For security issues, please see [SECURITY.md](../../SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- **[DESIGN.md](DESIGN.md)** — architecture, per-flow sequence diagrams, all env vars explained, and extension points for this sample
- [Microsoft Agent 365 SDK - Node.js repository](https://github.com/microsoft/Agent365-nodejs)
- [Microsoft 365 Agents SDK - Node.js repository](https://github.com/Microsoft/Agents-for-js)
- [OpenAI API documentation](https://platform.openai.com/docs/)
- [Node.js API documentation](https://learn.microsoft.com/javascript/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](../../LICENSE.md) file for details.
