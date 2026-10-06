<!-- Copyright (c) Microsoft Corporation. Licensed under the MIT License. -->

# Agent Code Walkthrough

A step-by-step tour of the Career Coach implementation. It uses a **hybrid pro-code** architecture: the LLM handles free-text conversation and creative generation only; every card submit, data write, and business rule runs as deterministic TypeScript. See [`docs/design.md`](docs/design.md) for the architecture diagrams.

## File map

| File | Role |
|---|---|
| `src/index.ts` | Express server: `/api/messages`, `/api/portal-event` (Graph webhook + manual test), `/api/health` |
| `src/agent.ts` | `MyAgent extends AgentApplication` — message/notification/install routing + `Action.Execute` card handlers |
| `src/client.ts` | OpenAI Agents client, system prompt, and observability wiring (the LLM path) |
| `src/cards.ts` | Adaptive Card renderers + `renderCard()` / `extractCards()` |
| `src/handlers.ts` | Deterministic card handlers (skill ratings, save plan, quiz submit, sync) |
| `src/career-coach-service.ts` | Pure business logic + typed SharePoint CRUD |
| `src/llm-tasks.ts` | Three focused LLM sub-calls (quiz gen, short-answer grade, email prose) |
| `src/graph-service.ts` | MSAL device-code + agentic Graph clients, `sendMail`, subscriptions |
| `src/subscription-manager.ts` | Auto-create + auto-renew the Graph change subscription |

---

## Step 1 — Server entry point (`index.ts`)

`index.ts` boots an Express server and wires three routes. Environment is loaded **first** so config is available when packages initialize at import time.

```typescript
const isDevelopment = process.env.NODE_ENV === 'development';
const authConfig: AuthConfiguration = isDevelopment ? {} : loadAuthConfigFromEnv();
```

- `GET /api/health` — placed **before** the JWT middleware so it needs no auth.
- `POST /api/portal-event` — the Feature 1 trigger. Also before auth, because Graph and manual callers don't produce an A365 JWT. It accepts three request shapes:
  1. **Graph validation handshake** (`?validationToken=…`) → echo the token as `text/plain` within ~10s.
  2. **Graph change notification** (`{ value: [...] }`) → verify `clientState === PORTAL_EVENT_SECRET`, ack `202` fast, then handle asynchronously.
  3. **Manual test** (`X-Portal-Secret` header + `{ UserAADId }`) → fire a proactive DM immediately.
- `POST /api/messages` — the standard A365 turn endpoint, behind `authorizeJWT`, handed to the `CloudAdapter`.

Process-level `unhandledRejection` / `uncaughtException` guards keep the server up if a background activity (typing indicator, system-notification reply) rejects.

---

## Step 2 — Agent routing (`agent.ts`)

