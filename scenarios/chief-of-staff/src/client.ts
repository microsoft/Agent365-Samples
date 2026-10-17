// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// IMPORTANT: Load environment variables FIRST before any other imports.
import { configDotenv } from 'dotenv';
configDotenv({ override: true });

import { randomUUID } from 'node:crypto';
import { Agent, run } from '@openai/agents';
import { Authorization, TurnContext } from '@microsoft/agents-hosting';
import { AgenticTokenCacheInstance } from '@microsoft/agents-a365-observability-hosting';
import {
  ObservabilityManager,
  InferenceScope,
  Builder,
  InferenceOperationType,
  InferenceDetails,
  Agent365ExporterOptions,
  ObservabilityConfiguration,
} from '@microsoft/agents-a365-observability';
import { DefaultConfigurationProvider } from '@microsoft/agents-a365-runtime';
import { OpenAIAgentsTraceInstrumentor } from '@microsoft/agents-a365-observability-extensions-openai';

import { buildAgentDetails, buildRequest, buildUserDetails, instrumentMcpServers, instrumentTools } from './observability';
import { configureOpenAIClient, getModelName, isFoundryEndpoint } from './openai-config';
import { createPlannerTools } from './graph/plannerTools';
import { createPeopleTools, resolveUpnToAad, isUserInTeam } from './graph/peopleTools';
import { createBriefCardTool } from './cards/briefTool';
import { createFollowupCardTools } from './cards/followupCards';
import { addWorkIqServersToAgent } from './workiq';
import { directUserActionPolicy } from './security-policy';

// Configure the OpenAI/Foundry client BEFORE any agent operations.
configureOpenAIClient();

export interface Client {
  invokeAgentWithScope(prompt: string): Promise<string>;
  getAgent(): Agent;
  /** Resolve a Microsoft 365 UPN (email) to its Entra AAD Object ID. Cached. */
  resolveUpnToAad(upn: string | undefined): Promise<string | null>;
  /**
   * Check whether an AAD Object ID belongs to the given Team (M365 group).
   * Returns null if teamId is empty (caller should treat as "no restriction").
   */
  isUserInTeam(aadObjectId: string | undefined, teamId: string | undefined): Promise<boolean | null>;
  /**
   * Auth options bundle used by direct-send card helpers (actionRouter etc.).
   * Mirrors CardToolOptions so callers can build cards outside the LLM path.
   */
  getPeopleOpts(): { authorization: Authorization; context: TurnContext; authHandlerName: string };
}

// ─── Observability ─────────────────────────────────────────────────────────
// Exporter activation is asserted in code rather than left to
// ENABLE_A365_OBSERVABILITY_EXPORTER alone — a missing env var otherwise
// disables telemetry silently. The env var can still force it off.
const observabilityConfigProvider = new DefaultConfigurationProvider(
  () =>
    new ObservabilityConfiguration({
      isObservabilityExporterEnabled: () =>
        process.env.ENABLE_A365_OBSERVABILITY_EXPORTER?.trim().toLowerCase() !== 'false',
    })
);

export const a365Observability = ObservabilityManager.configure((builder: Builder) => {
  const exporterOptions = new Agent365ExporterOptions();
  // A single capture turn emits well over 10 spans once tool calls are traced.
  exporterOptions.maxQueueSize = 512;
  builder.withService('Chief of Staff Agent', '0.1.0').withExporterOptions(exporterOptions);
  builder.withConfigurationProvider(observabilityConfigProvider);
  builder.withTokenResolver((agentId: string, tenantId: string) =>
    AgenticTokenCacheInstance.getObservabilityToken(agentId, tenantId)
  );
});

const openAIAgentsTraceInstrumentor = new OpenAIAgentsTraceInstrumentor({
  enabled: true,
  tracerName: 'openai-agent-auto-instrumentation',
  tracerVersion: '0.1.0',
});

a365Observability.start();
openAIAgentsTraceInstrumentor.enable();

