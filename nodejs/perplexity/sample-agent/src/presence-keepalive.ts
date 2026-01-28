// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ensurePresenceAvailable } from "./presence-manager";

type Target = {
  tenantId: string;
  userId: string;
  sessionId: string;
  lastSeenAt: number;
};

/**
 * Creates a unique key for a presence target based on tenantId, userId, and sessionId.
 * @param t The target object containing tenantId, userId, and sessionId.
 * @returns A string key uniquely identifying the target.
 */
function keyOf(t: Pick<Target, "tenantId" | "userId" | "sessionId">) {
  return `${t.sessionId}:${t.tenantId}:${t.userId}`;
}

/**
 * Manages presence keep-alive for multiple users across tenants.
 */
export class PresenceKeepAliveManager {
  private targets = new Map<string, Target>();
  private timer: NodeJS.Timeout | null = null;
  private readonly tickMs: number;
  private readonly maxIdleMs: number;
  private readonly sessionId: string;
  private readonly tenantId: string;

  constructor(
    sessionId: string,
    tenantId: string,
    tickMs?: number,
    maxIdleMs?: number
  ) {
    this.sessionId = sessionId;
    this.tenantId = tenantId;
    this.tickMs = tickMs ?? 30000;
    this.maxIdleMs = maxIdleMs ?? 30 * 60000;
  }

  /**
   * Starts the presence keep-alive manager, initiating periodic presence updates.
   */
  start() {
    console.log("✅ Starting PresenceKeepAliveManager");
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
  }

  /**
   * Stops the presence keep-alive manager, halting periodic presence updates.
   */
  stop() {
    console.log("🛑 Stopping PresenceKeepAliveManager");
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.targets.clear();
  }

  /**
   * Updates the last seen timestamp for a presence target, or adds it if not present.
   * @param args An object containing userId.
   */
  touch(args: { userId: string }) {
    if (!args.userId) return;

    const targetArgs = {
      tenantId: this.tenantId,
      userId: args.userId,
      sessionId: this.sessionId,
    };
    const k = keyOf(targetArgs);
    const now = Date.now();
    const existing = this.targets.get(k);

    this.targets.set(k, {
      tenantId: this.tenantId,
      userId: args.userId,
      sessionId: this.sessionId,
      lastSeenAt: now,
    });
  }

  /**
   * Registers a presence target to keep it alive without requiring message traffic.
   * @param args An object containing userId.
   */
  register(args: { userId: string }) {
    // like touch(), but doesn’t require “message traffic” to stay present
    this.touch(args);
  }

  /**
   * Performs a tick to update presence for all registered targets.
   */
  private async tick() {
    const now = Date.now();

    for (const [k, t] of this.targets) {
      if (now - t.lastSeenAt > this.maxIdleMs) {
        this.targets.delete(k);
        continue;
      }

      try {
        await ensurePresenceAvailable({
          tenantId: t.tenantId,
          userId: t.userId,
          sessionId: t.sessionId,
        });
      } catch (e: any) {
        console.error("presence keepalive tick failed:", k, e?.message ?? e);
      }
    }
  }
}
