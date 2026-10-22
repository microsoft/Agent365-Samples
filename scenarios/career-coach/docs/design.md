# Career Coach autopilot — Design

How the agent is designed and why. For a line-by-line tour of the code see [`AGENT-CODE-WALKTHROUGH.md`](../AGENT-CODE-WALKTHROUGH.md); for setup and testing see [`README.md`](../README.md).

## 1. Purpose and scope

A private career coach for employees, delivered as a Microsoft **Agent 365 AI Teammate**. It helps a person:

1. pick a target role,
2. self-assess against that role's skills,
3. get a gap analysis and a course plan from a curated catalog,
4. save the plan as a **goal**,
5. learn, prove each course with a short quiz, and see progress,
6. get a milestone summary at 80% and a completion email to their manager at 100%,
7. prepare for a 1:1 with their manager,
8. start a new goal and keep the history of earlier ones.

It works in **Teams** and **email**, shares one data model across both, and reports telemetry to Agent 365 (Defender / admin-center Activity).

Out of scope: acting for anyone but the signed-in user, writing to the reference lists, and handling quizzes by email.

## 2. Design principles

| # | Principle | What it means in practice |
|---|---|---|
| 1 | **The LLM talks; code decides.** | The model handles conversation and text. Saving, grading, progress maths, emails and status changes are deterministic TypeScript |
| 2 | **Rules are enforced, not requested.** | Tool-level guards reject disallowed writes; prompts only explain them. A model mistake can't corrupt data |
| 3 | **One source of truth.** | State lives in SharePoint lists. Teams and email read and write the same rows; there is no per-channel copy of a goal |
| 4 | **Never go silent.** | Every background step either completes or tells the user what failed and how to retry |
| 5 | **Degrade, don't die.** | Optional capabilities (Mail/Calendar tools, telemetry, the webhook) can fail without stopping a conversation |
| 6 | **Least privilege.** | The agent acts as its own agentic user; WorkIQ SharePoint is read-only; email goes only to the requesting user (and their manager only on request or on completion) |

## 3. Architecture

```
            Teams                          Email to the agent's mailbox
              │ (Bot/Agent activity)         │ (A365 email notification)
              ▼                              ▼
        POST /api/messages  ──►  CloudAdapter ──► MyAgent (agent.ts)
                                                   │
      ┌──────────────┬──────────────┬──────────────┼──────────────┬─────────────────┐
      │ Card actions │ Typed-message│ LLM path     │ Email handler│ Proactive       │
      │ (buttons)    │ shortcuts    │ (client.ts)  │              │ (portal event)  │
      └──────┬───────┴──────┬───────┴──────┬───────┴──────┬───────┴────────┬────────┘
             ▼              ▼              ▼              ▼                ▼
        handlers.ts  ◄── career-coach-service.ts (pure rules) ──►  sharepoint-tools.ts (guards)
             │                                                          │
             └──────────────► Microsoft Graph (agentic user) ◄──────────┘
                                   │
                     SharePoint lists (state)   ·   Mail (completion email)

   LLM path also uses ► WorkIQ MCP (Mail, Calendar, SharePoint read-only)  ·  Azure OpenAI

   Every path is wrapped by telemetry (invoke_agent / chat / execute_tool) ► Agent 365 exporter (S2S route)

   SharePoint LearningPortalStatus change ► Graph subscription ► POST /api/portal-event ► Proactive DM
```

**Why a hybrid and not a pure agent?** A pure LLM agent hallucinated skill bumps, marked courses complete without evidence, double-saved plans, and exceeded Teams' 10-second card-action limit. Moving every write and rule into code removes those failure classes and makes behaviour testable; the model is kept for what it is good at (understanding intent, writing text, authoring quiz questions).

## 4. Components

| Component | Responsibility |
|---|---|
| `index.ts` | Process entry, auth mode, routes, portal webhook, startup jobs |
| `telemetry.ts`, `observability/` | Agent 365 exporter setup, export-token resolver, span conversation id |
| `agent.ts` | Routing, card actions, typed shortcuts, email, proactive trigger, failure net (`runDeferred`), telemetry wrappers (`runObserved`) |
| `client.ts` | LLM agent: system prompt, tools, history, WorkIQ attach, retries |
| `sharepoint-tools.ts` | The only way the LLM touches SharePoint, plus the write guards |
| `handlers.ts` | Deterministic flows (skill ratings, save, sync, quiz, milestones, completion) |
| `career-coach-service.ts` / `career-coach-types.ts` | Pure business rules, typed list access, the goal lifecycle |
| `llm-tasks.ts` | Narrow LLM calls with JSON output: quiz generation, short-answer grading, completion email text |
| `cards.ts` | Adaptive Card builders and the card-block parser |
| `email-conversation.ts`, `email-plan-store.ts` | Email text/prompt/rendering and the pending-plan store |
| `graph-service.ts`, `subscription-manager.ts` | Graph clients, mail, change subscriptions |

