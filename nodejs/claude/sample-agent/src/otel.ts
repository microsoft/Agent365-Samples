// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Must be imported before any HTTP/Express module so auto-instrumentations can patch them at load time.
// dotenv is loaded here (not in index.ts) because TypeScript compiles `import` to hoisted `require()` calls,
// which means this module executes before any executable statements in index.ts — including configDotenv().
// Loading .env here ensures OTEL_* variables are populated when useMicrosoftOpenTelemetry() initialises.
import { configDotenv } from 'dotenv';
import { useMicrosoftOpenTelemetry, shutdownMicrosoftOpenTelemetry } from '@microsoft/opentelemetry';

configDotenv();
useMicrosoftOpenTelemetry();

const shutdown = async () => {
  try { await shutdownMicrosoftOpenTelemetry(); } catch (err) { console.error(err); }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
