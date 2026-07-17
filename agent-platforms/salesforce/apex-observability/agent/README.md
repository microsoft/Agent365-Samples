# Agentforce agent (reference)

This folder is a **reference** for the optional Agentforce agent that drives the *origination*
path of this sample — i.e. an Agentforce turn that calls the `A365AgentforceTool` Apex action,
which **originates** an Agent 365 trace (an `invoke_agent` root + an `execute_tool` span) from
Salesforce.

> The Apex classes, configuration, named/external credentials, and permission set in
> [`../force-app`](../force-app) are the reusable core and deploy normally. The Agentforce agent
> itself is **org-specific** (its generated metadata embeds org record IDs and a running user),
> so it is **not** shipped as deployable metadata. Build it per-org using the steps below; this
> file documents exactly what to create.

## What's here

- **`A365_Observability_Sample.agent`** — the agent definition in human-readable **Agent Script**
  (ASL). It shows the system instructions, the single `Echo` topic, and the wiring of the `APEX`
  action to `apex://A365AgentforceTool` (passing `prompt` and `sessionId = @variables.RoutableId`).

## Build it in your org

1. Deploy the core first (see the [sample README](../README.md)) so `A365AgentforceTool` and the
   `A365_Observability` permission set exist.
2. In **Setup → Agentforce Studio → Agentforce Agents**, create a new agent (or import the Agent
   Script above via the Agent Builder / Metadata API).
3. Wire a single topic whose only action targets the Apex `A365AgentforceTool` invocable
   (label **A365 Echo**), mapping:
   - `prompt` ← the user's message text
   - `sessionId` ← the `RoutableId` variable (`@MessagingSession.Id`)
4. Set the agent's **running user** to a user that has the **A365_Observability** permission set
   assigned (this is the `default_agent_user` placeholder in the Agent Script). The running user
   also needs **Read** on `UserExternalCredential` and access to the `A365_Obs_Entra` external
   credential principal — both are granted by the permission set.

   > ⚠️ **A deployed agent runs as its own bot user, not you.** Once activated on a channel the agent
   > executes as its auto-provisioned **EinsteinServiceAgent User** (username ends in `.ext`) — a
   > *different* identity from the developer who runs the Agent Builder **preview**. Both must hold
   > `A365_Observability`. If only your dev user has it, the preview emits telemetry but real turns
   > don't: Salesforce silently drops the Apex action from the planner for the unassigned bot user.
   > Assign it to the bot user too — see [sample README](../README.md) Deploy step 3
   > (`sf org assign permset … --on-behalf-of <bot-user>`).
5. Activate the agent and send a message. With `OriginateEnabled__c = true` in the
   `A365_Observability_Config.Default` record, the turn originates a Salesforce-authored trace
   (`service.name = salesforce-agentforce`).

> **If the action never fires, check permissions first.** When a turn's `enabled_tools`/`tools_sent`
> contains only `__end_session_action__` (no `A365AgentforceTool`, no async job, nothing in Defender),
> the running user is almost certainly missing the `A365_Observability` permission set — Salesforce
> drops Apex actions the user can't access from the planner's tool list. On a real channel that user
> is the **bot user**, not your preview user (see step 4). The directives below only matter once the
> action is actually available to the running user.
>
> **Deterministic invocation (`run @actions.APEX`):** the reasoning block uses `run @actions.APEX` so
> the action fires on **every** turn instead of leaving the choice to the planner (which may answer
> conversationally and skip it) — guaranteeing one telemetry span per turn for the demo.
>
> **Why `prompt` is optional:** `run @actions.APEX` compiles to a *pre-reasoning* node that carries
> **no bound inputs** (`boundInputs={}`, `llmInputs=[]` in the compiled `GenAiPlannerBundle` graph).
> If `prompt` were required, that deterministic invocation would fail input validation and never fire.
> Keeping `prompt` optional (both in the `.agent` action **and** on the `@InvocableVariable` in
> `A365AgentforceTool`) lets `run` fire every turn — `A365AgentforceTool` echoes a greeting for a
> blank prompt, while the planner's own tool call still fills the real message text when it reasons.
>
> **Agent Builder preview caveat:** the preview is not a messaging channel, so `@MessagingSession.Id`
> (the `RoutableId` variable) is empty. Don't eager-bind `sessionId` to `@variables.RoutableId` — an
> action referencing an unresolvable variable is dropped from the preview's tool list. Leave the
> inputs model-filled (`with sessionId = ...`); `sessionId` is optional and `A365AgentforceTool` falls
> back to a generated trace seed, so telemetry still flows in preview. Deploy to a real channel (or
> type a value into the `RoutableId` field) to exercise the linked variable.

## Surfacing sessions in the M365 Admin Center ("Activity" tab)

An Agentforce turn has **no native Entra user** — the conversation runs inside Salesforce. By
default the originated `invoke_agent` span is therefore *user-less*: the ingest pipeline records
`CloudAppEvents.UserKey = 0`, so the session lands in **Defender** raw logs but never surfaces as a
**session / Agent run-time** in the M365 Admin Center, which keys its Activity on a non-zero
`UserKey` (resolved from the span's `user.id`).

To attribute Agentforce-originated sessions to a real identity, set a **run-as Entra user** on the
`A365_Observability_Config.Default` record (`scripts/create-obs-config.apex`):

| Field | Span attribute | Maps to (CloudAppEvents) | Purpose |
|-------|----------------|--------------------------|---------|
| `RunAsUserId__c` | `user.id` | `UserKey` | **Attribution key** — surfaces the session/run-time in the Admin Center. Blank ⇒ user-less (Defender-only). |
| `BlueprintId__c` | `microsoft.a365.agent.blueprint.id` | `TargetAgentBlueprintID` | The blueprint this agent instances. |
| `AgentName__c` | `gen_ai.agent.name` | `TargetAgentName` | Agent display name (falls back to `AgentforceServiceName__c`). |
| `ChannelName__c` | `microsoft.channel.name` | `ChannelName` | Channel (defaults to `agentforce`). |

`gen_ai.conversation.id` / `microsoft.session.id` (→ `ConversationId` / `SessionIdentity`) are set
automatically from the Agentforce session seed. All enrichment is opt-in and fail-open: leave
`RunAsUserId__c` blank to preserve the prior user-less behavior.

## Why it's a reference, not deployable metadata

Agentforce planner bundles (`genAiPlannerBundle`), bot definitions, and their local-action schemas
are **auto-generated** and carry org-scoped identifiers (e.g. component developer names suffixed
with org record IDs, and a concrete running-user). Shipping that generated metadata would neither
deploy cleanly to a different org nor be appropriate for a public sample. Building from the Agent
Script above regenerates clean, org-correct metadata for your org.
