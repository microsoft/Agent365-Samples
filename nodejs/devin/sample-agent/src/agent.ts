// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  AgentDetails,
  BaggageBuilder,
  InferenceDetails,
  InferenceOperationType,
  InferenceScope,
  InvokeAgentScope,
  ObservabilityManager,
  TenantDetails,
} from "@microsoft/agents-a365-observability";
import { ClusterCategory } from "@microsoft/agents-a365-runtime";
import { Activity, ActivityTypes } from "@microsoft/agents-activity";
import {
  AgentApplication,
  AgentApplicationOptions,
  MemoryStorage,
  TurnContext,
  TurnState,
} from "@microsoft/agents-hosting";
import {
  AgentNotificationActivity,
  NotificationType,
  createEmailResponseActivity,
} from "@microsoft/agents-a365-notifications";
import '@microsoft/agents-a365-notifications';
import { Stream } from "stream";
import { v4 as uuidv4 } from "uuid";
import { devinClient } from "./devin-client";
import tokenCache from "./token-cache";
import { ApplicationTurnState } from "./types/agent.types";
import { getAgentDetails, getTenantDetails } from "./utils";

export class A365Agent extends AgentApplication<ApplicationTurnState> {
  isApplicationInstalled: boolean = false;
  agentName = "Devin Agent";

  constructor(
    options?: Partial<AgentApplicationOptions<ApplicationTurnState>> | undefined
  ) {
    super(options);
    const clusterCategory: ClusterCategory =
      (process.env.CLUSTER_CATEGORY as ClusterCategory) || "dev";

    // Initialize Observability SDK
    const observabilitySDK = ObservabilityManager.configure((builder) =>
      builder
        .withService("devin-sample-agent", "1.0.0")
        .withTokenResolver(async (agentId, tenantId) => {
          // Token resolver for authentication with Agent 365 observability
          console.log(
            "🔑 Token resolver called for agent:",
            agentId,
            "tenant:",
            tenantId
          );

          // Retrieve the cached agentic token
          const cacheKey = this.createAgenticTokenCacheKey(agentId, tenantId);
          const cachedToken = tokenCache.get(cacheKey);

          if (cachedToken) {
            console.log("🔑 Token retrieved from cache successfully");
            return cachedToken;
          }

          console.log(
            "⚠️ No cached token found - token should be cached during agent invocation"
          );
          return null;
        })
        .withClusterCategory(clusterCategory)
    );

    // Start the observability SDK
    observabilitySDK.start();

    // Handle messages
    this.onActivity(
      ActivityTypes.Message,
      async (context: TurnContext, state: ApplicationTurnState) => {
        // Increment count state
        let count = state.conversation.count ?? 0;
        state.conversation.count = ++count;

        // Extract agent and tenant details from context
        const invokeAgentDetails = getAgentDetails(context);
        const tenantDetails = getTenantDetails(context);

        // Create BaggageBuilder scope
        const baggageScope = new BaggageBuilder()
          .tenantId(tenantDetails.tenantId)
          .agentId(invokeAgentDetails.agentId)
          .correlationId(uuidv4())
          .agentName(invokeAgentDetails.agentName)
          .conversationId(context.activity.conversation?.id)
          .build();

        await baggageScope.run(async () => {
          const invokeAgentScope = InvokeAgentScope.start(
            invokeAgentDetails,
            tenantDetails
          );

          await invokeAgentScope.withActiveSpanAsync(async () => {
            invokeAgentScope.recordInputMessages([
              context.activity.text ?? "Unknown text",
            ]);

            await context.sendActivity(Activity.fromObject({ type: "typing" }));
            await this.handleAgentMessageActivity(
              context,
              invokeAgentScope,
              invokeAgentDetails,
              tenantDetails
            );
          });

          invokeAgentScope.dispose();
        });

        baggageScope.dispose();
      }
    );

    // Handle agent notifications
    this.onAgentNotification(
      "agents:*",
      async (
        context: TurnContext,
        state: ApplicationTurnState,
        agentNotificationActivity: AgentNotificationActivity
      ) => {
        await this.handleAgentNotificationActivity(
          context,
          state,
          agentNotificationActivity
        );
      }
    );

    // Handle installation activities
    this.onActivity(
      ActivityTypes.InstallationUpdate,
      async (context: TurnContext, state: TurnState) => {
        await this.handleInstallationUpdateActivity(context, state);
      }
    );
  }