## 5. Data model (SharePoint)

| List | Access | Holds |
|---|---|---|
| `CompetencyFramework` | read-only | Roles → required skills and levels (seeded from CSV) |
| `LearningCatalog` | read-only | Courses → skills and level ranges (seeded from CSV) |
| `UserState` | read/write (guarded) | **One row per goal**: target role, skills, goals, learning progress, manager, milestone flags, lifecycle status |
| `LearningPortalStatus` | written by the learning portal | Per-user course telemetry (status, percent, time) |
| `QuizResponses` | append-only | Every quiz attempt with per-question feedback |

`UserState` stores `Goals`, `Skills` and `LearningProgress` as JSON in multi-line text columns. Each learning record carries the latest quiz summary; the full attempt history is in `QuizResponses`.

**Why one row per goal?** The first design had one row per user, so starting a new goal overwrote the old one and lost its history, and the agent kept showing a finished plan. Rows-per-goal keep history, make "completed" a state instead of a deletion, and let every handler stay simple by reading only the active row.

### Goal lifecycle

```
                 Save my plan (no active goal)
   (none) ───────────────────────────────────────► Active
                                                    │  │
        all courses quizzed + completion email sent │  │ user saves a different goal
                                                    ▼  ▼   while this one has progress
                                              Completed   Replaced
                                         (read-only history)
```

- At most **one Active** goal per user.
- Saving over an Active goal **without** progress edits it in place; **with** progress it becomes Replaced and a new row is created.
- Completed only after the completion email is sent, so a failed send can be retried.
- Legacy rows without `PlanStatus` map to Completed (if `Completion100Fired`) or Active.
- With no Active goal the user gets the welcome card; "previous goals" and "prep my 1:1" can read finished goals (read-only).

## 6. Key flows

### 6.1 Build and save a plan
1. Role named in chat → LLM reads the framework and emits the **skillPath** card (dropdowns, 0–4).
2. *Continue* → the card locks, code matches up to 3 courses per skill gap and sends **planReview**.
3. *Save my plan* (or email reply "Save it") → the same `savePlan` function applies the lifecycle rules, writes `UserState`, returns a progress card.

### 6.2 Prove a course (quiz)
Portal row complete, or the user says "I completed X" → server generates 5 questions and keeps the answer key **server-side** → card without answers → submit → deterministic grading (short answers by one narrow LLM call) → pass = 4/5 → course Complete, skill level raised, progress recomputed → milestone / completion cascade → next queued quiz.

### 6.3 Completion
100% → LLM writes the email text, **code** sends it (To: user, Cc: manager) → on success the goal is marked Completed → the next conversation starts with the welcome card. The chat model is instructed never to send this email itself.

### 6.4 Email
Inbound email → sender must be an organisation member → thread-scoped history (stable thread id) → same LLM and rules as Teams, with a prompt that excludes interactive steps → reply as HTML (cards become tables). A proposed plan is stored per thread so "Save it" saves exactly that plan.

### 6.5 Learning-portal event
List change → Graph notification → webhook (validated by a shared secret) → proactive turn → the same sync handler as "check my progress".

## 7. Security and trust boundaries

| Risk | Control |
|---|---|
| Prompt injection via user text, email bodies, documents, tool results | System prompt says only system instructions count; Mail/Calendar rules forbid acting on embedded instructions and limit recipients; all writes still go through code guards |
| LLM claims progress it didn't earn | Progress guard rejects Complete / passed-quiz / skill-level writes; only the quiz grader records them |
| LLM corrupts lifecycle data | Lifecycle columns stripped from model writes; finished goals read-only; one active goal; role switch with progress rejected |
| LLM bypasses guards through a second SharePoint path | WorkIQ SharePoint server exposes only read tools |
| Unknown or external email senders | Ignored; only organisation Members get replies; bounces ignored |
| Forged webhook | Graph `clientState` / `X-Portal-Secret` must equal `PORTAL_EVENT_SECRET` |
| Inbound request forgery | JWT auth on `/api/messages` (disabled only with `NODE_ENV=development`) |
| Secrets | `.env`, `a365.generated.config.json` and runtime state are git-ignored; export tokens are validated and never logged |

## 8. Reliability and error handling

