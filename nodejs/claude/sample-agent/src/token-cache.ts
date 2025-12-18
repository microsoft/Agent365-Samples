// ------------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ------------------------------------------------------------------------------

export function createAgenticTokenCacheKey(agentId: string, tenantId?: string): string {
  return tenantId ? `agentic-token-${agentId}-${tenantId}` : `agentic-token-${agentId}`;
}

// A simple example of custom token resolver which will be called by observability SDK when needing tokens for exporting telemetry
export const tokenResolver = (agentId: string, tenantId: string): string | null => {
  try {
    // Use cached agentic token from agent authentication
    const cacheKey = createAgenticTokenCacheKey(agentId, tenantId);
    const cachedToken = tokenCache.get(cacheKey);

    if (cachedToken) {
      return cachedToken;
    } else {
      return null;
    }
  } catch (error) {
    console.error(`❌ Error resolving token for agent ${agentId}, tenant ${tenantId}:`, error);
    return null;
  }
};

/**
 * Simple custom in-memory token cache
 * In production, use a more robust caching solution like Redis
 */
class TokenCache {
  private cache = new Map<string, string>();

  set(key: string, token: string): void {
    this.cache.set(key, token);
    console.log(`🔐 Token cached for key: ${key}`);
  }

  get(key: string): string | null {
    const entry = this.cache.get(key);
    if (!entry) {
      console.log(`🔍 Token cache miss for key: ${key}`);
      return null;
    }
    return entry;
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    return !!entry;
  }
}

// Create a singleton instance for the application
const tokenCache = new TokenCache();

export default tokenCache;