# Scrum Master Agent Code Walkthrough

This walkthrough describes the scenario implementation, not the smaller base
OpenAI sample. For configuration and commands, see [`README.md`](README.md);
for flow diagrams, see [`docs/design.md`](docs/design.md).

## 1. Entry point and request authentication

[`src/index.ts`](src/index.ts) loads `.env`, installs scenario logging,
prints the startup configuration summary and creates the Express server.

- `GET /api/health` is public.
- `/api/internal/*` routes run **before** JWT middleware. They check the raw
  `x-internal-token` header against `INTERNAL_TRIGGER_TOKEN`; this is a shared
  secret, not an Agent 365 token exchange. Blank is allowed for local
  development only when `NODE_ENV` is exactly `development`. Every other
  value, including unset or `test`, requires a nonempty token at startup.
- `POST /api/messages` sits **after** `authorizeJWT(authConfig)`. Only
  `NODE_ENV=development` uses the empty development auth configuration.
  Other environments load the SDK connection settings.
- `CloudAdapter.process` converts the request into a turn and calls
  `agentApplication.run(context)`. Request JWT validation and the agent's
  downstream token acquisition are separate stages.

The listener uses `PORT` (default `3978`) and `HOST`. Cloud hosting must set
`NODE_ENV=production` and `HOST=0.0.0.0`; do not deploy the template's
loopback/development settings.

## 2. Agent application and dispatch

[`src/agent.ts`](src/agent.ts) defines `MyAgent`, an
`AgentApplication<TurnState>` using `MemoryStorage`. Its configured
authorization handler is `agentic`. Message and notification handlers declare
that handler; installation-update events have their own route.

For a message, the application:

1. Attempts observability token warm-up; failures are logged and do not block
   the scenario turn.
2. Wraps dispatch in `runWithTurnBaggage`.
3. Best-effort captures the sender's conversation reference for proactive
   delivery. Live mode stores it through the roster service; mock mode keeps
   its roster in-memory.
4. Routes `activity.value.action` prefixes `standup.`, `reconcile.`,
   `blocker.` and `meeting.` to the corresponding card handlers.
5. Routes recognized slash commands through `handlers/commands.ts`.
6. Sends nonempty free text to `handlers/answer.ts` by default.

The routing is important: ordinary sprint questions do **not** go through
`getClient()` and its generic MCP assistant.

## 3. Deterministic scenario handlers

| Handler | Responsibility |
|---|---|
| `handlers/standup.ts` | Group Jira issues by roster assignee, send cards, collect updates and summarize |
| `handlers/reconcile.ts` | Classify update phrases and apply/approve Jira transitions |
| `handlers/chase.ts` | Resolve blockers, propose slots and book a meeting after card actions |
| `handlers/warn.ts` | Evaluate sprint progress and remaining-point thresholds |
| `handlers/sprint-summary.ts` | Classify issue risk and post a mid-sprint RAG table |
| `handlers/report.ts` | Generate deterministic sprint-close markdown with a per-sprint delivery guard |
| `handlers/config.ts` | Capture the destination channel conversation reference |

Reconciliation approval cards submit only the standup id and approval
toggles. The handler requires the Scrum Master's AAD object id and uses a
server-side pending proposal with a 24-hour lifetime; caller-supplied issue
transitions are not authoritative. Apply/skip consumes the proposal.
Expired, replayed or post-restart submissions fail closed and need a new
proposal. The deterministic classifier refuses completion inference when
negation is present.

`/standup` and `/help` do not require LLM inference. In mock mode the first
personal Playground caller becomes the mock Alex (SM) persona and receives
Alex's issue card; other mock assignees are separate identities, not silently
merged into the caller. Live delivery requires real roster mappings and prior
conversations.

## 4. Grounded Jira Q&A

[`handlers/answer.ts`](src/handlers/answer.ts) creates a scenario-specific
`Agent` named `Scrum Master — Answer` using `JIRA_TOOLS` from
[`services/jira-tool.ts`](src/services/jira-tool.ts).

The model selects Jira tools for issue status, sprint issues and comments.
Friendly `Task-N` labels are translated at the tool boundary. `JIRA_MODE`
selects live REST or the mutable mock board; even with mocked Jira, inference
requires the configured OpenAI/Azure OpenAI service.

