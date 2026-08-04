// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Agent Interface
 * Defines the interface that agents must implement to work with the generic host.
 */

import type { TurnContext } from '@microsoft/agents-hosting';

export interface AgentInterface {
  /**
   * Process a user message and return a response.
   */
  invokeAgent(
    message: string,
    auth: unknown,
    authHandlerName: string | null,
    context: TurnContext
  ): Promise<string>;

  /**
   * Process a user message within an observability scope and return a response.
   */
  invokeAgentWithScope(
    message: string,
    auth: unknown,
    authHandlerName: string | null,
    context: TurnContext
  ): Promise<string>;
}