- **Card actions** return immediately and run in the background; on failure `runDeferred` reports to the user and restores the card when resubmitting is safe.
- **LLM calls** retry transient network errors (3 attempts, backoff) and roll back the unanswered message from history.
- **Optional dependencies** (MCP servers, telemetry export, the webhook subscription) are best-effort and never block a turn.
- **Duplicate input** (double-clicks, re-sent Save) is absorbed by in-flight claims, locked cards and the save guard.
- **Lifecycle events** from the platform are acknowledged by a top-priority route so they can't crash a turn or trigger an error-reply loop.
- **Process-level** rejections are logged; the server stays up.

Known trade-offs: the quiz answer-key cache and queue are in memory (lost on restart — the user is asked to say "check my progress" to regenerate), and the proactive map, email-plan store and subscription state are local files, which suits a single instance. Running several instances would need shared storage for these.

## 9. Observability design

Goal: every run — LLM turn, button click, email, proactive event — appears in Agent 365 Activity as an agent run with its inputs, outputs, tool steps and errors.

- **Export route**: S2S with an app-only token for the agent identity (delegated tokens are rejected on that route). The token comes from a 3-hop exchange (blueprint credential → FMI assertion → agent identity → Observability API) and is validated before use.
- **Identity binding**: `gen_ai.agent.id` is the runtime agent identity read from the turn's recipient; the blueprint id travels separately.
- **Spans**: `invoke_agent` per run, `chat` around the model call, `execute_tool` around code-handled steps; auto-instrumentation adds model usage.
- **Context**: caller (the employee), channel (Teams / email), session description, and a **conversation id** — the activity id for Teams, the stable thread id for email, so one thread is one conversation.
- **Verifiability**: `A365_OBSERVABILITY_LOG_LEVEL=info|warn|error` shows exporter and token activity; `a365 query-entra` verifies the blueprint's grants and inheritance.

## 10. Identity and permissions

The agent is registered with `a365 setup all --aiteammate` (blueprint + agent identity + permissions). At runtime it acts as its **own agentic user** (own mailbox and Graph identity), not as the person chatting:

- SharePoint lists: the agent user must be a Member of the site.
- Completion email and user-requested email come from the agent's mailbox.
- WorkIQ Mail/Calendar/SharePoint need the MCP grants applied by a Global Administrator (`a365 setup permissions mcp`).
- Developer scripts use delegated MSAL (device code) instead, as a signed-in admin.

## 11. Configuration

See README §3 for the full table. In short: Azure OpenAI settings, the agent connection written by the CLI, SharePoint site and list names, the portal webhook URL and secret, and the observability switches. List display names are configurable so the lists can be versioned (e.g. `UserState_V3`).

## 12. Deployment topology

Local development exposes port 3978 through a **dev tunnel**; the blueprint's messaging endpoint and the Graph subscription both point at the tunnel URL. The agent is published with `a365 publish`, uploaded in the admin center, configured in Teams Developer Portal (API-based agent, notification URL), then instantiated and approved. For production, host the same Node process anywhere with a public HTTPS endpoint and move the in-memory / file state to shared storage.

## 13. Extension points

| To add… | Where |
|---|---|
| A new card or button flow | `cards.ts` builder + `agent.ts` `actionExecute` verb + `handlers.ts` function, wrapped in `runDeferred` / `runObserved` |
| A new rule or calculation | A pure function in `career-coach-service.ts` |
| A new typed shortcut | An intent function and a branch before the LLM path in `agent.ts` |
| A new data field | `setup-sharepoint.ts` schema, `serializeUserState` / `hydrateUserState`, and the prompt's list description |
| A new LLM tool | `sharepoint-tools.ts` (and a guard if it writes) |
| A new Microsoft 365 capability | A WorkIQ MCP server in `ToolingManifest.json` (+ admin grant) |
| Another channel | A notification/route handler that resolves the user, then reuses the same client, handlers and guards |

## 14. Decisions at a glance

| Decision | Alternative rejected | Reason |
|---|---|---|
| Deterministic handlers for writes and grading | Let the LLM write SharePoint | Hallucinated progress, double saves, timeouts |
| Server-side quiz answer key, LLM-authored quizzes discarded | Trust the card the LLM writes | The grader needs the key; the model's cards had none |
| One row per goal | One row per user, overwrite | Lost history; completed goals kept showing |
| Email shares the Teams data model and save code | Separate email plan store as the source of truth | Two places for one goal would drift |
| Per-thread email key from the notification | Activity conversation id | It changes with every message, so history was lost |
| WorkIQ SharePoint read-only | Allow its write tools | They bypass the progress and lifecycle guards |
| Completion email sent by code | Let the model send it with the Mail tool | Reliability, a single code path, and no duplicate sends |
| Run card actions in the background | Do the work inside the invoke | Teams' ~10 s limit |
