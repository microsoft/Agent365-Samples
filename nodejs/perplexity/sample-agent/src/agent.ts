// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  TurnState,
  AgentApplication,
  AttachmentDownloader,
  MemoryStorage,
  TurnContext,
} from "@microsoft/agents-hosting";
import { ActivityTypes } from "@microsoft/agents-activity";
import { AgentNotificationActivity } from "@microsoft/agents-a365-notifications";
import { PerplexityAgent } from "./perplexityAgent.js";
import { PlaygroundActivityTypes } from "./playgroundActivityTypes.js";

import {
  BaggageBuilder,
  InvokeAgentDetails,
  InvokeAgentScope,
  ExecutionType,
  ServiceEndpoint,
} from "@microsoft/agents-a365-observability";
import {
  createAgenticTokenCacheKey,
  extractAgentDetailsFromTurnContext,
  extractTenantDetailsFromTurnContext,
} from "./telemetryHelpers.js";
import { getObservabilityAuthenticationScope } from "@microsoft/agents-a365-runtime";
import tokenCache from "./tokenCache.js";
import { AgenticTokenCacheInstance } from "@microsoft/agents-a365-observability-tokencache";

/**
 * Conversation state interface for tracking message count.
 */
interface ConversationState {
  count: number;
}

/**
 * ApplicationTurnState combines TurnState with our ConversationState.
 */
type ApplicationTurnState = TurnState<ConversationState>;

/**
 * Instantiate the AttachmentDownloader.
 */
const downloader: AttachmentDownloader = new AttachmentDownloader();

/**
 * Instantiate the MemoryStorage.
 */
const storage: MemoryStorage = new MemoryStorage();

/**
 * Create the Agent Application instance with typed state.
 */
export const agentApplication: AgentApplication<ApplicationTurnState> =
  new AgentApplication<ApplicationTurnState>({
    authorization: {
      agentic: {}, // We have the type and scopes set in the .env file
    },
    storage,
    fileDownloaders: [downloader],
  });

/**
 * Instantiate the PerplexityAgent.
 */
const perplexityAgent: PerplexityAgent = new PerplexityAgent(undefined);

/* --------------------------------------------------------------------
 * 🔧 Shared telemetry helper
 * -------------------------------------------------------------------- */

async function runWithTelemetry(
  context: TurnContext,
  _state: ApplicationTurnState,
  options: {
    operationName: string;
    executionType: ExecutionType;
    requestContent?: string;
  },
  handler: (invokeScope?: InvokeAgentScope) => Promise<void>
): Promise<void> {
  const agentInfo = extractAgentDetailsFromTurnContext(context);
  const tenantInfo = extractTenantDetailsFromTurnContext(context);

  const requestContent =
    options.requestContent ??
    context.activity.text ??
    options.operationName ??
    "Unknown request";

  const baggageScope = new BaggageBuilder()
    .tenantId(tenantInfo.tenantId)
    .agentId(agentInfo.agentId)
    .agentName(agentInfo.agentName)
    .conversationId(context.activity.conversation?.id)
    .callerId((context.activity.from as any)?.aadObjectId)
    .callerUpn(context.activity.from?.id)
    .correlationId(context.activity.id ?? `corr-${Date.now()}`)
    .build();

  await baggageScope.run(async () => {
    const invokeDetails: InvokeAgentDetails = {
      ...agentInfo,
      conversationId: context.activity.conversation?.id,
      request: {
        content: requestContent,
        executionType: options.executionType,
        sessionId: context.activity.conversation?.id,
      },
      endpoint: {
        host: context.activity.serviceUrl ?? "unknown",
        port: 0,
      } as ServiceEndpoint,
    };

    const invokeScope = InvokeAgentScope.start(
      invokeDetails,
      tenantInfo,
      agentInfo
    );

    if (!invokeScope) {
      // Observability not configured – just run the handler
      await handler();
      return;
    }

    try {
      await invokeScope.withActiveSpanAsync(async () => {
        invokeScope.recordInputMessages([requestContent]);

        // 🔐 auth (logged via telemetry)
        await authenticateObservability(
          context,
          agentInfo,
          tenantInfo,
          options.operationName,
          invokeScope
        );

        // 🔁 handler (logged via telemetry)
        await executeHandlerWithTelemetry(
          options.operationName,
          invokeScope,
          handler
        );
      });
    } finally {
      invokeScope.dispose();
    }
  });
}

/**
 * Authenticates observability using either custom resolver or shared cache.
 * @param context The TurnContext.
 * @param agentInfo The agent information.
 * @param tenantInfo The tenant information.
 * @param operationName The name of the operation.
 * @param invokeScope The InvokeAgentScope instance.
 * @returns Promise<void>
 */
