# Career Coach autopilot — Agent 365 scenario sample (Node.js)

An AI **Career Coach** built on the [Microsoft Agent 365 SDK](https://github.com/microsoft/Agent365-nodejs) that runs inside Microsoft Teams: it helps employees set a target role, maps their skill gaps, recommends courses, quizzes them proactively as they complete learning, and drafts the manager wrap-up email — all as Adaptive Card conversations backed by SharePoint state and Microsoft Graph. This is a **scenario extension** on top of the base [OpenAI + Node.js sample-agent](../../nodejs/openai/sample-agent); see that folder for A365 SDK primer material (user identity, install events, typing indicators).

> **Stack:** Node.js · TypeScript · Microsoft Agent 365 SDK · OpenAI Agents SDK · Azure OpenAI (GPT-4o) · SharePoint Lists · Microsoft Graph (agentic delegated) · Adaptive Cards.

> 📘 Architecture, per-feature flows, and module responsibilities live in **[`docs/design.md`](docs/design.md)** and **[`AGENT-CODE-WALKTHROUGH.md`](AGENT-CODE-WALKTHROUGH.md)**. This README is about **getting the agent running end-to-end** and trying each capability.

Uses a **hybrid pro-code architecture** — the LLM handles free-text conversation and creative generation only; every card submit, data write, and business rule runs as deterministic TypeScript.

## What this sample demonstrates

- A pro-code Agent 365 **AI Teammate** with its own M365 identity, running in Microsoft Teams.
- **Hybrid architecture** — deterministic TypeScript for all card submits, data writes, and business rules; focused LLM sub-calls only for conversation, quiz generation, short-answer grading, and email prose.
- **Durable SharePoint state** across five lists, read/written via agentic Microsoft Graph.
- **Proactive messaging** via Microsoft Graph change notifications (a learning-portal completion triggers an unprompted quiz DM).
- **Adaptive Card** flows for goal-setting, gap analysis, quizzes, milestones, and the manager wrap-up email.
- **Agent 365 observability** (OpenTelemetry) spans for every agent turn and inference.

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
| Microsoft 365 tenant | E3/E5 dev tenant works | Owns the SharePoint site + the two test users. |
| Microsoft 365 Agents Toolkit | latest | For sideloading the agent into Teams. |
| Agent 365 CLI | latest | `dotnet tool install -g Microsoft.Agents.A365.DevTools.Cli`. Registers the Blueprint + AI Teammate identity. |
| Dev Tunnels CLI | latest | To expose your local `/api/portal-event` webhook. Install with `winget install Microsoft.devtunnel` or `az extension add --name dev-tunnel`. |

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

**SharePoint site**
- Any modern team/comm site works. This repo assumes `https://<tenant>.sharepoint.com/sites/CareerCoach`.
- The setup script creates all 5 lists automatically — you don't create them by hand.

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

### A365 hosted-agent connection
| Variable | Where to get it |
|---|---|
| `connections__service_connection__settings__clientId` | Entra ID app registration ID |
| `connections__service_connection__settings__clientSecret` | Client secret you created for the app |
| `connections__service_connection__settings__tenantId` | Your M365 tenant ID |
| `agent_id` | Same as `clientId` |

### SharePoint
| Variable | Value |
|---|---|
| `SP_SITE_HOST` | e.g. `contoso.sharepoint.com` |
| `SP_SITE_PATH` | `/sites/CareerCoach` (or whatever you use) |
| `SP_LIST_*` | Keep the shipped defaults unless you rename lists |

### Feature 1 webhook (real-time trigger)
| Variable | Value |
|---|---|
| `PORTAL_WEBHOOK_URL` | Your dev-tunnel URL + `/api/portal-event` (see §5) |
| `PORTAL_EVENT_SECRET` | Any random string (used for a manual POST test path) |

> **Security note** — never check `.env` into git. The shipped `.env.template` has no secrets.

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

Creates:
- `CompetencyFramework_v2`
- `LearningCatalog_v2`
- `UserState`
- `LearningPortalStatus`
- `QuizResponses`

**Step 4.3 — Seed reference data** (roles + course catalog)

```powershell
npm run seed:reference
```

Reads the two CSVs from `SharePoint Data\` (project-local, ships with the repo) and inserts ~19 competencies + ~31 courses. Override the location with `SP_SEED_CSV_DIR` if needed.

---

## 5. Dev tunnel + Graph subscription (Feature 1)

Feature 1 is the "portal completes a course → agent DMs the user with a quiz" flow. It needs a public HTTPS URL for Microsoft Graph to POST change notifications to.

**Step 5.1 — Start a persistent dev tunnel** (in its own terminal, keep running)

```powershell
devtunnel host -p 3978 --allow-anonymous
```

The CLI prints something like `https://spiffy-dog-h50g1wc.inc1.devtunnels.ms`. Note this URL.

**Step 5.2 — Point `.env` at that URL**

```env
PORTAL_WEBHOOK_URL=https://spiffy-dog-h50g1wc.inc1.devtunnels.ms/api/portal-event
```

**Step 5.3 — Subscription is created automatically on server startup.**

When you `npm run dev` (see §6), the server calls Graph `POST /subscriptions` pointing at `PORTAL_WEBHOOK_URL`. Graph validates by POSTing `?validationToken=X` — your server must echo it back within ~10s (already handled). The subscription auto-renews every 30 minutes.

---

## 6. Run the agent

```powershell
npm run dev
```

Or, better — pipe output to a log file so you can grep it later:

```powershell
npm run dev 2>&1 | Tee-Object -FilePath .\dev.log
```

You should see:

```
Server listening on 0.0.0.0:3978 for appId <clientId>
[sub-mgr] Created new subscription (id=…) expiring 2026-01-01T00:00:00Z
[SharePointTools] Warmed siteId cache with "…"
```

Then sideload the agent into Teams via the Microsoft 365 Agents Toolkit (any of the two test users below can chat with it).

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

Verify in SharePoint: `UserState` list has a new row with your test user's UserAADId, 5 goals, 5 skills, and 7 courses in LearningProgress.

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

Run one command per course during the demo. See §9 for the full 6-course sequence.

### 8.4 — Feature 3 — 80% milestone

When 3+ of the 5 goals reach 100%, `OverallProgress` crosses 80%. The **milestone80** card fires automatically inside the same reply as the quiz result, showing:
- Overall progress
- Which goals still need work
- Top 5 weak topic tags aggregated from every quiz attempt

### 8.5 — Feature 4 — 100% completion + manager email

When all goals hit 100%, the **completionSummary** card fires. The `handleQuizSubmit` cascade:
1. LLM composes a warm HTML email body listing every completed course + total time
2. Code sends via `/me/sendMail` — **To:** the test user, **Cc:** their manager (from Entra ID)

Check the test user's Sent Items + the manager's Inbox — the email should arrive within ~30 seconds of the completion card.

### 8.6 — Deterministic "check my progress"

Send `check my progress` in Teams — this bypasses the LLM entirely and runs `handleSyncProgress` directly. Useful for verifying state without needing another course completion.

---

## 9. Scripts reference

| Command | Purpose |
|---|---|
| `npm run dev` | Start the agent in watch mode. Nodemon restarts on any `src/` change. |
| `npm run build` | Compile TypeScript to `dist/` (used by `npm run start`). |
| `npm run start` | Run the compiled build (production mode). |
| `npm run setup:sharepoint` | One-time: create the 5 SharePoint lists (idempotent). |
| `npm run seed:reference` | Populate `CompetencyFramework_v2` + `LearningCatalog_v2` from CSVs. |
| `npm run clear:list -- <ListName>` | Delete every item from a list. Useful for demo resets. |
| `npm run mark:complete -- <CourseId> [CourseId…]` | Insert one or more rows into `LearningPortalStatus` marking those courses complete for the current test user (env var). |
| `npm run reset:milestones -- <AadObjectId>` | Flip `Milestone80Fired` + `Completion100Fired` back to false so cards can re-fire. |
| `npm run backup:user -- <AadObjectId> "Name"` | Snapshot the user's rows across `UserState` + `LearningPortalStatus` + `QuizResponses` to `backups/`, then delete them. |

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
Microsoft Teams  ←→  Career Coach Autopilot (A365 SDK)  ←→  Microsoft 365
                     ├─ 🚦 Card + message router
                     ├─ ⚙️ Deterministic TypeScript
                     │      ├─ Save plan
                     │      ├─ Sync progress
                     │      ├─ Grade MCQ
                     │      ├─ Milestones
                     │      └─ Send email
                     └─ 🧠 Focused LLM sub-calls
                            ├─ Role elicitation (chat)
                            ├─ Quiz question generation
                            ├─ Short-answer grading
                            └─ Completion email prose
```

- **SharePoint lists** own state — `UserState` (per-user plan), `LearningPortalStatus` (course telemetry), `QuizResponses` (attempt log), plus two read-only reference lists.
- **Microsoft Graph** delivers change notifications when the portal updates + sends the completion email on `/me/sendMail`.
- **Agentic auth** — the A365 platform hands the agent a delegated Graph token per turn, so `/me` refers to whoever is in the current chat. No manual token refreshes.

Source layout:

```
src/
├── index.ts                  Express + /api/messages + /api/portal-event
├── agent.ts                  AgentApplication + Action.Execute handlers
├── client.ts                 OpenAI Agents client + system prompt (LLM path)
├── cards.ts                  All Adaptive Card renderers + renderCard()
├── handlers.ts               Deterministic card handlers (skill ratings, save, quiz, sync, milestone, email)
├── career-coach-service.ts   Pure business logic + typed SP CRUD
├── llm-tasks.ts              3 focused LLM sub-calls (Q gen, short-answer grade, email prose)
├── graph-service.ts          MSAL device-code + agentic Graph clients + sendMail + subscriptions
├── sharepoint-tools.ts       OpenAI Agents function tools (LLM path only)
├── sharepoint-column-map.ts  Display-name ↔ internal-name translation
├── career-coach-types.ts     Shared types + SP_CONFIG
├── quiz-cache.ts             In-memory quiz answer key store
├── file-storage.ts           Disk-backed SDK Storage impl for Proactive subsystem
├── proactive-refs.ts         AAD ID → conversation reference cache
├── subscription-manager.ts   Auto-create + auto-renew Graph subscription
└── scripts/                  Setup, seed, clear, mark, reset, backup helpers
```

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Server listening…` but no messages received in Teams | Agent not sideloaded, or wrong app ID in `.env` | Re-sideload via Agents Toolkit; verify `agent_id` matches the app registration |
| `[Proactive] Conversation not found in proactive storage` | Nodemon restart wiped the in-memory ref cache | Send `hi` in Teams once to re-register, then re-run `mark:complete` |
| `Something went wrong` red banner on card submit | Action.Execute took > 10s | Every card handler is fire-and-forget by design — check `dev.log` for the actual error. Common culprit: SharePoint token expired or Graph 429. |
| Quiz questions all show `Q1.` numbering wrong (`1. 1. 1.`) | Old cards.ts | Should be fixed in this build. If it recurs, verify `cards.ts` uses `Q${qNum}.` not `${qNum}.`. |
| Feature 4 email "Access is denied" | `sendMail` using `/users/{id}/sendMail` on a delegated token | Should be fixed — `graph-service.ts` uses `/me/sendMail` whenever a graph client is passed in. |
| `Failed to acquire token silently` on script start | Cached MSAL token expired (60 days) or was for a different tenant | Delete `.mstoken-cache.json` and re-run — a fresh device-code prompt will appear. |
| SharePoint 500 on write with no error detail | Column-name mismatch between display and internal | Check the `[createListItem] Known columns:` log line — the field you sent must be in there. |
| Graph subscription creation fails with "Notification URL invalid" | `PORTAL_WEBHOOK_URL` isn't reachable | Verify the dev tunnel is running and the URL in `.env` matches; test with `curl <URL>?validationToken=hi` (should echo `hi`). |
| Costs pile up on Azure OpenAI | Every user turn hits GPT-4o | Only Stage 1 (role elicit) + short-answer grading + email body call the LLM. Card submits are deterministic. Verify your logs show `[Sync] Deterministic sync…` not full LLM turns. |

For anything else, grep `dev.log` — every subsystem prefixes its logs (`[Proactive]`, `[Sync]`, `[Quiz]`, `[SavePlan]`, `[SharePointTools]`, `[sub-mgr]`, `[Completion100]`).

---

## 12. Authentication + identity

Two distinct auth paths, both **delegated** (no application-permission client secret):

- **Runtime (the agent in Teams)** uses **agentic authentication** — the Agent 365 platform mints a delegated Microsoft Graph token per turn, so `/me` resolves to whoever is chatting with the agent. Configured via the `agentic_*` and `connections__service_connection__*` values in `.env` (stamped by `a365 setup all`). The runtime agent identity (`gen_ai.agent.id`) is resolved dynamically from the turn context; the Blueprint ID is only used for provisioning.
- **Setup / seed scripts** use the **MSAL device-code** flow with delegated scopes (`Sites.Manage.All`, `Sites.ReadWrite.All`, `User.Read.All`, `Mail.Send`, `offline_access`), cached in `.mstoken-cache.json`.

> **Admin consent required for setup.** `Sites.Manage.All` and `User.Read.All` are **admin-restricted** delegated permissions. In a fresh tenant a non-admin cannot consent to them, so the one-time device-code sign-in for the setup scripts must be performed by — or pre-consented by — a **tenant / SharePoint administrator**. No app-only credentials are used.

## 13. Deploying the agent

For local testing, a dev tunnel + the Agents Playground are enough (sections 5-6). To run it as a real Teams AI Teammate:

1. Register the Blueprint + Agentic User identity: `a365 setup all --aiteammate` (see the [Agent 365 developer docs](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)).
2. Host the agent at a public HTTPS endpoint (a dev tunnel for testing, or Azure App Service / Container Apps / Functions for a persistent deployment — see [Deploy to Azure](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/deploy-agent-azure)).
3. Reconcile the messaging endpoint: `a365 setup blueprint --update-endpoint <url>/api/messages --m365`.
4. Package + publish with `a365 publish`, then upload the package and request an instance from the M365 admin center ([create an instance](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/create-instance)).

Set the cloud env vars (Azure OpenAI, agentic auth, observability, SharePoint) at the platform level — not just in a local `.env`.

## 14. Additional resources

- [Microsoft Agent 365 developer docs](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/)
- [Agent 365 observability](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability)
- Base sample this extends: [`nodejs/openai/sample-agent`](../../nodejs/openai/sample-agent)
- Sibling scenarios: [Chief of Staff (#333)](https://github.com/microsoft/Agent365-Samples/pull/333) and [Scrum Master (#334)](https://github.com/microsoft/Agent365-Samples/pull/334)
- [`docs/design.md`](docs/design.md) and [`AGENT-CODE-WALKTHROUGH.md`](AGENT-CODE-WALKTHROUGH.md)

---

## Appendix — What's in this sample

| Folder / file | What it is |
|---|---|
| `src/` | All TypeScript source. Runtime + `scripts/` + service layer. |
| `manifest/` | Teams app manifest (placeholder IDs — filled in by `a365 setup`/`a365 publish`). |
| `docs/design.md` | Architecture + per-feature flow design notes. |
| `images/` | Agent thumbnail. |
| `SharePoint Data/` | Seed CSVs for the two reference lists. |
| `AGENT-CODE-WALKTHROUGH.md` | Deep-dive into the source code. |
| `.env.template` | Template for the runtime config. Copy to `.env` and fill in the blanks. |
| `package.json` / `tsconfig.json` | Standard Node/TS build config. |
| `verify-userstate.ps1` | Debug helper to dump the `UserState` list via Graph. |

**Regenerated / never committed:** `.env`, `node_modules/`, `dist/`, `*.log`, `.mstoken-cache.json`, `backups/`, `.proactive-*.json`, `a365.*.config.json`.

---

## Support · Contributing · Trademarks · License

This sample is provided as-is under the terms in the repository [`LICENSE.md`](../../LICENSE.md) (MIT). It is a scenario demonstration, not a supported product.

- **Issues / questions:** open an issue on [microsoft/Agent365-Samples](https://github.com/microsoft/Agent365-Samples/issues).
- **Contributing:** see the repo [`CONTRIBUTING.md`](../../CONTRIBUTING.md). Contributions require agreement to the Microsoft CLA.
- **Trademarks:** this project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft trademarks or logos is subject to and must follow [Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general). Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
