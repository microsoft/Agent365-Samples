// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TurnContext } from "@microsoft/agents-hosting";
import type { InvokeAgentScope } from "@microsoft/agents-a365-observability";

export enum GuardContext {
  Message = "Message",
  Notification = "Notification",
}

export interface AgentState {
  isApplicationInstalled: boolean;
  termsAndConditionsAccepted: boolean;
}

/**
 * GuardService provides methods to enforce preconditions
 * such as application installation and terms acceptance.
 */
export class GuardService {
  constructor(private readonly state: AgentState) {}

  /**
   * Ensures the application is installed; if not, prompts the user.
   * @param turnContext The context of the current turn.
   * @param invokeScope The scope for invoking the agent.
   * @param context The guard context (Message or Notification).
   * @returns True if installed, false otherwise.
   */
  async ensureApplicationInstalled(
    turnContext: TurnContext,
    invokeScope: InvokeAgentScope | undefined,
    context: GuardContext
  ): Promise<boolean> {
    if (this.state.isApplicationInstalled) return true;

    const noun = `${context.toLowerCase()}s`; // "messages" / "notifications"

    invokeScope?.recordOutputMessages([`${context} path: AppNotInstalled`]);

    await turnContext.sendActivity(
      `Please install the application before sending ${noun}.`
    );
    return false;
  }

  /**
   * Ensures the terms and conditions are accepted; if not, prompts the user.
   * @param turnContext The context of the current turn.
   * @param invokeScope The scope for invoking the agent.
   * @param context The guard context (Message or Notification).
   * @returns True if terms accepted, false otherwise.
   */
  async ensureTermsAccepted(
    turnContext: TurnContext,
    invokeScope: InvokeAgentScope | undefined,
    context: GuardContext
  ): Promise<boolean> {
    if (this.state.termsAndConditionsAccepted) return true;

    const text = turnContext.activity.text?.trim().toLowerCase();

    if (text === "i accept") {
      this.state.termsAndConditionsAccepted = true;

      invokeScope?.recordOutputMessages([
        `${context} path: TermsAcceptedOn${context}`,
      ]);

      await turnContext.sendActivity(
        "Thank you for accepting the terms and conditions! How can I assist you today?"
      );
      return false; // completes the turn
    }

    invokeScope?.recordOutputMessages([`${context} path: TermsNotYetAccepted`]);

    await turnContext.sendActivity(
      "Please accept the terms and conditions to proceed. Send 'I accept' to accept."
    );
    return false;
  }

  /**
   * Ensures the user message is non-empty; if empty, prompts the user.
   * @param turnContext The context of the current turn.
   * @param invokeScope The scope for invoking the agent.
   * @returns The user's message if present, otherwise null.
   */
  async ensureUserMessage(
    turnContext: TurnContext,
    invokeScope?: InvokeAgentScope
  ): Promise<string | null> {
    const userMessage = turnContext.activity.text?.trim() || "";

    if (!userMessage) {
      invokeScope?.recordOutputMessages(["Message path: EmptyUserMessage"]);
      await turnContext.sendActivity(
        "Please send me a message and I'll help you!"
      );
      return null;
    }

    return userMessage;
  }
}