  /**
   * Handles incoming user messages and sends responses.
   */
  async handleAgentMessageActivity(
    turnContext: TurnContext,
    invokeAgentScope: InvokeAgentScope,
    agentDetails: AgentDetails,
    tenantDetails: TenantDetails
  ): Promise<void> {
    if (!this.isApplicationInstalled) {
      await turnContext.sendActivity(
        "Please install the application before sending messages."
      );
      return;
    }

    const userMessage = turnContext.activity.text?.trim() || "";

    if (!userMessage) {
      await turnContext.sendActivity(
        "Please send me a message and I'll help you!"
      );
      return;
    }

    try {
      const inferenceDetails: InferenceDetails = {
        operationName: InferenceOperationType.CHAT,
        model: "claude-3-7-sonnet-20250219",
        providerName: "cognition-ai",
        inputTokens: Math.ceil(userMessage.length / 4), // Rough estimate
        responseId: `resp-${Date.now()}`,
        outputTokens: 0, // Will be updated after response
        finishReasons: undefined,
      };

      const inferenceScope = InferenceScope.start(
        inferenceDetails,
        agentDetails,
        tenantDetails
      );
      inferenceScope.recordInputMessages([userMessage]);

      let totalResponseLength = 0;
      const responseStream = new Stream()
        .on("data", async (chunk) => {
          totalResponseLength += (chunk as string).length;
          invokeAgentScope.recordOutputMessages([`LLM Response: ${chunk}`]);
          inferenceScope.recordOutputMessages([`LLM Response: ${chunk}`]);
          await turnContext.sendActivity(chunk);
        })
        .on("error", async (error) => {
          invokeAgentScope.recordOutputMessages([`Streaming error: ${error}`]);
          inferenceScope.recordOutputMessages([`Streaming error: ${error}`]);
          await turnContext.sendActivity(error);
        })
        .on("close", () => {
          inferenceScope.recordOutputTokens(Math.ceil(totalResponseLength / 4)); // Rough estimate
          inferenceScope.recordFinishReasons(["stop"]);
        });

      await devinClient.invokeAgent(userMessage, responseStream);
    } catch (error) {
      invokeAgentScope.recordOutputMessages([`LLM error: ${error}`]);
      await turnContext.sendActivity(
        "There was an error processing your request"
      );
    }
  }

  /**
   * Handles agent notification activities.
   */
  async handleAgentNotificationActivity(
    context: TurnContext,
    state: ApplicationTurnState,
    agentNotificationActivity: AgentNotificationActivity
  ): Promise<void> {
    switch (agentNotificationActivity.notificationType) {
      case NotificationType.EmailNotification:
        await this.handleEmailNotification(context, agentNotificationActivity);
        break;
      default:
        await context.sendActivity(
          `Received notification of type: ${agentNotificationActivity.notificationType}`
        );
    }
  }

  /**
   * Handles email notification activities with proper EmailResponse.
   */
  private async handleEmailNotification(
    context: TurnContext,
    activity: AgentNotificationActivity
  ): Promise<void> {
    const emailNotification = activity.emailNotification;

    if (!emailNotification) {
      const errorResponse = createEmailResponseActivity(
        "I could not find the email notification details."
      );
      await context.sendActivity(errorResponse);
      return;
    }

    try {
      // Collect the response from Devin using a stream
      let responseContent = "";
      const responseStream = new Stream()
        .on("data", (chunk) => {
          responseContent += chunk as string;
        })
        .on("error", (error) => {
          console.error("Stream error:", error);
        });

      // Process the email notification with Devin
      const prompt = `You have a new email from ${context.activity.from?.name} with id '${emailNotification.id}', ` +
        `ConversationId '${emailNotification.conversationId}'. Please process this email and provide a helpful response.`;

      await devinClient.invokeAgent(prompt, responseStream);

      const emailResponseActivity = createEmailResponseActivity(
        responseContent || "I have processed your email but do not have a response at this time."
      );
      await context.sendActivity(emailResponseActivity);
    } catch (error) {
      console.error("Email notification error:", error);
      const errorResponse = createEmailResponseActivity(
        "Unable to process your email at this time."
      );
      await context.sendActivity(errorResponse);
    }
  }

  /**
   * Handles agent installation and removal events.
   */
  async handleInstallationUpdateActivity(
    turnContext: TurnContext,
    state: TurnState
  ): Promise<void> {
    if (turnContext.activity.action === "add") {
      this.isApplicationInstalled = true;
      await turnContext.sendActivity(
        "Thank you for hiring me! Looking forward to assisting you in your professional journey!"
      );
    } else if (turnContext.activity.action === "remove") {
      this.isApplicationInstalled = false;
      await turnContext.sendActivity(
        "Thank you for your time, I enjoyed working with you."
      );
    }
  }

  /**
   * Create a cache key for the agentic token
   */
  private createAgenticTokenCacheKey(
    agentId: string,
    tenantId: string
  ): string {
    return tenantId
      ? `agentic-token-${agentId}-${tenantId}`
      : `agentic-token-${agentId}`;
  }
}

export const agentApplication = new A365Agent({
  storage: new MemoryStorage(),
  authorization: { agentic: {} }, // Type and scopes set in .env
});
