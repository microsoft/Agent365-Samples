// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Only configuration and telemetry modules load statically; the app is imported at the end.
import { configDotenv } from 'dotenv';
import { useMicrosoftOpenTelemetry } from '@microsoft/opentelemetry';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { createObservabilityTokenResolver } from './observability-token-service.js';

configDotenv();

// On AWS, secret settings come from Secrets Manager (A365_SECRETS_ARN), not the environment; they
// must be in process.env before the token resolver below reads them. No-op locally.
await import('./secrets.js');

// A365 Observability — exports over the S2S endpoint with an app-only token for the agent
// instance (observability-token-service.ts). Export is off unless ENABLE_A365_OBSERVABILITY_EXPORTER=true.
useMicrosoftOpenTelemetry({
  enableConsoleExporters: process.env.NODE_ENV !== 'production' && !process.env.WEBSITE_SITE_NAME,
  resource: resourceFromAttributes({
    'service.name': process.env.agent365Observability__agentName ?? 'Travel Agent AWS',
  }),
  a365: {
    enabled: true,
    useS2SEndpoint: true,
    enableObservabilityExporter: ['true', '1', 'yes', 'on'].includes((process.env.ENABLE_A365_OBSERVABILITY_EXPORTER ?? '').toLowerCase()),
    // Published 1.4.0+ can replay stored legacy route choices; keep replay disabled.
    durableDelivery: { enabled: false },
    tokenResolver: createObservabilityTokenResolver(),
  },
  instrumentationOptions: { langchain: {} },
});

// ESM evaluates every static import before this module's body runs, so the app (agents-hosting,
// LangChain, MCP tooling) is loaded dynamically, only after telemetry and LangChain
// instrumentation are registered above.
await import('./app.js');
