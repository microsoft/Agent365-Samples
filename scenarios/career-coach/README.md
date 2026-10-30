# Career Coach autopilot — Agent 365 scenario sample (Node.js)

An AI **Career Coach** built on the Microsoft Agent 365 SDK that runs inside Microsoft Teams **and by email**: it helps employees set a target role, maps their skill gaps, recommends courses, quizzes them proactively as they complete learning, and sends the manager wrap-up email — all backed by SharePoint state and Microsoft Graph. This is a **scenario extension** on top of the base [OpenAI + Node.js sample-agent](../../nodejs/openai/sample-agent); see that folder for A365 SDK primer material (user identity, install events, typing indicators).

> **Stack:** Node.js · TypeScript · Microsoft Agent 365 SDK · OpenAI Agents SDK · Azure OpenAI (GPT-4o) · SharePoint Lists · Microsoft Graph (agentic auth) · WorkIQ MCP · Adaptive Cards.

> 📘 Architecture, data model, security and design decisions live in **[`docs/design.md`](docs/design.md)**; a request-order tour of the code is in **[`AGENT-CODE-WALKTHROUGH.md`](AGENT-CODE-WALKTHROUGH.md)**. This README is about **getting the agent running end-to-end** and trying each capability.

Uses a **hybrid pro-code architecture** — the LLM handles free-text conversation and creative generation only; every card submit, data write, and business rule runs as deterministic TypeScript.

> **Agent 365 AI Teammate** — this sample is registered with Microsoft **Agent 365** and runs as an **AI Teammate** (it has its own M365 identity and mailbox). OpenTelemetry observability (→ MAC Activity / Defender) and WorkIQ MCP tools (Mail, Calendar — V2 servers in `ToolingManifest.json`) are wired in; SharePoint list access uses the agent's own Graph function tools (`src/sharepoint-tools.ts`). The agent also converses by email (see §8.8 and `src/email-conversation.ts`). Each user's goals are tracked as one SharePoint row per goal (see §8.7). Registration, endpoint and publish steps are in §6.1 and §13.

## What this sample demonstrates

- A pro-code Agent 365 **AI Teammate** with its own M365 identity and mailbox, reachable in Microsoft Teams and by email.
- **Hybrid architecture** — deterministic TypeScript for all card submits, data writes, grading and business rules; focused LLM calls only for conversation, quiz generation, short-answer grading, and email prose.
- **Guarded LLM writes** — tool-level guards stop the model from marking progress it didn't earn or corrupting the goal lifecycle (one SharePoint row per goal, with history).
- **Durable SharePoint state** across five lists, read and written via agentic Microsoft Graph.
- **Proactive messaging** via Microsoft Graph change notifications (a learning-portal completion triggers an unprompted quiz DM).
- **WorkIQ MCP tools** (Mail, Calendar) for user-requested Microsoft 365 actions.
- **Agent 365 observability** — `invoke_agent`, `chat` and `execute_tool` spans for every turn, exported over the S2S route with an app-only token for the runtime agent identity.

This sample uses the following Microsoft Agents and Agent 365 packages:

