// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Background service that logs a heartbeat message on a configurable interval.
 */
export function startHeartbeatService(intervalMs: number): ReturnType<typeof setInterval> {
  console.log(`HeartbeatService started. Interval: ${intervalMs}ms`);

  return setInterval(() => {
    console.log(`Agent heartbeat ${new Date().toISOString()}`);
  }, intervalMs);
}
