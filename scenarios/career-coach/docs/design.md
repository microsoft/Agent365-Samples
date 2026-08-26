<!-- Copyright (c) Microsoft Corporation. Licensed under the MIT License. -->

# Career Coach — Design

A private AI **Career Coach** built on the Microsoft Agent 365 SDK + OpenAI Agents SDK. It helps an employee set a target role, maps their skill gaps against a competency framework, recommends courses, proactively quizzes them as they complete learning, fires milestone nudges, and drafts a manager wrap-up email — all as Adaptive Card conversations inside Microsoft Teams.

## 1. Design principles

1. **Deterministic-first.** The LLM is gated to only the paths that genuinely need language understanding: free-text role elicitation, quiz-question generation, short-answer grading, and completion-email prose. Every card submit, data write, MCQ grade, milestone rule, and email dispatch is plain TypeScript. This eliminates hallucinated skill bumps, wrong goal completion, and long invoke timeouts.
2. **Card actions never double-fire.** Every `Action.Execute` handler acknowledges fast; heavy work runs after the ack.
3. **Durable state in SharePoint.** Five lists hold all state; a disk-backed store keeps proactive conversation references across restarts.
4. **One path to Graph.** Runtime uses agentic auth (a delegated Graph token minted per turn — `/me` is whoever is in the chat). Setup/seed scripts use MSAL device-code + delegated scopes. No application-permission client secret at runtime.
5. **Grounded, not hallucinated.** All plan/progress state is read back from SharePoint before each write; the LLM never invents list IDs or progress values.
6. **Graceful degradation.** A365 lifecycle events are consumed by a top-priority route so onboarding never crashes the turn.

## 2. Architecture

```mermaid
flowchart LR
    subgraph Teams["Microsoft Teams"]
        User["👤 Employee"]
    end

    subgraph Coach["Career Coach (A365 SDK)"]
        Router["🚦 Card & Message Router<br/>agent.ts"]
        Code["⚙️ Deterministic TypeScript<br/>handlers.ts · career-coach-service.ts<br/>Save · Sync · Grade MCQ · Milestones · Email"]
        LLM["🧠 Focused LLM Calls<br/>llm-tasks.ts + client.ts<br/>Role elicit · Quiz gen · Short-answer grade · Email prose"]
    end

    subgraph M365["Microsoft 365"]
        SP["📁 SharePoint Lists<br/>UserState · LearningCatalog · Quiz · Portal · Competency"]
        Graph["📧 Microsoft Graph<br/>/me/manager · sendMail · Change Subscriptions"]
    end

    Portal["🎓 Learning Portal"] -->|logs course completions| SP
    User <-->|adaptive cards<br/>welcome · skill path · plan · quiz · progress| Router
    Router --> Code
    Router --> LLM
    LLM --> Code
    Code <--> SP
    Code <--> Graph
    SP -.->|change notification via webhook| Router
    Graph -.->|email to user + manager on 100%| User

    classDef code fill:#e8f4fd,stroke:#2b6cb0,color:#111;
    classDef llm fill:#fef3c7,stroke:#b45309,color:#111;
    classDef data fill:#e6f7ea,stroke:#2f855a,color:#111;
    class Code code;
    class LLM llm;
    class SP,Graph,Portal data;
```

**Hybrid pro-code:** the LLM handles free-text conversation and creative generation only; the deterministic TypeScript path owns every card submit, data write, business rule, and email.

## 3. User journey

```mermaid
flowchart LR
    A["👤 Employee<br/>opens Teams"] --> B["🎯 Set goal<br/>pick target role"]
    B --> C["📊 Rate skills<br/>0 → 4 on each dimension"]
    C --> D["💾 Save plan<br/>courses + goals in SharePoint"]
    D --> E["📚 Learn<br/>take courses on learning portal"]
    E --> F["📝 Auto-quiz<br/>coach DMs a 5-question quiz on completion"]
    F -->|Pass ≥ 4/5| G["🚀 Skill level bumps<br/>progress recomputes"]
    F -->|Fail| F2["Retry quiz"]
    F2 --> F
    G -->|≥ 80% overall| H["🏆 Milestone card<br/>weak topics surfaced"]
    G -->|100% overall| I["🎉 Email to manager<br/>courses + hours invested"]

    classDef start fill:#e0e7ff,stroke:#3730a3,color:#111;
    classDef win fill:#dcfce7,stroke:#166534,color:#111;
    class A start;
    class H,I win;
```

## 4. Source layout

```
src/
├── index.ts                  Express server: /api/messages, /api/portal-event, /api/health
├── agent.ts                  MyAgent (AgentApplication) — message/notification/install routing +
│                             Action.Execute handlers (welcome, skill_ratings, save_plan, quiz_submit)
├── client.ts                 OpenAI Agents client + system prompt + observability wiring (LLM path)
├── cards.ts                  All Adaptive Card renderers + renderCard()/extractCards()
├── handlers.ts               Deterministic card handlers: skill ratings, save plan, quiz submit, sync
├── career-coach-service.ts   Pure business logic + typed SharePoint CRUD (gap analysis, grading,
│                             milestones, progress recompute)
├── career-coach-types.ts     Shared interfaces + SP_CONFIG
├── llm-tasks.ts              3 focused LLM sub-calls: quiz generation, short-answer grade, email prose
├── graph-service.ts          MSAL device-code + agentic Graph clients, sendMail, subscriptions
├── sharepoint-tools.ts       OpenAI function tools for the LLM path (agentic Graph, auto-correction)
├── sharepoint-column-map.ts  Display-name ↔ internal-name column translation
├── quiz-cache.ts             In-memory quiz answer-key store
├── file-storage.ts           Disk-backed Storage impl for the Proactive subsystem
├── proactive-refs.ts         AAD Object ID → conversation reference cache
├── subscription-manager.ts   Auto-create + auto-renew the Graph change subscription
├── openai-config.ts          Azure OpenAI vs OpenAI client selection
├── token-cache.ts            Observability token cache helpers
└── scripts/                  Setup, seed, and demo helpers (see README §9)
```