// ─── System instructions ───────────────────────────────────────────────────
const AGENT_INSTRUCTIONS = `You are the Chief of Staff Teammate, an autonomous AI colleague that runs the operating rhythm of a leader and their team.

Your available tools:
- planner_list_tasks / planner_get_task / planner_create_task — Microsoft Planner is the single source of truth for every task, decision, blocker, and risk.
- graph_list_meeting_attendees — given a meeting chatId, list attendees with their AAD Object IDs. Call this BEFORE creating Planner tasks from a transcript so you can resolve speaker names to assigneeAadIds.
- graph_find_user — search the directory for a person by name / email / UPN. Use this when a message mentions a name you don't already have an AAD for.
- send_brief_card — DM the leader an Adaptive Card summary. Use this instead of a plain-text DM when building the daily brief.
- mcp_TeamsServer — meeting transcripts, chat posts, DMs, channel messages.
- mcp_MailTools — read the agent's mailbox and send email.
- mcp_CalendarTools — read the leader's shared calendar, book meetings.

─── When a real user DMs you (a human person), decide which flow the message fits and act:

1. UNBLOCK — the user reports a blocker or says they're stuck ("I'm blocked", "finance hasn't approved", "waiting on X"):
   a. Look up the underlying Planner task via planner_list_tasks if you can infer it from context; otherwise treat the blocker generically.
   b. Identify stakeholders named or implied in the message. For each name, call graph_find_user; pick the top match whose jobTitle/department fits.
   c. Propose 2-3 candidate meeting times based on typical business hours (09:00-17:00 local, weekdays, avoiding lunch). Do NOT pre-check participant calendars.
   d. Book an unblock meeting via mcp_CalendarTools inviting: the reporter (aad in User context), the resolved stakeholders, and the Leader.
   e. Create a Planner task via planner_create_task titled "[BLOCKER] <short summary>", assigneeAadIds=[leader aad], with reporter + meeting time in description.
   f. Reply to the reporter with a concise confirmation naming invite time(s) and stakeholders.

2. RECALL — the user asks a status question ("where are we on X?", "what's the status of Y?"):
   a. If User context says the sender is NOT a leadership-team member, politely refuse: "I can only share status with members of the leadership team." DO NOT reveal task titles or meeting names.
   b. Otherwise, use planner_list_tasks (and planner_get_task for detail) to find matching tasks by title/description.
   c. Use mcp_CalendarTools to enumerate the agent's accessible calendars, find the leader's shared calendar (owner.address matches Leader UPN in User context), and look for upcoming/recent meetings related to the topic.
   d. Compose a concise bulleted answer (max ~150 words). Reference task/meeting titles so the leader can find them.
   e. If nothing relevant is found, say so plainly — do NOT hallucinate.

3. CHIT-CHAT / COMMANDS / META ("hi", "how are you", "what can you do", "remind me tomorrow to X"):
   - Reply naturally and briefly. If they ask what you can do, mention Capture / Brief / Follow-up / Unblock / Escalate / Recall / Task-complete in one sentence each.

─── General rules:
- When booking a meeting, propose 2-3 candidate times based on typical business hours. Do NOT pre-check availability.
- For calendar info about the leader, list the agent's accessible calendars via mcp_CalendarTools and find the one whose owner.address matches Leader UPN.
- Track blockers/risks as Planner tasks with a "[BLOCKER]" or "[RISK]" title prefix so they're easy to filter later.

${directUserActionPolicy()}
`;

export interface ClientOptions {
  /**
   * False for cron/poller-driven runs. Suppresses `user.id` so an autonomous
   * run never reports the cached inbound caller as the human who ran it.
   */
  humanInitiated?: boolean;
  /**
   * True when the sender is outside the configured leadership team (or the
   * membership check failed). The agent is then built with NO tools — no
   * Planner, calendar, mail, Teams, card, or directory/people lookups — so
   * protected data can't be read regardless of what the prompt says.
   */
  restrictedAccess?: boolean;
  /**
   * Meeting-capture extraction: only the read-only people lookups needed to
   * resolve owners. No Planner/card write tools and no WorkIQ MCP, so content
   * inside an untrusted transcript can't trigger writes during extraction —
   * all writes happen afterwards in deterministic code (cos/capture.ts).
   */
  extractionOnly?: boolean;
}

// When false (default), a WorkIQ MCP registration failure fails the turn
// instead of silently running without Teams/Mail/Calendar tools.
const SKIP_TOOLING_ON_ERRORS = process.env.SKIP_TOOLING_ON_ERRORS?.trim().toLowerCase() === 'true';

