# Chief of Staff Teammate — `cos-agent`

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
| **Capture** — extracts action items + decisions from Teams meetings and creates Planner tasks (extraction is checkpointed, then tasks and assignment cards are written by code, so a retry never duplicates work) | Calendar poller finds any Teams meeting with both the leader and the CoS on the invite (any organizer; in-progress and upcoming meetings are tracked until their transcript exists), the transcript for that occurrence is fetched, LLM extracts |
| **Daily Brief** — Adaptive Card DM to the leader with priorities, watch items, upcoming meetings | Cron (default 8 AM weekdays, gated behind `BRIEF_ENABLED`) |
| **Follow-up** — Adaptive Card DM to each at-risk owner — every current assignee of a task gets their own card (`On track` / `Need more time` / `I'm blocked`) | Cron (default hourly) |
| **Extension request** — leader gets an approval card, agent PATCHes Planner due date on approval | Owner clicks "Need more time" or types `extend` |
| **Blocker meeting** — agent proposes 3 slots, books calendar invite on click | Owner clicks "I'm blocked" or types `blocked` |
| **Escalation** — 🚨 card DM'd to the leader if the owner ignores their follow-up | Post-followup sweep after `FOLLOWUP_ESCALATE_AFTER_HOURS`; auto-cancels if the task is closed first |
| **Task complete (Planner)** — owner marks it done in Planner, leader gets a confirmation DM | Planner poll detects `percentComplete: 100` |
| **Task complete (chat)** — owner tells the agent in plain language ("`The task "X" is done`"), agent PATCHes Planner to 100 % and notifies leader | Message router matches completion phrase + quoted title, fuzzy-matches Planner |
| **Recall / chit-chat** — the leader asks "where are we on X?" and gets a status answer, restricted to leadership team members (Teams chat **and** email) | LLM turn with `planner_list_tasks` + `mcp_CalendarTools` |

Everything is deterministic **except** capture extraction (LLM parses the
transcript), recall/chit-chat, and free-text unblock. Card booking and
meeting-summary posts call WorkIQ directly with code-bound recipients,
timestamps, and text. They require
an actual event/message ID in the tool result; model text such as `OK` is not
a success signal. A free-text DM can still book through the conversational
client's MCP tools. All routing, dedup, date math, and Planner writes are TypeScript.

`npm test` builds the sample and runs offline regression tests with mocked
Graph/MCP responses; CI runs the same command on Node 20 and 22. No tenant
credentials are required. Direct WorkIQ writes require a catalog schema that
can bind all approved fields; unsupported or ambiguous schemas fail before
making a write. Verify live tool compatibility in the target tenant before
relying on booking or summary delivery.

Due days from chat, capture, and extension requests use `BRIEF_DISPLAY_TZ`
and are stored at 17:00 local. Date-only input (`YYYY-MM-DD`) is preferred;
legacy UTC-midnight values are treated as that same civil due day.
This legacy conversion happens only at the conversational tool boundary;
capture checkpoints already hold resolved instants and pass them unchanged
to Planner and the assignment card.
The conversational extension-card tool follows the same boundary: its card
and stored proposal share one normalized instant. A card for a superseded
proposal cannot approve a newer date; use the latest card or a typed decision.

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
- A **leader** test account with a mailbox (e.g. `mario@…`)
- At least one **second test user** with a mailbox (e.g. `peyton@…`)
- (Optional) **Microsoft 365 Copilot** license on the leader — enables
  pre-extracted `aiInsights` on meetings. Without it the agent falls back to
  LLM extraction from the raw transcript. Nothing else changes.

### 3a. Create the agent identity

From `scenarios/chief-of-staff` (relative to the repo root):

```powershell
cd scenarios/chief-of-staff
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
cd scenarios/chief-of-staff
.\scripts\bootstrap-graph-app.ps1
```

The script:

1. Finds the Entra app named exactly `cos-graph-worker` (and stops if more
   than one app has that name), or creates it.