`MyAgent extends AgentApplication<TurnState>`. The constructor enables the **Proactive** subsystem (disk-backed `FileStorage` so nodemon restarts don't wipe conversation records) and agentic authorization, then registers routes.

### Lifecycle-event guard (must out-rank every other route)

A365 emits `type: event`, `name: agentLifecycle` events during onboarding whose `value` has no `action`. The hosting SDK's adaptive-card selector throws `"Invalid action value"` on those, which would crash the turn and 502-loop. A top-priority Agentic+Invoke route (rank 0) consumes them:

```typescript
this.addRoute(
  async (ctx) => ctx.activity?.type === ActivityTypes.Event &&
    String(ctx.activity?.name ?? '').toLowerCase() === 'agentlifecycle',
  async (ctx) => { /* acknowledge, no reply */ },
  true, 0, [], true, // isInvoke, rank=First, authHandlers, isAgentic
);
```

### The routes

- `onAgentNotification("agents:*", …)` → `handleAgentNotificationActivity` (email + lifecycle notifications).
- `onActivity(Message, …)` → `handleAgentMessageActivity` (free text: welcome, role elicitation, `check my progress` sync intent).
- `onActivity(InstallationUpdate, …)` → install/uninstall.
- Four `adaptiveCards.actionExecute` handlers — one per card verb.

### Card verbs → handlers

| Verb | What it does |
|---|---|
| `careercoach_welcome` | Renders the personalized welcome card / opening question |
| `careercoach_skill_ratings` | User's self-assessment → `handleSkillRatingsSubmit` (gap analysis + planReview card) |
| `careercoach_save_plan` | Persists the plan → `handleSavePlanSubmit` (writes `UserState`) |
| `careercoach_quiz_submit` | Grades the quiz **deterministically** (MCQ letter match + short-answer LLM sub-call) → `handleQuizSubmit` |

`unwrapActionData()` unwraps the `Action.Execute` envelope (`{ verb, data }`) so handlers read input ids directly.

---

## Step 3 — The LLM path (`client.ts`)

`client.ts` builds an OpenAI Agents `Agent` with the SharePoint function tools (`makeSharePointTools`) and a system prompt describing the five lists and card-output contract. Observability is configured once at module load:

```typescript
export const a365Observability = ObservabilityManager.configure((builder) => {
  builder.withService('Employee Career Coach', '1.0.0')
         .withExporterOptions(exporterOptions);
  if (process.env.Use_Custom_Resolver === 'true') builder.withTokenResolver(tokenResolver);
  else builder.withTokenResolver((agentId, tenantId) =>
         AgenticTokenCacheInstance.getObservabilityToken(agentId, tenantId));
});
a365Observability.start();
openAIAgentsTraceInstrumentor.enable();
```

`getClient()` caches one client per conversation and exposes `invokeAgentWithScope(prompt, ctx)`, which runs the agent inside an `InferenceScope` so `gen_ai` spans carry the runtime agent identity. The LLM is used only for free-text conversation and the quiz/email sub-calls — never for card submits.

---

## Step 4 — Deterministic handlers (`handlers.ts` + `career-coach-service.ts`)

`handlers.ts` is the deterministic core. It never calls the full agent; it uses pure functions from `career-coach-service.ts` plus focused sub-calls from `llm-tasks.ts`.

- `handleSkillRatingsSubmit` — turns self-assessment into a gap analysis (`gapCategoryFor`) and course recommendations (`matchCoursesForSkill`), renders the planReview card.
- `handleSavePlanSubmit` — writes the living plan to `UserState` (`upsertUserState`).
- `handleSyncProgress` — diffs `LearningPortalStatus` against the plan (`diffPortalAgainstPlan`), picks the next pending quiz (`pickNextPendingQuiz`).
- `handleQuizSubmit` — grades MCQ in code (`gradeMcqAnswer`), grades short answers via `gradeShortAnswers` (LLM), appends to `QuizResponses`, bumps skill level (`applyQuizPass` / `applyQuizFail`), recomputes progress (`recomputeGoalsAndOverall`), and fires the 80%/100% cards. On 100%, `composeCompletionEmail` + `sendMail` email the user and their manager.

`career-coach-service.ts` holds all business rules as pure, testable functions (no I/O beyond the typed SharePoint CRUD): `findRole`, `matchCoursesForSkill`, `recomputeGoalsAndOverall`, `applyQuizPass/Fail`, `computeMilestoneAggregate`, `summarizeGrading`, etc.

---

## Step 5 — Focused LLM sub-calls (`llm-tasks.ts`)

Three narrow, structured calls — each returns typed data, not free prose that downstream code has to parse loosely:

- `generateQuizQuestions(course)` — 3 MCQ + 2 short-answer questions with an answer key (cached in `quiz-cache.ts`).
- `gradeShortAnswers(items)` — grades free-text answers against expected points.
- `composeCompletionEmail(input)` — writes the manager email body.

---

## Step 6 — Graph + proactive (`graph-service.ts`, `subscription-manager.ts`)

- `graph-service.ts` exposes two client factories: `getAgenticGraphClient` (runtime, delegated per-turn token — used for all user-context reads/writes and `/me/sendMail`) and `getGraphClient` (MSAL device-code, used by the setup scripts). `sendMail` sends the completion email; list helpers back the CRUD.
- `subscription-manager.ts` (`ensureSubscription`) creates and auto-renews the Microsoft Graph change subscription on the `LearningPortalStatus` list that drives Feature 1. `proactive-refs.ts` maps AAD Object ID → conversation id so the webhook can DM the right user.

---

## Auth summary

| Path | Auth |
|---|---|
| Runtime Graph (reads/writes/mail) | Agentic auth — delegated token minted per turn by A365; `/me` is the chat user |
| Setup / seed scripts | MSAL device-code, delegated `Sites.ReadWrite.All`, cached in `.mstoken-cache.json` |

No application-permission client secret is used at runtime. See [`docs/design.md`](docs/design.md) §7 for details.