## 5. The five flows

Each flow is a deterministic handler in `handlers.ts`, backed by pure logic in `career-coach-service.ts`, with focused LLM sub-calls in `llm-tasks.ts`.

| Flow | Trigger | Key code |
|---|---|---|
| **Set goals + skill path** | `careercoach_welcome` tile → role name | `buildSkillPathForRole`, `findRole` |
| **Map skills + save plan** | `careercoach_skill_ratings` → `careercoach_save_plan` | `handleSkillRatingsSubmit`, `handleSavePlanSubmit`, `matchCoursesForSkill`, `gapCategoryFor` |
| **Proactive quiz** | Graph change notification → `/api/portal-event` | `handleSyncProgress`, `generateQuizQuestions`, `handleQuizSubmit`, `gradeMcqAnswer`, `gradeShortAnswers` |
| **80% milestone** | recompute after a quiz pass | `recomputeGoalsAndOverall`, `computeMilestoneAggregate` |
| **100% completion + email** | all goals reach 100% | `composeCompletionEmail`, `sendMail` (Graph `/me/sendMail`) |

### Feature 1 — portal → proactive quiz (sequence)

```mermaid
sequenceDiagram
    autonumber
    actor Emp as 👤 Employee
    participant Portal as 🎓 Learning Portal
    participant SP as 📁 SharePoint
    participant Graph as 📧 Microsoft Graph
    participant Coach as 🚦 Career Coach
    participant LLM as 🧠 LLM (Q gen)

    Emp->>Portal: Completes a course
    Portal->>SP: Writes row to LearningPortalStatus
    SP->>Graph: Change notification (subscribed list)
    Graph->>Coach: POST /api/portal-event
    Coach->>SP: Read UserState + LearningPortalStatus
    Note over Coach: Diff finds newly-completed course
    Coach->>LLM: Generate 5 quiz questions for that course
    LLM-->>Coach: Questions + correct answers
    Coach->>Emp: Proactive DM with quiz card
    Emp->>Coach: Submits answers
    Coach->>Coach: Grade MCQ (code) + short-answer (LLM)
    Coach->>SP: Append QuizResponses + update UserState
    Coach->>Emp: Quiz result + progress card
```

### Course state lifecycle

```mermaid
stateDiagram-v2
    [*] --> Recommended: Save plan
    Recommended --> InProgress: Portal marks In Progress
    Recommended --> QuizPending: Portal marks Complete
    InProgress --> QuizPending: Portal marks Complete
    QuizPending --> QuizFailed: Submit, score < 4
    QuizFailed --> QuizPending: Retry
    QuizPending --> Complete: Submit, score ≥ 4
    Complete --> [*]

    Recommended: 📚 Recommended
    InProgress: ⏳ In Progress
    QuizPending: 📝 Awaiting quiz
    QuizFailed: ❌ Failed (weak topics logged)
    Complete: 🎉 Complete (skill level bumped)
```

## 6. SharePoint schema

| List | Access | Purpose |
|---|---|---|
| `CompetencyFramework_v2` | read | Role → required-skill mapping (per level) |
| `LearningCatalog_v2` | read | Courses mapped to skills, with from/to levels |
| `UserState` | read/write | One row per user — the living plan (JSON columns: Goals, Skills, LearningProgress) |
| `LearningPortalStatus` | read | Mimicked learning-portal telemetry (the Feature 1 trigger source) |
| `QuizResponses` | write | Append-only audit log of every quiz attempt |

Column display-name ↔ internal-name translation is handled by `sharepoint-column-map.ts`. Lists are created idempotently by `npm run setup:sharepoint` and seeded by `npm run seed:reference`.

## 7. Auth model

- **Runtime (agentic auth):** the A365 platform mints a delegated Graph token per turn (`getAgenticGraphClient` in `graph-service.ts`). `/me`, `/me/manager`, and `/me/sendMail` resolve to the user in the current chat. No client secret is used at runtime.
- **Scripts (MSAL device-code):** `setup:sharepoint` / `seed:reference` / `mark:complete` etc. sign in once interactively as a developer with `Sites.ReadWrite.All`; the token is cached in `.mstoken-cache.json`.

## 8. Observability

`client.ts` configures the A365 `ObservabilityManager` with a token resolver (built-in `AgenticTokenCacheInstance`, or a custom resolver when `Use_Custom_Resolver=true`) and enables the OpenAI Agents auto-instrumentor. The message handler in `agent.ts` builds a baggage scope from the turn context and preloads the observability token before invoking the LLM path, so `invoke_agent` / `chat` spans carry the runtime agent identity. Set `ENABLE_A365_OBSERVABILITY_EXPORTER=true` to export to MAC Activity; the default is console-only.

## 9. Extension points

1. **New card flow** — add a renderer in `cards.ts` + an `adaptiveCards.actionExecute(<verb>, …)` route in `agent.ts` + a handler in `handlers.ts`.
2. **New business rule** — add pure logic to `career-coach-service.ts` (fully unit-testable, no I/O).
3. **New LLM sub-call** — add a focused function to `llm-tasks.ts`; keep it narrow and structured.
4. **Different data backend** — swap the SharePoint CRUD in `career-coach-service.ts` / `graph-service.ts`.
5. **Production mail** — replace delegated `/me/sendMail` with app-only `Mail.Send` + `Sites.Selected`.