2. Adds the least-privilege application permissions the sample's code uses:
   `Calendars.Read`, `OnlineMeetings.Read.All`,
   `OnlineMeetingTranscript.Read.All`, `OnlineMeetingAiInsight.Read.All`,
   `Tasks.ReadWrite.All`, `User.Read.All`, `GroupMember.Read.All`,
   `ChatMember.Read.All` (read-only, for the meeting-attendee lookup). No
   chat create/write permission is requested — card DMs use Bot Framework.
3. Admin-consents them tenant-wide via `az` (no browser, avoids
   AADSTS82007 in demo tenants), then waits until every role is assigned.
   Because `admin-consent` grants **everything** the app requests, the script
   first lists the app's permissions and stops — without consenting — if a
   reused `cos-graph-worker` app requests anything beyond these eight roles;
   remove the extras and re-run. If consent fails, it exits non-zero
   **before** creating any secret.
4. Creates a client secret only when the app has no unexpired one, and
   prints:
   ```text
   GRAPH_APP_ID=<guid>
   GRAPH_APP_SECRET=<secret>
   GRAPH_TENANT_ID=<guid>
   ```
   Paste those three into `scenarios/chief-of-staff/.env`.

Re-running is safe: missing permissions are added and verified, and an
existing secret is **kept**. To issue a new secret, run with
`-RotateSecret` — it is appended (old secrets are not deleted), so remove
the previous one yourself after `.env` and App Service use the new value.

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
| **CoS-agent-only (recommended)** — grants only to the CoS agent UPN. Every Graph call reads as the CoS agent. Any meeting with both the leader and `Chief-of-Staff@…` on the invite gets captured. Zero admin work per leader. | `Grant-CsApplicationAccessPolicy -PolicyName "cos-agent-policy" -Identity "<COS_AGENT_UPN>"` | Just add them to the invite |
| **Tenant-wide** — grants to every user. Simple for demo tenants. Broad exposure in production. | `Grant-CsApplicationAccessPolicy -PolicyName "cos-agent-policy" -Global` | Nothing |
| **Per-leader** — precise but manual. Cmdlet re-run for each new leader. | `Grant-CsApplicationAccessPolicy -PolicyName "cos-agent-policy" -Identity "<LEADER_UPN>"` | Re-run cmdlet |

For strategy 1 (recommended), leave `CAPTURE_GRAPH_OWNER=cos-agent` in `.env`
(the default). For strategies 2 or 3, set `CAPTURE_GRAPH_OWNER=leader`.

> **Note:** policy assignment can take up to 30 minutes to propagate through
> Teams. Test with a *fresh* meeting after running the grant.

Verify:

```powershell
az rest --method GET `
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/<sp-object-id>/appRoleAssignments" `
  -o table
```

Eight rows expected — one per permission listed in step 2.

> **Adaptive-card DMs** are sent via Bot Framework proactive messaging, not
> Graph — so they need no Graph scope. The recipient must have DM'd the
> agent (or installed the app in Teams) at least once so the agent has a
> cached personal-chat `ConversationReference` for them; that reference is
> persisted to `.cos-state/conversation-refs.json` and survives restarts.
> Group-chat or channel references are never stored as DM destinations.


### 3c. Grant WorkIQ (MCP) server permissions

The agent registers the three WorkIQ servers listed in `ToolingManifest.json`
itself (`addWorkIqServersToAgent` in `src/workiq.ts`). Each server has its
**own** resource (audience) and uses the delegated `Tools.ListInvoke.All`
scope; the agent requests a separate agentic token per server.

| MCP server | Resource (audience) | Delegated scope |
|---|---|---|
| `mcp_MailTools` | `16b1878d-62c7-4009-aa25-68989d63bbad` | `Tools.ListInvoke.All` |
| `mcp_TeamsServer` | `ce5029ee-c1d3-45c0-bdcc-efb5a4245687` | `Tools.ListInvoke.All` |
| `mcp_CalendarTools` | `910333d2-47e9-43ca-981f-6df2f4531ef4` | `Tools.ListInvoke.All` |

`a365 develop setup` normally grants these. If it didn't, run
`a365 setup permissions mcp` as a Global Administrator from this folder —
it reads `ToolingManifest.json` and grants each server's scope with
inheritance to the agent instance.

### 3d. Create the leadership Team

In Teams:

1. Create a Team named **Leadership Operations** (or similar).
2. Add the **leader** as owner.
3. Add the **agent user** (`Chief-of-Staff@…`) as a member.
4. Add the **second test user** as a member.
5. Grab the **Team ID** from the Team URL (`groupId=<GUID>`) → this is
   `LEADERSHIP_TEAM_ID` in `.env`. The GUID is recommended because this value
   is the access boundary. A *display name* (`Leadership Operations`) or the
   *channel email* also works, but only if it matches exactly one group — if
   two Teams share the name, the agent refuses to pick one and denies
   non-leaders until you set the GUID.

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

**To skip auto-resolve entirely** (fastest boot; the §3b Graph worker is
still required), paste the explicit IDs from Planner UI + Graph
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
cd scenarios/chief-of-staff
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
LEADER_UPN=mario@yourdomain.onmicrosoft.com

# CoS agent's own inviteable UPN — REQUIRED for meeting capture
COS_AGENT_UPN=chief-of-staff@yourdomain.onmicrosoft.com

# Standalone Graph worker app — REQUIRED; printed by scripts/bootstrap-graph-app.ps1 (§3b)
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

# Local dev only — do NOT copy HOST / NODE_ENV to App Service (see §10)
NODE_ENV=development
HOST=127.0.0.1
PORT=3978
```

