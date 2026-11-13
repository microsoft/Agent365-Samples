// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.


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
  } catch {
    console.error('Error resolving cached observability token.');
    return null;
  }
};

/**
 * Simple in-memory token cache — no TTL, no eviction. The sample relies on the SDK
 * calling `preloadObservabilityToken` on every turn to refresh entries; production
 * deployments should replace this with a TTL-aware store (Redis, App Service secrets
 * cache, etc.).
 */
class TokenCache {
  private cache = new Map<string, string>();

  set(key: string, token: string): void {
    this.cache.set(key, token);
    console.log('Observability token cached.');
  }

  /**
   * Retrieve a token 
   */
  get(key: string): string | null {
    const entry = this.cache.get(key);

    if (!entry) {
      console.log('Observability token cache miss.');
      return null;
    }

    return entry;
  }

  /**
   * Check if a token exists 
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);

    if (!entry) {
      return false;
    }

    return true;
  }
}

// Create a singleton instance for the application
const tokenCache = new TokenCache();

export default tokenCache;
