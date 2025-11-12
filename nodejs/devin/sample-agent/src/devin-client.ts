// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import Stream from "stream";
import {
  DevinCreateSessionResponse,
  DevinSessionResponse,
  DevinSessionStatus,
} from "./types/devin-client.types";

export interface Client {
  invokeAgent(prompt: string, responseStream: Stream): Promise<void>;
}

/**
 * DevinClient provides an interface to interact with the Devin API
 * It maintains agentOptions as an instance field and exposes an invokeAgent method.
 */
export class DevinClient implements Client {
  private readonly devinMessageType = "devin_message";
  private readonly devinBaseUrl: string;
  private readonly devinApiKey: string;
  private readonly pollingIntervalSeconds: number;
  private currentSession: string | undefined;

  constructor() {
    this.devinBaseUrl = process.env.DEVIN_BASE_URL || "";
    this.devinApiKey = process.env.DEVIN_API_KEY || "";
    this.pollingIntervalSeconds = parseInt(
      process.env.POLLING_INTERVAL_SECONDS || "10"
    );

    if (!this.devinBaseUrl) {
      throw new Error("DEVIN_BASE_URL environment variable is required");
    }

    if (!this.devinApiKey) {
      throw new Error("DEVIN_API_KEY environment variable is required");
    }
  }

  /**
   * Sends a user message to Devin API and returns the AI's response in a stream.
   * Handles streaming results and error reporting.
   *
   * @param {string} prompt - The message or prompt to send to Devin.
   * @param {Stream} responseStream - A stream for the client to send Devin's replies to.
   * @returns {Promise<void>}
   */
  async invokeAgent(prompt: string, responseStream: Stream): Promise<void> {
    const pollMs = this.pollingIntervalSeconds * 1_000 || 10_000;

    this.currentSession = await this.promptDevin(prompt, this.currentSession);
    await this.getDevinResponse(this.currentSession, pollMs, responseStream);
  }

  private async promptDevin(
    prompt: string,
    sessionId?: string
  ): Promise<string> {
    const requestUrl = sessionId
      ? `${this.devinBaseUrl}/sessions/${sessionId}/message`
      : `${this.devinBaseUrl}/sessions`;

    const requestBody = sessionId ? { message: prompt } : { prompt };

    const response = await fetch(requestUrl, {
      method: "POST",
      headers: this.getReqHeaders(),
      body: JSON.stringify(requestBody),
    });

    const data = (await response.json()) as DevinCreateSessionResponse;
    const rawSessionId = String(data?.session_id ?? "");
    return sessionId || rawSessionId.replace("devin-", "");
  }

  private async getDevinResponse(
    sessionId: string,
    pollMs: number,
    responseStream: Stream,
    timeoutMs: number = 300_000
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const sentMessages = new Set<string>();
    let latestStatus = DevinSessionStatus.new;

    console.debug("starting poll for Devin's reply");

    while (Object.values(DevinSessionStatus).includes(latestStatus)) {
      console.debug("calling GET session/messages");
      if (Date.now() > deadline) {
        console.info("Timed out, not polling for an answer anymore");
        break;
      }

      await this.delay(pollMs);
      const requestUrl = `${this.devinBaseUrl}/sessions/${sessionId}`;

      const response = await fetch(requestUrl, {
        headers: this.getReqHeaders(),
      });

      if (response.status !== 200) {
        console.error(`API call failed with status ${response.status}}`);
        console.error(`Error response: ${JSON.stringify(response)}`);
        responseStream.emit(
          "data",
          "There was an error processing your request, please try again"
        );
        break;
      }

      const data = (await response.json()) as DevinSessionResponse;
      latestStatus = data.status;
      console.debug(`Current Devin Session status is: ${latestStatus}`);
      const latestMessage = data?.messages?.pop();
      console.debug(`latest message is ${JSON.stringify(latestMessage)}`);

      if (latestMessage && latestMessage.type === this.devinMessageType) {
        if (!sentMessages.has(latestMessage.event_id)) {
          const messageContent = String(latestMessage?.message);
          responseStream.emit("data", messageContent);
          sentMessages.add(latestMessage.event_id);
          console.debug(`emit data event with content: ${messageContent}}`);
        }
      }
    }

    console.debug("emitting close event");
    responseStream.emit("close");
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private getReqHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.devinApiKey}`,
      "Content-Type": "application/json",
    };
  }
}

export const devinClient = new DevinClient();