**Optional tunables** (all have sensible code defaults — see `.env.template`
for the exhaustive list):

| Env | Default | Description |
|---|---|---|
| `LEADER_NAME` | — | Display name used in card copy (e.g. "Assigned by: Mario"). Falls back to "the Leader" when unset |
| `BRIEF_ENABLED` | `false` | Set to `true` to turn on the daily Brief cron |
| `CRON_BRIEF` | `0 8 * * 1-5` | When the Brief card fires (8 AM weekdays) |
| `CRON_FOLLOWUP` | `0 * * * *` | When follow-up cards fire (each tick also runs the deterministic escalation sweep) |
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
| `LOG_HTTP` | `false` | Log every outbound HTTP call with status + latency (ids, UPNs, and query strings in URLs are masked) |
| `SCHEDULER_ENABLED` | `true` | Set `false` to disable all crons + pollers |
| `SKIP_TOOLING_ON_ERRORS` | `false` | `false` fails a turn when WorkIQ MCP registration fails; `true` continues without those tools |
| `BRIEF_DISPLAY_TZ` | `Asia/Kolkata` | Wall-clock TZ for card dates and blocker meeting slots (DST-aware) |
| `STATE_BACKEND` | `file` | `file` (persist to disk) or `null` (in-memory only, for tests) |
| `STATE_DIR` | `./.cos-state` | Root dir for state files. On Azure App Service: `/home/data/cos-state` |
| `CAPTURE_STATE_RETENTION_DAYS` | `30` | TTL for finished captures on disk. In-flight records always kept |
| `FOLLOWUP_STATE_RETENTION_HOURS` | `72` | TTL for terminal follow-ups on disk. In-flight always kept |
| `PLANNER_PLAN_NAME` | — | Disambiguate when `LEADERSHIP_TEAM_ID` has multiple plans (case-insensitive exact match) |
| `PLANNER_BUCKET_NAME` | `New` | Bucket-name to search for in the auto-resolved plan |

