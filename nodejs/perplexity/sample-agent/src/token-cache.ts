// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Simple in-memory token cache
 * In production, use a more robust caching solution like Redis
 */
class TokenCache {
  private cache: Map<string, string>;

  constructor() {
    this.cache = new Map();
  }

  /**
   * Store a token with key
   */
  set(key: string, token: string): void {
    this.cache.set(key, token);
    console.log(`🔐 Token cached for key: ${key}`);
  }

  /**
   * Retrieve a token
   */
  get(key: string): string | null {
    const entry = this.cache.get(key);

    if (!entry) {
      console.log(`🔍 Token cache miss for key: ${key}`);
      return null;
    }

    return entry;
  }

  /**
   * Check if a token exists
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Clear a token from cache
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }
}

// Create a singleton instance for the application
const tokenCache = new TokenCache();

export default tokenCache;
