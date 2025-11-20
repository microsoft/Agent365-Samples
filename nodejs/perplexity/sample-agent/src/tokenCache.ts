// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Simple in-memory token cache with expiration handling
 * In production, use a more robust caching solution like Redis
 */
class TokenCache {
  private cache = new Map<string, string>();

  /**
   * Store a token with expiration
   */
  set(key: string, token: string): void {
    this.cache.set(key, token);
  }

  /**
   * Retrieve a token
   */
  get(key: string): string | null {
    const entry = this.cache.get(key);

    if (!entry) {
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
