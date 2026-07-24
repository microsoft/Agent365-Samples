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

Seven capabilities, each a handler under [`src/handlers/`](src/handlers). All use proactive DMs, durable state in SharePoint, and grounded tool calls into Jira — no hallucinated status.

1. **Standup** — Proactively DMs every squad member an Adaptive Card listing their sprint tasks with an update field and blocker toggle. Aggregates responses into a summary card posted to the configured channel. See [`handlers/standup.ts`](src/handlers/standup.ts).
2. **Board reconciliation** — A deterministic phrase classifier reads each update, maps it to a Jira status, and either auto-applies safe forward transitions or DMs the Scrum Master an approval card for ambiguous moves. See [`handlers/reconcile.ts`](src/handlers/reconcile.ts).
3. **Blocker chase** — When someone flags a blocker, the agent matches a subject-matter expert from the helper roster, calls the MCP Calendar tool for open slots, and books an unblock meeting on its own mailbox with the SM + owner + reporter as attendees. See [`handlers/chase.ts`](src/handlers/chase.ts).
4. **Sprint risk warn** — Nightly check: if the sprint is past the halfway mark and too many points are still in "To Do", DMs the SM with a risk assessment. See [`handlers/warn.ts`](src/handlers/warn.ts).
5. **Grounded Q&A** — Free-text questions ("what's the status of Task-14?", "latest update on Task-6?") go to a scenario-specific OpenAI Agent whose tools call live Jira. Per-user rolling history so follow-ups resolve against the last discussed task. See [`handlers/answer.ts`](src/handlers/answer.ts).
6. **Mid-sprint RAG report** — Two days before sprint end, classifies every task Red/Amber/Green by due date and posts a prioritised risk table to the channel. See [`handlers/sprint-summary.ts`](src/handlers/sprint-summary.ts).
7. **Sprint close report** — On sprint end, auto-generates a management-ready summary (completed stories, deliverables, release notes, action items, metrics) and posts inline to the channel. See [`handlers/report.ts`](src/handlers/report.ts).

