// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TurnContext, TurnState } from "@microsoft/agents-hosting";
import { AgentNotificationActivity } from "@microsoft/agents-a365-notifications";
import type { InvokeAgentScope } from "@microsoft/agents-a365-observability";
import { PerplexityClient } from "./perplexityClient.js";
import { GuardService, GuardContext, AgentState } from "./guardService.js";
import { ChatFlowService } from "./chatFlowService.js";
import { ToolRunner } from "./toolRunner.js";
import { NotificationService } from "./notificationService.js";
import { PlaygroundService } from "./playgroundService.js";

/**
 * PerplexityAgent is the main agent class handling messages, notifications, and playground actions.
 */
export class PerplexityAgent implements AgentState {
  isApplicationInstalled = false;
  termsAndConditionsAccepted = false;

  authorization: any;

  private readonly guards: GuardService;
  private readonly toolRunner: ToolRunner;
  private readonly chatFlow: ChatFlowService;
  private readonly notifications: NotificationService;
  private readonly playground: PlaygroundService;

  constructor(authorization: any) {
    this.authorization = authorization;
    this.guards = new GuardService(this);

    this.toolRunner = new ToolRunner();

    this.chatFlow = new ChatFlowService(() => this.getPerplexityClient());

    this.notifications = new NotificationService(this, this.guards, () =>
      this.getPerplexityClient()
    );

    this.playground = new PlaygroundService();
  }

  /* ------------------------------------------------------------------
   * ✅ Message path (human chat)
   * ------------------------------------------------------------------ */

  async handleAgentMessageActivity(
    turnContext: TurnContext,
    state: TurnState,
    invokeScope?: InvokeAgentScope
  ): Promise<void> {
    // Guard: app must be installed
    if (
      !(await this.guards.ensureApplicationInstalled(
        turnContext,
        invokeScope,
        GuardContext.Message
      ))
    ) {
      return;
    }

    // Guard: terms must be accepted
    if (
      !(await this.guards.ensureTermsAccepted(
        turnContext,
        invokeScope,
        GuardContext.Message
      ))
    ) {
      return;
    }

    // Guard: non-empty user message
    const userMessage = await this.guards.ensureUserMessage(
      turnContext,
      invokeScope
    );
    if (!userMessage) {
      return;
    }

    // Long-running flow: tool invocation
    const lower = userMessage.toLowerCase().trim();
    const isToolInvocation = lower === "tool" || lower.startsWith("tool ");

    if (isToolInvocation) {
      invokeScope?.recordOutputMessages(["Message path: ToolOnly_Start"]);
      await this.toolRunner.runToolFlow(turnContext);
      invokeScope?.recordOutputMessages(["Message path: ToolOnly_Completed"]);
      return;
    }

    // Long-running flow: Perplexity (with streaming + telemetry)
    await this.chatFlow.runChatFlow(
      turnContext,
      state,
      userMessage,
      invokeScope
    );
  }

  /* ------------------------------------------------------------------
   * ✅ Real notifications (Word/email) + installation updates
   * ------------------------------------------------------------------ */

  async handleAgentNotificationActivity(
    turnContext: TurnContext,
    state: TurnState,
    activity: AgentNotificationActivity,
    invokeScope?: InvokeAgentScope
  ): Promise<void> {
    await this.notifications.handleAgentNotificationActivity(
      turnContext,
      state,
      activity,
      invokeScope
    );
  }

  async handleInstallationUpdateActivity(
    turnContext: TurnContext,
    state: TurnState,
    invokeScope?: InvokeAgentScope
  ): Promise<void> {
    await this.notifications.handleInstallationUpdate(
      turnContext,
      state,
      invokeScope
    );
  }

  async wordNotificationHandler(
    turnContext: TurnContext,
    state: TurnState,
    activity: AgentNotificationActivity,
    invokeScope?: InvokeAgentScope
  ): Promise<void> {
    await this.notifications.handleWordNotification(
      turnContext,
      state,
      activity,
      invokeScope
    );
  }

  async emailNotificationHandler(
    turnContext: TurnContext,
    state: TurnState,
    activity: AgentNotificationActivity,
    invokeScope?: InvokeAgentScope
  ): Promise<void> {
    await this.notifications.handleEmailNotification(
      turnContext,
      state,
      activity,
      invokeScope
    );
  }

  /* ------------------------------------------------------------------
   * ✅ Playground handlers
   * ------------------------------------------------------------------ */

  async handlePlaygroundMentionInWord(
    turnContext: TurnContext,
    state: TurnState,
    invokeScope?: InvokeAgentScope
  ): Promise<void> {
    await this.playground.handleMentionInWord(turnContext, state, invokeScope);
  }

  async handlePlaygroundSendEmail(
    turnContext: TurnContext,
    state: TurnState,
    invokeScope?: InvokeAgentScope
  ): Promise<void> {
    await this.playground.handleSendEmail(turnContext, state, invokeScope);
  }

  async handlePlaygroundSendTeamsMessage(
    turnContext: TurnContext,
    state: TurnState,
    invokeScope?: InvokeAgentScope
  ): Promise<void> {
    await this.playground.handleSendTeamsMessage(
      turnContext,
      state,
      invokeScope
    );
  }

  async handlePlaygroundCustom(
    turnContext: TurnContext,
    state: TurnState,
    invokeScope?: InvokeAgentScope
  ): Promise<void> {
    await this.playground.handleCustom(turnContext, state, invokeScope);
  }

  /* ------------------------------------------------------------------
   * 🔧 Shared Perplexity client factory
   * ------------------------------------------------------------------ */

  private getPerplexityClient(): PerplexityClient {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) {
      throw new Error("PERPLEXITY_API_KEY environment variable is not set");
    }

    const model = process.env.PERPLEXITY_MODEL || "sonar";
    return new PerplexityClient(apiKey, model);
  }
}
