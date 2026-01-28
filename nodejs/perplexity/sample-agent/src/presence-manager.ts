// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Client } from "@microsoft/microsoft-graph-client";
import { ClientSecretCredential } from "@azure/identity";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js";
import { presenceStateCache } from "./token-cache";

type PresenceCacheEntry = { lastSetAt: number; expiresAt: number };

export type EnsurePresenceArgs = {
  tenantId: string; // AAD tenant
  userId: string; // AAD object id of agent/bot user
  sessionId: string; // Application (client) ID used as presence sessionId
  availability?: "Available" | "Busy" | "DoNotDisturb" | "Away" | string;
  activity?:
    | "Available"
    | "InACall"
    | "InAConferenceCall"
    | "Presenting"
    | "Away"
    | string;
  expirationDuration?: string; // ISO 8601 duration, e.g. "PT1H"
};

const PRESENCE_KEEPALIVE_MS = 4 * 60 * 1000; // refresh before default 5 min expiry
const DEFAULT_EXPIRY_MS = 60 * 60 * 1000; // if you request PT1H
const DEFAULT_EXPIRATION_DURATION = "PT1H";

/**
 * PRODUCTION OPTIMIZATION NOTE:
 *
 * This sample demonstrates presence management per-agent-user, but for production
 * deployments with many agent users, consider these optimizations:
 *
 * 1. **Batch API calls**: Use Microsoft Graph's $batch endpoint to set presence for
 *    multiple agent users in a single request, reducing API overhead and improving
 *    performance.
 *
 * 2. **Distributed caching**: Move from in-memory presenceStateCache to a distributed
 *    cache (Redis, Azure Cache for Redis) to share presence state across multiple
 *    server instances and prevent redundant Graph API calls.
 *
 * 3. **Rate limiting & throttling**: Implement exponential backoff and respect Graph
 *    API throttling limits (429 responses). Consider a queue-based approach for
 *    presence updates during high traffic.
 *
 * 4. **Lazy initialization**: Only set presence when an agent user first interacts,
 *    rather than proactively for all discovered users at startup.
 *
 * 5. **Monitoring & alerting**: Add Application Insights or similar telemetry to
 *    track presence API success rates, latency, and failures.
 */

/**
 * Retrieves the value of a required environment variable.
 * Throws an error if the environment variable is not set.
 * @param name The name of the environment variable.
 * @returns The value of the environment variable.
 */
function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const PRESENCE_CLIENT_ID = requiredEnv("PRESENCE_CLIENTID");
const PRESENCE_CLIENT_SECRET = requiredEnv("PRESENCE_CLIENTSECRET");

/**
 * Creates a unique key for a presence target based on sessionId, tenantId, and userId.
 * @param sessionId The application (client) ID used as presence sessionId.
 * @param tenantId The AAD tenant ID.
 * @param userId The AAD object ID of the agent/bot user.
 * @returns A string key uniquely identifying the presence target.
 */
function presenceCacheKey(sessionId: string, tenantId: string, userId: string) {
  return `presence:${sessionId}:${tenantId}:${userId}`;
}

/**
 * gets a Microsoft Graph client for the specified tenant using
 * the provided app registration credentials.
 * @param tenantId The AAD tenant ID.
 * @returns A Microsoft Graph client instance.
 */
function getGraphClientForTenant(tenantId: string): Client {
  const credential = new ClientSecretCredential(
    tenantId,
    PRESENCE_CLIENT_ID,
    PRESENCE_CLIENT_SECRET,
  );

  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ["https://graph.microsoft.com/.default"],
  });

  return Client.initWithMiddleware({ authProvider });
}

/**
 * Ensures that the presence of a user is set to "Available" or a specified state,
 * refreshing the presence if it is close to expiring.
 * @param args An object containing tenantId, userId, sessionId, and optional presence details.
 * @returns A promise that resolves when the presence has been ensured.
 */
export async function ensurePresenceAvailable(
  args: EnsurePresenceArgs,
): Promise<void> {
  const { tenantId, userId, sessionId } = args;
  if (!tenantId || !userId || !sessionId) return;

  const key = presenceCacheKey(sessionId, tenantId, userId);
  const now = Date.now();

  const cached = presenceStateCache.get(key) as unknown as
    | PresenceCacheEntry
    | undefined;
  const lastSetAt = cached?.lastSetAt ?? 0;
  const expiresAt = cached?.expiresAt ?? 0;

  const shouldRefresh =
    now - lastSetAt >= PRESENCE_KEEPALIVE_MS || now >= expiresAt;
  if (!shouldRefresh) return;

  const graph = getGraphClientForTenant(tenantId);

  await graph.api(`/users/${userId}/presence/setPresence`).post({
    sessionId,
    availability: args.availability ?? "Available",
    activity: args.activity ?? "Available",
    expirationDuration: args.expirationDuration ?? DEFAULT_EXPIRATION_DURATION,
  });

  presenceStateCache.set(key, {
    lastSetAt: now,
    expiresAt: now + DEFAULT_EXPIRY_MS,
  });
}