async function authenticateObservability(
  context: TurnContext,
  agentInfo: { agentId: string },
  tenantInfo: { tenantId?: string },
  operationName: string,
  invokeScope: InvokeAgentScope
): Promise<void> {
  // 🔧 Gate auth by environment / flag
  if (
    process.env.ENABLE_A365_OBSERVABILITY_EXPORTER === "false" ||
    process.env.DEBUG === "true"
  ) {
    invokeScope.recordOutputMessages([
      `${operationName} auth: skipped (debug/local environment)`,
    ]);
    invokeScope.recordResponse(`${operationName}_Auth_Skipped`);
    return;
  }

  // 🔐 Real auth path (same logic as before)
  try {
    // Set Use_Custom_Resolver === 'true' to use a custom token resolver (see telemetry.ts) and a custom token cache (see token-cache.ts).
    // Otherwise: use the default AgenticTokenCache via RefreshObservabilityToken.
    if (process.env.Use_Custom_Resolver === "true") {
      const aauToken = await agentApplication.authorization.exchangeToken(
        context,
        [...getObservabilityAuthenticationScope()],
        "agentic"
      );

      const cacheKey = createAgenticTokenCacheKey(
        agentInfo.agentId,
        tenantInfo.tenantId
      );

      if (aauToken?.token) {
        tokenCache.set(cacheKey, aauToken.token);
        invokeScope.recordOutputMessages([
          `${operationName} auth: Custom resolver token cached`,
        ]);
      } else {
        invokeScope.recordOutputMessages([
          `${operationName} auth: Custom resolver returned no token`,
        ]);
        invokeScope.recordResponse(`${operationName}_Auth_NoToken`);
      }
    } else {
      await AgenticTokenCacheInstance.RefreshObservabilityToken(
        agentInfo.agentId,
        tenantInfo.tenantId,
        context,
        agentApplication.authorization,
        getObservabilityAuthenticationScope()
      );

      invokeScope.recordOutputMessages([
        `${operationName} auth: Shared cache refreshed`,
      ]);
    }
  } catch (authError) {
    const err = authError as Error;
    invokeScope.recordError(err);
    invokeScope.recordOutputMessages([
      `${operationName} auth: Failed`,
      `Auth error: ${err.message ?? String(err)}`,
    ]);
    invokeScope.recordResponse(
      `${operationName}_Auth_Failed: ${err.message ?? String(err)}`
    );
    // Optional: rethrow if you want auth failure to abort the whole operation
    // throw authError;
  }
}

/**
 * Executes the handler with telemetry recording.
 * @param operationName The name of the operation.
 * @param invokeScope The InvokeAgentScope instance.
 * @param handler The handler function to execute.
 */
async function executeHandlerWithTelemetry(
  operationName: string,
  invokeScope: InvokeAgentScope,
  handler: (invokeScope?: InvokeAgentScope) => Promise<void>
): Promise<void> {
  try {
    await handler(invokeScope);

    invokeScope.recordOutputMessages([
      `${operationName} handled by PerplexityAgent`,
    ]);
    invokeScope.recordResponse(`${operationName} succeeded`);
  } catch (error) {
    const err = error as Error;

    invokeScope.recordError(err);
    invokeScope.recordOutputMessages([
      `${operationName} failed`,
      `Handler error: ${err.message ?? String(err)}`,
    ]);
    invokeScope.recordResponse(
      `${operationName} failed: ${err.message ?? String(err)}`
    );

    throw error;
  }
}

/* --------------------------------------------------------------------
 * ✅ Real Notification Events (Production) + telemetry
 * -------------------------------------------------------------------- */

/**
 * Handles ALL real notification events from any workload.
 */
agentApplication.onAgentNotification(
  "*",
  async (
    context: TurnContext,
    state: ApplicationTurnState,
    activity: AgentNotificationActivity
  ): Promise<void> => {
    await runWithTelemetry(
      context,
      state,
      {
        operationName: "AgentNotification_*",
        executionType: ExecutionType.EventToAgent,
        requestContent: `NotificationType=${activity.notificationType}`,
      },
      async (invokeScope) => {
        await perplexityAgent.handleAgentNotificationActivity(
          context,
          state,
          activity,
          invokeScope
        );
      }
    );
  }
);

/**
 * Word-specific notifications.
 */
agentApplication.onAgenticWordNotification(
  async (
    context: TurnContext,
    state: ApplicationTurnState,
    activity: AgentNotificationActivity
  ): Promise<void> => {
    await runWithTelemetry(
      context,
      state,
      {
        operationName: "AgentNotification_Word",
        executionType: ExecutionType.EventToAgent,
        requestContent: `WordNotificationType=${activity.notificationType}`,
      },
      async (invokeScope) => {
        await perplexityAgent.handleAgentNotificationActivity(
          context,
          state,
          activity,
          invokeScope
        );
      }
    );
  }
);

