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
import {
  MentionInWordValue,
  PlaygroundActivityTypes,
  SendEmailActivity,
  SendTeamsMessageActivity,
} from "./playgroundActivityTypes.js";

import {
  BaggageBuilder,
  InvokeAgentDetails,
  InvokeAgentScope,
  ExecutionType,
  ServiceEndpoint,
} from "@microsoft/agents-a365-observability";
import {
  extractAgentDetailsFromTurnContext,
  extractTenantDetailsFromTurnContext,
} from "./telemetryHelpers.js";

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
  handler: () => Promise<void>
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

    // If observability isn't configured, just run the handler
    if (!invokeScope) {
      await handler();
      return;
    }

    try {
      await invokeScope.withActiveSpanAsync(async () => {
        invokeScope.recordInputMessages([requestContent]);

        await handler();

        invokeScope.recordOutputMessages([
          `${options.operationName} handled by PerplexityAgent`,
        ]);
      });
    } finally {
      invokeScope.dispose();
    }
  });
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
      async () => {
        await perplexityAgent.handleAgentNotificationActivity(
          context,
          state,
          activity
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
      async () => {
        await perplexityAgent.handleAgentNotificationActivity(
          context,
          state,
          activity
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
      async () => {
        await perplexityAgent.handleAgentNotificationActivity(
          context,
          state,
          activity
        );
      }
    );
  }
);

/* --------------------------------------------------------------------
 * ✅ Playground Events (Simulated) + telemetry
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
      async () => {
        const value: MentionInWordValue = context.activity
          .value as MentionInWordValue;
        const docName: string = value.mention.displayName;
        const docUrl: string = value.docUrl;
        const userName: string = value.mention.userPrincipalName;
        const contextSnippet: string = value.context
          ? `Context: ${value.context}`
          : "";
        const message: string = `✅ You were mentioned in **${docName}** by ${userName}\n📄 ${docUrl}\n${contextSnippet}`;
        await context.sendActivity(message);
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
      async () => {
        const activity = context.activity as SendEmailActivity;
        const email = activity.value;

        const message: string = `📧 Email Notification:
          From: ${email.from}
          To: ${email.to.join(", ")}
          Subject: ${email.subject}
          Body: ${email.body}`;

        await context.sendActivity(message);
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
      async () => {
        const activity = context.activity as SendTeamsMessageActivity;
        const message = `💬 Teams Message: ${activity.value.text} (Scope: ${activity.value.destination.scope})`;
        await context.sendActivity(message);
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
      async () => {
        await context.sendActivity("this is a custom activity handler");
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
      async () => {
        await perplexityAgent.handleAgentMessageActivity(context, state);
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
      async () => {
        await perplexityAgent.handleInstallationUpdateActivity(context, state);
      }
    );
  }
);
