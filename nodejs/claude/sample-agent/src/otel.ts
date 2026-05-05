// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Must be imported before any HTTP/Express module so auto-instrumentations can patch them at load time.

import { useMicrosoftOpenTelemetry, shutdownMicrosoftOpenTelemetry } from '@microsoft/opentelemetry';

useMicrosoftOpenTelemetry();

const shutdown = async () => {
  try { await shutdownMicrosoftOpenTelemetry(); } catch (err) { console.error(err); }
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
