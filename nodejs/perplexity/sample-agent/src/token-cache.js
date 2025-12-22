// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Simple in-memory token cache
 * In production, use a more robust caching solution like Redis
 */
class TokenCache {
  constructor() {
    this.cache = new Map();
  }

  /**
   * Store a token with key
   */
  set(key, token) {
    this.cache.set(key, token);
    console.log(`🔐 Token cached for key: ${key}`);
  }

  /**
   * Retrieve a token
   */
  get(key) {
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
  has(key) {
    return this.cache.has(key);
  }

  /**
   * Clear a token from cache
   */
  delete(key) {
    return this.cache.delete(key);
  }
}

// Create a singleton instance for the application
export const agenticTokenCache = new TokenCache(); // stores agentic/observability tokens
export const presenceStateCache = new TokenCache(); // stores presence state tokens
