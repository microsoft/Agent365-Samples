# Scrum Master autopilot — Agent 365 scenario sample (Node.js)

An autonomous **Scrum Master** built on the [Microsoft Agent 365 SDK](https://github.com/microsoft/Agent365-nodejs) that runs a scrum team's ceremonies end-to-end: daily standups, board reconciliation, blocker chase, mid-sprint risk warnings, grounded Q&A, and the sprint close report — all as proactive Adaptive Card conversations in Microsoft Teams. This is a **scenario extension** on top of the base [OpenAI + Node.js sample-agent](../../nodejs/openai/sample-agent); see that folder for A365 SDK primer material (user identity, install events, typing indicators).

> **Stack:** Node.js · TypeScript · Microsoft Agent 365 SDK · OpenAI Agents SDK · Jira Cloud REST v3 + Agile 1.0 · Microsoft Graph (delegated) · MCP Calendar tools · Adaptive Cards.

> 📘 Architecture, per-flow sequence diagrams, module responsibilities, and extension points live in **[`docs/design.md`](docs/design.md)**. This README is only about **getting the agent running end-to-end** and trying each capability.

## Contents

1. [What it does](#what-it-does)
2. [Prerequisites](#prerequisites)
3. [Quick start — mock mode (no external services)](#quick-start--mock-mode-no-external-services)
4. [Full setup — live mode](#full-setup--live-mode)
5. [First live proof](#first-live-proof)
6. [Try each capability](#try-each-capability)
7. [Configuration reference](#configuration-reference)
8. [Internal HTTP endpoints](#internal-http-endpoints)
9. [SharePoint schema](#sharepoint-schema)
10. [Reset the demo](#reset-the-demo)
11. [Troubleshooting](#troubleshooting)
12. [Deploy to Azure](#deploy-to-azure)
13. [Known limitations](#known-limitations)
14. [Support · Contributing · Trademarks · License](#support)

## What it does

Seven capabilities, each a handler under [`src/handlers/`](src/handlers). Live mode uses proactive DMs, SharePoint records, and grounded Jira tools. Standup aggregation and daily deduplication are process-local; they do not survive restart or coordinate replicas.

1. **Standup** — Proactively DMs every squad member an Adaptive Card listing their sprint tasks with an update field and blocker toggle. Aggregates responses into a summary card posted to the configured channel. See [`handlers/standup.ts`](src/handlers/standup.ts).
2. **Board reconciliation** — A deterministic phrase classifier reads each update, maps it to a Jira status, and either auto-applies safe forward transitions or DMs the Scrum Master an approval card for ambiguous moves. See [`handlers/reconcile.ts`](src/handlers/reconcile.ts).
3. **Blocker chase** — When someone flags a blocker, the agent matches a subject-matter expert from the helper roster, calls the MCP Calendar tool for open slots, and books an unblock meeting on its own mailbox with the SM + owner + reporter as attendees. See [`handlers/chase.ts`](src/handlers/chase.ts).
4. **Sprint risk warn** — Nightly check: if the sprint is past the halfway mark and too many points are still in "To Do", DMs the SM with a risk assessment. See [`handlers/warn.ts`](src/handlers/warn.ts).
5. **Grounded Q&A** — Free-text questions ("what's the status of Task-14?", "latest update on Task-6?") go to a scenario-specific OpenAI Agent whose tools read only the configured Jira project. Rolling history is isolated by caller and conversation, so follow-ups stay within the same audience. See [`handlers/answer.ts`](src/handlers/answer.ts).
6. **Mid-sprint RAG report** — Two days before sprint end, classifies every task Red/Amber/Green by due date and posts a prioritised risk table to the channel. See [`handlers/sprint-summary.ts`](src/handlers/sprint-summary.ts).
7. **Sprint close report** — On sprint end, auto-generates a management-ready summary (completed stories, deliverables, release notes, action items, metrics) and posts inline to the channel. See [`handlers/report.ts`](src/handlers/report.ts).

Full flow diagrams for each capability are in [`docs/design.md#5-the-seven-flows`](docs/design.md#5-the-seven-flows).

## Prerequisites

Fast path (mock standup): **Node.js and npm are required.** Jira and roster data are in-memory; no Graph/SharePoint setup is needed for this path. Free-text Q&A still requires OpenAI or Azure OpenAI credentials and network access.

| Requirement | Needed for | Notes |
|---|---|---|
| **Node.js ≥ 22** | Agent host | Required by the OpenAI Agents SDK; use a current LTS |
| **Azure OpenAI or OpenAI API key** | Q&A + calendar tool | `gpt-4o` recommended |
| Atlassian Cloud (free) | Live Jira mode | Skip if `JIRA_MODE=mock`. [Sign up](https://www.atlassian.com/software/jira/free) |
| Microsoft 365 dev tenant | Live SharePoint mode | Skip if you only exercise the Q&A path |
| Agent 365 CLI | Deploying to Teams | Not needed for local Playground testing |

The agent uses OpenAI Agents SDK 0.7.x to match the Agent 365 OpenAI adapters, OpenAI 6.x, and Zod 4.6.6 or later. Keep these dependencies compatible when upgrading; older Zod releases are affected by [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).

The Zod override applies to SDK transitive consumers too, removing their vulnerable nested 3.25.75 copy. Offline tests exercise the real hosting/activity message, card, semantic-action and feedback schemas, including invalid input rejection, in addition to the OpenAI tool/output schemas.

The hosting package's MSAL dependency is overridden to patched 7.1.2+ for [GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5), because hosting 1.9.1 pins affected MSAL 5.6.0. The separate Graph device-code MSAL dependency is unchanged. Offline compatibility tests cover hosting client-credentials and OBO calls.

OpenTelemetry's Node SDK is pinned through an override to patched 0.217.x for [GHSA-q7rr-3cgh-j5r3](https://github.com/advisories/GHSA-q7rr-3cgh-j5r3); this also selects its patched Prometheus exporter without changing the agent's exporter configuration.

Its optional Jaeger propagator is overridden to 2.9.0+ for [GHSA-45rx-2jwx-cxfr](https://github.com/advisories/GHSA-45rx-2jwx-cxfr). This does not enable Jaeger propagation; it keeps the installed dependency safe if explicitly selected.

The 0.217.x OTLP transformer's protobuf runtime is overridden to 8.6.6+ to avoid the affected 8.0.1 release. Offline tests serialize real A365 spans through that patched runtime; older 7.x consumers retain their own compatible version.

Until the package feed serves `follow-redirects` 1.16.2, the package pins the official MIT-licensed release at immutable Git commit `7130c835c45e71dcce25fcc999febe14c97ef64d` and shares that version with Axios. A loopback-only regression test verifies normal and cross-realm sensitive-header arrays. Replace the Git source with the patched registry release once it is available; do not downgrade Axios or suppress [GHSA-mrwp-f3q8-3g9p](https://github.com/advisories/GHSA-mrwp-f3q8-3g9p).

## Quick start — mock mode (no external services)

Uses the built-in mock Jira sprint in [`src/mock/jira-mock.ts`](src/mock/jira-mock.ts) and an in-memory roster/standup path. This exercises local card interactions, not real Teams delivery or SharePoint persistence.

```powershell
git clone https://github.com/microsoft/Agent365-Samples.git
cd Agent365-Samples/scenarios/scrum-master

cp .env.template .env
# Leave JIRA_MODE=mock and JIRA_PROJECT_KEY=SCRUM.
# For optional free-text Q&A, set AZURE_OPENAI_* (or OPENAI_API_KEY).

npm install
npm run dev
```

In another terminal:

```powershell
npm run test-tool     # opens the Agents Playground
```

In a personal Playground conversation, DM the agent `/standup`. The first caller is bound to the mock Alex (Scrum Master) roster entry and receives Alex's tasks. Other mock assignees are unreachable until they interact in their own conversations; this is not a four-member delivery proof. Fill in an update and click **Submit**. The summary waits for expected responses or the cutoff. Then try:

Mock standups require that initiating Playground turn. Cron and HTTP triggers without a turn context explicitly skip before creating a daily session; they never fall through to the live proactive adapter.

- `What's the status of Task-1?` — grounded Q&A over the mock board (requires LLM credentials)
- Submit an update first, then ask for that task's latest comments — the mock starts without standup comments or seeded blockers
- `/help` — full command list

## Full setup — live mode

For a real Jira + Teams demo. Approximately 20-30 minutes end-to-end.

### 1. Configure Jira

1. [Sign up for a free Atlassian Cloud site](https://www.atlassian.com/software/jira/free).
2. Create a Scrum project (any template). Note the **project key** (e.g. `DEMO`) shown next to the project name.
3. Note the **board id** — it's the number in the board URL, e.g. `.../jira/software/projects/DEMO/boards/1` → `1`.
4. [Create a Jira API token](https://id.atlassian.com/manage-profile/security/api-tokens).

### 2. Configure SharePoint

Pick any SharePoint site your account can write to (a dev-tenant OneDrive-linked site is fine). The setup script will provision the lists into a `SMA_` namespace — it will never touch existing content on that site.

### 3. Fill `.env`

```powershell
cp .env.template .env
```

Then edit — at minimum:

```bash
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_ENDPOINT=https://<your-resource>.services.ai.azure.com
AZURE_OPENAI_DEPLOYMENT=gpt-4o

JIRA_MODE=live
JIRA_BASE_URL=https://<your-org>.atlassian.net
JIRA_EMAIL=<your-atlassian-account-email>
JIRA_API_TOKEN=<paste-token>
JIRA_PROJECT_KEY=DEMO
JIRA_BOARD_ID=1

SHAREPOINT_SITE_URL=https://<your-tenant>.sharepoint.com/sites/<your-site>
GRAPH_TENANT_ID=<your-tenant-id>
# Optional override; blank uses the Graph CLI public client. Tenant consent may be required.
GRAPH_CLIENT_ID=
INTERNAL_TRIGGER_TOKEN=<any-random-string>
```

Full var reference in [Configuration reference](#configuration-reference) below.

### 4. Provision & seed

```powershell
npm install

# Signs in via device code (Microsoft Graph delegated). Creates the SMA_*
# lists (including SprintReportsDelivery) + SprintReports library. Idempotent.
npm run setup:sharepoint

# Seed the SMA_TeamMembers list from src/scripts/team.sample.json.
# Edit that file first to insert real AAD Object Ids + Jira accountIds for
# your squad, or accept the four Alice/Bob/Charlie/Dana placeholders.
npm run seed

# Seed SMA_HelperRoster (subject-matter experts for the blocker chase flow).
npm run seed:helpers

# Optional: create 2 stories + 5 sub-tasks + 1 future sprint on your Jira
# project. Skip if you already have real sprint data.
npm run seed:jira
```

If you ran `npm run seed:jira`, open your Jira board and click **Start sprint** on the newly-created sprint before continuing.

The seed resolves the project's enabled subtask type by ID, including `Sub-task`
and localized names. If subtasks are disabled, it fails before creating issues;
enable a subtask issue type in the project's Jira settings and retry.

### 5. Run

```powershell
npm run dev
```

You should see the startup banner listing all resolved config, followed by the Express server binding to `:3978`. In another terminal, either connect via the Agents Playground:

```powershell
npm run test-tool
```

Or hire the agent inside your Teams tenant using the manifest in [`manifest/`](manifest) — see the [Configure Agent Testing guide](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing?tabs=nodejs) for the full Teams-side flow.

## First live proof

Sanity check that the runtime is wired correctly, in three minutes:

1. **Health check.** With `npm run dev` running, in another terminal:
   ```powershell
   Invoke-RestMethod http://localhost:3978/api/health
   ```
   Expected: `{ status = 'healthy'; timestamp = '...' }`

2. **Standup fire.** Trigger the flow via the internal endpoint (equivalent to a Scrum Master DM'ing `/standup`):
   ```powershell
   Invoke-RestMethod -Method Post `
     -Uri 'http://localhost:3978/api/internal/standup-trigger' `
     -Headers @{ 'x-internal-token' = '<INTERNAL_TRIGGER_TOKEN>' } -Body '{}'
   ```
   Expected: `{ standupId = '1#2026-07-24'; sentTo = 4; skipped = 0 }`. Every roster member with a cached conversation reference receives a standup card DM.

3. **Grounded Q&A.** In the Agents Playground (or Teams DM):
   ```
   What's the status of Task-1?
   ```
   Expected: a reply that names the assignee, status, story points, and a link to the Jira issue. If the reply says "Task-1", the [`issue-labels.ts`](src/services/issue-labels.ts) mapping is working; if it says the raw project key (e.g. `DEMO-1`), the mapping is not being applied — see [Troubleshooting](#troubleshooting).

If all three succeed the sample is fully wired.

Run the local regression suite after `npm install`:

```powershell
npm test
```

These tests do not replace the live service and delivery checks above.

## Try each capability

Slash commands and free-text go to the agent DM. Card actions come back as follow-up DMs or channel posts.

| Capability | How to trigger | Expected behaviour | Handler |
|---|---|---|---|
| Standup | `/standup` | Card DMs to every roster member; summary card in channel after all responses. | [`standup.ts`](src/handlers/standup.ts) |
| Reconcile | Submit a standup update mentioning "PR is up" / "merged" / "started" | Safe transitions auto-apply with a Jira comment; ambiguous ones DM an approval card to the SM. | [`reconcile.ts`](src/handlers/reconcile.ts) |
| Chase | Toggle the blocker switch on a standup card and add text | SM gets a blocker card → click **Propose unblock meeting** → SME matched → click **Book it**. | [`chase.ts`](src/handlers/chase.ts) |
| Warn | `POST /api/internal/nightly-check?force=warn&forceAlert=true` | SM gets a risk-alert DM (`forceAlert` bypasses the threshold gate for demos). | [`warn.ts`](src/handlers/warn.ts) |
| Q&A | `What's the status of Task-1?` in a DM | Grounded reply with assignee, story points, link. Follow up with `provide more details` — it remembers the task. | [`answer.ts`](src/handlers/answer.ts) |
| Mid-sprint RAG | `POST /api/internal/sprint-summary?force=true` | Red/Amber/Green table posted to the configured channel. | [`sprint-summary.ts`](src/handlers/sprint-summary.ts) |
| Sprint close | `POST /api/internal/nightly-check?force=report` | Management-ready markdown report posted to the channel. | [`report.ts`](src/handlers/report.ts) |

Set `SMA_ALLOWED_TEAM_ID` to your deployment's Teams team GUID, then have the
configured Scrum Master (`SMA_TeamMembers.Role=SM`, matching their authenticated
AAD object ID) run `/config channel` from **inside** a channel of that team.
The command fails closed if the team setting is missing, the team differs, or
the caller is not an SM. It captures the channel reference for downstream reports.
Authorization compares the setting with `channelData.team.aadGroupId` (the team's
Microsoft 365 group GUID), not `team.id` (the connector's `19:...` routing ID).
Missing AAD group metadata is rejected explicitly; connector IDs are retained for routing.

## Configuration reference

Every scenario-specific env var — see [`.env.template`](.env.template) for the full list including base-sample vars.

| Variable | Default | Required for | Description |
|---|---|---|---|
| `LOG_LEVEL` | `info` | Never | Central console filtering: `error` / `warn` / `info` / `debug` / `trace`; SDK-specific logging may have additional controls |
| `LOG_HTTP` | `false` | Debugging | Traces instrumented axios clients, including Jira; not Graph/fetch or MCP transports |
| `JIRA_MODE` | `mock` | Everything | `mock` uses in-memory Jira/roster data; Q&A still calls the configured LLM. `live` calls Atlassian. |
| `JIRA_BASE_URL` | *(none)* | live | `https://<org>.atlassian.net` |
| `JIRA_EMAIL` | *(none)* | live | Atlassian account email |
| `JIRA_API_TOKEN` | *(none)* | live | Personal API token |
| `JIRA_PROJECT_KEY` | `SCRUM` (mock) | live | Keep `SCRUM` for the bundled mock; replace with your real project key in live mode |
| `JIRA_BOARD_ID` | *(none)* | live | Numeric board id |
| `SHAREPOINT_SITE_URL` | *(none)* | live | Site that hosts all `SMA_*` lists |
| `SHAREPOINT_LISTS_PREFIX` | `SMA_` | live | Namespace prefix on every list |
| `GRAPH_TENANT_ID` | `common` | live | Set to a single tenant guid to pin the sign-in |
| `GRAPH_CLIENT_ID` | `14d82eec-204b-4c2f-b7e8-296a70dab67e` | live Graph | Microsoft Graph CLI public client when blank/unset. Tenant policy and delegated-permission consent still apply; use your own public client for production. |
| `SMA_ALLOWED_TEAM_ID` | *(none)* | `/config channel` | Allowed Teams team GUID; only configured SMs can set a reporting channel within this team. Missing value denies changes. |
| `STANDUP_CRON` | `0 30 3 * * 1-5` | Local scheduler | UTC cron — default = 09:00 IST weekdays |
| `NIGHTLY_CRON` | `0 0 19 * * *` | Local scheduler | UTC cron — default = 00:30 IST daily |
| `STANDUP_CUTOFF_HOURS` | `4` | Standup | Give people this long to respond before the summary posts anyway |
| `TIMEZONE` | `Asia/Kolkata` | Local dates | Card labels, mid-sprint date gate, meeting-slot search; both cron schedulers evaluate in UTC independently of this setting |
| `WARN_TODO_PCT` | `0.40` | Warn | Trip if this fraction of committed points is still `To Do` |
| `WARN_SPRINT_PROGRESS_PCT` | `0.50` | Warn | Trip only after this fraction of sprint duration has elapsed |
| `LOCAL_CRON` | `true` | Dev | Set `false` in prod once Azure Function timers are wired up |
| `INTERNAL_TRIGGER_TOKEN` | *(none)* | Timer endpoints | Shared secret in the `x-internal-token` header |

## Internal HTTP endpoints

Standup card submissions require a known open in-memory session, the authenticated
expected responder, and only that responder's server-side assigned issues.
Unknown/post-restart sessions and cross-identity submissions are rejected without
writes; `DEMO_MODE` does not bypass this check.
Blocker dismiss/slot actions and meeting book/cancel actions require the configured
SM. Booking uses a single-use, 30-minute server-side proposal bound to that SM,
the blocker and offered slots. Old cards after restart/expiry require fresh slots.

All three accept the `x-internal-token` header (must match a configured `INTERNAL_TRIGGER_TOKEN`) and are designed for the Azure Function timers in the sibling [`azure-functions/`](azure-functions) folder. A blank token leaves them open only when `NODE_ENV` is exactly `development`; every other value (including unset or `test`) requires a nonempty token at startup.

### `POST /api/internal/standup-trigger`

Fires today's standup. The `<sprintId>#<UTC-date>` guard retains completed records for the lifetime of this process. Live mode also checks persisted SharePoint session records before new fanout after restart, but this is not an atomic cross-process claim and does not reconstruct an interrupted session.

```powershell
Invoke-RestMethod -Method Post `
  -Uri 'http://localhost:3978/api/internal/standup-trigger' `
  -Headers @{ 'x-internal-token' = '<INTERNAL_TRIGGER_TOKEN>'; 'content-type' = 'application/json' } `
  -Body '{}'
```

Response: `{ "standupId": "1#2026-07-12", "sentTo": 4, "skipped": 0 }`

### `POST /api/internal/nightly-check`

Runs the **Warn** check, the **Mid-sprint RAG report** when its T-2 gate is met, and the **Sprint close report** if the sprint has ended.

If any check throws, the response is HTTP 500 with `ok: false`, allowing the
Functions retry policy to engage. Checks that already succeeded are not
rolled back. The T-2 summary has no durable delivery guard, so retrying the
nightly call can repeat its output even when another check caused the failure.
Both report results preserve failed connector messages in `error` and `note`
with `uploaded: false`, and log failed sends before/after the SM fallback.
A returned delivery failure is not an exception and does not by itself cause
the nightly route to return HTTP 500; inspect each report result.

Query params:
- `force=warn` — Warn only
- `force=report` — Report only, bypasses the "sprint has ended" gate, not the per-sprint delivery guard
- `sprintId=<n>` — Override the auto-detected active sprint
- `forceAlert=true` — Make Warn DM the SM regardless of thresholds (demo aid)

### `POST /api/internal/sprint-summary`

Fires the mid-sprint RAG report to the configured channel.

Unlike sprint-close reporting, this path has no durable delivery guard;
repeated eligible calls can post repeated summaries.

Query params:
- `force=true` — bypass the "T-2 days from sprint end" gate

## SharePoint schema

Full reference: [`docs/sharepoint-schema.md`](docs/sharepoint-schema.md).

Source of truth: `LIST_SCHEMAS` in [`src/services/sharepoint.ts`](src/services/sharepoint.ts).

## Reset the demo

```powershell
Remove-Item .mstoken-cache.json      # force a fresh device-code sign-in
# Empty the SMA_* lists via SharePoint UI (Site contents → each list → delete all items)
# or delete the lists entirely and re-run `npm run setup:sharepoint`.
```

To reset Jira sprint issues, use the Atlassian UI or `POST /rest/agile/1.0/sprint/{sprintId}/issue`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Agent says `Couldn't fetch information on Task-N` and the same `Task-N` clearly exists in Jira. | `issue-labels.ts` fallback project key doesn't match `JIRA_PROJECT_KEY`, or nodemon is running stale code. | Confirm `JIRA_PROJECT_KEY` in `.env` matches your project. Restart `npm run dev`. |
| `/standup` responds `sentTo: 0`. | No roster member has an active conversation reference yet — nobody has DM'd the agent since the last SharePoint provisioning. | Ask each squad member to DM the agent `hi` once. `SMA_TeamMembers.ConversationRef` populates on their first turn. |
| `MSAL: no cached account` on any seed script. | Delegated token cache missing / expired. | Run `npm run setup:sharepoint` again to trigger a fresh device-code sign-in. |
| Jira REST calls 401 during standup summarisation. | `JIRA_API_TOKEN` was revoked or `JIRA_EMAIL` is wrong. | Recreate the token in Atlassian Account → Security → API tokens; make sure `JIRA_EMAIL` matches the account the token belongs to. |
| Adaptive Card submit hangs, then Teams says *"Something went wrong"*. | Handler exceeded the ~15 s Invoke SLA. | Standup submits send a recording acknowledgement before deferring Graph work; a submitted card follows only after recording succeeds. Other handlers may still perform inline authorization/lookups. There is no fixed acknowledgement latency guarantee. See [`docs/design.md#9-concurrency-idempotency-and-dedup`](docs/design.md#9-concurrency-idempotency-and-dedup). |
| MCP calendar tool call returns `-32001 Session not found` on the second run. | MCP transport was closed after the first call. | Check `services/calendar.ts` — the `withServers()` helper should NOT close after each call; a retry-once on session-lost is expected on cold starts. |
| `Cannot find module '../services/xxx'` after `git pull`. | ts-node cached the old module tree. | `Ctrl+C` the dev server and restart. If persistent, `rm -rf dist && npm run build`. |
| Duplicate standup summary cards. | Both local `node-cron` and the Azure Function timer fired the same day. | Set `LOCAL_CRON=false` once the Function is deployed. |
| Email notification returns `Unable to process your email`. | The agent's delegated Graph `Mail.Read` scope is missing or the notified message cannot be read. | Grant `Mail.Read` to the blueprint's agentic connection and verify access to the agent mailbox. Email retrieval does not use the SharePoint user's cache. Drafting uses a tool-less agent, not the generic MCP assistant. |
| `Summary delivered, but completion persistence failed` in logs. | The SharePoint completion lookup, PATCH, or refresh GET failed after summary delivery. | Blocker follow-up and in-memory cleanup still run without resending the summary. Inspect the daily `SMA_StandupSessions` row and repair its State to `summarized` before restarting; do not delete the daily claim. |
| `Summary delivered, but blocker follow-up failed` in logs. | SharePoint lookup or blocker notification delivery failed. | Retry `/standup` in the same process and UTC day. Only pending blocker follow-up runs; the summary is not resent and successful blocker notifications are skipped. After restart, inspect blocker records and delivery logs for manual recovery; pending follow-up is process-local. Do not delete the daily claim. |

### Enable HTTP tracing

For Jira REST diagnostics, set `LOG_HTTP=true` in `.env` and restart. Instrumented axios requests print `method host path status latency` with credential redaction. This does **not** trace Microsoft Graph's fetch transport or MCP traffic; use their SDK diagnostics separately. Keep HTTP tracing off in production.

### Claim recovery

Live operations claim SharePoint records before sending external side effects.
Do not delete or reset a claim merely because a timer/card action was retried.

- **Standup creation:** `SMA_StandupSessions.RunKey` is indexed and unique
  (`<sprintId>#<UTC yyyy-mm-dd>`). Only the worker that inserts it starts fan-out.
  Existing runs, including completed runs, block new daily fan-out. A crash after
  insertion can leave a partially delivered run: inspect records/delivery logs
  rather than deleting the claim or assuming another worker resumes it.
  Before upgrading an existing deployment, pause **all** agent workers and run
  `npm run setup:sharepoint` with the live site's configuration. The script
  validates distinct nonempty legacy Titles, backfills `RunKey` from `Title`,
  then enforces indexed uniqueness. Duplicate/mismatched legacy keys fail
  migration without modifying records; review and reconcile them manually.
  Resume workers only after successful migration. No live setup is implied by
  building or testing this sample.
- **Sprint close:** `SMA_SprintReportsDelivery.DeliveryKey` is unique and indexed
  (`sprint-close:<sprintId>`). `sent` blocks another report; `failed` permits a
  later retry. A crash or uncertain send can leave `claimed` indefinitely.
  An operator must inspect Teams and delivery logs first. Confirm a delivered
  report as `sent`; only after establishing that nothing was delivered should
  an authorized operator mark the record `failed` and retry.
- **Standup responses:** `SMA_StandupResponses.ResponseKey` is indexed and unique
  (`<StandupId>#<UserAadId>`). The first accepted response wins. Replaying a card
  returns the original acknowledgement without repeating blocker mutations or
  Jira comments; response edits require a new standup, not resubmitting the card.
  Pause all workers and run `npm run setup:sharepoint` before upgrading an existing
  list. The script validates canonical, distinct response Titles and backfills
  `ResponseKey` before enabling uniqueness. Existing duplicates or mismatched
  identities stop migration before any response rows change; inspect and reconcile
  those records manually, then rerun. Do not delete accepted rows merely to retry.
  Automatic selection skips already delivered/claimed ended sprints and selects
  the newest remaining unreported (or explicitly failed) ended sprint, including
  closed sprints, so an already reported newer sprint cannot starve the backlog.
- **Meeting booking:** `SMA_Blockers.State` is conditionally claimed from `open`
  to `booking`, then set to `booked` after a confirmed booking. An uncertain
  Calendar result may retain `booking` (or mark `booked` when verification
  output is malformed). Check Outlook, event details and invitees before
  recovery. Record an existing event as booked; reset to `open` for a new
  proposal only after verifying that no event/invitations were created.
  Repeating a booked card returns an Outlook link built from the stored event ID,
  without creating another event; when no ID was recorded, inspect Outlook.
- **Standup finalization:** an ambiguous failure can leave `summarizing`.
  Preliminary roster lookup failures leave the session open and retryable.
  Finalization waits for already accepted response writes before snapshotting,
  and rejects new submissions once claimed.
  Inspect channel/DM delivery and persisted responses before recovery;
  restarting does not rebuild response fan-in or cutoff timers.

## Deploy to Azure

Recommended target: **Azure App Service (Node 22 or later) + Azure Functions timers**.

Minimum runtime configuration:

- Azure App Service (Linux, Node 22 LTS). Set `WEBSITES_PORT=3978`.
- Configure application settings explicitly; do **not** copy the local `.env` blindly. Required cloud overrides: `NODE_ENV=production`, `HOST=0.0.0.0`, and a nonempty random `INTERNAL_TRIGGER_TOKEN`. Supply live Jira, Graph, LLM and hosting/auth connection settings securely; never commit secrets.
- Health check path: `/api/health`.
- Always-On: enabled for the long-lived agent. Use the sibling [`azure-functions/`](azure-functions) package for timer triggers and set `LOCAL_CRON=false` on the agent so only one scheduler is active.
- `.mstoken-cache.json` — for local dev only. In production, replace `graph.ts`'s file-backed MSAL cache with an Azure Key Vault-backed one (out of scope for this sample).

Example deployment commands (replace placeholders; no deployment validation is implied):

```powershell
# From the scenario folder
npm run build
az webapp up --name <app-name> --resource-group <rg> --runtime "NODE|22-lts"
```

Wire the Function App to point at your App Service:

```powershell
# From the sibling azure-functions folder
func azure functionapp publish <func-app-name>
```

Set `AGENT_CALLBACK_URL=https://<your-agent-host>` (base URL, without `/api/messages`) and the same nonempty `INTERNAL_TRIGGER_TOKEN` on the Function App so its timers can call `/api/internal/*`. Leave `WEBSITE_TIME_ZONE` unset: timer expressions are UTC. Both schedulers run daily Warn, mid-sprint summary and sprint-close checks, each with its own eligibility gate.

## Known limitations

- **MSAL token cache is unencrypted on disk** (`.mstoken-cache.json`, git-ignored). Fine for local dev; swap for Key Vault or a DPAPI-backed extension in production.
- **`GRAPH_CLIENT_ID` defaults to the well-known "Microsoft Graph Command Line Tools" public client** when blank/unset. This avoids creating an app for local sign-in, not tenant policy or admin consent. Register your own public client for a real deployment.
- **Single-team by design.** The sample assumes one scrum team per process (single project key, single board, single channel). Multi-team support (per-team config, isolated Jira credentials, sharded timers) is called out as future work in [`docs/design.md#12-known-limitations--hardening-roadmap`](docs/design.md#12-known-limitations--hardening-roadmap).
- **Proactive DMs require prior interaction.** Every squad member must have said "hi" to the agent at least once so their conversation reference is captured in `SMA_TeamMembers`.
- **Use one scheduler and one agent process for standups.** Live daily creation uses the unique SharePoint `RunKey` after schema migration; mock guards remain process-local. Active response fan-in and cutoff timers are still in-memory, are not rebuilt after a restart, and are not shared by replicas. The creation claim prevents duplicate fan-out, not distributed standup processing. Set `LOCAL_CRON=false` once the Function is deployed.
- **Sprint-close delivery claims are separate from standup state.** Live mode uses `SMA_SprintReportsDelivery` with a unique per-sprint key. A crash or uncertain send leaves a `claimed` record requiring operator verification; it is not automatically retried. A confirmed delivery failure can be retried. `force=report` does not bypass this guard.

## Support

- Issues, questions, feedback: [GitHub Issues](https://github.com/microsoft/Agent365-Samples/issues)
- SDK docs: [Microsoft Agent 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- Security: see the repo-root [`SECURITY.md`](../../SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com).

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at <http://go.microsoft.com/fwlink/?LinkID=254653>.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License — see the repo-root [`LICENSE.md`](../../LICENSE.md) for details.

![](https://m365-visitor-stats.azurewebsites.net/Agent365-Samples/scenarios/scrum-master)
