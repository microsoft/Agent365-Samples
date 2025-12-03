// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TurnContext, TurnState } from "@microsoft/agents-hosting";
import {
  AgentNotificationActivity,
  NotificationType,
} from "@microsoft/agents-a365-notifications";
import type { InvokeAgentScope } from "@microsoft/agents-a365-observability";

import { PerplexityClient } from "./perplexityClient.js";
import { GuardService, GuardContext, AgentState } from "./guardService.js";

/**
 * NotificationService handles real M365 notification activities.
 */
export class NotificationService {
  constructor(
    private readonly agentState: AgentState,
    private readonly guards: GuardService,
    private readonly getPerplexityClient: () => PerplexityClient
  ) {}

  /* ------------------------------------------------------------------
   * Entry point for generic notification events ("*")
   * ------------------------------------------------------------------ */
  async handleAgentNotificationActivity(
    turnContext: TurnContext,
    state: TurnState,
    activity: AgentNotificationActivity,
    invokeScope?: InvokeAgentScope
  ): Promise<void> {
    // Reuse shared guards
    if (
      !(await this.guards.ensureApplicationInstalled(
        turnContext,
        invokeScope,
        GuardContext.Notification
      ))
    ) {
      return;
    }

    if (
      !(await this.guards.ensureTermsAccepted(
        turnContext,
        invokeScope,
        GuardContext.Notification
      ))
    ) {
      return;
    }

    try {
      switch (activity.notificationType) {
        case NotificationType.EmailNotification:
          invokeScope?.recordOutputMessages([
            "Notification path: EmailNotificationHandler",
          ]);
          await this.handleEmailNotification(
            turnContext,
            state,
            activity,
            invokeScope
          );
          break;

        case NotificationType.WpxComment:
          invokeScope?.recordOutputMessages([
            "Notification path: WordNotificationHandler",
          ]);
          await this.handleWordNotification(
            turnContext,
            state,
            activity,
            invokeScope
          );
          break;

        default:
          invokeScope?.recordOutputMessages([
            "Notification path: UnsupportedNotificationType",
          ]);
          await turnContext.sendActivity(
            "Notification type not yet implemented."
          );
      }
    } catch (error) {
      const err = error as any;

      invokeScope?.recordError(error as Error);
      invokeScope?.recordOutputMessages([
        "Notification path: HandlerException",
        `Error handling notification: ${err.message || err}`,
      ]);

      await turnContext.sendActivity(
        `Error handling notification: ${err.message || err}`
      );
    }
  }

  /* ------------------------------------------------------------------
   * Word notifications (real Word @mention)
   * ------------------------------------------------------------------ */
  async handleWordNotification(
    turnContext: TurnContext,
    _state: TurnState,
    activity: AgentNotificationActivity,
    invokeScope?: InvokeAgentScope
  ): Promise<void> {
    invokeScope?.recordOutputMessages(["WordNotification path: Starting"]);

    const stream = this.getStreamingOrFallback(turnContext);
    await stream.sendProgress(
      "Thanks for the @-mention notification! Working on a response..."
    );

    const mentionNotificationEntity = activity.wpxCommentNotification;

    if (!mentionNotificationEntity) {
      invokeScope?.recordOutputMessages([
        "WordNotification path: MissingEntity",
      ]);

      const msg = "I could not find the mention notification details.";
      await stream.sendFinal(msg);
      return;
    }

    const documentId = mentionNotificationEntity.documentId;
    const odataId = mentionNotificationEntity["odata.id"];
    const initiatingCommentId = mentionNotificationEntity.initiatingCommentId;
    const subjectCommentId = mentionNotificationEntity.subjectCommentId;

    const mentionPrompt = `You have been mentioned in a Word document.
      Document ID: ${documentId || "N/A"}
      OData ID: ${odataId || "N/A"}
      Initiating Comment ID: ${initiatingCommentId || "N/A"}
      Subject Comment ID: ${subjectCommentId || "N/A"}
      Please retrieve the text of the initiating comment and return it in plain text.`;

    const client = this.getPerplexityClient();
    const commentContent = await client.invokeAgentWithScope(mentionPrompt);

    const response = await client.invokeAgentWithScope(
      `You have received the following comment. Please follow any instructions in it. ${commentContent}`
    );

    invokeScope?.recordOutputMessages([
      "WordNotification path: Completed",
      "WordNotification_Success",
    ]);

    await stream.sendFinal(response);
  }