Full flow diagrams for each capability are in [`docs/design.md#5-the-seven-flows`](docs/design.md#5-the-seven-flows).

## Prerequisites

Fast path (mock mode): **only Node.js is required.** All external services can be skipped.

| Requirement | Needed for | Notes |
|---|---|---|
| **Node.js ≥ 18** | Everything | Any current LTS |
| **Azure OpenAI or OpenAI API key** | Q&A + calendar tool | `gpt-4o` recommended |
| Atlassian Cloud (free) | Live Jira mode | Skip if `JIRA_MODE=mock`. [Sign up](https://www.atlassian.com/software/jira/free) |
| Microsoft 365 dev tenant | Live SharePoint mode | Skip if you only exercise the Q&A path |
| Agent 365 CLI | Deploying to Teams | Not needed for local Playground testing |

## Quick start — mock mode (no external services)

Get from clone to a working demo in under 5 minutes. Uses the built-in mock Jira sprint in [`src/mock/jira-mock.ts`](src/mock/jira-mock.ts) — a mutable in-memory board that responds to transitions and comments the same way live Jira would.

```powershell
git clone https://github.com/microsoft/Agent365-Samples.git
cd Agent365-Samples/scenarios/scrum-master

cp .env.template .env
# Edit .env: set AZURE_OPENAI_* (or OPENAI_API_KEY), leave JIRA_MODE=mock.

npm install
npm run dev
```

In another terminal:

```powershell
npm run test-tool     # opens the Agents Playground
```

In the Playground, DM the agent `/standup`. The agent will DM a standup card for the mock sprint. Fill in an update, click **Submit**, and watch the summary card land. Then try:

- `What's the status of Task-1?` — grounded Q&A over the mock board
- `What's blocking Task-6?` — inspects the mock blocker
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
INTERNAL_TRIGGER_TOKEN=<any-random-string>
```

Full var reference in [Configuration reference](#configuration-reference) below.

### 4. Provision & seed

```powershell
npm install

# Signs in via device code (Microsoft Graph delegated). Creates the 7 SMA_*
# lists + SprintReports library. Idempotent.
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

Point the channel at the right place with `/config channel` from **inside** a Teams channel — captures its conversation reference so all downstream summaries and reports post there instead of the SM's DM.

## Configuration reference

Every scenario-specific env var — see [`.env.template`](.env.template) for the full list including base-sample vars.

| Variable | Default | Required for | Description |
|---|---|---|---|
| `LOG_LEVEL` | `info` | Never | `error` / `warn` / `info` / `debug` / `trace` |
| `LOG_HTTP` | `false` | Debugging | `true` traces every outbound axios call (Jira / Graph / MCP) |
| `JIRA_MODE` | `mock` | Everything | `mock` runs offline; `live` calls Atlassian. |
| `JIRA_BASE_URL` | *(none)* | live | `https://<org>.atlassian.net` |
| `JIRA_EMAIL` | *(none)* | live | Atlassian account email |
| `JIRA_API_TOKEN` | *(none)* | live | Personal API token |
| `JIRA_PROJECT_KEY` | *(none)* | live | Project key, e.g. `DEMO` |
| `JIRA_BOARD_ID` | *(none)* | live | Numeric board id |
| `SHAREPOINT_SITE_URL` | *(none)* | live | Site that hosts all `SMA_*` lists |
| `SHAREPOINT_LISTS_PREFIX` | `SMA_` | live | Namespace prefix on every list |
| `GRAPH_TENANT_ID` | `common` | live | Set to a single tenant guid to pin the sign-in |
| `GRAPH_CLIENT_ID` | *(none)* | live | Public-client app id. `14d82eec-204b-4c2f-b7e8-296a70dab67e` (Microsoft Graph CLI) works on most tenants without additional consent. |
| `STANDUP_CRON` | `0 30 3 * * 1-5` | Local scheduler | UTC cron — default = 09:00 IST weekdays |
| `NIGHTLY_CRON` | `0 0 19 * * *` | Local scheduler | UTC cron — default = 00:30 IST daily |
| `STANDUP_CUTOFF_HOURS` | `4` | Standup | Give people this long to respond before the summary posts anyway |
| `TIMEZONE` | `Asia/Kolkata` | Display only | Used in card date rendering |
| `WARN_TODO_PCT` | `0.40` | Warn | Trip if this fraction of committed points is still `To Do` |
| `WARN_SPRINT_PROGRESS_PCT` | `0.50` | Warn | Trip only after this fraction of sprint duration has elapsed |
| `LOCAL_CRON` | `true` | Dev | Set `false` in prod once Azure Function timers are wired up |
| `INTERNAL_TRIGGER_TOKEN` | *(none)* | Timer endpoints | Shared secret in the `x-internal-token` header |

## Internal HTTP endpoints

All three are guarded by the `x-internal-token` header (must match `INTERNAL_TRIGGER_TOKEN`) and are designed for the Azure Function timers in the sibling [`azure-functions/`](azure-functions) folder — but curl-safe for demos.

### `POST /api/internal/standup-trigger`

Fires today's standup. Idempotent per calendar day.

```powershell
Invoke-RestMethod -Method Post `
  -Uri 'http://localhost:3978/api/internal/standup-trigger' `
  -Headers @{ 'x-internal-token' = '<INTERNAL_TRIGGER_TOKEN>'; 'content-type' = 'application/json' } `
  -Body '{}'
```

Response: `{ "standupId": "1#2026-07-12", "sentTo": 4, "skipped": 0 }`

### `POST /api/internal/nightly-check`

Runs the **Warn** check and, if the sprint has ended, the **Sprint close report**.

Query params:
- `force=warn` — Warn only
- `force=report` — Report only, bypasses the "sprint has ended" gate
- `sprintId=<n>` — Override the auto-detected active sprint
- `forceAlert=true` — Make Warn DM the SM regardless of thresholds (demo aid)

### `POST /api/internal/sprint-summary`

Fires the mid-sprint RAG report to the configured channel.

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
| Adaptive Card submit hangs, then Teams says *"Something went wrong"*. | Handler did heavy work synchronously and blew the ~15 s Invoke SLA. | All submits should ack in <200 ms and defer via `setImmediate`. See [`docs/design.md#9-concurrency-idempotency-and-dedup`](docs/design.md#9-concurrency-idempotency-and-dedup). |
| MCP calendar tool call returns `-32001 Session not found` on the second run. | MCP transport was closed after the first call. | Check `services/calendar.ts` — the `withServers()` helper should NOT close after each call; a retry-once on session-lost is expected on cold starts. |
| `Cannot find module '../services/xxx'` after `git pull`. | ts-node cached the old module tree. | `Ctrl+C` the dev server and restart. If persistent, `rm -rf dist && npm run build`. |
| Duplicate standup summary cards. | Both local `node-cron` and the Azure Function timer fired the same day. | Set `LOCAL_CRON=false` once the Function is deployed. |

### Enable HTTP tracing

If a live call fails silently, set `LOG_HTTP=true` in `.env` and restart. Every outbound axios call prints `method host path status latency`. Credentials are redacted automatically.

## Deploy to Azure

Recommended target: **Azure App Service (Node 18/20) + Azure Functions timers**.

Minimum runtime configuration:

- Azure App Service (Linux, Node 20 LTS). Set `WEBSITES_PORT=3978`.
- Application Settings: all `.env` vars mapped one-to-one.
- Health check path: `/api/health`.
- Always-On: enabled — the local cron scheduler needs the process to stay warm. Alternative: set `LOCAL_CRON=false` and use the sibling [`azure-functions/`](azure-functions) package for timer triggers.
- `.mstoken-cache.json` — for local dev only. In production, replace `graph.ts`'s file-backed MSAL cache with an Azure Key Vault-backed one (out of scope for this sample).

Deploy pattern used successfully in dev tenants:

```powershell
# From the scenario folder
npm run build
az webapp up --name <app-name> --resource-group <rg> --runtime "NODE|20-lts"
```

Wire the Function App to point at your App Service:

```powershell
# From the sibling azure-functions folder
func azure functionapp publish <func-app-name>
```

Set `INTERNAL_TRIGGER_URL` and `INTERNAL_TRIGGER_TOKEN` on the Function App so its timers can call `/api/internal/*` on the App Service.

## Known limitations

- **MSAL token cache is unencrypted on disk** (`.mstoken-cache.json`, git-ignored). Fine for local dev; swap for Key Vault or a DPAPI-backed extension in production.
- **`GRAPH_CLIENT_ID` defaults to the well-known "Microsoft Graph Command Line Tools" public client** for zero-setup device-code sign-in. Register your own multi-tenant public client for a real deployment.
- **Single-team by design.** The sample assumes one scrum team per process (single project key, single board, single channel). Multi-team support (per-team config, isolated Jira credentials, sharded timers) is called out as future work in [`docs/design.md#12-known-limitations--hardening-roadmap`](docs/design.md#12-known-limitations--hardening-roadmap).
- **Proactive DMs require prior interaction.** Every squad member must have said "hi" to the agent at least once so their conversation reference is captured in `SMA_TeamMembers`.
- **Running local `node-cron` and Azure Function timers simultaneously is safe** (`standupId = <sprintId>#<yyyy-mm-dd>` provides idempotency) but does two Jira reads per tick. Set `LOCAL_CRON=false` once the Function is deployed.

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