/**
 * Email-specific notifications.
 */
agentApplication.onAgenticEmailNotification(
  async (
    context: TurnContext,
    state: ApplicationTurnState,
    activity: AgentNotificationActivity
  ): Promise<void> => {
    await runWithTelemetry(
      context,
      state,
      {
        operationName: "AgentNotification_Email",
        executionType: ExecutionType.EventToAgent,
        requestContent: `EmailNotificationType=${activity.notificationType}`,
      },
      async (invokeScope) => {
        await perplexityAgent.handleAgentNotificationActivity(
          context,
          state,
          activity,
          invokeScope
        );
      }
    );
  }
);

/* --------------------------------------------------------------------
 * ✅ Playground Events (Simulated) + telemetry (delegated to PerplexityAgent)
 * -------------------------------------------------------------------- */

agentApplication.onActivity(
  PlaygroundActivityTypes.MentionInWord,
  async (context: TurnContext, state: ApplicationTurnState): Promise<void> => {
    await runWithTelemetry(
      context,
      state,
      {
        operationName: "Playground_MentionInWord",
        executionType: ExecutionType.HumanToAgent,
        requestContent: JSON.stringify(context.activity.value ?? {}),
      },
      async (invokeScope) => {
        await perplexityAgent.handlePlaygroundMentionInWord(
          context,
          state,
          invokeScope
        );
      }
    );
  }
);

agentApplication.onActivity(
  PlaygroundActivityTypes.SendEmail,
  async (context: TurnContext, state: ApplicationTurnState): Promise<void> => {
    await runWithTelemetry(
      context,
      state,
      {
        operationName: "Playground_SendEmail",
        executionType: ExecutionType.HumanToAgent,
        requestContent: JSON.stringify(context.activity.value ?? {}),
      },
      async (invokeScope) => {
        await perplexityAgent.handlePlaygroundSendEmail(
          context,
          state,
          invokeScope
        );
      }
    );
  }
);

agentApplication.onActivity(
  PlaygroundActivityTypes.SendTeamsMessage,
  async (context: TurnContext, state: ApplicationTurnState): Promise<void> => {
    await runWithTelemetry(
      context,
      state,
      {
        operationName: "Playground_SendTeamsMessage",
        executionType: ExecutionType.HumanToAgent,
        requestContent: JSON.stringify(context.activity.value ?? {}),
      },
      async (invokeScope) => {
        await perplexityAgent.handlePlaygroundSendTeamsMessage(
          context,
          state,
          invokeScope
        );
      }
    );
  }
);

agentApplication.onActivity(
  PlaygroundActivityTypes.Custom,
  async (context: TurnContext, state: ApplicationTurnState): Promise<void> => {
    await runWithTelemetry(
      context,
      state,
      {
        operationName: "Playground_Custom",
        executionType: ExecutionType.HumanToAgent,
        requestContent: "custom",
      },
      async (invokeScope) => {
        await perplexityAgent.handlePlaygroundCustom(
          context,
          state,
          invokeScope
        );
      }
    );
  }
);

/* --------------------------------------------------------------------
 * ✅ Message Activities + telemetry
 * -------------------------------------------------------------------- */

agentApplication.onActivity(
  ActivityTypes.Message,
  async (context: TurnContext, state: ApplicationTurnState): Promise<void> => {
    // Increment count state
    let count: number = state.conversation.count ?? 0;
    state.conversation.count = ++count;

    await runWithTelemetry(
      context,
      state,
      {
        operationName: "Message",
        executionType: ExecutionType.HumanToAgent,
        requestContent: context.activity.text || "Unknown text",
      },
      async (invokeScope) => {
        await perplexityAgent.handleAgentMessageActivity(
          context,
          state,
          invokeScope
        );
      }
    );
  }
);

/* --------------------------------------------------------------------
 * ✅ Installation Updates (add/remove) + telemetry
 * -------------------------------------------------------------------- */

agentApplication.onActivity(
  ActivityTypes.InstallationUpdate,
  async (context: TurnContext, state: ApplicationTurnState): Promise<void> => {
    const action = (context.activity as any).action ?? "unknown";

    await runWithTelemetry(
      context,
      state,
      {
        operationName: "InstallationUpdate",
        executionType: ExecutionType.EventToAgent,
        requestContent: `InstallationUpdate action=${action}`,
      },
      async (invokeScope) => {
        await perplexityAgent.handleInstallationUpdateActivity(
          context,
          state,
          invokeScope
        );
      }
    );
  }
);
