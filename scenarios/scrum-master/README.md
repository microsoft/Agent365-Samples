# OpenAI Sample Agent - Node.js

This sample demonstrates how to build an agent using OpenAI in Node.js with the Microsoft Agent 365 SDK. It covers:

- **Observability**: End-to-end tracing, caching, and monitoring for agent applications
- **Notifications**: Services and models for managing user notifications
- **Tools**: Model Context Protocol tools for building advanced agent solutions
- **Hosting Patterns**: Hosting with Microsoft 365 Agents SDK

This sample uses the [Microsoft Agent 365 SDK for Node.js](https://github.com/microsoft/Agent365-nodejs).

For comprehensive documentation and guidance on building agents with the Microsoft Agent 365 SDK, including how to add tooling, observability, and notifications, visit the [Microsoft Agent 365 Developer Documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/).

## Prerequisites

- Node.js 18.x or higher
- Microsoft Agent 365 SDK
- OpenAI Agents SDK
- Azure/OpenAI API credentials

## Working with User Identity

On every incoming message, the A365 platform populates `activity.from` with basic user
information — always available with no API calls or token acquisition:

| Field | Description |
|---|---|
| `activity.from.id` | Channel-specific user ID (e.g., `29:1AbcXyz...` in Teams) |
| `activity.from.name` | Display name as known to the channel |
| `activity.from.aadObjectId` | Azure AD Object ID — use this to call Microsoft Graph |

The sample logs these fields at the start of every message turn and injects the display name
into the LLM system instructions for personalized responses.

## Handling Agent Install and Uninstall

When a user installs (hires) or uninstalls (removes) the agent, the A365 platform sends an `InstallationUpdate` activity — also referred to as the `agentInstanceCreated` event. The sample handles this in `handleInstallationUpdateActivity` ([agent.ts](src/agent.ts)):

| Action | Description |
|---|---|
| `add` | Agent was installed — send a welcome message |
| `remove` | Agent was uninstalled — send a farewell message |

```typescript
if (context.activity.action === 'add') {
  await context.sendActivity('Thank you for hiring me! Looking forward to assisting you in your professional journey!');
} else if (context.activity.action === 'remove') {
  await context.sendActivity('Thank you for your time, I enjoyed working with you.');
}
```

To test with Agents Playground, use **Mock an Activity → Install application** to send a simulated `installationUpdate` activity.

## Sending Multiple Messages in Teams

Agent365 agents can send multiple discrete messages in response to a single user prompt in Teams. This is achieved by calling `sendActivity` multiple times within a single turn.

> **Important**: Streaming responses are not supported for agentic identities in Teams. The SDK detects agentic identity and buffers the stream into a single message. Use `sendActivity` directly to send immediate, discrete messages to the user.

The sample demonstrates this in `handleAgentMessageActivity` ([agent.ts](src/agent.ts)):

```typescript
// Message 1: immediate ack — reaches the user right away
await turnContext.sendActivity('Got it — working on it…');

// ... LLM processing ...

// Message 2: the LLM response
await turnContext.sendActivity(response);
```

Each `sendActivity` call produces a separate Teams message. You can call it as many times as needed to send progress updates, partial results, or a final answer.

### Typing Indicators

The agent sends typing indicators in a loop every ~4 seconds to keep the `...` animation alive while the LLM processes the request:

```typescript
let typingInterval: ReturnType<typeof setInterval> | undefined;
const startTypingLoop = () => {
  typingInterval = setInterval(async () => {
    await turnContext.sendActivity({ type: 'typing' } as Activity);
  }, 4000);
};
const stopTypingLoop = () => { clearInterval(typingInterval); };

startTypingLoop();
try {
  // ... LLM processing ...
} finally {
  stopTypingLoop();
}
```

> **Note**: Typing indicators are only visible in 1:1 chats and small group chats — not in channels.

## Running the Agent

To set up and test this agent, refer to the [Configure Agent Testing](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/testing?tabs=nodejs) guide for complete instructions.

---

# Scrum Master Assistant POC — extensions to this sample

Everything below is layered on top of the base sample above. All base functionality (auth, MCP registration, observability, adaptive activities) is unchanged.

## What the POC adds

Six MVPs from the client brief, all driven by the same running agent:

| MVP | Entry point | Handler |
|---|---|---|
| **1. Standup** | `/standup` DM · `POST /api/internal/standup-trigger` · daily cron | [`src/handlers/standup.ts`](src/handlers/standup.ts) |
| **2. Reconcile** | Auto after every standup summary | [`src/handlers/reconcile.ts`](src/handlers/reconcile.ts) |
| **3. Chase** | Auto after summary (if blockers) + `blocker.*` / `meeting.*` card submits | [`src/handlers/chase.ts`](src/handlers/chase.ts) |
| **4. Warn** | `POST /api/internal/nightly-check?force=warn` · nightly cron | [`src/handlers/warn.ts`](src/handlers/warn.ts) |
| **5. Answer** | Free-text DM to the agent | [`src/handlers/answer.ts`](src/handlers/answer.ts) |
| **6. Report** | `POST /api/internal/nightly-check?force=report` · nightly cron | [`src/handlers/report.ts`](src/handlers/report.ts) |

External systems used:

- **Jira Cloud** via Atlassian REST + Agile API (issues, transitions, sprints).
- **SharePoint** via Microsoft Graph — six lists (`SMA_TeamMembers`, `SMA_TeamsConfig`, `SMA_StandupSessions`, `SMA_StandupResponses`, `SMA_Blockers`, `SMA_SprintRisks`) plus one `SprintReports` doc library.
- **`mcp_CalendarTools`** (from the A365 tooling manifest) for unblock-meeting flow — no user-Graph consent needed.
- **OpenAI Agents SDK** for Q&A (MVP 5) and the mcp_CalendarTools LLM path (MVP 3).

## POC environment variables

Add these to `.env` (they live alongside the base sample vars). See [`.env.template`](.env.template) for the canonical list.

```dotenv
# --- Jira (Atlassian Cloud) ---
JIRA_MODE=live                                             # live | mock
JIRA_BASE_URL=https://<tenant>.atlassian.net
JIRA_EMAIL=<atlassian account email>
JIRA_API_TOKEN=<generated at id.atlassian.com/manage-profile/security/api-tokens>
JIRA_PROJECT_KEY=SCRUM
JIRA_BOARD_ID=1

# --- SharePoint (delegated Graph) ---
SHAREPOINT_SITE_URL=https://<tenant>.sharepoint.com/sites/<site>
SHAREPOINT_LISTS_PREFIX=SMA_
GRAPH_TENANT_ID=<tenant guid or 'common'>
# Microsoft Graph Command Line Tools — pre-consented on most tenants
GRAPH_CLIENT_ID=14d82eec-204b-4c2f-b7e8-296a70dab67e

# --- Scheduling (UTC cron) ---
STANDUP_CRON=0 30 3 * * 1-5         # 09:00 Asia/Kolkata weekdays
NIGHTLY_CRON=0 0 19 * * *           # 00:30 Asia/Kolkata daily
STANDUP_CUTOFF_HOURS=4
TIMEZONE=Asia/Kolkata

# --- Warn thresholds ---
WARN_TODO_PCT=0.40                  # >=40% points/items still in To Do
WARN_SPRINT_PROGRESS_PCT=0.50       # ... once >=50% of sprint duration is elapsed

# --- Runtime ---
LOCAL_CRON=true                     # in-process scheduler; false in prod (use Azure Functions)
INTERNAL_TRIGGER_TOKEN=<any-random-string>
```

## One-time setup

```powershell
npm install

# Interactive Microsoft sign-in (device code). Creates the 6 SharePoint lists +
# `SprintReports` document library on the SHAREPOINT_SITE_URL site and persists
# the MSAL token cache to `.mstoken-cache.json`.
npm run setup:sharepoint

# Seed the TeamMembers list. `--mock` uses `src/scripts/team.sample.json`; the
# script auto-resolves the current signed-in user's AAD Object Id via /me and
# patches placeholder rows.
npm run seed -- --mock

# Start the agent (nodemon watches `src/`)
npm run dev
```

## Slash commands (Teams DM with the agent)

| Command | What it does |
|---|---|
| `/standup` | Immediately runs today's standup for the active sprint. Falls back to a friendly reply if a session for today is already open. |
| `/config channel` | Run this from inside a Teams **channel** — captures that channel's conversation reference so future summaries and warnings post there instead of the SM's DM. |
| `/help` | Lists commands. |

Free-text messages (that aren't slash commands or Adaptive Card submits) go to the **Answer** handler — a scenario-specific OpenAI Agents SDK agent bound to two Jira tools (`jira_get_issue`, `jira_list_sprint_issues`) that gives grounded, tool-cited answers.

## Adaptive Card actions

The agent handles four categories of card submits — routed at the top of [`src/agent.ts`](src/agent.ts) via `activity.value.action`:

| Action prefix | Handler |
|---|---|
| `standup.*` | [`handlers/standup.ts`](src/handlers/standup.ts) — user submits their standup update |
| `reconcile.*` | [`handlers/reconcile.ts`](src/handlers/reconcile.ts) — Scrum Master approves/skips risky board transitions |
| `blocker.*` | [`handlers/chase.ts`](src/handlers/chase.ts) — dismiss or propose an unblock sync |
| `meeting.*` | [`handlers/chase.ts`](src/handlers/chase.ts) — book or cancel the proposed slot |

Every card submit is **fire-and-forget** — the handler sends an immediate ack ("Booking the meeting…", "Applying approved changes…") so the Teams invoke response lands inside the platform's ~15 s timeout, and the downstream Jira / Graph / MCP work runs in `setImmediate`. Follow-up messages are delivered via `sendProactive` against the same conversation reference.

## Internal HTTP endpoints

Both endpoints are guarded by the `x-internal-token` header, which must match `INTERNAL_TRIGGER_TOKEN` from `.env`. They are also called by the Azure Function timers in [`../../azure-functions`](../../azure-functions).

### `POST /api/internal/standup-trigger`

Fires today's standup (equivalent to `/standup` from the SM in Teams). Idempotent for the same day.

```powershell
Invoke-RestMethod -Method Post `
  -Uri 'http://localhost:3978/api/internal/standup-trigger' `
  -Headers @{ 'x-internal-token' = '<INTERNAL_TRIGGER_TOKEN>'; 'content-type' = 'application/json' } `
  -Body '{}'
```

Response:
```json
{ "standupId": "2#2026-07-12", "sentTo": 1, "skipped": 0 }
```

### `POST /api/internal/nightly-check`

Runs the **Warn** check and, if the current sprint has ended, generates the **Report** and uploads to SharePoint.

Query params:
- `force=warn` — run **only** Warn (skip Report even if sprint has ended)
- `force=report` — run **only** Report, and bypass the "sprint end date has passed" gate (so you can generate a report against an in-flight sprint)
- `force=both` (default when both would run) — same as unset
- `sprintId=<n>` — report on a specific sprint id instead of the active one
- `forceAlert=true` — makes Warn DM the SM regardless of whether thresholds actually tripped (useful for demos when the sprint is too young to trip organically)

Examples:
```powershell
# Warn only, force the alert even if thresholds aren't tripped
Invoke-RestMethod -Method Post `
  -Uri 'http://localhost:3978/api/internal/nightly-check?force=warn&forceAlert=true' `
  -Headers @{ 'x-internal-token' = '<INTERNAL_TRIGGER_TOKEN>' } -Body '{}'

# Report the active sprint even though it hasn't ended
Invoke-RestMethod -Method Post `
  -Uri 'http://localhost:3978/api/internal/nightly-check?force=report&sprintId=2' `
  -Headers @{ 'x-internal-token' = '<INTERNAL_TRIGGER_TOKEN>' } -Body '{}'
```

## Reconcile rules (MVP 2)

Free-text updates are classified by a small rule set in [`handlers/reconcile.ts`](src/handlers/reconcile.ts). First rule to match wins (priority order):

| Target | Trigger patterns (case-insensitive) |
|---|---|
| `Done` | `done`, `completed`, `finished`, `merged`, `shipped`, `deployed`, `closed`, `ready to close` |
| `In Review` | `in review`, `code review`, `pr up`, `pull request`, `reviewing`, `waiting for/on review` |
| `In Progress` | `started`, `starting`, `began`, `beginning`, `kicked off`, `working on`, `in progress`, `picked up`, `am/i'm/now implementing/building/coding/writing` |

A blocker toggle on any item forces `unchanged`. Any status difference that maps to a **safe forward step** on `To Do → In Progress → In Review → Done` is auto-applied. Anything else (backwards move, skip, ambiguous) goes into a **transition confirm card** that DMs the Scrum Master, who approves per-row and clicks **Apply approved**.

## Warn thresholds (MVP 4)

Sprint is flagged **at risk** when both hold:

```
progressPct         >= WARN_SPRINT_PROGRESS_PCT     (default 0.50)
pointsInToDo/total  >= WARN_TODO_PCT                (default 0.40)
```

If story points are missing on any issue, the check falls back to item counts.

## Calendar path (MVP 3)

**`Propose unblock meeting`** and **`Book it`** on the Adaptive Cards drive the A365 `mcp_CalendarTools` MCP server via a scenario-specific OpenAI Agent whose output is Zod-validated. The event is created on the **agent's own** mailbox (Scrum-Master-Assistant); the SM plus blocker owner + reporter are attached as attendees and receive Teams meeting invitations. No delegated user calendar consent is required.

Fallback: if `findMeetingTimes` yields no candidates, the code synthesizes three consecutive hour slots so the demo still moves forward.

## Reset the demo

Two things to purge if you want a fresh state:

```powershell
# 1. Wipe the delegated MSAL token cache (forces a fresh device-code sign-in on next setup)
Remove-Item .mstoken-cache.json

# 2. Empty the SMA_* lists via SharePoint UI (Site contents → each list → delete all items)
#    or re-run `npm run setup:sharepoint` after deleting the lists.
```

To reset Jira sprint issues for a fresh demo, use the Atlassian UI or the Agile REST API (`POST /rest/agile/1.0/sprint/{sprintId}/issue`).

## File layout of the POC additions

```
src/
├─ agent.ts                        (modified) routes SMA card submits + commands
├─ index.ts                        (modified) mounts /api/internal/* + starts local cron
├─ config.ts                       (new)      centralized env-var reader
├─ handlers/
│  ├─ commands.ts   (new)  /standup, /config channel, /help
│  ├─ standup.ts    (new)  triggerStandup + handleStandupSubmit + summarizeStandup
│  ├─ reconcile.ts  (new)  auto forward transitions + confirm-card path
│  ├─ chase.ts      (new)  blocker escalation, propose slots, book meeting
│  ├─ warn.ts       (new)  sprint risk assessor
│  ├─ report.ts     (new)  sprint-close markdown + SharePoint upload
│  ├─ answer.ts     (new)  Q&A over live Jira board
│  └─ config.ts     (new)  /config channel handler
├─ cards/
│  ├─ standup-request.card.ts
│  ├─ standup-summary.card.ts
│  ├─ blocker-escalation.card.ts
│  ├─ meeting-propose.card.ts
│  └─ transition-confirm.card.ts
├─ services/
│  ├─ jira.ts             REST client (live) + fallback to mock/jira-mock.ts
│  ├─ graph.ts            MSAL device-code + delegated Graph
│  ├─ sharepoint.ts       List/library CRUD via Graph
│  ├─ team-roster.ts      TeamMembers list wrapper + auto-provisioning
│  ├─ session-store.ts    in-memory session cache
│  ├─ proactive.ts        adapter.continueConversation wrapper
│  ├─ jira-tool.ts        OpenAI Agents SDK tools for MVP 5 Answer
│  └─ calendar.ts         mcp_CalendarTools LLM-driven path for MVP 3
├─ cron/local-scheduler.ts (new)   node-cron in dev; disabled in prod
├─ mock/jira-mock.ts       (new)   offline seeded sprint for JIRA_MODE=mock
└─ scripts/
   ├─ setup-sharepoint.ts  provisions site collateral
   ├─ seed-team.ts         seeds TeamMembers with /me auto-fill
   └─ team.sample.json     mock roster
```

## Known limitations of the POC

- **MSAL token cache is unencrypted on disk** (`.mstoken-cache.json`, gitignored). Fine for local dev. For prod, swap for a Key Vault or the DPAPI-backed extension.
- **`GRAPH_CLIENT_ID` uses the well-known "Microsoft Graph Command Line Tools" app** for zero-setup device-code sign-in. In a real deployment, register your own multi-tenant public client and swap the id here.
- **Local `node-cron` and Azure Functions timer are idempotent** (`standupId = <sprintId>#<yyyy-mm-dd>`), but running both simultaneously does two Jira reads per tick — cheap, but you can disable `LOCAL_CRON=false` once the Azure Function is deployed.
- **Team-roster proactive DMs require prior interaction** — every squad member must have said "hi" to the agent at least once so we have their conversation reference. `upsertConversationReference` captures it on every incoming activity.

## Support

For issues, questions, or feedback:

- **Issues**: Please file issues in the [GitHub Issues](https://github.com/microsoft/Agent365-nodejs/issues) section
- **Documentation**: See the [Microsoft Agents 365 Developer documentation](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- **Security**: For security issues, please see [SECURITY.md](SECURITY.md)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Additional Resources

- [Microsoft Agent 365 SDK - Node.js repository](https://github.com/microsoft/Agent365-nodejs)
- [Microsoft 365 Agents SDK - Node.js repository](https://github.com/Microsoft/Agents-for-js)
- [OpenAI API documentation](https://platform.openai.com/docs/)
- [Node.js API documentation](https://learn.microsoft.com/javascript/api/?view=m365-agents-sdk&preserve-view=true)

## Trademarks

*Microsoft, Windows, Microsoft Azure and/or other Microsoft products and services referenced in the documentation may be either trademarks or registered trademarks of Microsoft in the United States and/or other countries. The licenses for this project do not grant you rights to use any Microsoft names, logos, or trademarks. Microsoft's general trademark guidelines can be found at http://go.microsoft.com/fwlink/?LinkID=254653.*

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the MIT License - see the [LICENSE](LICENSE.md) file for details.