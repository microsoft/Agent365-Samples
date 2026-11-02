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
| `graph-service.ts`, `subscription-manager.ts`, `agent-identity.ts`, `portal-secret.ts` | Graph clients (per-turn agentic; background agent user), mail, change subscriptions with backoff retry, the captured agent identity, portal-secret validation |
| `mail-guard.ts` | Code-level recipient allowlist on the WorkIQ Mail / Calendar servers |
| `user-lock.ts` | Per-user mutex serialising every `UserState` read-modify-write |

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
- Saving over an Active goal **without** progress edits it in place; **with** progress the new goal row is created first and then the old one becomes Replaced (rolled back if that fails), so there is always a usable active goal.
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
100% → LLM writes the email text, **code** sends it (To: the employee, Cc: the manager looked up at send time) → the goal is recorded as Completed **before** the summary card is rendered → the next conversation starts with the welcome card. If the employee's own address can't be resolved (after one retry) nothing is sent and the goal stays Active, so a later "check my progress" retries; the manager is never made the only recipient. The chat model is instructed never to send this email itself.

### 6.4 Email
Inbound email → sender must be an organisation member → thread-scoped history (stable thread id) → same LLM and rules as Teams, with a prompt that excludes interactive steps → reply as HTML (cards become tables). A proposed plan is stored per thread so "Save it" saves exactly that plan.

### 6.5 Learning-portal event
List change → Graph notification → webhook (validated by a shared secret) → proactive turn → the same sync handler as "check my progress".

## 7. Security and trust boundaries