- [@microsoft/agents-a365-notifications - npm](https://www.npmjs.com/package/@microsoft/agents-a365-notifications)
- [@microsoft/agents-a365-runtime - npm](https://www.npmjs.com/package/@microsoft/agents-a365-runtime)
- [@microsoft/agents-a365-tooling - npm](https://www.npmjs.com/package/@microsoft/agents-a365-tooling)
- [@microsoft/agents-a365-tooling-extensions-openai - npm](https://www.npmjs.com/package/@microsoft/agents-a365-tooling-extensions-openai)
- [@microsoft/agents-activity - npm](https://www.npmjs.com/package/@microsoft/agents-activity)
- [@microsoft/agents-hosting - npm](https://www.npmjs.com/package/@microsoft/agents-hosting)
- [@microsoft/opentelemetry - npm](https://www.npmjs.com/package/@microsoft/opentelemetry)

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Clone + install](#2-clone--install)
3. [Configure `.env`](#3-configure-env)
4. [First-time SharePoint setup](#4-first-time-sharepoint-setup)
5. [Dev tunnel + Graph subscription (Feature 1)](#5-dev-tunnel--graph-subscription-feature-1)
6. [Run the agent](#6-run-the-agent)
7. [Test accounts](#7-test-accounts)
8. [End-to-end test walkthrough](#8-end-to-end-test-walkthrough)
9. [Scripts reference](#9-scripts-reference)
10. [Architecture summary](#10-architecture-summary)
11. [Troubleshooting](#11-troubleshooting)
12. [Authentication + identity](#12-authentication--identity)
13. [Deploying the agent](#13-deploying-the-agent)
14. [Additional resources](#14-additional-resources)

---

## 1. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | **20.x or 22.x** | Tested on 22.14. `nvm-windows` or `nvm` recommended. |
| PowerShell | 5.1 or 7.x | Every terminal snippet in this guide uses PowerShell. |
| VS Code | 1.90+ | Optional but recommended (Copilot Chat + integrated terminal). |
| Azure subscription | any | For Azure OpenAI (GPT-4o deployment) + the A365 app registration. |
| Microsoft 365 tenant | E3/E5 dev tenant works | Owns the SharePoint site + the two test users. Needs Agent 365 (Frontier) access and a mailbox for the agent user. |
| Agent 365 CLI | latest | `dotnet tool install -g Microsoft.Agents.A365.DevTools.Cli`. Registers the Blueprint + AI Teammate identity and publishes the manifest (see §6.1). |
| Dev Tunnels CLI | latest | To expose your local `/api/messages` endpoint and the `/api/portal-event` webhook. Install with `winget install Microsoft.devtunnel` or `az extension add --name dev-tunnel`. |

**Azure OpenAI deployment**
- Model: `gpt-4o` (any recent version)
- Deployment name: your choice — put it in `.env` as `AZURE_OPENAI_DEPLOYMENT`

**Microsoft Entra (Azure AD) app registration for the agent**
- The A365 platform provisions one for you when you create a hosted-agent project. That app's client ID + secret + tenant ID go into `.env` under `connections__service_connection__settings__*`.
- **Required delegated Graph scopes (with admin consent):**
  - `Sites.ReadWrite.All`
  - `User.Read.All`
  - `Mail.Send`
  - `Mail.ReadWrite`
  - `Chat.ReadWrite`
  - ⚠️ `a365 setup all --aiteammate` grants `Sites.Read.All` but **not** `Sites.ReadWrite.All`, so saving a plan fails with `Access denied`. Add it to the blueprint after setup (pass the full scope list — it replaces the Graph grant), then accept the admin-consent URL the CLI prints and restart the agent:
    ```powershell
    a365 setup permissions custom --resource-app-id 00000003-0000-0000-c000-000000000000 `
      --scopes "Mail.ReadWrite,Mail.Send,Chat.ReadWrite,User.Read.All,Sites.Read.All,Sites.ReadWrite.All,Files.ReadWrite.All,ChannelMessage.Read.All,ChannelMessage.Send"
    ```
- **WorkIQ (Mail / Calendar) permissions:** the MCP servers in `ToolingManifest.json` need an extra grant. A **Global Administrator** runs `a365 setup permissions mcp` from this folder once. Until then the agent still works but its Mail / Calendar tools fail (403 or timeouts, logged as `[WorkIQ] Could not connect MCP server …`).
- **Observability permission:** `Agent365.Observability.OtelWrite` (delegated and application) on the blueprint — granted by `a365 setup all`. Verify with the read-only `a365 query-entra blueprint-scopes` and `a365 query-entra inheritance`.

**SharePoint site**
- Any modern team/comm site works. This repo assumes `https://<tenant>.sharepoint.com/sites/CareerCoach`.
- The setup script creates all 5 lists automatically — you don't create them by hand.
- **Don't create the lists by CSV import.** That makes every column single-line text (max 255 chars), and saving a plan then fails with `General exception while processing`. Let `npm run setup:sharepoint` create the lists so `Goals`/`Skills`/`LearningProgress`/`QuestionsJSON` are multi-line and numbers/dates/booleans are typed. (Importing CSVs into the two read-only reference lists is fine.)

---

## 2. Clone + install

```powershell
git clone https://github.com/microsoft/Agent365-Samples.git
cd Agent365-Samples/scenarios/career-coach

# Install dependencies (~2 min, ~200 MB into node_modules)
npm install
```

---

## 3. Configure `.env`

Copy the shipped template and fill in the values:

```powershell
Copy-Item .env.template .env
```

Then open `.env` and set each variable. Grouped for clarity:

### Azure OpenAI
| Variable | Where to get it |
|---|---|
| `AZURE_OPENAI_API_KEY` | Azure portal → your Azure OpenAI resource → *Keys and Endpoint* |
| `AZURE_OPENAI_ENDPOINT` | Same page. Format: `https://<name>.openai.azure.com/` |
| `AZURE_OPENAI_DEPLOYMENT` | Name you gave the GPT-4o deployment (not the model name) |
| `AZURE_OPENAI_API_VERSION` | Leave as `2024-10-21` |

(To use OpenAI directly instead, set `OPENAI_API_KEY` and `OPENAI_MODEL` and leave the Azure values empty.)

### A365 hosted-agent connection
These are written by the A365 CLI during registration (`a365 setup all --agent-name "Career Coach" --aiteammate`) — the template's `connections__*`, `connectionsMap__*`, `agentic_*` and `USE_AGENTIC_AUTH=true` entries must all be filled.

| Variable | Where to get it |
|---|---|
| `connections__service_connection__settings__clientId` | The blueprint's app (client) ID — `agentBlueprintId` in `a365.generated.config.json` |
| `connections__service_connection__settings__clientSecret` | The blueprint client secret created by the CLI |
| `connections__service_connection__settings__tenantId` | Your M365 tenant ID |
| `agent_id` | Same as `clientId` |
| `USE_AGENTIC_AUTH` | `true` — the agent acts as its own agentic user |
| `NODE_ENV` | `production` when running behind the dev tunnel so inbound tokens are validated. `development` **disables inbound auth** — local Playground only. |

### Observability (Agent 365 telemetry)
| Variable | Value |
|---|---|
| `ENABLE_A365_OBSERVABILITY_EXPORTER` | `true` to send spans to Agent 365 (MAC Activity / Defender). Set `false` for local-only runs. |
| `A365_OBSERVABILITY_LOG_LEVEL` | `none`, or any of `info`, `warn`, `error` joined with `\|`. Use `info\|warn\|error` while verifying (shows exporter / token lines); `warn\|error` afterwards. |
| `agent365Observability__agentId` | The **runtime Agent Identity** app ID (the agent instance — **not** the blueprint ID). Only a fallback; the live ID is read from each turn. The startup log line `[A365 Observability] App-only export token acquired for agent <id>` shows it. |
| `agent365Observability__agentBlueprintId` | The blueprint's app ID |
| `agent365Observability__tenantId`, `…__clientId`, `…__clientSecret`, `…__agentName`, `…__agentDescription` | From registration (see the template) |

### WorkIQ tools (optional, local dev only)
| Variable | Value |
|---|---|
| `BEARER_TOKEN` | Token from `a365 develop get-token`, only for running MCP tools without the platform token. Leave empty normally. Tokens expire. |

The agent never blocks on WorkIQ: if an MCP server can't be reached it logs `[WorkIQ] Could not connect MCP server …` and carries on with its SharePoint tools.

### SharePoint
| Variable | Value |
|---|---|
| `SP_SITE_HOST` | e.g. `contoso.sharepoint.com` |
| `SP_SITE_PATH` | `/sites/CareerCoach` (or whatever you use) |
| `SP_LIST_*` | Keep the shipped defaults unless you rename lists (the list *display names* must match exactly, e.g. `UserState_V3`) |

### Feature 1 webhook (real-time trigger)
| Variable | Value |
|---|---|
| `PORTAL_WEBHOOK_URL` | Your dev-tunnel URL + `/api/portal-event` (see §5) |
| `PORTAL_EVENT_SECRET` | Any random string (used for a manual POST test path) |

> **Security note** — never check `.env` or `a365.generated.config.json` into git (they hold secrets). The shipped `.env.template` has no secrets.

---

## 4. First-time SharePoint setup

**Step 4.1 — MSAL device-code sign-in** (one-time, per developer machine)

The setup scripts use MSAL delegated auth (device-code flow) as a developer signed in with **Sites.Manage.All** or a Site Collection Admin. When you run any `setup:*` / `seed:*` / `mark:*` script the first time, you'll see:

```
To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code XXXXXXX to authenticate.
```

Sign in with an account that has admin rights on the SharePoint site. Token is cached in `.mstoken-cache.json` for future runs (60 days).

**Step 4.2 — Provision the 5 lists**

```powershell
npm run setup:sharepoint
```

Creates (names come from `SP_LIST_*`; the defaults are shown):
- `CompetencyFramework_v2`
- `LearningCatalog_v2`
- `UserState` — one row per goal, including the `PlanStatus` / `PlanCompletedDate` lifecycle columns (see §8.7)
- `LearningPortalStatus`
- `QuizResponses`

It is idempotent. Re-run it after upgrading so existing lists get any new columns.

**Step 4.3 — Seed reference data** (roles + course catalog)

```powershell
npm run seed:reference
```

Reads the two CSVs from `SharePoint Data\` (project-local, ships with the repo) and inserts ~19 competencies + ~31 courses. Override the location with `SP_SEED_CSV_DIR` if needed.

**Step 4.4 — Give the agent user access to the site** (required)

At runtime the agent reads/writes the lists as its **own agent user** (e.g. `CareerCoach@<tenant>.onmicrosoft.com`, created when the agent instance is approved), not as the developer who ran the setup scripts. Add that agent user as a **Member** of the site (SharePoint → site → *Settings* → *Site permissions*, or the site's Microsoft 365 group). Without it, every SharePoint tool call fails and the agent replies that it is "having trouble accessing your progress". Membership can take a few minutes to propagate.

---

## 5. Dev tunnel + Graph subscription (Feature 1)

Feature 1 is the "portal completes a course → agent DMs the user with a quiz" flow. It needs a public HTTPS URL for Microsoft Graph to POST change notifications to.

**Step 5.1 — Start a persistent dev tunnel** (in its own terminal, keep running)

A named tunnel keeps the same URL across restarts, so the blueprint endpoint and the Graph subscription don't need re-registering:

```powershell
devtunnel user login                                                    # once
devtunnel create career-coach-tunnel --allow-anonymous                  # once
devtunnel port create career-coach-tunnel -p 3978 --protocol http       # once — http, not https (https causes relay 502s)
devtunnel host career-coach-tunnel                                      # every session
```

The host command prints something like `https://spiffy-dog-h50g1wc-3978.inc1.devtunnels.ms`. Note this URL. (For a quick throw-away tunnel you can instead run `devtunnel host -p 3978 --allow-anonymous`, but its URL changes every time.)

**Step 5.2 — Point `.env` at that URL**

```env
PORTAL_WEBHOOK_URL=https://spiffy-dog-h50g1wc-3978.inc1.devtunnels.ms/api/portal-event
```

**Step 5.3 — Subscription is created automatically on server startup.**

When you `npm run dev` (see §6), the server calls Graph `POST /subscriptions` pointing at `PORTAL_WEBHOOK_URL`. Graph validates by POSTing `?validationToken=X` — your server must echo it back within ~10s (already handled). The subscription auto-renews every 30 minutes.

---

## 6. Run the agent

### 6.1 — Register and publish (once per tenant)

```powershell
a365 setup all --agent-name "Career Coach" --aiteammate                          # blueprint + agent identity + permissions
a365 setup blueprint --update-endpoint https://<tunnel>/api/messages --m365      # point the blueprint at your dev tunnel (--m365 also registers it with Teams)
a365 publish --agent-name "Career Coach" --aiteammate                            # builds manifest\manifest.zip
```

Then complete the Teams side (see [Create agent instance](https://learn.microsoft.com/microsoft-agent-365/developer/create-instance)):
1. Upload `manifest\manifest.zip` in the Microsoft 365 admin center.
2. In **Teams Developer Portal**, open the blueprint configuration at `https://dev.teams.microsoft.com/tools/agent-blueprint/<agentBlueprintId>/configuration` (`agentBlueprintId` is in `a365.generated.config.json`) and check: **Agent Type = API Based**, **Notification URL = your `/api/messages` endpoint**. Without this the agent receives nothing from Teams or email.
3. Create an agent instance and approve it as a tenant admin. The agent user (mailbox) is created at this point. Make sure the agent user has the licenses Agent 365 requires (for example an Agent 365 license plus Teams) — an unlicensed agent user never receives Teams messages.
4. Add the agent user to the SharePoint site (§4.4), then open **Career Coach** in Teams.

Re-run `a365 setup blueprint --update-endpoint … --m365` whenever the tunnel URL changes. A new agent user can take a few minutes (sometimes longer) before Teams delivers messages to it.

### 6.2 — Start the agent + tunnel

Use two terminals:

```powershell
# Terminal 1 — the dev tunnel (§5.1)
devtunnel host career-coach-tunnel

# Terminal 2 — the agent
npm run dev
```

(`npm run dev` uses nodemon + ts-node and restarts on every `src/` change. To run the compiled build instead: `npm run build`, then `npm start`.) To keep a log you can grep later:

```powershell
npm run dev 2>&1 | Tee-Object -FilePath .\dev.log
```

You should see:

```
Server listening on 0.0.0.0:3978 for appId <clientId>
[sub-mgr] Created new subscription (id=…) expiring 2026-01-01T00:00:00Z
[SharePointTools] Warmed siteId cache with "…"
[WorkIQ] Attached 3 MCP server(s): …                      (on the first message of a conversation)
[A365 Observability] App-only export token acquired for agent <id> (S2S route)
```

Health check: `GET /api/health`.

---

## 7. Test accounts

Pick any two users from **your own M365 tenant** to test with. For a realistic Feature 4 (manager email) demo, make sure at least one of them has a **manager** set in Entra ID — the completion email is Cc'd to that manager.

You'll need each test user's **UPN** and **AAD Object ID** (Entra ID → Users → select the user → *Object ID*).

> **Set the default user for scripts:** every helper script (`mark:complete`, `reset:milestones`, `backup:user`) accepts a user AAD ID. To avoid retyping it, set env vars **once** per terminal session:
>
> ```powershell
> $env:TEST_USER_AAD_ID = '<your-test-user-object-id>'
> $env:TEST_USER_NAME   = 'Your Test User'
> ```

---

## 8. End-to-end test walkthrough

Recommended order — takes ~10-15 min the first time, ~5 min for re-runs.

### 8.0 — Fresh slate (optional but recommended for demos)

Snapshots your test user's state to disk, then clears their 3 write-lists so you get a clean re-run:

```powershell
npm run backup:user -- <your-test-user-object-id> "Your Test User"
```

Backup lands in `backups/user-<Name>-<timestamp>.json`.

### 8.1 — Welcome + set target role

1. Sign into Teams as your test user
2. Open the Career Coach chat
3. Send `hi`
4. **Expected:** the welcome card renders with a 2×2 tile grid: 🎯 Goal · 📊 Skills · 💬 Prep · 📈 Progress
5. Click **Goal**
6. **Expected:** the coach asks *"What role are you targeting?"*
7. Reply `AI Engineer`
8. **Expected:** skill-path card renders with 5 skills, each with a target level and a dropdown

### 8.2 — Rate skills + save plan

1. Change each dropdown from `0 · Not started` to some higher value (mix of 0, 1, 2)
2. Click **Continue — see my gaps**
3. **Expected:** the interactive card converts to a read-only summary (✅ Ratings submitted), and a **planReview** card renders below with each skill's gap + recommended courses
4. Click **💾 Save my plan**
5. **Expected:** a **progress** card renders showing all goals at 0% Not Started (plan is saved)

Verify in SharePoint: `UserState` list has a new row with your test user's UserAADId, `PlanStatus = Active`, 5 goals, 5 skills, and 7 courses in LearningProgress.

Buttons lock after use: submitted rating and quiz cards turn read-only, and a saved plan can't be saved twice. If a step fails after you click (for example a network drop), the agent says so, unlocks the card with your answers kept, and tells you what to click. If a step fails after showing its result, the card stays locked and the message points to the next step.

### 8.3 — Feature 1 — real-time proactive quiz

**Simulate a course completion** on the learning portal by inserting a row into `LearningPortalStatus`:

```powershell
npm run mark:complete -- CS007560
```

That's course "Fundamentals of AI Engineering" for skill "ai-engineering".

Within ~30-60 seconds, the Graph webhook fires and your test user gets an **unprompted DM** with a 5-question quiz card. Answer 4 or 5 correctly and submit.

**Expected sequence:**
1. `quizResult` card with your score + per-question feedback
2. UserState updates in code: skill `ai-engineering` bumps to level 2, goal recomputes, one course marked Complete

You can also report a completion in chat instead of using the portal: `I completed <course name>` (or `I completed all the courses`) starts the same quiz. A course only becomes Complete when its quiz is passed (4 of 5) — the LLM can't mark it complete itself.

Run one command per course during the demo. See §9 for the full 6-course sequence.

### 8.4 — Feature 3 — 80% milestone

When 3+ of the 5 goals reach 100%, `OverallProgress` crosses 80%. The **milestone80** card fires automatically inside the same reply as the quiz result, showing:
- Overall progress
- Which goals still need work
- Top 5 weak topic tags aggregated from every quiz attempt

### 8.5 — Feature 4 — 100% completion + manager email

When all goals hit 100%, the **completionSummary** card fires. The app handles this on its own (`fireCompletion100` in `handlers.ts`), not the LLM. It runs from the `handleQuizSubmit` cascade or from `check my progress`:
1. An LLM sub-call writes a warm HTML email body listing every completed course + total time
2. Code sends via `/me/sendMail` from the agent's own mailbox — **To:** the test user, **Cc:** their manager (from Entra ID)
3. `Completion100Fired` is set only after a successful send, so `check my progress` retries a failed email
4. The goal is then marked **Completed** (`PlanStatus`, `PlanCompletedDate`). The next "hi" gets the welcome card and a fresh goal (see 8.7)

The chat LLM is told never to send this email itself (it has WorkIQ Mail tools, see below).

Check the test user's Inbox + the manager's Inbox — the email should arrive within ~30 seconds of the completion card.

### 8.6 — Deterministic "check my progress"

Send `check my progress` in Teams (also `sync my progress`, `any updates`, `resend completion email`, …) — this bypasses the LLM entirely and runs `handleSyncProgress` directly. Useful for verifying state without needing another course completion, and it retries a completion email that failed to send.

### 8.7 — Goal lifecycle (one row per goal)

`UserState` keeps **one row per goal**, so all goals for a user (Teams and email) are tracked in one place:

| `PlanStatus` | Meaning |
|---|---|
| `Active` | The goal being worked on. At most one per user. All handlers and the LLM's SharePoint tools only see this row. |
| `Completed` | Reached 100% and the completion email was sent. Read-only history. |
| `Replaced` | The user saved a new goal before finishing this one (the unfinished goal is kept, not overwritten). Read-only history. |

- With no active goal, the agent greets the user with the welcome card and starts a new goal. Saving a new goal creates a new row.
- Ask *"show my previous goals"* to see the history (the LLM's `listPreviousGoals` tool).
- **"Prep me for my 1:1"** uses the active goal. With no active goal it uses the finished goal, or asks which one when there are several. Previous goals are read-only, so a manager-asks answer is used in the brief but not saved to a finished goal.
- `PlanStatus`, `PlanCompletedDate`, `Completion100Fired`, `ManagerName` and `ManagerEmail` are app-managed. The SharePoint tools strip them from LLM writes (also when sent under an internal column name) and block edits to finished goals, creating a second active goal, and changing the role of a goal that has progress. The model only ever sees and writes the current user's own rows, and only `UserState` can be written from chat.
- Rows saved before these columns existed count as `Completed` once `Completion100Fired` is Yes, otherwise `Active`.
- **Existing tenants:** re-run `npm run setup:sharepoint` once to add the `PlanStatus` and `PlanCompletedDate` columns. Until then the agent still works, falling back to `Completion100Fired`, and logs a warning.

### 8.8 — Email conversations

Send an email to the agent's address (e.g. `CareerCoach@<tenant>.onmicrosoft.com`) from a user in your tenant. The agent holds the same conversation as in Teams and replies in the thread:

1. Email `Hi` → the welcome text. Reply with a target role → skill table, then reply with your ratings as text (e.g. `1, 2, 0, 1, 2`)
2. The plan comes back as a table with **Reply "Save it" to save this plan** — reply `Save it` and the plan is saved with the same code as the Teams button (progress table comes back)
3. Quizzes and other interactive steps say to continue in Teams
4. Ask for things in plain words (`email me my plan`, `find time for my 1:1`) — the agent uses its WorkIQ Mail / Calendar tools, only for you

How it behaves:
- History is kept **per email thread**; after an agent restart, the quoted text in your reply restores the context.
- Only people in your organization get an answer (guests, external senders and bounce / non-delivery mails are ignored).
- In Defender / MAC Activity, one thread is one conversation.

If an email gets no reply, check `dev.log` for `[Email]` lines (and that the Teams Developer Portal notification URL is set — §6.1).

---

## 9. Scripts reference

| Command | Purpose |
|---|---|
| `npm run dev` | Start the agent in watch mode. Nodemon restarts on any `src/` change. |
| `npm run build` | Compile TypeScript to `dist/` (used by `npm run start`). |
| `npm run start` | Run the compiled build (production mode). |
| `npm run test-tool` | Open Agents Playground for local testing without Teams (set `NODE_ENV=development` for that — it disables inbound auth). |
| `npm run clean` / `npm run install:clean` | Remove `dist`, `node_modules` and the lockfile / do that, then reinstall. |
| `npm run setup:sharepoint` | Create the 5 SharePoint lists and add any missing `UserState` columns (idempotent; re-run after upgrades). |
| `npm run seed:reference` | Populate `CompetencyFramework_v2` + `LearningCatalog_v2` from CSVs. |
| `npm run clear:list -- <ListName>` | Delete every item from a list. Useful for demo resets. |
| `npm run mark:complete -- <CourseId> [CourseId…]` | Insert one or more rows into `LearningPortalStatus` marking those courses complete for the current test user (env var). |
| `npm run reset:milestones -- <AadObjectId>` | Flip `Milestone80Fired` + `Completion100Fired` back to false so cards can re-fire. If the user has no active goal, it reopens their latest Completed goal. |
| `npm run backup:user -- <AadObjectId> "Name"` | Snapshot the user's rows across `UserState` (every goal, including finished ones) + `LearningPortalStatus` + `QuizResponses` to `backups/`, then delete them. |

### Course IDs for the demo run (in the order voiceover expects them)

```powershell
npm run mark:complete -- CS008714   # Programming Foundations: Beyond the Fundamentals
npm run mark:complete -- CS002731   # What Is Generative AI?
npm run mark:complete -- CS004890   # Generative AI: Introduction to LLMs
npm run mark:complete -- CS008605   # Building Generative AI Skills for Developers
npm run mark:complete -- CS001927   # Natural Language Processing for Speech and Text
npm run mark:complete -- CS006481   # Advance Your Skills in Natural Language Processing
```

Space them ~60s apart so each proactive quiz DM arrives before the next completion fires.

---

## 10. Architecture summary

```
Microsoft Teams ─┐
                 ├─←→  Career Coach (A365 SDK)  ←→  Microsoft 365
Email (A365 ─────┘     ├─ 🚦 Card + message + email router
 email notification)   ├─ ⚙️ Deterministic TypeScript
                       │      ├─ Save plan (Teams button or "Save it" email)
                       │      ├─ Sync progress
                       │      ├─ Grade MCQ
                       │      ├─ Milestones + goal lifecycle
                       │      └─ Send completion email
                       └─ 🧠 Focused LLM sub-calls
                              ├─ Conversation (role elicitation, prep brief, previous goals)
                              ├─ Quiz question generation
                              ├─ Short-answer grading
                              └─ Completion email prose
```

- **SharePoint lists** own state — `UserState` (one row per goal — the active plan plus finished goals as history), `LearningPortalStatus` (course telemetry), `QuizResponses` (attempt log), plus two read-only reference lists.
- **Microsoft Graph** delivers change notifications when the portal updates + sends the completion email on `/me/sendMail`.
- **WorkIQ MCP tools** (Mail, Calendar, plus SharePoint if the gateway attaches it) give the LLM M365 actions the user explicitly asks for ("email me my plan"). The WorkIQ SharePoint server is **read-only**: `client.ts` hides its write tools, so every list write goes through the guarded tools in `sharepoint-tools.ts`. Emails *sent to* the agent are still received by the A365 email notification handler in `agent.ts`. WorkIQ doesn't replace that handler. MCP servers are attached per turn and never block it — a server that can't connect is skipped.
- **Email conversations** keep their history per email thread (keyed on the stable `emailNotification.conversationId`). If the agent has no history for a thread (e.g. after a restart), the quoted reply history in the email is passed to the LLM as context. Replying **"Save it"** saves the plan from the thread's latest plan-review card using the same code as the Teams **Save my plan** button (pending plans are kept in `.email-plans.json`). Quizzes still need Teams.
- **Guarded writes** — `sharepoint-tools.ts` stops the LLM from marking a course Complete or raising a skill level without a passed quiz (`[ProgressGuard]`), enforces the goal lifecycle (§8.7), limits chat writes to `UserState`, scopes every personal list to the caller's own rows, and verifies row ownership before an update. Every `UserState` read-modify-write runs under a per-user lock (`user-lock.ts`).
- **Resilient card actions** — button steps run after the invoke returns; on failure `runDeferred` in `agent.ts` tells the user, and unlocks the card when it is safe to retry.
- **Observability** — `telemetry.ts` initialises `@microsoft/opentelemetry` (A365 exporter on the S2S route). `observability/app-token-resolver.ts` does the 3-hop FMI token exchange for the runtime agent identity; every turn (LLM, card action, email) is wrapped in `invoke_agent` / `chat` / `execute_tool` spans. `observability/conversation-id.ts` groups an email thread into one conversation.
- **Agentic auth** — the A365 platform hands the agent its own agentic-user Graph token per turn, so `/me` is the Career Coach agent user (its own mailbox). No manual token refreshes.

Source layout:

```
src/
├── index.ts                  Express + /api/messages + /api/portal-event + /api/health
├── telemetry.ts              A365 observability bootstrap (imported first)
├── agent.ts                  AgentApplication, Action.Execute handlers, email + notification handling, observability scopes
├── client.ts                 OpenAI Agents client + system prompt + WorkIQ MCP attach (LLM path)
├── openai-config.ts          Azure OpenAI / OpenAI client setup
├── cards.ts                  All Adaptive Card renderers + renderCard()
├── handlers.ts               Deterministic card handlers (skill ratings, save, quiz, sync, milestone, completion email)
├── career-coach-service.ts   Pure business logic + typed SP CRUD (active vs previous goals)
├── llm-tasks.ts              3 focused LLM sub-calls (Q gen, short-answer grade, email prose)
├── graph-service.ts          MSAL device-code + agentic Graph clients + sendMail + subscriptions
├── sharepoint-tools.ts       OpenAI Agents function tools incl. listPreviousGoals + write guards (LLM path only)
├── sharepoint-column-map.ts  Display-name ↔ internal-name translation
├── career-coach-types.ts     Shared types + SP_CONFIG + goal lifecycle (PlanStatus)
├── quiz-cache.ts             In-memory quiz answer key store (one in-flight generation per user/course)
├── user-lock.ts              Per-user async mutex around every UserState read-modify-write
├── file-storage.ts           Disk-backed SDK Storage impl for Proactive subsystem
├── email-conversation.ts     Email turn prompt, quoted-history fallback, card → HTML rendering
├── email-plan-store.ts       Plans proposed by email, waiting for a "Save it" reply
├── proactive-refs.ts         AAD ID → conversation reference cache
├── subscription-manager.ts   Auto-create + auto-renew Graph subscription
├── observability/            app-token-resolver.ts (export token), conversation-id.ts (span conversation id)
└── scripts/                  Setup, seed, clear, mark, reset, backup helpers
```

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Server listening…` but no messages received in Teams | Agent instance not approved, wrong Notification URL in Teams Developer Portal, stale tunnel URL, or wrong app ID in `.env` | Follow §6.1 (re-run `a365 setup blueprint --update-endpoint …` after a tunnel change); verify `agent_id` matches the blueprint app ID, and check the agent user is licensed. |
| `[Proactive] Conversation not found in proactive storage` | Nodemon restart wiped the in-memory ref cache | Send `hi` in Teams once to re-register, then re-run `mark:complete` |
| `Something went wrong` red banner on card submit | Action.Execute took > 10s | Every card handler is fire-and-forget by design — check `dev.log` for the actual error. Common culprit: SharePoint token expired or Graph 429. |
| Quiz questions all show `Q1.` numbering wrong (`1. 1. 1.`) | Old cards.ts | Should be fixed in this build. If it recurs, verify `cards.ts` uses `Q${qNum}.` not `${qNum}.`. |
| Feature 4 email "Access is denied" | `sendMail` using `/users/{id}/sendMail` on a delegated token | Should be fixed — `graph-service.ts` uses `/me/sendMail` whenever a graph client is passed in. |
| `Failed to acquire token silently` on script start | Cached MSAL token expired (60 days) or was for a different tenant | Delete `.mstoken-cache.json` and re-run — a fresh device-code prompt will appear. |
| SharePoint 500 on write with no error detail | Column-name mismatch between display and internal | Check the `[createListItem] Known columns:` log line — the field you sent must be in there. |
| Graph subscription creation fails with "Notification URL invalid" | `PORTAL_WEBHOOK_URL` isn't reachable | Verify the dev tunnel is running and the URL in `.env` matches; test with `curl <URL>?validationToken=hi` (should echo `hi`). |
| Costs pile up on Azure OpenAI | Every user turn hits GPT-4o | Only Stage 1 (role elicit) + short-answer grading + email body call the LLM. Card submits are deterministic. Verify your logs show `[Sync] Deterministic sync…` not full LLM turns. |
| Agent says it is "having trouble accessing your progress" | The agent user isn't a member of the SharePoint site | Add the agent user as a Member of the site (§4.4); allow a few minutes. |
| Agent goes quiet after "Got it…" / "Saving your plan…" | Network/DNS drop to Graph or SharePoint (`fetch failed`) | The agent now tells you and unlocks the card (keeps your answers) — click the button again. Check `dev.log` for `Deferred step failed (network)`. If you get no message at all, the outage also blocked the reply: restart the agent and retry. |
| `[WorkIQ] Could not connect MCP server … Request timed out` | Slow / blocked MCP gateway, or the WorkIQ grants weren't applied | The turn continues without Mail / Calendar. A Global Admin runs `a365 setup permissions mcp`; re-check later. |
| "I don't see a saved plan" / "You don't have an active goal right now" | The user's last goal is Completed or Replaced | Expected after a goal finishes — say `hi` for a fresh goal, or ask for previous goals / a 1:1 prep (§8.7). |
| `[UserState] Column "PlanStatus" is missing` warning in the log | `setup:sharepoint` wasn't re-run after the goal-lifecycle upgrade | Run `npm run setup:sharepoint`. |
| Email to the agent gets no reply | Sender outside the organization, a bounce message, or the Teams Developer Portal notification URL isn't set | See `[Email] Ignored …` lines in `dev.log`; check §6.1 step 2. |
| Code change has no effect | `npm start` runs the compiled build in `dist/` | Run `npm run build` again before `npm start`, or use `npm run dev`. |
| Telemetry doesn't appear in Defender / MAC Activity | Exporter off, wrong agent ID, or tenant not onboarded | Check `ENABLE_A365_OBSERVABILITY_EXPORTER=true`, set `A365_OBSERVABILITY_LOG_LEVEL=info\|warn\|error` and look for `[A365 Observability]` lines; run `a365 query-entra inheritance`. Defender `CloudAppEvents` needs the right licence / portal; allow ~5 min for indexing. |

For anything else, grep `dev.log` — every subsystem prefixes its logs (`[Proactive]`, `[Sync]`, `[Quiz]`, `[SavePlan]`, `[SharePointTools]`, `[sub-mgr]`, `[Completion100]`, `[Email]`, `[WorkIQ]`, `[ProgressGuard]`, `[GoalLifecycle]`, `[A365 Observability]`).

---

## 12. Authentication + identity

Three separate credentials, each used for one job:

- **Runtime workload (the agent in Teams and email)** uses **agentic authentication**. The Agent 365 platform hands the agent a delegated Microsoft Graph token for its **own agentic user** on each turn, so `/me` is the Career Coach agent user (its own mailbox) — not the person chatting. SharePoint reads/writes, the completion email and WorkIQ MCP calls all use this identity. Configured via the `agentic_*` and `connections__service_connection__*` values in `.env` (stamped by `a365 setup all`). The person chatting is identified from the turn (`activity.from.aadObjectId`), and every SharePoint tool is scoped to that user's own rows.
- **Telemetry export** uses an **app-only** token for the runtime agent identity, exported over the S2S route (`src/observability/app-token-resolver.ts`): the blueprint credential issues an FMI assertion for the agent identity, which exchanges it for an Observability API token. The token is validated (no `scp`, matching client/tenant/audience) and never logged. `gen_ai.agent.id` is the runtime agent identity read from each turn (`activity.recipient.agenticAppId`); the Blueprint ID travels only as blueprint metadata.
- **Setup / seed scripts** use the **MSAL device-code** flow with delegated scopes (`Sites.Manage.All`, `Sites.ReadWrite.All`, `User.Read.All`, `Mail.Send`, `offline_access`), cached in `.mstoken-cache.json`.

> **Admin consent required.** `Sites.Manage.All` and `User.Read.All` are **admin-restricted** delegated permissions, so the one-time device-code sign-in for the setup scripts must be performed — or pre-consented — by a **tenant / SharePoint administrator**. The blueprint's `Sites.ReadWrite.All` grant (§1) and the WorkIQ MCP grants (`a365 setup permissions mcp`) also need a Global Administrator.

## 13. Deploying the agent

For local testing, a dev tunnel + the Agents Playground are enough (sections 5–6). To run it as a real Teams AI Teammate:

1. Register the Blueprint + Agentic User identity: `a365 setup all --agent-name "Career Coach" --aiteammate` (see the [Agent 365 developer docs](https://learn.microsoft.com/microsoft-agent-365/developer/)).
2. Host the agent at a public HTTPS endpoint (a dev tunnel for testing, or Azure App Service / Container Apps / Functions for a persistent deployment — see [Deploy to Azure](https://learn.microsoft.com/microsoft-agent-365/developer/deploy-agent-azure)).
3. Reconcile the messaging endpoint: `a365 setup blueprint --update-endpoint <url>/api/messages --m365`.
4. Package with `a365 publish --agent-name "Career Coach" --aiteammate`, upload the package in the Microsoft 365 admin center, confirm the Teams Developer Portal configuration, and request an instance ([create an instance](https://learn.microsoft.com/microsoft-agent-365/developer/create-instance)).

Set the cloud env vars (Azure OpenAI, agentic auth, observability, SharePoint) at the platform level — not just in a local `.env`. The quiz answer-key cache is in memory and the proactive map, email-plan store and subscription state are local files, which suits a single instance; move them to shared storage before running several instances.

## 14. Additional resources

- [Microsoft Agent 365 developer docs](https://learn.microsoft.com/microsoft-agent-365/developer/)
- [Agent 365 observability](https://learn.microsoft.com/microsoft-agent-365/developer/observability)
- [Test agents by using Dev Tunnels](https://learn.microsoft.com/microsoft-agent-365/developer/test-with-devtunnels)
- [Microsoft Agent 365 SDK for Node.js](https://github.com/microsoft/Agent365-nodejs)
- Base sample this extends: [`nodejs/openai/sample-agent`](../../nodejs/openai/sample-agent)
- Sibling scenarios: [Chief of Staff (#333)](https://github.com/microsoft/Agent365-Samples/pull/333) and [Scrum Master (#334)](https://github.com/microsoft/Agent365-Samples/pull/334)
- [`docs/design.md`](docs/design.md) and [`AGENT-CODE-WALKTHROUGH.md`](AGENT-CODE-WALKTHROUGH.md)

---

## Appendix — What's in this sample

| Folder / file | What it is |
|---|---|
| `src/` | All TypeScript source. Runtime + `scripts/` + service layer + `observability/`. |
| `manifest/` | Teams app manifest (placeholder IDs — filled in by `a365 setup` / `a365 publish`, which builds `manifest.zip`). |
| `docs/design.md` | Design: principles, architecture, data model and goal lifecycle, key flows, security, reliability, observability, decisions. |
| `AGENT-CODE-WALKTHROUGH.md` | Guided tour of the code in request order: startup, routing, flows, guards, email, observability. |
| `ToolingManifest.json` | WorkIQ MCP servers (Mail, Calendar) the agent loads. |
| `SharePoint Data/` | Seed CSVs for the two reference lists. |
| `images/` | Agent thumbnail. |
| `.env.template` | Template for the runtime config. Copy to `.env` and fill in the values. |
| `package.json` / `tsconfig.json` | Standard Node/TS build config. |

**Regenerated / never committed:** `.env`, `a365.config.json`, `a365.generated.config.json`, `.a365-workspace-detection.local.json`, `node_modules/`, `dist/`, `*.log`, `.mstoken-cache.json`, `.proactive-storage.json`, `.proactive-refs.json`, `.sp-subscription.json`, `.email-plans.json`, `backups/`, `manifest/manifest.zip`.

---

## Support · Contributing · Trademarks · License

This sample is provided as-is under the terms in the repository [`LICENSE.md`](../../LICENSE.md) (MIT). It is a scenario demonstration, not a supported product.

- **Issues / questions:** open an issue on [microsoft/Agent365-Samples](https://github.com/microsoft/Agent365-Samples/issues).
- **Contributing:** see the repo [`CONTRIBUTING.md`](../../CONTRIBUTING.md). Contributions require agreement to the Microsoft CLA.
- **Trademarks:** this project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft trademarks or logos is subject to and must follow [Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general). Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