`ALLOW_DIRECT_USER_ACTIONS` defaults to `false`. Set it to `true` to let
authenticated direct requests invoke action tools. Instructions embedded in
emails, documents, transcripts, web content, and tool results stay untrusted.

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
[startup] ✅ LEADER_UPN=mar…@… — LEADER_AAD_ID will auto-resolve on first turn
[startup] ✅ PLANNER_PLAN_ID=9H_e2N…AGlda
[startup] ✅ PLANNER_BUCKET_NEW=09dDjr…FVgg
[startup] ✅ LEADERSHIP_TEAM_ID=… — Recall gated to team members
[startup] ✅ COS_AGENT_UPN=chi…@… — meetings captured whenever BOTH the leader and this UPN are on the invite (any organizer, including in-progress/upcoming meetings)
[startup] ✅ GRAPH_APP_ID=<masked> — Graph calls use standalone worker app (application permissions)
[startup] ℹ️  FOLLOWUP_ESCALATE_AFTER_HOURS=3 — owners are escalated if they don't reply within this window
[startup] ℹ️  NODE_ENV=development
[startup] ℹ️  WorkIQ MCP servers are read from ToolingManifest.json (deploy it next to dist/) with a per-server agentic token. SKIP_TOOLING_ON_ERRORS=false — a registration failure fails the turn.
[startup] ─────────────────────────────────────────────
[graphAppToken] standalone Graph worker configured (appId=…)
[scheduler] restored persisted conversation reference — scheduled work resumes immediately.
[scheduler] starting — brief="0 8 * * 1-5" followup="0 * * * *" tz=server-local meetingPoll=60s tasksPoll=300s
[agent] CosAgent initialized (agentic auth)
[server] listening on 127.0.0.1:3978
```

On a brand-new deployment the scheduler line reads
`no conversation reference yet — scheduled work starts after the first message to the agent.`

Any ❌ red line **must** be fixed before proceeding.

### 6a. Wire a dev tunnel so Teams can reach you

In a **second** terminal:

```powershell
devtunnel host -p 3978 --allow-anonymous
```

Copy the `https://….devtunnels.ms` URL and register it as the messaging
endpoint of your agent's bot channel (via the Agent 365 Toolkit or the Teams
admin center).

---

## 7. First live proof

1. Open Teams as **the leader**.
2. DM the Chief-of-Staff agent: `hi`.
3. Expect an LLM reply within ~10 seconds.
4. Then a read-only check: `What tasks are in my Planner plan?` — expect a
   short list (proves auth + LLM + Graph + Planner reads).
5. To also prove writes, set `ALLOW_DIRECT_USER_ACTIONS=true` in `.env`,
   restart, and send `Create a Planner task called "Test task" for me due tomorrow`.
   Expect the task in the `New` bucket within seconds. With the default
   `false`, the agent treats direct commands as data and won't perform this
   write — that is the intended safety default (see §5).

If these work → auth + LLM + Graph + Planner pipeline is proven end-to-end.

> **Important:** on a brand-new deployment the scheduler and Graph pollers
> start firing **after step 2** — the first inbound Teams message bootstraps
> the agentic auth context. That reference is persisted, so after a restart
> scheduled work resumes on boot without another message.

---

## 8. Verify every feature end-to-end

Run through this once per fresh tenant. The list is the ground-truth
acceptance test — if all pass, someone else can reproduce your setup.

### 8.1 Capture

1. Create a Teams meeting for the next few minutes (any organizer works —
   the leader, a delegate, or another exec).
2. Invitees: the leader, the second test user, **and** the CoS agent
   (`COS_AGENT_UPN`). Capture requires both the leader and the CoS on the
   invite.
3. Both real users join and record. Say clear action items:
   *"Peyton will send the pricing model by Friday"*,
   *"Decision: we go with tiered pricing"*.
4. End the meeting.
5. Within ~60 s the meeting watcher picks it up. It waits for the transcript
   (retries at `[1, 3, 7, 15, 30]` min, capped by the wait budget), then
   either uses Copilot AI insights (rich path) or falls back to transcript-only.
6. `runCapture` fires → Planner tasks appear with owners attributed and DM
   cards land in each owner's chat with the CoS.

**Success signals in the log:**

```text
[meetingWatcher] ✓ QUALIFIED event=…<id-tail> (ended) meetingId=…
[capturePoller] READY: event=…<id-tail> transcript=✓ content=✓ (N ch) insights=…
[capture] trigger received {…transcriptContentChars:…}
[capture] DEBUG dispatching prompt to LLM (…)
POST /planner/tasks   × N
```

### 8.2 Daily Brief