  /* ------------------------------------------------------------------
   * Email notifications (real email notifications)
   * ------------------------------------------------------------------ */
  async handleEmailNotification(
    turnContext: TurnContext,
    _state: TurnState,
    activity: AgentNotificationActivity,
    invokeScope?: InvokeAgentScope
  ): Promise<void> {
    invokeScope?.recordOutputMessages(["EmailNotification path: Starting"]);

    const stream = this.getStreamingOrFallback(turnContext);
    await stream.sendProgress(
      "Thanks for the email notification! Working on a response..."
    );

    const emailNotificationEntity = activity.emailNotification;

    if (!emailNotificationEntity) {
      invokeScope?.recordOutputMessages([
        "EmailNotification path: MissingEntity",
        "EmailNotification_MissingEntity",
      ]);

      const msg = "I could not find the email notification details.";
      await stream.sendFinal(msg);
      return;
    }

    const emailNotificationId = emailNotificationEntity.id;
    const emailNotificationConversationId =
      emailNotificationEntity.conversationId;
    const emailNotificationConversationIndex =
      emailNotificationEntity.conversationIndex;
    const emailNotificationChangeKey = emailNotificationEntity.changeKey;

    const client = this.getPerplexityClient();
    const emailContent = await client.invokeAgentWithScope(
      `You have a new email from ${turnContext.activity.from?.name} with id '${emailNotificationId}',
      ConversationId '${emailNotificationConversationId}', ConversationIndex '${emailNotificationConversationIndex}',
      and ChangeKey '${emailNotificationChangeKey}'. Please retrieve this message and return it in text format.`
    );

    const response = await client.invokeAgentWithScope(
      `You have received the following email. Please follow any instructions in it. ${emailContent}`
    );

    invokeScope?.recordOutputMessages([
      "EmailNotification path: Completed",
      "EmailNotification_Success",
    ]);

    await stream.sendFinal(response);
  }

  /* ------------------------------------------------------------------
   * Installation lifecycle (add/remove)
   * ------------------------------------------------------------------ */
  async handleInstallationUpdate(
    turnContext: TurnContext,
    _state: TurnState,
    invokeScope?: InvokeAgentScope
  ): Promise<void> {
    const action = (turnContext.activity as any).action;

    if (action === "add") {
      this.agentState.isApplicationInstalled = true;
      this.agentState.termsAndConditionsAccepted = false;

      invokeScope?.recordOutputMessages([
        "Installation path: Added",
        "Installation_Add",
      ]);

      await turnContext.sendActivity(
        'Thank you for hiring me! Looking forward to assisting you with Perplexity AI! Before I begin, could you please confirm that you accept the terms and conditions? Send "I accept" to accept.'
      );
    } else if (action === "remove") {
      this.agentState.isApplicationInstalled = false;
      this.agentState.termsAndConditionsAccepted = false;

      invokeScope?.recordOutputMessages([
        "Installation path: Removed",
        "Installation_Remove",
      ]);

      await turnContext.sendActivity(
        "Thank you for your time, I enjoyed working with you."
      );
    } else {
      invokeScope?.recordOutputMessages([
        "Installation path: UnknownAction",
        "Installation_UnknownAction",
      ]);
    }
  }

  /* ------------------------------------------------------------------
   * Streaming helper (used only for real notification flows)
   * ------------------------------------------------------------------ */
  private getStreamingOrFallback(turnContext: TurnContext) {
    const streamingResponse = (turnContext as any).streamingResponse;

    return {
      hasStreaming: !!streamingResponse,
      async sendProgress(message: string): Promise<void> {
        if (streamingResponse) {
          streamingResponse.queueInformativeUpdate(message);
        }
        // Non-streaming surfaces: skip progress messages
      },
      async sendFinal(message: string): Promise<void> {
        if (streamingResponse) {
          streamingResponse.queueTextChunk(message);
          await streamingResponse.endStream();
        } else {
          await turnContext.sendActivity(message);
        }
      },
    };
  }
}
