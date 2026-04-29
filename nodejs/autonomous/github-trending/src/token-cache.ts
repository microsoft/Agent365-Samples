// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Simple in-memory token cache for observability tokens.
 * In production, use a more robust caching solution like Redis.
 */

interface CacheEntry {
  token: string;
  expiresAt: number; // Unix ms
}

const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

const cache = new Map<string, CacheEntry>();

export function cacheToken(agentId: string, tenantId: string, token: string, expiresInMs: number = 60 * 60 * 1000): void {
  const key = `${agentId}:${tenantId}`;
  cache.set(key, {
    token,
    expiresAt: Date.now() + expiresInMs,
  });
  // Avoid logging agentId/tenantId on every cache write to reduce log noise
}

export function getCachedToken(agentId: string, tenantId: string): string | null {
  const key = `${agentId}:${tenantId}`;
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  if (Date.now() + EXPIRY_BUFFER_MS >= entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  return entry.token;
}

/**
 * Token resolver called by the A365 Observability exporter when exporting telemetry.
 */
export const tokenResolver = (agentId: string, tenantId: string): string | null => {
  return getCachedToken(agentId, tenantId);
};
