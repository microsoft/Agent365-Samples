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
5. Activate the agent and send a message. With `OriginateEnabled__c = true` in the
   `A365_Observability_Config.Default` record, the turn originates a Salesforce-authored trace
   (`service.name = salesforce-agentforce`).

## Why it's a reference, not deployable metadata

Agentforce planner bundles (`genAiPlannerBundle`), bot definitions, and their local-action schemas
are **auto-generated** and carry org-scoped identifiers (e.g. component developer names suffixed
with org record IDs, and a concrete running-user). Shipping that generated metadata would neither
deploy cleanly to a different org nor be appropriate for a public sample. Building from the Agent
Script above regenerates clean, org-correct metadata for your org.