The handler retains at most eight user/assistant history items per user in a
process-local map. A restart loses this context. Empty model output receives
a fallback message; exceptions produce an error reply, not invented Jira data.

## 5. Generic MCP assistant and notifications

Setting `SMA_ANSWER_DISABLED=true` switches ordinary free text to the generic
client in [`src/client.ts`](src/client.ts). This path acknowledges the message,
sends typing activities and calls `getClient(authorization, authHandlerName,
turnContext, displayName)`.

`getClient()` creates an OpenAI agent with the configured model and registers
MCP servers through `McpToolRegistrationService`. Registration receives the
authorization object, handler name, turn context and optional `BEARER_TOKEN`.
It does not read `MCP_AUTH_TOKEN` or `AGENTIC_USER_ID`. If registration fails,
the warning is logged and the agent can continue without those tools; that is
not proof that an external operation succeeded.

The notification route handles email notifications by retrieving content,
then asking the generic client to summarize/draft a response while treating
the email body as untrusted data. Other notification types receive a generic
notification-type response. Installation updates send welcome/farewell text.

## 6. Calendar tools, fallback and connection lifecycle

[`services/calendar.ts`](src/services/calendar.ts) creates a separate
`Scrum Master — Calendar` agent with Zod-structured output and the same MCP
registration service pattern. It attempts calendar availability lookup and
event creation through the configured Calendar server.

- In mock mode the meeting-booking handler returns an offline notice rather
  than attempting Graph-backed booking; it does not create a real event.
- If slot lookup or structured output is unusable, it returns synthetic
  candidate slots. These are **not verified free/busy availability**.
- Booking failures are errors; suggested slots alone do not prove an event
  was created. Successful booking requires the returned event details.
- The booking handler conditionally claims the blocker `open → booking`
  before attempting Calendar and records `booked` afterwards. Uncertain
  results retain a duplicate-prevention claim; inspect Outlook before
  manually recovering it, rather than automatically retrying invitations.
- `withServers()` connects available transports and retries once on
  `Session not found` / `-32001`.
- Neither the calendar helper nor `OpenAIClient.invokeAgent()` closes servers
  after each call. The module-level tooling service reuses Streamable-HTTP
  sessions; adding `finally { closeServers(); }` would break later turns.

## 7. Observability and logging

[`src/client.ts`](src/client.ts) configures the service name
`Scrum Master Sample Agent`, initializes `OpenAIAgentsTraceInstrumentor`,
and selects the custom token resolver or the built-in agentic token cache.
[`src/observability.ts`](src/observability.ts) supplies runtime identity,
baggage and invoke/tool scope helpers. Missing identity/token information may
skip observability without blocking the user flow.

The generic client wraps inference in `InferenceScope`, records input/output
messages and finish reasons, and disposes the scope in `finally`. It does
**not** record fabricated fixed token counts. Exporter configuration is not
evidence of successful Defender/MAC ingestion.

`LOG_LEVEL` centrally filters console output; SDK-specific logging may also
have separate controls. `LOG_HTTP=true` traces instrumented axios clients including Jira,
not Graph's fetch client or MCP transports.

## 8. Scheduling and persistence boundaries

[`cron/local-scheduler.ts`](src/cron/local-scheduler.ts) and the sibling
[`azure-functions/`](azure-functions) app drive standup and nightly ceremonies.
Both evaluate cron expressions in UTC; nightly checks cover Warn, mid-sprint
summary and sprint close with their eligibility gates. Deploy only one
scheduler (`LOCAL_CRON=false` when Functions is active).

Live mode uses delegated Graph device-code authentication for SharePoint,
separate from inbound request authentication and MCP authorization. The
file-backed MSAL cache is unencrypted and intended for local development.

Standup response fan-in, cutoff timers, completed daily guard and Q&A history
are process-local. SharePoint records do not make those maps a distributed
lock or reconstruct them after restart. Sprint-close delivery has a separate
durable per-sprint claim in live mode; `force` bypasses timing, not that guard.
Mock services and their changes are in-memory and reset with the process.
Live standup startup checks existing SharePoint session records before
fanout, but that check is not atomic across processes. Ambiguous failed
finalization remains `summarizing` for operator review, not automatic retry.
