# Career Coach autopilot — Code Walkthrough

A guided tour of how the agent works, in the order a request travels through it. For the *why* behind the design, see [`docs/design.md`](docs/design.md). For setup and testing, see [`README.md`](README.md).

## 1. What the agent is

An **Agent 365 AI Teammate** (Node.js / TypeScript) that coaches an employee through a career goal: pick a target role → rate skills → get a gap analysis and course plan → save it → learn → pass a quiz per course → milestone and completion emails. It works in **Microsoft Teams** and **by email**, and it tracks every goal as a row in a SharePoint list.

The key idea is a **hybrid**: the LLM only handles free conversation and creative text. Anything that changes data or enforces a rule (saving a plan, grading, progress maths, emails, status changes) is **deterministic TypeScript**, and the LLM is physically prevented from doing those things itself.

| Concern | Technology |
|---|---|
| Hosting, auth, routing | Microsoft 365 Agents SDK (`@microsoft/agents-hosting`) — `AgentApplication`, agentic auth |
| LLM orchestration | OpenAI Agents SDK (`@openai/agents`) against **Azure OpenAI (GPT-4o)** |
| State | SharePoint Lists through Microsoft Graph (agentic auth, as the agent's own user) |
| Email in/out | `@microsoft/agents-a365-notifications` (inbound email), Graph `sendMail` (completion email), WorkIQ Mail MCP (user-requested email) |
| Extra tools | WorkIQ MCP servers (Mail, Calendar; SharePoint read-only) via `@microsoft/agents-a365-tooling-extensions-openai` |
| Telemetry | `@microsoft/opentelemetry` (Agent 365 exporter, S2S route) |
| Cards | Adaptive Cards, built in `cards.ts` |

## 2. File map

```
src/
├── index.ts                  Process entry: Express, auth, /api/messages, /api/portal-event, /api/health, startup jobs
├── telemetry.ts              Observability bootstrap — must be imported first
├── agent.ts                  MyAgent: routes, card actions, typed-message shortcuts, email, proactive, observability scopes
├── client.ts                 LLM client: system prompt, SharePoint tools, WorkIQ MCP attach, bounded history, retries
├── openai-config.ts          Azure OpenAI / OpenAI client setup
├── sharepoint-tools.ts       LLM function tools + progress, lifecycle and JSON collection-shape guards
├── handlers.ts               Deterministic flows: skill ratings, save plan, sync, quizzes, milestones, completion
├── career-coach-service.ts   Pure business logic + typed SharePoint reads/writes
├── career-coach-types.ts     Types, SP_CONFIG (list names), PlanStatus lifecycle helpers
├── llm-tasks.ts              Small focused LLM calls: quiz questions, short-answer grading, completion email text
├── cards.ts                  All Adaptive Card builders, extractCards(), renderCard()
├── quiz-cache.ts             In-memory quiz answer keys, server-issued quiz-generation IDs, one in-flight generation per user/course, graded markers, pending-quiz queue
├── user-lock.ts              Per-user async mutex around every UserState read-modify-write
├── email-conversation.ts     Email text extraction, email prompt, card → HTML
├── email-plan-store.ts       Disk-backed "plan proposed by email, awaiting Save it"
├── graph-service.ts          Graph clients (per-turn agentic; background agent user via getAgenticUserToken; MSAL device-code for scripts), sendMail, subscriptions
├── subscription-manager.ts   Create / renew / re-create the Graph change subscription (replaced when the notification secret rotates; bounded-backoff retry)
├── agent-identity.ts         The agent's own tenant / instance / agentic-user ids, captured from turns (or env) for background Graph tokens
├── portal-secret.ts          Rejects empty / placeholder / short PORTAL_EVENT_SECRET values
├── mail-guard.ts             Code-level recipient allowlist for the WorkIQ Mail and Calendar MCP servers
├── sharepoint-column-map.ts  Display-name ↔ internal-column-name translation
├── file-storage.ts           Disk-backed SDK Storage (proactive subsystem)
├── conversation-privacy.ts   isPrivateConversation + notice: private data only in 1:1 chats
├── directory-lookup.ts       email sender → directory user (UPN/id, then unambiguous SMTP / proxy address)
├── completion-email-receipts.ts per-goal sent-email receipt for retrying SharePoint completion persistence
├── proactive-refs.ts         AAD object id → personal (1:1) conversation id map (disk); group chats and channels are never stored
├── portal-notifications.ts   Durable queue for portal notifications: recorded before the 202, bounded-backoff retry, per-user checkpoint (dedupe)
├── observability/
│   ├── app-token-resolver.ts App-only token for the exporter (3-hop FMI exchange)
│   └── conversation-id.ts    Stable conversation id for spans (email threads)
└── scripts/                  setup-sharepoint, seed-reference-data, clear-list, mark-courses-complete, reset-milestones, backup-and-reset-user
```

Root files that matter: `ToolingManifest.json` (WorkIQ MCP servers), `a365.config.json` / `a365.generated.config.json` (CLI registration, generated — never committed), `.env` (from `.env.template`), `manifest/` (Teams app package).

## 3. Process startup — `index.ts`

Order matters:

1. `configDotenv()` first, so every module sees the environment.
2. `import './telemetry'` **before** the agent or LLM modules load. The OpenTelemetry distro must patch `@openai/agents` before it is imported, otherwise the LLM calls would not be traced.
3. `setObservabilityConnection(...)` hands the adapter's default (blueprint) connection to the token resolver, which needs it lazily because the adapter is created after telemetry initialises. `setBackgroundTokenProvider(...)` hands the same connection to `graph-service.ts`, so background Graph work (no user turn) can mint the agent user's token with `getAgenticUserToken`, using the ids `agent-identity.ts` captured from the first message. In production, background work never falls back to a developer sign-in (it fails until the ids are known and retries), and startup exits when `PORTAL_WEBHOOK_URL` is set without a valid secret and the service connection.
4. Safety nets: an `unhandledRejection` handler logs and keeps the process up (a single failed typing indicator must not crash the agent); `uncaughtException` exits.
5. Auth: `NODE_ENV=development` **disables** inbound auth (Playground only). Anything else loads auth config from the environment and requires a valid token.
6. Routes, in this order:
   - `GET /api/health` — before auth.
   - `POST /api/portal-event` — before auth, because Graph and manual callers don't carry an agent token. Three shapes: Graph validation handshake (echo `validationToken`), Graph change notification (`clientState` must equal `PORTAL_EVENT_SECRET`; answered `202` immediately, work done async), and a manual test call (`X-Portal-Secret` header).
   - `authorizeJWT(...)`, then `POST /api/messages` → `adapter.process` → `agentApplication.run`.
7. On listen: `ensureSubscription()` (best-effort, single-flight) creates/renews the Graph subscription on the `LearningPortalStatus` list — retried with backoff, and immediately when the agent first learns its own ids. A subscription made with the developer fallback (non-production only) is replaced by an agent-user one at that point. The SharePoint site/list caches are warmed so the LLM can't guess IDs. A Graph change notification is recorded durably before it is acknowledged; the first scan reads the bounded 24-hour lookback, and later scans use the persisted watermark with a 10-minute overlap, never earlier than 24 hours before the scan (server-side filter, full-scan fallback). A gap longer than that lookback is not fully recovered. Each user is DMed once per change, with failed work retried using bounded backoff (`PortalQueue`).

## 4. Routing — `MyAgent` constructor (`agent.ts`)

`MyAgent extends AgentApplication<TurnState>` with agentic auth and a disk-backed proactive store. Routes it registers:

| Route | Handler | Notes |
|---|---|---|
| `agentLifecycle` events | acknowledge only | Registered as an agentic invoke route with rank 0 so it runs *before* the Adaptive Card selectors, which throw on non-card values and used to cause a 502 reply loop |
| Agent notifications (`agents:*`) | `handleAgentNotificationActivity` | Email notifications; lifecycle notifications are logged, never replied to |
| `Message` | `handleAgentMessageActivity` | Typed chat in Teams |
| `InstallationUpdate` | `handleInstallationUpdateActivity` | Welcome card on install, goodbye on uninstall |
| Card action `careercoach_skill_ratings` | rating card → plan review | See §6 |
| Card action `careercoach_save_plan` | Save my plan | See §6 |
| Card action `careercoach_quiz_submit` | grade a quiz | See §7 |
| Card action `careercoach_welcome` | welcome-card tiles | `progress` runs a sync; `goal`/`skills`/`prep` become a synthetic user message |

## 5. A typed message in Teams — `handleAgentMessageActivity`

```
message ─► remember conversation for proactive DMs
        ─► "/welcome"                         → welcome card
        ─► isSyncIntent  ("check my progress")      → handleSyncProgress        (no LLM)
        ─► isCompletedAllIntent ("I finished all")  → handleCompletedAllCourses (no LLM)
        ─► isCompletionReport ("I completed <course>") naming plan courses → quiz queue (no LLM)
        ─► otherwise the LLM path (below)
```

The shortcuts run first because they are cheaper, faster and safer than asking the model. If a shortcut throws, the user gets a message — never silence.

**The LLM path:**

1. Start a typing indicator loop (re-sent every 4 s).
2. Open the observability **baggage** scope and an `invoke_agent` span.
3. `getClient(...)` returns the cached client for this conversation (or builds one) and `invokeAgentWithScope(...)` runs it.
4. The reply is post-processed deterministically:
   - `::welcome::` token → the designed welcome card (with the user's real name).
   - Otherwise `extractCards()` splits it into prose + fenced ` ```card ` JSON blocks, and every card is rendered through `cards.ts`. **Quiz cards authored by the LLM are discarded** and regenerated server-side with `emitQuizFor`, because only the server holds the answer key.
   - If the progress guard blocked the model from marking courses Complete this turn (`takeBlockedCompletions`), the app starts those quizzes itself.
5. Errors are caught and reported as a message; the typing loop and baggage scope are always cleaned up.

## 6. Card actions (fire-and-forget by design)

Teams gives an `Action.Execute` about 10 seconds. Reads/writes to SharePoint plus LLM calls can exceed that, so each handler:

1. validates the payload and returns a short string immediately ("Got it — building your gap analysis…"),
2. replaces the clicked card with a **read-only** copy (so it can't be edited or resubmitted),
3. runs the real work in the background via `runDeferred(...)` → `runObserved(...)`.

| Verb | Background work |
|---|---|
| `careercoach_skill_ratings` | `handleSkillRatingsSubmit`: read the catalog, compute each skill's gap, `matchCoursesForSkill` (up to 3 courses, best-fitting level range first), send the **planReview** card |
| `careercoach_save_plan` | `handleSavePlanSubmit` → `savePlan` (shared with email "Save it"): build Skills/Goals/LearningProgress, apply the goal lifecycle (§9), write `UserState`, send the progress card |
| `careercoach_quiz_submit` | `handleQuizSubmit` (§7) |
| `careercoach_welcome` | `handleSyncProgress`, or re-enter the normal message flow with a synthetic message |

**`runDeferred`** is the failure net. If the background work throws (typically a network drop), it logs `[Label] Deferred step failed (network)`, restores the card when that is safe (user's ratings / answers kept; skipped if results were already shown so nothing can be submitted twice), and sends a short message saying what failed and what to click. The apology itself is retried once, since the same outage can break it.

**`runObserved`** wraps a code-handled step in the same telemetry shape as an LLM turn (§12).

## 7. Quizzes — grade deterministically

**Sending** (`emitQuizFor`): `generateQuizQuestions` (LLM, in `llm-tasks.ts`) makes 5 questions (about 3 multiple choice + 2 short answer) with answer keys and rubrics. The keys and a server-issued `generationId` go into `quiz-cache.ts` (in memory, keyed by user + course); overlapping syncs or portal events for the same course share **one** generation, so every card sent is graded against the same key. The card carries that opaque ID in its submit action, but contains **no answers**.

**Grading** (`handleQuizSubmit` → `handleQuizSubmitInner`):

1. A per-user/course in-flight claim ignores a double-click.
2. The submit action's `generationId` must match the current cached quiz. A card from before a restart/regeneration is refused even if its course id and question ids (`q1`–`q5`) match the new card. Already-graded or missing-cache submissions get a clear message (a restart empties the cache: "say *check my progress* and I'll regenerate it").
3. Multiple choice is a letter match (`gradeMcqAnswer`). Short answers are graded by one focused LLM call (`gradeShortAnswers`); if that fails or returns an incomplete result, nothing is recorded and no attempt is counted — `runDeferred` tells the user and restores the card with their answers. An outage is never graded as wrong and never silently passed.
4. Under the user lock the course must be on the **current plan** (otherwise the submit is refused before any write). Pass = 4 of 5. The attempt is appended to `QuizResponses`, then `applyQuizPass` / `applyQuizFail` updates `UserState`. If the audit append fails, the state update is not attempted; the recorded submission is retained so retrying the same answers reuses its grading and attempt number. A pass marks the course Complete, raises the skill level to the course's `ToLevel`, and recomputes goal and overall progress.
5. The result is marked graded **before** the quiz-result card is sent, so a send failure can't leave a graded quiz open for a duplicate submit. Then the **cascade**: 80% milestone, 100% completion, and the next queued quiz — so the user is never left waiting after a result.

Saving or replacing a goal clears every cached quiz, graded marker and queued quiz for the user (`clearAllQuizzes`), so questions from the previous plan can never be graded against the new one.

Attempts are counted only after the SharePoint reads succeed, so a network failure isn't counted as an attempt.

The 80% milestone uses a per-user/goal in-flight claim and re-reads `Milestone80Fired` under the user lock before sending. Overlapping progress checks therefore send at most one card; a failed read or send releases the claim so a retry can try again.

## 8. Progress maths

`recomputeGoalsAndOverall` is the single source of truth: each goal's progress = completed courses ÷ courses for that skill; overall = average of goals. No level ratios are involved.

`diffPortalAgainstPlan` merges `LearningPortalStatus` rows into the plan (percent, time spent, "In Progress") and finds courses the portal says are complete but have no passed quiz — those become quizzes, not completions.

## 9. Goal lifecycle — one row per goal

`UserState` holds one row per goal. `PlanStatus` is `Active`, `Completed` or `Replaced` (`career-coach-types.ts`: `planStatusOf`). Rows from before the column existed count as Completed when `Completion100Fired` is set, otherwise Active.

| Function | Behaviour |
|---|---|
| `readUserState` | Returns only the **Active** goal (newest first), so every deterministic handler automatically ignores finished goals |
| `readPreviousPlans` | Completed + Replaced goals, newest first |
| `savePlan` | Every selected course must have a catalog `courseId` (otherwise the plan is rejected before anything changes). Active goal with no progress → updated in place. Active goal **with** progress → the replacement row is created **first**, then the old goal is marked `Replaced` (kept); if retiring the old goal fails the new row is removed again, so the user is never left without an active goal. Same role with progress → refused, nothing overwritten |
| `fireCompletion100` | Claims the goal in-process (one email per goal), re-reads the goal and proceeds only if it is still the active, unfinished, 100% goal it was triggered for; minutes are summed from the portal rows for that plan's courses only. The manager is looked up from the directory at send time (never the value cached at save time; if the lookup fails only the employee is mailed). After a successful send, a git-ignored local receipt records the goal and summary; if the SharePoint lifecycle update fails, "check my progress" retries that update without resending. The goal is recorded as `Completed` + date before rendering the summary card and only for that goal (never one that replaced it meanwhile). The card says the manager was copied only if they were. If sending fails, no receipt is written and the goal stays Active for retry |
| `noActiveGoalMessage` | Explains "your *X* goal is complete — name your next role" instead of "no plan" |

`dropMissingLifecycleColumns` lets the agent keep working (with a warning) on a list that hasn't had `npm run setup:sharepoint` re-run.

## 10. The LLM client — `client.ts`

- **System prompt** (one long template string): security rules, the SharePoint list schemas, the card JSON schemas (welcome, skillPath, planReview, progress, prepBrief, quiz, quizResult, milestone80, …), the stages (set goals → map skills → save → sync → quiz → milestone → completion → prep), the greeting rule, previous-goals rule, the WorkIQ Mail/Calendar rules, and write discipline ("never write `UserState` until the user confirms").
- **Tools** (`makeSharePointTools`): `getSiteByPath`, `listLists`, `listListItems`, `createListItem`, `updateListItem`, `listPreviousGoals`. `modelSettings.toolChoice = 'required'` forces a tool call on the first step so the model can't answer from memory.
- **History**: one client per conversation id (`clientCache`); email turns pass the email thread id instead. Recent turns are bounded by message count and character budget before each request. A context-limit error clears cached history and asks the user to resend, so the conversation can recover. `hasClient(key)` tells the email handler whether history exists.
- **WorkIQ**: `attachWorkIqTools` registers the MCP servers each turn (tokens are per turn), connects each independently, skips any that time out, and closes them afterwards. The SharePoint MCP server gets a `toolFilter` that only exposes read-verb tools (`get…`, `list…`, `search…`), so list writes can only go through our guarded tools.
- **Retries**: a transient network error (`fetch failed`, timeouts, DNS) is retried up to 3 times with backoff, **unless** a Mail or Calendar write was already attempted in that run — replaying it would send a second email or duplicate invite, so the run stops, the user is told to check their inbox/calendar, and the exchange is kept in history. If it fails with nothing external done, the unanswered message is rolled back out of history (by reference) so the next turn is consistent.
- **One run at a time**: `invokeAgentWithScope` queues behind the previous run of the same cached client, so history, the MCP server list and the rollback are never touched by two runs at once. (Separate from the per-user `UserState` lock.)

## 11. The write guards — `sharepoint-tools.ts`

These make wrong LLM behaviour impossible rather than merely discouraged:

| Guard | Rule |
|---|---|
| **Site + list allowlist** | The data tools (`listListItems`, `createListItem`, `updateListItem`) only operate on the configured Career Coach site, and only read the five Career Coach lists. Chat **writes are limited to `UserState`** — reference data, portal completions and quiz audit rows are written only by provisioning, the portal and the deterministic quiz grader |
| **Owner scoping** | Personal lists (`UserState`, `LearningPortalStatus`, `QuizResponses`) return only the caller's own rows (`activity.from.aadObjectId`), whatever filter the model asks for. A new plan is always created for the caller (a different `UserAADId` is rejected and the caller's id is persisted). An update first reads the row **fail-closed** — unreadable or someone else's rows are refused — and `UserAADId` can never be changed. With no authenticated user, personal data is refused |
| **Column-name canonicalization** | Every model write is rewritten to display names first (case-insensitive, internal `field_N` names included), so no guard can be bypassed through an alias; two keys for the same column are rejected |
| **Progress guard** (`guardUserStateWrite`) | A write that would mark a course Complete, record a passed quiz, or raise a skill level is rejected with `BLOCKED …` (a record with no `courseId` counts too); the courses are remembered for the turn so the app can start their quizzes |
| **Catalog check** (`requireCatalogCourses`) | Every `LearningProgress` record needs a `courseId`, and any course the model adds must exist in the `LearningCatalog` (cached 5 min; fails closed if the catalog can't be read) |
| **Server-owned progress merge** (`mergeServerOwnedProgress`) | The model composes a write from an earlier read, so passed courses (Complete + passed quiz) from the freshly read row are merged back in, skill levels never go down, and `Goals` / `OverallProgress` are recomputed from the merged courses — a stale write can't undo a quiz result |
| **App-managed fields** | `PlanStatus`, `PlanCompletedDate`, `Completion100Fired`, `ManagerName` and `ManagerEmail` are stripped from LLM writes. The manager comes only from the directory, so the model can't redirect the completion email |
| **Finished goals** | Update of a Completed/Replaced row is rejected |
| **One active goal** | `createListItem` on `UserState` is rejected when an active goal already exists |
| **Role switch** | Changing `TargetRole` on a goal that has progress is rejected (the Save button keeps the old goal as history) |
| **Visibility** | `listListItems` on `UserState` returns only the active goal; `listPreviousGoals` is the only way to see history |
| **Per-user lock** | Every `UserState` read-modify-write (save, sync, quiz grading, milestone / completion persistence, and the model's own create / update) runs under `withUserLock` (`user-lock.ts`), so concurrent turns can't overwrite each other's changes |
| **ID repair** | A truncated site id or a list *display name* passed as an id is replaced with the real one |

`listNameOf` falls back to asking Graph when the list-name cache is cold, so passing a raw GUID can't bypass the rules.

## 12. Email

**Inbound** — `handleAgentNotificationActivity` → `handleEmailNotification`:

1. Bounce / non-delivery mails are ignored (`isBounceEmail`).
2. The sender is looked up in Graph (`resolveDirectoryUser`: object id / UPN first, then an exact, unambiguous `mail` / `proxyAddresses` match for members whose mail address differs from their UPN); only organisation **Members** get a reply (guests / external / unresolvable ignored). The sender's object id is put on the activity so the conversation is scoped to their plan.
3. The thread key is `email:<agent instance>:<sender id>:<emailNotification.conversationId>` — stable across a thread (unlike the per-message activity id) and unique per member, so two people replying in the same thread never share a client, history or pending plan.
4. An explicit short confirmation such as **"Save it"**, **"Yes, save my plan"** or **"Please save this plan"** (`isSavePlanIntent`) with a pending plan for this thread → `savePlan` (same code as the Teams button), reply with the progress table. Questions or informational mentions of saving stay on the normal conversation path and leave the pending plan untouched.
5. Otherwise the LLM runs with an email-specific prompt. The email text — and, if there is no history for the thread (first email, or after a restart), the **quoted reply history** (`extractQuotedHistory`) — goes in `<untrusted_email>` fences with any delimiter tags inside neutralised, and the model is told never to follow instructions in them. Mail / Calendar tools are checked in code by `mail-guard.ts`: the Career Coach mailbox is shared by every employee, so the Mail server is **send-only** (reading, searching, replying, forwarding, updating and deleting are hidden and refused); every address in a send or invite must be the sender (or their manager, only when the sender's own message asks for the manager); Calendar reads must name a verified address; unverifiable recipients are refused.
6. If the reply contains a `planReview` card it is stored in `email-plan-store.ts` (disk, 14-day expiry, tied to thread + user). The card is rendered as an HTML table with "Reply **Save it**"; quizzes point to Teams.

**Outbound** — two separate things:
- The **completion email** is always sent by `fireCompletion100` (Graph `sendMail`, To: the employee, Cc: the manager looked up at send time). If the employee's own address can't be resolved nothing is sent and the goal stays Active for a retry. The goal is recorded as Completed before the summary card is rendered. The LLM is told never to send it.
- Emails the **user asks for** ("email me my plan") are sent by the model through the WorkIQ Mail tools, from the agent's own mailbox. If a transient failure happens after such a send, the run is not replayed.

## 13. Proactive flow (learning-portal updates)

A row changes in `LearningPortalStatus` → Graph change notification → `POST /api/portal-event` → the work is **recorded on disk** (`.portal-queue.json`) → `202` → `PortalQueue` finds rows updated since the persisted **processing watermark** (start of the last fully successful pass, minus a 10-minute overlap, never earlier than 24 h before the scan — notifications can arrive hours late). Before the first successful pass establishes a watermark, it scans the full bounded 24-hour lookback, not from notification arrival; a gap longer than the lookback is not fully recovered → `agentApplication.handleProactivePortalEvent(aadId, …)` → `proactive.continueConversation(...)` → inside that turn `handleSyncProgress` runs under `runObserved` with a short preface message → the user gets a quiz DM for any newly finished course. Failed reads or deliveries are retried with bounded backoff (and resumed after a restart); the per-user checkpoint stops a retry or someone else's update from re-sending a DM. The destination is the employee's stored **personal (1:1)** conversation (`.proactive-refs.json`): only a personal chat is ever stored, so a group chat or channel never receives a private update. If there is no private chat yet, nothing is sent until the user messages the agent once.

## 14. Observability

- `telemetry.ts` calls `useMicrosoftOpenTelemetry` with `a365.enabled`, `enableObservabilityExporter`, `useS2SEndpoint: true` and the token resolver. The S2S route rejects delegated tokens, so Graph's agentic-user token is never used for export.
- `app-token-resolver.ts`: the blueprint connection issues an FMI assertion for the agent identity, which exchanges it (client credentials) for an app-only Observability token. The token is validated (no `scp`, right client/tenant/audience), cached until 5 minutes before expiry, shared across concurrent calls, and a failure backs off for 60 s.
- Per turn: a **baggage** scope (conversation id, channel, session), an `invoke_agent` span (`InvokeAgentScope`, input and output messages), a `chat` span from `InferenceScope` around the LLM call, and an `execute_tool` span (`ExecuteToolScope`) for code-handled steps inside `runObserved`. OpenAI Agents auto-instrumentation adds token usage.
- Agent identity comes from the turn's `recipient` (`agenticAppId`, `agenticUserId`, blueprint id). `agent365Observability__agentId` is only a fallback; the blueprint id is never used as the agent id.
- `observability/conversation-id.ts` makes every email in a thread report one conversation id.

## 15. Configuration quick reference

| Area | Variables |
|---|---|
| LLM | `AZURE_OPENAI_*` (or `OPENAI_API_KEY`, `OPENAI_MODEL`) |
| Agent auth | `connections__service_connection__settings__*`, `agent_id`, `agentic_*`, `USE_AGENTIC_AUTH`, `NODE_ENV` |
| SharePoint | `SP_SITE_HOST`, `SP_SITE_PATH`, `SP_LIST_*` |
| Portal webhook | `PORTAL_WEBHOOK_URL`, `PORTAL_EVENT_SECRET` |
| Observability | `ENABLE_A365_OBSERVABILITY_EXPORTER`, `A365_OBSERVABILITY_LOG_LEVEL`, `agent365Observability__*` |
| WorkIQ (dev only) | `BEARER_TOKEN` |

## 16. Failure behaviour at a glance

| Situation | What happens |
|---|---|
| Network drop during an LLM turn | Retried up to 3×, then a friendly "send that again" message |
| Network drop during a card action | `runDeferred` tells the user; card unlocked when safe |
| WorkIQ server times out | Skipped for that turn; SharePoint tools still work |
| SharePoint column `PlanStatus` missing | Writes continue without it, one warning logged |
| Quiz cache empty after restart | Asks the user to say "check my progress" to regenerate |
| Completion email fails | Goal stays Active; "check my progress" retries |
| Export token fails | Logged, 60 s backoff; the agent keeps working |
| Unknown email sender / bounce | Ignored silently (logged) |

## 17. Where to change what

| I want to… | Change |
|---|---|
| Add or change a card | `cards.ts` (builder + `CardPayload` type + `buildCard` switch), and the schema in the `client.ts` prompt if the LLM emits it |
| Add a button flow | Register an `actionExecute` verb in `agent.ts`, put the logic in `handlers.ts`, wrap with `runDeferred` / `runObserved` |
| Add a typed shortcut | An `isXIntent` function + a branch in `handleAgentMessageActivity` before the LLM path |
| Change grading or progress rules | `career-coach-service.ts` (pure functions) |
| Add a SharePoint column | `setup-sharepoint.ts` (schema + new-column list), `serializeUserState` / `hydrateUserState` |
| Add an LLM tool | `sharepoint-tools.ts` (`makeTool`), register in `makeSharePointTools`, document it in the prompt |
| Add a WorkIQ server | `a365 develop add-mcp-servers`, then a Global Admin runs `a365 setup permissions mcp` |