- Set `BRIEF_ENABLED=true`.
- Wait until 8 AM (`CRON_BRIEF` default) **or** temporarily set
  `CRON_BRIEF=* * * * *`, restart nodemon, and wait 60 s (DM `hi` first
  only on a brand-new deployment that has never received a message).
- The leader receives an Adaptive Card DM with Priorities, Watch items, and
  Upcoming meetings.
- Log: `[brief] ✓ DM sent to leader.`

### 8.3 Follow-up + interactive card responses

- Seed a task in the `New` bucket due tomorrow, assigned to the second user.
- Wait for the top-of-hour cron, or accelerate via `CRON_FOLLOWUP=* * * * *`.
- The owner receives an Adaptive Card with three buttons.
  - **On track** → agent confirms; Planner is patched to `In Progress 5%`;
    the follow-up is closed.
  - **Need more time** → agent proposes a new date (5 business days out,
    counted on the `BRIEF_DISPLAY_TZ` calendar) and DMs the leader an
    approval card. Leader clicks **Approve new date** → agent PATCHes the
    Planner due date and, only once that succeeds, confirms to the leader
    and DMs the owner. If the PATCH fails, both are told it isn't synced
    yet and the request stays pending for a retry. Once a request is
    approved, rejected, or cancelled, its old card can't change Planner
    again.
  - **I'm blocked** → agent proposes 3 slots (10:00 / 14:00 / 16:00 in
    `BRIEF_DISPLAY_TZ`) and DMs the leader a meeting picker. Leader clicks a
    slot → agent books the calendar invite first; only when the booking
    returns a created event ID does it close the check-in and DM the owner that the meeting
    is scheduled. A failed booking leaves the check-in open, tells the owner
    nothing was booked, and lets the leader pick another slot. Only one
    booking runs at a time per card, so clicking a second slot while the
    first is booking doesn't create a second meeting. A delivered card whose
    task has since been completed (or whose request was closed) books
    nothing.
  - If the leader's card can't be delivered (e.g. the leader hasn't messaged
    the agent yet), the extension/blocker request is saved and retried on
    every follow-up cycle (up to `LEADER_DELIVERY_MAX_ATTEMPTS`, default 24);
    the owner is DM'd once it's delivered, or told to contact the leader
    directly if it never is. If the task is completed in the meantime, the
    queued request is dropped instead of being sent.