export async function getClient(
  authorization: Authorization,
  authHandlerName: string,
  turnContext: TurnContext,
  displayName = 'unknown',
  options: ClientOptions = {}
): Promise<Client> {
  const modelName = getModelName();
  console.log(
    `[client] Creating agent (model=${modelName}, foundry=${isFoundryEndpoint()})`
  );

  const peopleOpts = {
    authorization,
    context: turnContext,
    authHandlerName,
  };
  const humanInitiated = options.humanInitiated ?? true;
  const restricted = options.restrictedAccess === true;
  const extractionOnly = !restricted && options.extractionOnly === true;
  // Groups every span this run emits (invoke_agent, chat, execute_tool).
  const runId = randomUUID();
  const scopeOptions = { sessionId: runId, humanInitiated, peopleOpts };

  // Every tool reads through the worker app's tenant-wide application
  // permissions, so a restricted sender gets NO tools — including the
  // directory and chat-membership lookups.
  const tools = restricted
    ? []
    : extractionOnly
    ? [...createPeopleTools(peopleOpts)]
    : [
        // Graph-backed Planner tools (mcp_PlannerServer isn't hosted in this tenant).
        ...createPlannerTools(peopleOpts),
        // Adaptive Card DM helper for the daily Brief.
        createBriefCardTool(peopleOpts),
        // Adaptive Card DM tools for the interactive Follow-up flow.
        ...createFollowupCardTools(peopleOpts),
        // Graph-backed people/directory tools: resolve display names to AAD Object IDs.
        ...createPeopleTools(peopleOpts),
      ];

  const agent = new Agent({
    name: 'Chief of Staff Agent',
    model: modelName,
    instructions: `${AGENT_INSTRUCTIONS}\n\nThe display name of the current user is "${displayName}".`,
    tools: instrumentTools(tools, turnContext, scopeOptions),
  });

  if (restricted) {
    console.log('[client] restricted sender — no tools attached (Planner, card, people, WorkIQ MCP).');
    return new CosAgentClient(agent, peopleOpts, humanInitiated, runId);
  }
  if (extractionOnly) {
    return new CosAgentClient(agent, peopleOpts, humanInitiated, runId);
  }

  try {
    await addWorkIqServersToAgent(
      agent,
      authorization,
      authHandlerName,
      turnContext
    );
    const attachedMcp = ((agent as any).mcpServers as any[] | undefined) ?? [];
    instrumentMcpServers(attachedMcp, turnContext, scopeOptions);
    const names = attachedMcp.map((s: any) => s?.name ?? s?.serverName ?? '(unnamed)');
    console.log(
      `[client] MCP tool servers attached: ${attachedMcp.length} — ${names.join(', ')}`
    );
  } catch (error) {
    if (!SKIP_TOOLING_ON_ERRORS) {
      throw new Error(
        `WorkIQ MCP registration failed (set SKIP_TOOLING_ON_ERRORS=true to continue without these tools): ${
          (error as Error)?.message ?? error
        }`
      );
    }
    console.warn('[client] Failed to register MCP tool servers (SKIP_TOOLING_ON_ERRORS=true — continuing):', error);
  }

  return new CosAgentClient(agent, peopleOpts, humanInitiated, runId);
}

// ─── Client wrapper ──────────────────────────────────────────────
class CosAgentClient implements Client {
  private agent: Agent;
  private peopleOpts: { authorization: Authorization; context: TurnContext; authHandlerName: string };
  private humanInitiated: boolean;
  // Groups every span this client emits into one logical run.
  private runId: string;

  constructor(
    agent: Agent,
    peopleOpts: { authorization: Authorization; context: TurnContext; authHandlerName: string },
    humanInitiated = true,
    runId = randomUUID()
  ) {
    this.agent = agent;
    this.peopleOpts = peopleOpts;
    this.humanInitiated = humanInitiated;
    this.runId = runId;
  }

  getAgent(): Agent {
    return this.agent;
  }

  resolveUpnToAad(upn: string | undefined): Promise<string | null> {
    return resolveUpnToAad(upn, this.peopleOpts);
  }

  isUserInTeam(
    aadObjectId: string | undefined,
    teamId: string | undefined
  ): Promise<boolean | null> {
    return isUserInTeam(aadObjectId, teamId, this.peopleOpts);
  }

  getPeopleOpts() {
    return this.peopleOpts;
  }

  private async invokeAgent(prompt: string): Promise<string> {
    try {
      await this.connectToServers();
      const result = await run(this.agent, prompt);
      return result.finalOutput || "Sorry, I couldn't get a response :(";
    } catch (error) {
      console.error('[client] agent error:', error);
      const err = error as any;
      return `Error: ${err.message || err}`;
    } finally {
      await this.closeServers();
    }
  }

  async invokeAgentWithScope(prompt: string): Promise<string> {
    let response = '';
    const context = this.peopleOpts.context;
    const agentDetails = buildAgentDetails(context);

    // No runtime agent identity means the backend can't bind the span, so it
    // would be dropped anyway. Run untraced rather than emit a bad agent id.
    if (!agentDetails) {
      console.warn(
        '[observability] no runtime agent identity (recipient.agenticAppId) or tenant on this turn — running without an inference span.'
      );
      return this.invokeAgent(prompt);
    }

    const inferenceDetails: InferenceDetails = {
      operationName: InferenceOperationType.CHAT,
      model: this.agent.model.toString(),
      providerName: isFoundryEndpoint() ? 'azure.ai.openai' : 'openai',
    };
    const request = buildRequest(context, { sessionId: this.runId });
    const userDetails = this.humanInitiated
      ? await buildUserDetails(context, this.peopleOpts)
      : undefined;

    const scope = InferenceScope.start(request, inferenceDetails, agentDetails, userDetails);
    try {
      await scope.withActiveSpanAsync(async () => {
        try {
          response = await this.invokeAgent(prompt);
          scope.recordOutputMessages([response]);
          scope.recordInputMessages([prompt]);
          scope.recordFinishReasons(['stop']);
        } catch (error) {
          scope.recordError(error as Error);
          scope.recordFinishReasons(['error']);
          throw error;
        }
      });
    } finally {
      scope.dispose();
    }
    return response;
  }

  private async connectToServers(): Promise<void> {
    const mcp = (this.agent as any).mcpServers as any[] | undefined;
    if (mcp?.length) {
      for (const s of mcp) await s.connect();
    }
  }

  private async closeServers(): Promise<void> {
    const mcp = (this.agent as any).mcpServers as any[] | undefined;
    if (mcp?.length) {
      for (const s of mcp) await s.close();
    }
  }
}
