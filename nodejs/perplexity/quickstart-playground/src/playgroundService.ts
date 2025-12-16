// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TurnContext, TurnState } from "@microsoft/agents-hosting";
import type { InvokeAgentScope } from "@microsoft/agents-a365-observability";

import {
  MentionInWordValue,
  SendEmailActivity,
  SendTeamsMessageActivity,
} from "./playgroundActivityTypes.js";

/**
 * PlaygroundService handles playground activities (non-streaming, snappy UX).
 */
export class PlaygroundService {
  /**
   * Handles the MentionInWord playground activity.
   * @param turnContext  The context object for this turn.
   * @param _state The state object for this turn.
   * @param invokeScope Optional scope for invoking the agent.
   * @returns A promise that resolves when the activity has been handled.
   */
  async handleMentionInWord(
    turnContext: TurnContext,
    _state: TurnState,
    invokeScope?: InvokeAgentScope
  ): Promise<void> {
    invokeScope?.recordOutputMessages([
      "Playground_MentionInWord path: Starting",
    ]);

    const value = turnContext.activity.value as MentionInWordValue | undefined;

    if (!value || !value.mention) {
      const msg = "Invalid playground MentionInWord payload.";

      invokeScope?.recordOutputMessages([
        "Playground_MentionInWord path: InvalidPayload",
        "Playground_MentionInWord_InvalidPayload",
      ]);

      await turnContext.sendActivity(msg);
      return;
    }

    const docName: string = value.mention.displayName;
    const docUrl: string = value.docUrl;
    const userName: string = value.mention.userPrincipalName;
    const contextSnippet: string = value.context
      ? `Context: ${value.context}`
      : "";

    const message: string = `✅ You were mentioned in **${docName}** by ${userName}\n📄 ${docUrl}\n${contextSnippet}`;

    invokeScope?.recordOutputMessages([
      "Playground_MentionInWord path: Completed",
      "Playground_MentionInWord_Success",
    ]);

    await turnContext.sendActivity(message);
  }

  /**
   * Handles the SendEmail playground activity.
   * @param turnContext The context object for this turn.
   * @param _state The state object for this turn.
   * @param invokeScope Optional scope for invoking the agent.
   * @returns A promise that resolves when the activity has been handled.
   */
  async handleSendEmail(
    turnContext: TurnContext,
    _state: TurnState,
    invokeScope?: InvokeAgentScope
  ): Promise<void> {
    invokeScope?.recordOutputMessages(["Playground_SendEmail path: Starting"]);

    const activity = turnContext.activity as SendEmailActivity;
    const email = activity.value;

    if (!email) {
      const msg = "Invalid playground SendEmail payload.";

      invokeScope?.recordOutputMessages([
        "Playground_SendEmail path: InvalidPayload",
        "Playground_SendEmail_InvalidPayload",
      ]);

      await turnContext.sendActivity(msg);
      return;
    }

    const message: string = `📧 Email Notification:
      From: ${email.from}
      To: ${email.to?.join(", ")}
      Subject: ${email.subject}
      Body: ${email.body}`;

    invokeScope?.recordOutputMessages([
      "Playground_SendEmail path: Completed",
      "Playground_SendEmail_Success",
    ]);

    await turnContext.sendActivity(message);
  }

  /**
   * Handles the SendTeamsMessage playground activity.
   * @param turnContext The context object for this turn.
   * @param _state The state object for this turn.
   * @param invokeScope Optional scope for invoking the agent.
   * @returns A promise that resolves when the activity has been handled.
   */
  async handleSendTeamsMessage(
    turnContext: TurnContext,
    _state: TurnState,
    invokeScope?: InvokeAgentScope
  ): Promise<void> {
    invokeScope?.recordOutputMessages([
      "Playground_SendTeamsMessage path: Starting",
    ]);

    const activity = turnContext.activity as SendTeamsMessageActivity;
    const value = activity.value;

    if (!value) {
      const msg = "Invalid playground SendTeamsMessage payload.";

      invokeScope?.recordOutputMessages([
        "Playground_SendTeamsMessage path: InvalidPayload",
        "Playground_SendTeamsMessage_InvalidPayload",
      ]);

      await turnContext.sendActivity(msg);
      return;
    }

    const message = `💬 Teams Message: ${value.text} (Scope: ${value.destination?.scope})`;

    invokeScope?.recordOutputMessages([
      "Playground_SendTeamsMessage path: Completed",
      "Playground_SendTeamsMessage_Success",
    ]);

    await turnContext.sendActivity(message);
  }

  /**
   * Handles a custom playground activity.
   * @param turnContext The context object for this turn.
   * @param _state The state object for this turn.
   * @param invokeScope Optional scope for invoking the agent.
   * @returns A promise that resolves when the activity has been handled.
   */
  async handleCustom(
    turnContext: TurnContext,
    _state: TurnState,
    invokeScope?: InvokeAgentScope
  ): Promise<void> {
    invokeScope?.recordOutputMessages(["Playground_Custom path: Starting"]);

    const message = "this is a custom activity handler";

    invokeScope?.recordOutputMessages([
      "Playground_Custom path: Completed",
      "Playground_Custom_Success",
    ]);

    await turnContext.sendActivity(message);
  }
}