| Risk | Control |
|---|---|
| Prompt injection via user text, email bodies, documents, tool results | System prompt says only system instructions count; email text and quoted history are fenced in `<untrusted_email>` tags (delimiters inside neutralised); Mail/Calendar recipients are enforced **in code** (`mail-guard.ts`: sender only, manager only when the sender's own message asks; forward/reply and unverifiable recipients refused, fail closed); all writes still go through code guards |
| One employee reads another's coaching mail through the shared mailbox | Every employee talks to the same Career Coach mailbox and calendar, so the Mail server is **send-only** (`mail-guard.ts` hides and refuses reading, searching, replying, forwarding, updating and deleting; sending an existing draft by id is refused too). Calendar reads are allowed only for lookups that name a verified address (the employee, or their manager when asked), never as an open listing |
| A group chat receives someone's private progress | Proactive references are stored only from **personal (1:1)** conversations and never replaced by a group or channel; a reference saved earlier that turns out not to be personal is dropped at send time and nothing is posted |
| LLM claims progress it didn't earn | Progress guard rejects Complete / passed-quiz / skill-level writes (including records with no `courseId`); every plan course must exist in the catalog; quiz-earned progress is merged from the fresh row into stale writes; a quiz only counts for a course on the current plan |
| LLM corrupts lifecycle data | Lifecycle columns and the manager identity stripped from model writes (under their display **and** internal names); finished goals read-only; one active goal; role switch with progress rejected |
| LLM reads or writes another employee's data | Data tools are limited to the configured site and the five Career Coach lists; personal lists are filtered to the caller's own rows in code; new plans are bound to the caller; updates verify row ownership fail-closed and can't change the owner; chat writes are limited to `UserState`; email threads are keyed on the verified sender so members never share a conversation |
| LLM redirects the completion email | `ManagerName` / `ManagerEmail` are app-managed and never written from the model. The manager copied on the completion email is resolved from the directory at send time (the value cached at save time is not used as a recipient), and the card only says the manager was copied if they were |
| Concurrent turns overwrite each other's plan changes | Every `UserState` read-modify-write runs under a per-user lock; quiz generation shares one in-flight result per user/course so a card is always graded against its own answer key; the completion email is claimed per goal and only closes the goal it was sent for |
| LLM bypasses guards through a second SharePoint path | WorkIQ SharePoint server exposes only read tools |
| Unknown or external email senders | Ignored; only organisation Members get replies; bounces ignored |
| Forged webhook | Graph `clientState` / `X-Portal-Secret` must equal `PORTAL_EVENT_SECRET`, which must be a real secret (≥16 chars, not the template placeholder; production refuses to start otherwise); a rotated secret replaces the Graph subscription (the saved subscription stores a hash of the secret) |
| Inbound request forgery | JWT auth on `/api/messages` (disabled only with `NODE_ENV=development`) |
| Secrets and private content in logs | `.env`, `a365.generated.config.json` and runtime state are git-ignored; export tokens are validated and never logged; failed writes log operation, status, error code and column names only — never field values or user text |

## 8. Reliability and error handling

- **Card actions** return immediately and run in the background; on failure `runDeferred` reports to the user and restores the card when resubmitting is safe.
- **LLM calls** retry transient network errors (3 attempts, backoff) and roll back the unanswered message from history — but only while nothing outside the app has been done on the user's behalf. Once a Mail or Calendar write was attempted, the run is **not replayed** (a second email or duplicate invite has no idempotency key); the user is told to check rather than resend, and the exchange stays in history.
- **One run at a time per conversation**: each cached client queues its invocations (history update, MCP attach, execution, cleanup, rollback), so overlapping messages can't clear each other's connections or remove each other's replies. This conversation-level queue is separate from the per-user `UserState` lock.
- **Portal notifications are durable**: the webhook records the work on disk **before** it returns 202, then scans and delivers with bounded retry (30 s doubling to 10 min, 8 attempts / 1 h) and a per-user checkpoint as the deduplication key, independent of whether another list update arrives. Work still pending after a restart is resumed. A failure that retrying can't fix (the user has no private chat yet) is not retried.
- **A failed plan update after a quiz is graded** keeps a record of that submission (grading, attempt number, whether the audit row exists); resubmitting the same answers reuses it instead of grading and appending again, so one logical submission is never double-counted.
- **Optional dependencies** (MCP servers, telemetry export, the webhook subscription) are best-effort and never block a turn.
- **Duplicate input** (double-clicks, re-sent Save) is absorbed by in-flight claims, locked cards and the save guard.
- **Lifecycle events** from the platform are acknowledged by a top-priority route so they can't crash a turn or trigger an error-reply loop.
- **Process-level** rejections are logged; the server stays up.

Known trade-offs: the quiz answer-key cache and queue are in memory (lost on restart — the user is asked to say "check my progress" to regenerate), and the proactive map, email-plan store and subscription state are local files. The per-user lock is in-process too. All of this suits a single instance; running several instances would need shared storage and a shared lock (or conditional writes with row versions). The Graph change subscription is re-created automatically when it expires or is deleted while the process runs, and a failed first attempt (the agent's own ids aren't known until its first message, the tunnel is down) is retried with bounded backoff (30 s doubling to 10 min) and immediately when the ids are captured.

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
- Background work with no user turn (the Graph change subscription, the notification row scan, startup warm-up) also runs as the agent user: `graph-service.ts` mints its token with the hosting connection's `getAgenticUserToken`, using the tenant / agent instance / agentic user ids captured from the first message (persisted to `.agent-identity.json`, or set by `AGENT_INSTANCE_ID` + `AGENT_USER_ID`). The notification read is filtered server-side to recently updated rows, and a row already turned into a DM is not re-sent by a later notification.
  - **Production** (`NODE_ENV=production`): background work never uses a developer sign-in. Until the ids are known the calls fail and the subscription retries with backoff (immediately when the ids arrive); startup exits if `PORTAL_WEBHOOK_URL` is set without a valid secret and the service connection.
  - **Elsewhere**: an attempt before the ids are known may use the developer's `.mstoken-cache.json`. Such a subscription is recorded as developer-created and replaced by an agent-user one when the ids arrive (it is deleted with the identity that created it, since a subscription is only visible to its creator). Each attempt is pinned to one identity and setup is single-flight, so overlapping calls never leave two live subscriptions.
- Completion email and user-requested email come from the agent's mailbox. The manager copied on the completion email is looked up from the directory at send time, never taken from the value cached when the plan was saved.
- WorkIQ Mail/Calendar/SharePoint need the MCP grants applied by a Global Administrator (`a365 setup permissions mcp`).
- Developer scripts use delegated MSAL (device code) instead, as a signed-in admin (`npm run setup:sharepoint` does the sign-in; the others reuse its cache).

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