Every card also accepts a plain-text keyword reply. Owners can reply
`ontrack`, `extend`, or `blocked`. The leader can reply `approve` or
`reject` to a pending extension request (if several are pending, the agent
asks you to use the matching card's buttons), plus `reassign` / `defer` /
`escalate`. Leader keywords are only honored from the configured leader;
card buttons are checked against the sender too — owners can only act on
check-ins that are still open and on tasks Planner currently assigns to
them (a closed check-in only accepts **Complete**).

**Reassign is a manual handoff.** The agent has no "change assignee" action:
clicking **Reassign** closes the check-in, cancels the owner's pending
extension request (so a typed `approve` can't revive it), and tells the
leader to change the assignee in Planner. The next follow-up cycle then checks in with the new
owner.

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
- The leader gets a *"Peyton completed X"* (or *"Blocker resolved — Peyton
  completed X"* if the task was `[BLOCKER]` / `[RISK]` prefixed) DM.
- If a DM fails, the transition is kept and retried on the next poll; only
  recipients who weren't notified yet are messaged again.
- Any open follow-up for that task is auto-resolved so escalation won't fire.

### 8.6 Task complete via chat

- The owner DMs the CoS in plain English, including the exact task title in
  quotes:
  ```text
  Hi — the task "Send Contoso proposal to Mario" is done.
  ```
- Agent recognises only an affirmative statement that the work is already
  done (e.g. "is done", "I've finished", "completed"). Negations ("I have
  not completed…"), questions ("Is … done?"), requests ("Please check
  whether … is done", "can you confirm …"), and future or conditional
  phrasing ("I will finish …", "almost done", "done once Bob replies") are
  never treated as completion. Quoted titles are ignored when classifying
  the sentence.
- The quoted title is matched against open Planner tasks **assigned to the
  sender** (the leader may name any task), ignoring
  `[BLOCKER]`/`[RISK]`/`[DECISION]`/`[COMPLETED]` prefixes. Identifying
  tokens such as `Q2`, `v1`, or numbers must match.
- Only an exact title match is completed. "Exact" ignores only case,
  whitespace, and those prefixes — punctuation and non-ASCII letters must
  match, so `"Review C# hiring plan"` never completes `Review C++ hiring
  plan`. A close-but-not-exact match gets a
  "Did you mean …?" reply and nothing changes until the exact title is sent.
- Agent replies: `✅ Nice work — marking "…" complete. (Planner updated: 100% complete)`.
- `plannerPoller` sees the transition on its next tick and fires
  `runTaskComplete`, which DMs the leader.
- If the quoted title is ambiguous (multiple matches), the agent asks for
  clarification and lists candidates. If it matches nothing, the agent says
  so and does **not** fall back to a different task.
- Only when the message names no task at all (short affirmative message,
  ≤140 chars) does the agent use the sender's latest open follow-up.

### 8.7 Recall (leader status query)

- Leader DMs: `where are we on Contoso?`
- Agent runs a single LLM turn with `planner_list_tasks` +
  `mcp_CalendarTools` to compose a bulleted answer.
- Non-leadership-team members get a polite refusal instead of leaking any
  task titles — and their turn runs with no tools at all (no Planner,
  calendar, mail, Teams, card, or directory/people lookups). The same gate applies to **email**: the sender is
  resolved to an Entra user (the channel's AAD id, or a lookup of the sender
  address), and a sender who isn't a member — or can't be identified, such
  as an external address — gets the restricted toolset. If
  `LEADERSHIP_TEAM_ID` is set but can't be resolved (including a display
  name shared by several Teams) or membership can't be read, non-leaders are
  treated as non-members (fail closed).

### 8.8 Restart resumes scheduled work and doesn't re-capture meetings

- With the agent running, capture a meeting end-to-end (§8.1).
- Confirm the resulting Planner tasks exist and are attributed to the
  right owner.
- Stop the agent (`Ctrl+C`) — nodemon will flush the state files on
  `SIGINT`; you should see `[persistentMap] hydrated … kept=N pruned=0`
  on the next start.
- Restart with `npm run dev` and **do not** message the agent.
- The boot log shows
  `[scheduler] restored persisted conversation reference — scheduled work resumes immediately.`
- Within one meeting-poll tick (≤ 60 s), the log should show:
  ```
  [persistentMap] hydrated …/pending-captures.json: kept=N pruned=0
  [meetingWatcher] ✓ QUALIFIED event=…<id-tail> (ended) …
  ```
  and **no** `[capturePoller] discovery: added …` line for that meeting —
  it is discovered again, but its capture is already recorded as complete,
  so no new pending capture is created. No duplicate Planner tasks appear.
- Inspect `./.cos-state/pending-captures.json` to see the persisted
  records; complete captures have their `transcriptContent` stripped.
  A capture whose processing failed stays `ready` and is retried.
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
| `Access denied: Scope … is not present in the request` from a WorkIQ MCP server | That server's `Tools.ListInvoke.All` grant is missing, or `ToolingManifest.json` has a stale audience | Re-run `a365 develop add-mcp-servers` for the server, then `a365 setup permissions mcp` as Global Admin (see §3c) |
| `WorkIQ MCP registration failed …` turn error | A WorkIQ server couldn't be registered and `SKIP_TOOLING_ON_ERRORS=false` | Fix the cause in the message (manifest, grant, or dev token), or set `SKIP_TOOLING_ON_ERRORS=true` to continue without those tools |
| `[scheduler] X skipped — no cached conversation reference` | Brand-new deployment that has never received a message (restarts restore the persisted reference) | DM the agent once (`hi`) to seed the context |
| `[meetingWatcher] 403 Forbidden` | `Calendars.Read` missing / not consented | Add + admin-consent |
| `[transcriptFetch] 403` | `OnlineMeetingTranscript.Read.All` missing, or Teams application-access policy not granted | Add scope + run the `Grant-CsApplicationAccessPolicy` from §3b |
| `[capturePoller] COS_AGENT_UPN not set — Skipping` | Env var missing | Set `COS_AGENT_UPN` and restart |
| Capture never fires even though the meeting had a transcript | The leader or the CoS agent isn't on the invite | Both are required (organizer doesn't matter) — check that the event's organizer + `attendees` include both `LEADER_UPN` and `COS_AGENT_UPN` |
| `aiInsights` always empty in logs | Leader has no M365 Copilot license, or the API is `/beta`-only in your tenant | Falls back to transcript-only extraction automatically — no action needed |
| `[scheduler] N stale followup(s) but LEADER_UPN is not set` | Escalation sweep can't find the leader | Set `LEADER_UPN` |
| `[scheduler] meeting-poll skipped — previous scan still in flight` | Overlapping tick because your `POLL_MEETINGS_MS` is shorter than a full scan | Harmless — the guard is doing its job. Increase to `60000` if you don't need the density |
| MAC Activity tab in the admin center is empty even though `agent365-export succeeded` shows in logs | Blueprint-only token refresh — the exporter partitions groups by `(agentId, tenantId)` and drops groups without a cached token silently. The Activity tab is keyed on the agentic-instance id. | Already handled — `src/observability.ts::ensureObservabilityToken` refreshes tokens for BOTH blueprint and instance identities. Verify `[Agent365Exporter] Token resolved successfully` and per-group `export-group succeeded` events appear in your log for **your** agent-instance id (the `recipient.agenticAppId` on inbound activities). |
| MAC Activity "User principal name" column shows a base64 blob instead of `mario@…` | Tenant privacy setting hashes UPNs in all reports | Microsoft 365 admin center → Settings → Org Settings → Services → Reports → uncheck "Conceal user, group, and site names in all reports" → Save. Refresh after ~5 min. |
| Adaptive Card button clicks do nothing | Recipient's Teams client isn't routing card actions back as Invoke activities | Users can type the fallback keyword (`ontrack` / `extend` / `blocked`); the router handles both |
| `AADSTS65001: consent_required` for instance app on first Teams turn | Instance-app SP has no `oauth2PermissionGrants` for MCP / platform scopes | Re-run `a365 develop setup` for this tenant — it re-provisions the MCP / platform consents on the instance SP |
| `AADSTS82007: Static consent method not supported for service accounts` when opening the `/adminconsent` URL | Signed-in admin is a service account (common in M365 CPI demo tenants) | Skip the browser flow — Path 1 (§3b) does everything via `az` |
| Duplicate Planner tasks after a demo | Two overlapping meeting-poll ticks ran capture twice | Guard is already in place (`meetingPollInFlight` in `scheduler.ts`) — verify you're on the latest code |
| Chat message "the task X is done" creates or renames a task instead of completing it | Old build — the deterministic completion router wasn't wired | Pull latest — `actionRouter.ts` handles this via `findOpenTaskByTitle` |
| `[followup] filtered out … "[COMPLETED] …" — 100% complete` | Working as intended — Planner already shows the task complete | No action |

Set `LOG_LEVEL=debug` and `LOG_HTTP=true` to see everything at the wire
level. Every log line is single-line JSON-ish, easy to grep.

---

## 10. Deploy to Azure

The same code runs on Azure App Service (Linux, Node 20):

- Build: `npm run build` → point Node runtime at `dist/index.js`
- Deploy `ToolingManifest.json` next to `dist/` — the WorkIQ MCP servers are
  read from it at runtime (there is no gateway discovery).
- Set the env vars from §5 in App Service Configuration, **except the
  local-only values**: set `NODE_ENV=production`, omit `HOST` (or set
  `HOST=0.0.0.0`), and let App Service supply `PORT`. Copying
  `HOST=127.0.0.1` or `NODE_ENV=development` binds the server to loopback
  and App Service can't reach it. Keep `USE_AGENTIC_AUTH=true` and don't copy
  any `BEARER_TOKEN_*` values — static WorkIQ tokens are accepted only when
  `NODE_ENV=development`.
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
